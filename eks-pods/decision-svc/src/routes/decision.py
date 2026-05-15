"""decision routes - V6.2 4-stage cascade 자동 결정 (2026-05-14 Stage 0 추가).

POST /decide:
  Input: isbn13 · target_location_id · qty
  Algorithm (target_type=STORE_OFFLINE):
    Stage 0 (WH_TO_STORE): 자기 wh 본체 (location_type='WH') 의 effective_surplus ≥ qty?
    Stage 1 (REBALANCE):   target wh 내 다른 매장 중 가용 ≥ qty?
    Stage 2 (WH_TRANSFER): 다른 권역 wh 본체 가용 ≥ qty?
    Stage 3 (PUBLISHER_ORDER): 위 모두 불가 → 외부 발주
  target_type=WH 면 Stage 0/1 skip · Stage 2/3 만.
  Auto-derive:
    - urgency_level: stock_days_remaining (forecast_cache 기반) < 1 → URGENT, < 0.5 → CRITICAL
    - auto_execute_eligible: Stage 3 + URGENT/CRITICAL → True

Output: DecideResponse (order_id, stage, order_type, source/target, urgency, rationale)

`order.pending` Redis publish 는 notification-svc /send 호출 (시트10 정합).
"""
import json
import logging
import math
import os
from datetime import date, datetime, timedelta
from typing import Literal
from uuid import uuid4

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException, Query, status

from ..auth import AuthContext, require_auth
from ..db import db_conn
from ..settings import settings
from ..models import (
    BatchDecideRequest,
    BatchDecideResponse,
    DecideRequest,
    DecideResponse,
    PendingOrder,
    PendingOrdersResponse,
)

# Daily planner 상수 (D+1 forecast 기반 익일 배치 발의)
PLAN_SAFETY_DAYS = 5      # 매장 desired = predicted_demand × SAFETY_DAYS
PLAN_WH_BUFFER_DAYS = 2   # WH 본체 desired = sum(same-wh stores predicted) × BUFFER_DAYS
PLAN_MIN_ROW_QTY = 5      # 너무 작은 발의는 묶거나 스킵 (운송 효율)

# Stage 별 lead time — 사용자 도메인 (2026-05-15 v4):
#   "수요예측 D+0 새벽 → 9시 이내 승인 끝 → 그 날 안에 모든 계획 실행".
# REBALANCE/WH_TO_STORE: 발의 당일 매장↔매장 / wh→매장 차량 routing 으로 D+0 도착.
# WH_TRANSFER: 권역 간 (수도권↔영남) → D+1 도착.
# PUBLISHER_ORDER: 외부 출판사 발주 → D+3 도착.
LEAD_DAYS: dict[str, int] = {
    "REBALANCE": 0,
    "WH_TO_STORE": 0,
    "WH_TRANSFER": 1,
    "PUBLISHER_ORDER": 3,
}


def _expected_arrival(order_type: str, base: date | None = None) -> str:
    """order_type 의 LEAD_DAYS 를 base (default=today) 에 더한 ISO date string.

    /decide: base=date.today() · /plan-daily: base=snapshot_date.
    LEAD_DAYS 미정의 order_type 은 1일 fallback (안전).
    """
    base_date = base if base is not None else date.today()
    days = LEAD_DAYS.get(order_type, 1)
    return (base_date + timedelta(days=days)).isoformat()

log = logging.getLogger(__name__)
router = APIRouter(prefix="/decision", tags=["decision"])

NOTIFICATION_SVC_URL = os.environ.get(
    "DECISION_NOTIFICATION_SVC_URL",
    "http://notification-svc.bookflow.svc.cluster.local",
)

# FR-A4.1 EOQ 상수 (publishers.order_cost / books.holding_cost 컬럼 미존재 → default 사용)
MIN_EOQ = 10                          # 출판사 최소 발주량 (정책 안전망)
DEFAULT_ORDER_COST = 50000            # 발주 1건당 비용 (KRW · 운송 + 행정)
DEFAULT_HOLDING_COST_RATIO = 0.20     # books.price_standard 대비 연간 보관비 비율 (20%)


def _get_target_meta(cur, target_location_id: int) -> tuple[int, str]:
    """target location 의 (wh_id, location_type) 반환. Stage 1 가드용."""
    cur.execute("SELECT wh_id, location_type FROM locations WHERE location_id = %s", (target_location_id,))
    row = cur.fetchone()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"target_location_id {target_location_id} 가 locations 에 없음",
        )
    return row[0], row[1]


def _effective_available(
    on_hand: int,
    reserved_qty: int | None,
    incoming_qty: int | None,
    expected_demand: int | None,
    chained_incoming: int | None = None,
) -> int:
    """FR-A5.1 effective available = on_hand - reserved - incoming - chained_incoming - max(0, expected_demand)

    incoming_qty: pending_orders APPROVED · target=self · executed_at IS NULL 의 합 (이미 다른 발주에 잡힌 입고)
    chained_incoming: v5 2026-05-15 — 자기 wh 본체로 향하는 WH_TRANSFER/PUBLISHER 가 도착 시 자동 분배될 chained WH_TO_STORE 추정량
                      ("DECISION 이 chained 시점 고려" — 사용자 명시)
    expected_demand: forecast_cache 의 향후 14일 일별 predicted_demand 합

    None 입력은 0 으로 처리 (DB NULL 안전).
    expected_demand 가 음수면 0 으로 clamp (이상치/NULL 인 forecast 가 가용량을 늘리는 효과 차단).
    """
    on_hand = int(on_hand or 0)
    reserved = int(reserved_qty or 0)
    incoming = int(incoming_qty or 0)
    chained = int(chained_incoming or 0)
    demand = max(0, int(expected_demand or 0))
    return on_hand - reserved - incoming - chained - demand


def _estimated_chained_incoming(cur, isbn13: str, store_id: int) -> int:
    """v5 2026-05-15 — 매장 store_id 가 속한 wh 본체로 향하는 미실행 WH_TRANSFER/PUBLISHER 의
    chained 분배 추정량.

    가정 (state_machine._trigger_chained_wh_to_store 와 정합):
      - WH_TRANSFER (D+1 wh 도착) → chained WH_TO_STORE (D+2 매장 도착)
      - PUBLISHER (D+3 wh 도착) → chained WH_TO_STORE (D+4 매장 도착)
      - chained 는 권역 매장 중 부족 매장에 분배 (부족 없을 시 균등)
    단순 추정: qty / 권역 매장 수 (균등 분배 가정).
    """
    cur.execute("SELECT wh_id FROM locations WHERE location_id = %s", (store_id,))
    row = cur.fetchone()
    if not row or row[0] is None:
        return 0
    wh_id = row[0]
    cur.execute(
        """
        WITH wh_loc AS (
            SELECT location_id FROM locations WHERE wh_id = %s AND location_type = 'WH'
        ),
        store_count AS (
            SELECT GREATEST(COUNT(*)::int, 1) AS c
              FROM locations
             WHERE wh_id = %s AND location_type = 'STORE_OFFLINE' AND active = TRUE
        )
        SELECT COALESCE(SUM(po.qty), 0)::int / (SELECT c FROM store_count)
          FROM pending_orders po
         WHERE po.isbn13 = %s
           AND po.status IN ('APPROVED', 'IN_TRANSIT')
           AND po.executed_at IS NULL
           AND po.order_type IN ('WH_TRANSFER', 'PUBLISHER_ORDER')
           AND po.target_location_id IN (SELECT location_id FROM wh_loc)
        """,
        (wh_id, wh_id, isbn13),
    )
    r = cur.fetchone()
    return int(r[0] or 0) if r else 0


def _calc_eoq(annual_demand: float, order_cost: float, holding_cost: float) -> int:
    """FR-A4.1 경제적 발주량 EOQ = sqrt(2 * D * S / H)

    D: 연간 수요량 — forecast_cache 14일 SUM × (365/14) 또는 sales_realtime extrapolate
    S: 발주 1건당 비용 — publishers.order_cost 또는 DEFAULT_ORDER_COST
    H: 단위당 연간 보관비 — books.holding_cost 또는 books.price_standard × DEFAULT_HOLDING_COST_RATIO

    입력 ≤ 0 또는 NaN → MIN_EOQ (출판사 정책 안전망 + division by zero 방어).
    계산값이 MIN 보다 작으면 MIN 으로 clamp.
    """
    if annual_demand <= 0 or order_cost <= 0 or holding_cost <= 0:
        return MIN_EOQ
    eoq = math.sqrt(2.0 * annual_demand * order_cost / holding_cost)
    return max(MIN_EOQ, int(round(eoq)))


def _auto_execute_eligible(stage_num: int, urgency_level: str) -> bool:
    """FR-A4.7 자동 발주 자격 — 외부 발주 (Stage 3 PUBLISHER_ORDER) + 긴급 (URGENT/CRITICAL) 만.

    Stage 1 (재분배) · Stage 2 (권역이동) 는 항상 사람 승인 필요 (SOURCE/TARGET 담당자 책임).
    Stage 3 외부 발주는 사람 부재 시 07:00 KST CronJob 이 일괄 자동 승인 (사용자 결정 ·
    메모리 `project_auto_execute_07_kst`).

    이전 잘못된 정의 (Stage 1 + URGENT/CRITICAL) → 정정.
    """
    return stage_num == 3 and urgency_level in ("URGENT", "CRITICAL")


def _check_book_decision_eligibility(
    active: bool,
    discontinue_mode: str | None,
) -> tuple[bool, bool]:
    """FR-A6.2 / A5.8 / A3.8 books 마스터 상태별 의사결정 허용 여부.

    Returns: (allow_decision, allow_publisher_order)
      - allow_decision=False  → /decide 진입 즉시 400 (어떤 의사결정도 불가)
      - allow_publisher_order=False → Stage 3 (PUBLISHER_ORDER) 진입 시 400 (재분배·권역이동만)

    규칙:
      - active=FALSE OR discontinue_mode='INACTIVE' → 모두 차단 (master 비활성)
      - discontinue_mode='SOFT_DISCONTINUE'        → 재분배·권역이동 OK · 신규 발주 차단 (재고 소진 모드)
      - 그 외 ('NONE' / NULL / 미상)               → 모두 허용 (정상 도서)
    """
    if not active or discontinue_mode == "INACTIVE":
        return False, False
    if discontinue_mode == "SOFT_DISCONTINUE":
        return True, False
    return True, True


def _partner_surplus(
    on_hand: int,
    reserved_qty: int | None,
    safety_stock: int | None,
    expected_demand: int | None,
) -> int:
    """FR-A5.3 타 권역 WH 의 권역간 이동 가능 여유분 = on_hand - reserved - safety_stock - max(0, expected_demand_14d)

    Stage 1 의 _effective_available 와 다른 점:
      - 안전재고를 차감 (자기 wh 보전이 우선 · 보낼 수 있는 양은 안전재고 초과분만)
      - incoming 은 차감 안 함 (타 권역 입장 · 입고 예정은 자기 안전재고 회복용)

    음수면 보낼 수 없음 (자기 wh 도 부족 → 발주 대상).
    None 입력은 0 으로 처리, demand 음수는 0 clamp (이상치 forecast 방어).
    """
    on_hand = int(on_hand or 0)
    reserved = int(reserved_qty or 0)
    safety = int(safety_stock or 0)
    demand = max(0, int(expected_demand or 0))
    return on_hand - reserved - safety - demand


def _stage0_source(cur, isbn13: str, target_wh: int, qty: int) -> int | None:
    """Stage 0 (2026-05-14 신규): 자기 wh 본체 (location_type='WH') 의 매장 보충 가용.

    target_type=STORE_OFFLINE 일 때 자기 권역 wh 본체에서 매장으로 바로 보낼 수 있는지 먼저 확인.
    Stage 1 (매장 ↔ 매장 재분배) 보다 우선순위 높음 — wh 본체 잉여가 자연 흐름.

    effective_available = on_hand - reserved - incoming - max(0, expected_demand_14d).
    Stage 1 과 동일 정의이지만 safety_stock 은 차감 안 함 (자기 wh 본체는 자기 권역 매장에 자유롭게 보낼 수 있음).
    가장 여유 큰 wh 본체 location 반환.
    """
    cur.execute(
        """
        WITH stage0_candidates AS (
            SELECT
                i.location_id,
                i.on_hand,
                i.reserved_qty,
                COALESCE((
                    SELECT SUM(po.qty)
                      FROM pending_orders po
                     WHERE po.target_location_id = i.location_id
                       AND po.isbn13 = i.isbn13
                       -- 2026-05-15 v3: 4-step state machine 정합
                       -- 도착 예정 = APPROVED (출고 대기) + IN_TRANSIT (운송 중) + AUTO_EXECUTED (cron 자동)
                       -- PENDING 은 협의 미확정이라 제외 (over-count 회피)
                       AND po.status IN ('APPROVED','IN_TRANSIT','AUTO_EXECUTED')
                       AND po.executed_at IS NULL
                ), 0) AS incoming_qty,
                COALESCE((
                    SELECT SUM(fc.predicted_demand)
                      FROM forecast_cache fc
                     WHERE fc.isbn13 = i.isbn13
                       AND fc.store_id = i.location_id
                       AND fc.snapshot_date >= CURRENT_DATE
                       AND fc.snapshot_date <  CURRENT_DATE + INTERVAL '14 days'
                ), 0) AS expected_demand_14d
              FROM inventory i
              JOIN locations l ON l.location_id = i.location_id
              JOIN books b     ON b.isbn13 = i.isbn13
             WHERE l.wh_id = %s
               AND l.location_type = 'WH'
               AND i.isbn13 = %s
               AND b.active = TRUE
        )
        SELECT location_id,
               (on_hand - reserved_qty - incoming_qty - GREATEST(0, expected_demand_14d)) AS effective_available
          FROM stage0_candidates
         WHERE (on_hand - reserved_qty - incoming_qty - GREATEST(0, expected_demand_14d)) >= %s
         ORDER BY effective_available DESC
         LIMIT 1
        """,
        (target_wh, isbn13, qty),
    )
    row = cur.fetchone()
    return row[0] if row else None


def _stage1_source(cur, isbn13: str, target_wh: int, target_location_id: int, qty: int) -> int | None:
    """Stage 1 (FR-A5.1): 같은 wh 안에서 effective_available ≥ qty 인 location.

    effective_available = on_hand - reserved - incoming(APPROVED pending in-transit) - expected_demand(14d forecast).
    가장 여유 큰 location 선택.

    SOFT_DISCONTINUE 도서는 재분배 허용 (FR-A6.2), INACTIVE 도서는 재분배 차단 (Task 5 에서 보강).
    여기서는 books active=TRUE 만 안전하게 필터.
    """
    cur.execute(
        """
        WITH stage1_candidates AS (
            SELECT
                i.location_id,
                i.on_hand,
                i.reserved_qty,
                COALESCE((
                    SELECT SUM(po.qty)
                      FROM pending_orders po
                     WHERE po.target_location_id = i.location_id
                       AND po.isbn13 = i.isbn13
                       -- 2026-05-15 v3: 4-step state machine 정합
                       -- 도착 예정 = APPROVED (출고 대기) + IN_TRANSIT (운송 중) + AUTO_EXECUTED (cron 자동)
                       -- PENDING 은 협의 미확정이라 제외 (over-count 회피)
                       AND po.status IN ('APPROVED','IN_TRANSIT','AUTO_EXECUTED')
                       AND po.executed_at IS NULL
                ), 0) AS incoming_qty,
                COALESCE((
                    SELECT SUM(fc.predicted_demand)
                      FROM forecast_cache fc
                     WHERE fc.isbn13 = i.isbn13
                       AND fc.store_id = i.location_id
                       AND fc.snapshot_date >= CURRENT_DATE
                       AND fc.snapshot_date <  CURRENT_DATE + INTERVAL '14 days'
                ), 0) AS expected_demand_14d
              FROM inventory i
              JOIN locations l ON l.location_id = i.location_id
              JOIN books b     ON b.isbn13 = i.isbn13
             WHERE l.wh_id = %s
               AND l.location_type = 'STORE_OFFLINE'
               AND i.location_id <> %s
               AND i.isbn13 = %s
               AND b.active = TRUE
        )
        SELECT location_id,
               (on_hand - reserved_qty - incoming_qty - GREATEST(0, expected_demand_14d)) AS effective_available
          FROM stage1_candidates
         WHERE (on_hand - reserved_qty - incoming_qty - GREATEST(0, expected_demand_14d)) >= %s
         ORDER BY effective_available DESC
         LIMIT 1
        """,
        (target_wh, target_location_id, isbn13, qty),
    )
    row = cur.fetchone()
    return row[0] if row else None


def _stage2_source(cur, isbn13: str, target_wh: int, qty: int) -> dict | None:
    """Stage 2 (FR-A5.3): 다른 권역 WH 중 partner_surplus ≥ qty 인 곳 선택.

    partner_surplus = on_hand - reserved - safety_stock - max(0, expected_demand_14d)
    (자기 안전재고 + 14일 예상수요를 보전하고도 보낼 수 있는 양)

    필터:
      - l.wh_id <> target_wh (다른 권역)
      - l.location_type = 'WH' (권역간 이동은 WH 사이만 · 매장 직송 X)
      - b.active = TRUE (INACTIVE 도서 차단)

    Returns enriched dict (caller 가 rationale 에 partner_* 필드 채울 수 있음) or None.
    """
    cur.execute(
        """
        WITH stage2_candidates AS (
            SELECT
                i.location_id,
                l.wh_id AS partner_wh,
                i.on_hand,
                i.reserved_qty,
                COALESCE(i.safety_stock, 0) AS safety_stock,
                COALESCE((
                    SELECT SUM(fc.predicted_demand)::int
                      FROM forecast_cache fc
                     WHERE fc.isbn13 = i.isbn13
                       AND fc.store_id = i.location_id
                       AND fc.snapshot_date >= CURRENT_DATE
                       AND fc.snapshot_date <  CURRENT_DATE + INTERVAL '14 days'
                ), 0) AS expected_demand_14d
              FROM inventory i
              JOIN locations l ON l.location_id = i.location_id
              JOIN books b     ON b.isbn13 = i.isbn13
             WHERE l.wh_id <> %s
               AND l.location_type = 'WH'
               AND i.isbn13 = %s
               AND b.active = TRUE
        )
        SELECT location_id, partner_wh, on_hand, reserved_qty, safety_stock,
               expected_demand_14d,
               (on_hand - reserved_qty - safety_stock - GREATEST(0, expected_demand_14d)) AS surplus
          FROM stage2_candidates
         WHERE (on_hand - reserved_qty - safety_stock - GREATEST(0, expected_demand_14d)) >= %s
         ORDER BY surplus DESC
         LIMIT 1
        """,
        (target_wh, isbn13, qty),
    )
    row = cur.fetchone()
    if row is None:
        return None
    return {
        "location_id": row[0],
        "partner_wh": row[1],
        "partner_on_hand": int(row[2] or 0),
        "partner_reserved": int(row[3] or 0),
        "partner_safety": int(row[4] or 0),
        "partner_expected_demand_14d": int(row[5] or 0),
        "partner_surplus": int(row[6] or 0),
    }


def _annual_demand_for_book(cur, isbn13: str) -> float:
    """FR-A4.1 EOQ 입력 D 추정 — forecast_cache 14일 SUM × (365/14).

    forecast 데이터 없으면 0.0 (caller MIN_EOQ).
    """
    cur.execute(
        """
        SELECT COALESCE(SUM(predicted_demand), 0)::float
          FROM forecast_cache
         WHERE isbn13 = %s
           AND snapshot_date >= CURRENT_DATE
           AND snapshot_date <  CURRENT_DATE + INTERVAL '14 days'
        """,
        (isbn13,),
    )
    row = cur.fetchone()
    daily_sum_14d = float(row[0] or 0)
    return daily_sum_14d * (365.0 / 14.0)


def _holding_cost_for_book(cur, isbn13: str) -> float:
    """FR-A4.1 EOQ 입력 H 추정 — books.price_standard × DEFAULT_HOLDING_COST_RATIO.

    books 미존재 또는 price NULL → 0.0 (caller MIN_EOQ).
    향후 books.holding_cost 컬럼 추가 시 우선 사용.
    """
    cur.execute("SELECT price_standard FROM books WHERE isbn13 = %s", (isbn13,))
    row = cur.fetchone()
    price = float(row[0] or 0) if row else 0.0
    return price * DEFAULT_HOLDING_COST_RATIO


def _calc_urgency(cur, isbn13: str, target_location_id: int, qty: int) -> tuple[str, dict]:
    """현재 가용 + forecast_cache 기반 urgency 계산.

    stock_days_remaining = current_available_at_target / predicted_daily_demand
    < 0.5 → CRITICAL, < 1.0 → URGENT, else NORMAL.

    forecast_cache 데이터 없으면 NORMAL (정합 우선 · Phase 4 Vertex AI 연동 시 자동 채워짐).
    """
    cur.execute(
        "SELECT on_hand, reserved_qty FROM inventory WHERE isbn13 = %s AND location_id = %s",
        (isbn13, target_location_id),
    )
    row = cur.fetchone()
    current_available = (row[0] - row[1]) if row else 0

    cur.execute(
        """
        SELECT predicted_demand FROM forecast_cache
         WHERE isbn13 = %s AND store_id = %s
         ORDER BY snapshot_date DESC LIMIT 1
        """,
        (isbn13, target_location_id),
    )
    fc = cur.fetchone()
    predicted_daily = float(fc[0]) if fc and fc[0] is not None else None

    if predicted_daily and predicted_daily > 0:
        days = (current_available + qty) / predicted_daily
        if days < 0.5:
            urg = "CRITICAL"
        elif days < 1.0:
            urg = "URGENT"
        else:
            urg = "NORMAL"
    else:
        days = None
        urg = "NORMAL"

    return urg, {
        "current_available": current_available,
        "predicted_daily_demand": predicted_daily,
        "stock_days_remaining": days,
        "qty_requested": qty,
    }


@router.post("/decide", response_model=DecideResponse)
def decide(req: DecideRequest, ctx: AuthContext = Depends(require_auth)):
    """3-stage cascade 자동 결정. role 검증 (hq-admin · wh-manager 만)."""
    if ctx.role not in ("hq-admin", "wh-manager"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="hq-admin 또는 wh-manager 만 의사결정 생성 가능")

    order_id = uuid4()

    with db_conn() as conn:
        with conn.cursor() as cur:
            target_wh, target_type = _get_target_meta(cur, req.target_location_id)

            # WH manager scope 검증 (자기 wh 외 결정 불가)
            if ctx.role == "wh-manager" and ctx.scope_wh_id is not None and ctx.scope_wh_id != target_wh:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail=f"본인 창고 외 의사결정 불가 (scope wh_id={ctx.scope_wh_id} · target wh_id={target_wh})",
                )

            # FR-A6.2 / A5.8 / A3.8 books 마스터 상태 검증
            cur.execute("SELECT active, discontinue_mode FROM books WHERE isbn13 = %s", (req.isbn13,))
            book_row = cur.fetchone()
            if book_row is None:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"isbn13 {req.isbn13} books 마스터에 없음",
                )
            allow_decision, allow_publisher_order = _check_book_decision_eligibility(
                book_row[0], book_row[1]
            )
            if not allow_decision:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"비활성 도서 (active={book_row[0]} · discontinue_mode={book_row[1]}) 는 의사결정 불가",
                )

            # Cascade (4-stage · 2026-05-14: REBALANCE 1순위 · WH_TO_STORE 2순위 폴백 정정)
            stage_num: Literal[0, 1, 2, 3]
            order_type: str
            source_loc: int | None

            # Stage 0 REBALANCE (1순위 · 매장↔매장) + Stage 1 WH_TO_STORE (2순위 폴백) 는 target=STORE_OFFLINE 일 때만.
            # target 이 WH 본체 / 온라인(virtual) 이면 Stage 2/3 만.
            s_reb = (
                _stage1_source(cur, req.isbn13, target_wh, req.target_location_id, req.qty)
                if target_type == "STORE_OFFLINE"
                else None
            )
            stage2_info: dict | None = None
            if s_reb is not None:
                stage_num, order_type, source_loc = 0, "REBALANCE", s_reb
            else:
                s_wts = (
                    _stage0_source(cur, req.isbn13, target_wh, req.qty)
                    if target_type == "STORE_OFFLINE"
                    else None
                )
                if s_wts is not None:
                    stage_num, order_type, source_loc = 1, "WH_TO_STORE", s_wts
                else:
                    stage2_info = _stage2_source(cur, req.isbn13, target_wh, req.qty)
                    if stage2_info is not None:
                        stage_num, order_type, source_loc = 2, "WH_TRANSFER", stage2_info["location_id"]
                    else:
                        if not allow_publisher_order:
                            raise HTTPException(
                                status_code=status.HTTP_400_BAD_REQUEST,
                                detail=f"재고 소진 모드 도서 (discontinue_mode={book_row[1]}) 는 신규 출판사 발주 불가 · 권역내 재분배·권역간 이동만 가능",
                            )
                        stage_num, order_type, source_loc = 3, "PUBLISHER_ORDER", None

            urgency, rationale = _calc_urgency(cur, req.isbn13, req.target_location_id, req.qty)
            rationale.update({"stage": stage_num, "selected_order_type": order_type, "source_location_id": source_loc})
            if stage2_info is not None:
                # FR-A5.3 권역 이전 근거 — partner WH 의 실제 surplus 계산 내역
                rationale.update({
                    "partner_wh": stage2_info["partner_wh"],
                    "partner_on_hand": stage2_info["partner_on_hand"],
                    "partner_reserved": stage2_info["partner_reserved"],
                    "partner_safety": stage2_info["partner_safety"],
                    "partner_expected_demand_14d": stage2_info["partner_expected_demand_14d"],
                    "partner_surplus": stage2_info["partner_surplus"],
                    "transferable_qty": min(stage2_info["partner_surplus"], req.qty),
                })
            if req.note:
                rationale["note"] = req.note

            # FR-A4.1 EOQ — Stage 3 (PUBLISHER_ORDER) 진입 시 경제적 발주량 산출 후 qty 결정
            # max(EOQ, req.qty) — 사용자 요청 보장 + 출판사 발주 효율 확보
            final_qty = req.qty
            if stage_num == 3:
                annual_demand = _annual_demand_for_book(cur, req.isbn13)
                holding_cost = _holding_cost_for_book(cur, req.isbn13)
                eoq_qty = _calc_eoq(annual_demand, DEFAULT_ORDER_COST, holding_cost)
                final_qty = max(eoq_qty, req.qty)
                rationale.update({
                    "eoq_calc": eoq_qty,
                    "annual_demand_estimate": annual_demand,
                    "holding_cost_per_unit": holding_cost,
                    "order_cost_default": DEFAULT_ORDER_COST,
                    "final_qty": final_qty,
                    "final_qty_source": "EOQ" if eoq_qty >= req.qty else "USER_REQUEST",
                })

            # auto_execute_eligible: FR-A4.7 = Stage 3 (PUBLISHER_ORDER) + URGENT/CRITICAL
            # 07:00 KST intervention-svc CronJob 이 auto_execute_eligible=TRUE row 일괄 자동 승인 + 발주
            auto_exec = _auto_execute_eligible(stage_num, urgency)

            # 도착 예정일 (stage 별 lead time) — UI 가 도착일 별 group 해서 표시
            rationale["expected_arrival_date"] = _expected_arrival(order_type)

            cur.execute(
                """
                INSERT INTO pending_orders
                    (order_id, order_type, isbn13, source_location_id, target_location_id,
                     qty, urgency_level, auto_execute_eligible, forecast_rationale, status,
                     expected_arrival_at)
                VALUES (%s::uuid, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, 'PENDING', %s::date)
                RETURNING created_at
                """,
                (
                    str(order_id), order_type, req.isbn13, source_loc, req.target_location_id,
                    final_qty, urgency, auto_exec, json.dumps(rationale),
                    rationale["expected_arrival_date"],
                ),
                prepare=False,
            )
            created_at = cur.fetchone()[0]

            cur.execute(
                """
                INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, after_state)
                VALUES ('user', %s, 'decision.create', 'pending_orders', %s, %s::jsonb)
                """,
                (ctx.user_id, str(order_id), json.dumps({
                    "order_type": order_type, "isbn13": req.isbn13, "qty": final_qty,
                    "urgency": urgency, "stage": stage_num,
                })),
                prepare=False,
            )
        conn.commit()

    # notification-svc /send 호출 (OrderPending → Redis pub `order.pending`)
    # 시트10 정합: decision-svc 는 Redis 직접 publish 안 함, notification-svc 가 12 events dispatcher.
    try:
        with httpx.Client(timeout=2.0) as c:
            c.post(
                f"{NOTIFICATION_SVC_URL}/notification/send",
                headers={"Authorization": ctx.token},
                json={
                    "event_type": "OrderPending",
                    "severity": "WARNING" if urgency == "URGENT" else ("CRITICAL" if urgency == "CRITICAL" else "INFO"),
                    "recipients": [],
                    "channels": "redis,websocket",
                    "payload_summary": {
                        "order_id": str(order_id),
                        "isbn13": req.isbn13,
                        "qty": final_qty,
                        "urgency_level": urgency,
                        "order_type": order_type,
                        "stage": stage_num,
                    },
                },
            )
    except Exception as e:
        log.warning("notification-svc /send failed (non-fatal): %s", e)

    return DecideResponse(
        order_id=order_id,
        order_type=order_type,
        stage=stage_num,
        source_location_id=source_loc,
        target_location_id=req.target_location_id,
        qty=final_qty,
        urgency_level=urgency,
        auto_execute_eligible=auto_exec,
        status="PENDING",
        rationale=rationale,
        created_at=created_at,
    )


@router.get("/pending-orders", response_model=PendingOrdersResponse)
def list_pending(
    ctx: AuthContext = Depends(require_auth),
    limit: int = Query(default=50, ge=1, le=500),
):
    """PENDING 큐 — role/scope 자동 필터 (2026-05-14 정정).

    - hq-admin: 전체
    - wh-manager + scope_wh_id: source 또는 target wh = scope_wh_id
    - branch-clerk + scope_store_id: target_location_id = scope_store_id

    상세 승인 워크플로우 (PENDING/APPROVED/EXECUTED) 는 intervention-svc /intervention/queue.
    """
    where = ["po.status = 'PENDING'"]
    params: list = []
    scope_clause, scope_params = _plan_scope_clause(ctx)
    if scope_clause:
        where.append(scope_clause)
        params.extend(scope_params)
    params.append(limit)

    sql = f"""
        SELECT po.order_id, po.order_type, po.isbn13, po.source_location_id, po.target_location_id,
               po.qty, po.urgency_level, po.status, po.created_at
          FROM pending_orders po
         WHERE {' AND '.join(where)}
         ORDER BY po.urgency_level DESC, po.created_at ASC
         LIMIT %s
    """
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, params)
        rows = cur.fetchall()

    items = [
        PendingOrder(
            order_id=r[0], order_type=r[1], isbn13=r[2],
            source_location_id=r[3], target_location_id=r[4],
            qty=r[5], urgency_level=r[6], status=r[7], created_at=r[8],
        )
        for r in rows
    ]
    return PendingOrdersResponse(items=items)


@router.post("/decide/batch", response_model=BatchDecideResponse)
def decide_batch(req: BatchDecideRequest, ctx: AuthContext = Depends(require_auth)):
    """일괄 cascade 결정 (사용자 결정 2026-05-13).

    시연 "일괄 발의" 또는 매일 03:30 batch 가 N items 를 한 번에 전송 → backend 가 sequential 처리.
    개별 /decide 를 N 번 호출하던 frontend 패턴의 503 race + 느림 해소.

    각 item 별 transaction 분리 (한 건 실패가 다른 건에 영향 X). 결과 요약만 응답.
    """
    if ctx.role not in ("hq-admin", "wh-manager"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="hq-admin 또는 wh-manager 만 batch 결정 가능")

    counts = {"s0": 0, "s1": 0, "s2": 0, "s3": 0}
    failed = 0
    errors: list[str] = []
    for it in req.items:
        try:
            resp = decide(it, ctx)  # 같은 함수 직접 호출 (각 transaction 분리)
            stage_key = f"s{resp.stage}"
            counts[stage_key] = counts.get(stage_key, 0) + 1
        except HTTPException as e:
            failed += 1
            if len(errors) < 20:  # 너무 많이 누적 방지
                errors.append(f"{it.isbn13}: {e.detail}")
        except Exception as e:
            failed += 1
            if len(errors) < 20:
                errors.append(f"{it.isbn13}: {str(e)[:100]}")

    return BatchDecideResponse(
        total=len(req.items),
        s0=counts["s0"], s1=counts["s1"], s2=counts["s2"], s3=counts["s3"],
        failed=failed, errors=errors,
    )


# =============================================================================
# Daily planner — D+1 forecast 기반 익일 inventory placement
# =============================================================================
# 매일 03:30 KST batch (cron) 가 호출. 1000책 × 14 location 을 한 번에 plan.
# 알고리즘:
#   per isbn:
#     desired[loc]  = (매장: predicted×SAFETY_DAYS / WH: same-wh stores predicted×BUFFER_DAYS) + safety_stock
#     effective[loc] = on_hand - reserved + in_transit_in
#     gap[loc] = desired - effective   (양수=부족, 음수=잉여)
#     Phase A (Stage 1 REBALANCE): 같은 wh 매장 잉여 → 같은 wh 매장 부족 (greedy)
#     Phase B (Stage 2 WH_TRANSFER): WH 본체 잉여 → 다른 wh WH 본체 부족
#     Phase C (Stage 3 PUBLISHER_ORDER): 잔존 부족 (WH 본체 단위로 집계) → 출판사 발주
# =============================================================================

def _build_daily_plan(cur, snapshot_date: date) -> list[dict]:
    """D+1 forecast → optimal placement plan. Returns list of plan dicts.

    forecast 없는 책도 plan 대상 (active 이고 inventory 가 있으면 safety_stock 기준 부족 검사).
    """
    # 1. 전 active 책 list (forecast 있든 없든 — safety_stock 기반 부족도 plan)
    cur.execute("SELECT isbn13 FROM books WHERE active = TRUE")
    isbns = [r[0] for r in cur.fetchall()]
    if not isbns:
        return []

    # 2. forecast for snapshot_date (있는 것만, 나머지는 0 으로 처리)
    cur.execute(
        """
        SELECT isbn13, store_id, predicted_demand
          FROM forecast_cache
         WHERE snapshot_date = %s
           AND isbn13 = ANY(%s)
        """,
        (snapshot_date, isbns),
    )
    forecast: dict[str, dict[int, float]] = {}
    for isbn, store, pred in cur.fetchall():
        forecast.setdefault(isbn, {})[int(store)] = float(pred)

    # 2. locations meta
    cur.execute(
        "SELECT location_id, location_type, wh_id FROM locations "
        "WHERE COALESCE(active::text, 'true') NOT IN ('false', '0')"
    )
    loc_meta: dict[int, dict] = {}
    for loc, ltype, wh in cur.fetchall():
        loc_meta[int(loc)] = {"type": ltype, "wh": int(wh) if wh is not None else None}

    # 3. inventory for these isbns
    cur.execute(
        """
        SELECT isbn13, location_id, on_hand, reserved_qty, COALESCE(safety_stock, 0)
          FROM inventory
         WHERE isbn13 = ANY(%s)
        """,
        (isbns,),
    )
    inventory: dict[str, dict[int, dict]] = {}
    for isbn, loc, oh, res, safety in cur.fetchall():
        inventory.setdefault(isbn, {})[int(loc)] = {
            "on_hand": int(oh or 0),
            "reserved": int(res or 0),
            "safety": int(safety or 0),
        }

    # 4. incoming (이미 발의되어 곧 도착할 row) per (isbn, target_loc)
    # 2026-05-15 v3: 4-step state machine 정합 — APPROVED + IN_TRANSIT + AUTO_EXECUTED
    # PENDING 은 협의 미확정이라 제외 (over-count 회피).
    cur.execute(
        """
        SELECT isbn13, target_location_id, COALESCE(SUM(qty), 0)
          FROM pending_orders
         WHERE status IN ('APPROVED', 'IN_TRANSIT', 'AUTO_EXECUTED')
           AND executed_at IS NULL
           AND target_location_id IS NOT NULL
           AND isbn13 = ANY(%s)
         GROUP BY isbn13, target_location_id
        """,
        (isbns,),
    )
    in_transit: dict[str, dict[int, int]] = {}
    for isbn, tgt, qty in cur.fetchall():
        in_transit.setdefault(isbn, {})[int(tgt)] = int(qty or 0)

    # Pre-compute same-wh store map (for WH desired aggregation)
    wh_to_stores: dict[int, list[int]] = {}
    wh_body: dict[int, int] = {}  # wh_id → WH body location_id
    for loc, m in loc_meta.items():
        if m["wh"] is None:
            continue
        if m["type"] == "STORE_OFFLINE":
            wh_to_stores.setdefault(m["wh"], []).append(loc)
        elif m["type"] == "WH":
            wh_body[m["wh"]] = loc

    plan: list[dict] = []

    for isbn in isbns:
        inv = inventory.get(isbn, {})
        fc = forecast.get(isbn, {})  # forecast 없는 책 = empty dict (predicted=0 폴백)
        # forecast/inventory 모두 없으면 plan 대상 X (sold out 책 → inventory row 가 0 으로라도 있어야)
        if not inv:
            continue

        # Compute gap per location
        gaps: dict[int, dict] = {}
        for loc, meta in loc_meta.items():
            if meta["type"] not in ("STORE_OFFLINE", "WH"):
                continue  # online virtual skip
            i = inv.get(loc, {"on_hand": 0, "reserved": 0, "safety": 0})
            in_in = in_transit.get(isbn, {}).get(loc, 0)
            # v5 2026-05-15 — chained downstream 추정 (매장만 · WH 본체는 직접 incoming).
            #   자기 wh 본체로 향하는 WH_TRANSFER/PUBLISHER 가 도착 시 chained WH_TO_STORE 가
            #   자동 분배되어 결국 매장 incoming 이 됨. 사용자 명시 "DECISION 이 chained 시점 고려".
            chained_in = (
                _estimated_chained_incoming(cur, isbn, loc)
                if meta["type"] == "STORE_OFFLINE" else 0
            )
            effective = i["on_hand"] - i["reserved"] + in_in + chained_in

            # desired 정합: 시드의 inventory.safety_stock 이 이미 안전재고 buffer (5일치) 포함.
            # 중복 가산 방지: max(safety_stock, predicted × DAYS) — 둘 중 큰 쪽 (low badge 기준 동일).
            if meta["type"] == "STORE_OFFLINE":
                pred = fc.get(loc, 0.0)
                desired = max(i["safety"], math.ceil(pred * PLAN_SAFETY_DAYS))
            else:  # WH
                same_wh_stores = wh_to_stores.get(meta["wh"], [])
                wh_pred = sum(fc.get(s, 0.0) for s in same_wh_stores)
                desired = max(i["safety"], math.ceil(wh_pred * PLAN_WH_BUFFER_DAYS))

            gap = desired - effective
            gaps[loc] = {
                "gap": gap, "effective": effective, "desired": desired,
                "type": meta["type"], "wh": meta["wh"],
            }

        # Phase A (2026-05-14 정정 · 1순위): same-wh store-to-store REBALANCE
        # 매장 ↔ 매장 재분배 우선 시도. 안 되면 WH body 폴백 (Phase WB).
        for wh_id, store_list in wh_to_stores.items():
            shorts = sorted(
                [(l, gaps[l]) for l in store_list if l in gaps and gaps[l]["gap"] > 0],
                key=lambda x: -x[1]["gap"],
            )
            surplus = sorted(
                [(l, gaps[l]) for l in store_list if l in gaps and gaps[l]["gap"] < 0],
                key=lambda x: x[1]["gap"],
            )
            si = 0  # short index
            for src_loc, src_g in surplus:
                if si >= len(shorts):
                    break
                avail = -src_g["gap"]  # positive surplus
                while avail > 0 and si < len(shorts):
                    tgt_loc, tgt_g = shorts[si]
                    if tgt_g["gap"] <= 0:
                        si += 1
                        continue
                    take = min(avail, tgt_g["gap"])
                    if take >= PLAN_MIN_ROW_QTY:
                        plan.append({
                            "order_type": "REBALANCE", "isbn": isbn,
                            "src": src_loc, "tgt": tgt_loc, "qty": take, "stage": 0,
                            "rationale": {
                                "phase": "stage0_rebalance",
                                "src_effective": src_g["effective"], "src_desired": src_g["desired"],
                                "tgt_effective": tgt_g["effective"], "tgt_desired": tgt_g["desired"],
                            },
                        })
                    avail -= take
                    tgt_g["gap"] -= take
                    if tgt_g["gap"] <= 0:
                        si += 1
                src_g["gap"] = -avail

        # Phase A' (2026-05-14 정정 · 2순위 폴백): same-wh WH body → STORE (WH_TO_STORE).
        # 매장 재분배 (Phase A) 후에도 매장 부족 잔존 시, 자기 wh 본체 잉여로 보충.
        for wh_id, store_list in wh_to_stores.items():
            wb = wh_body.get(wh_id)
            if wb is None or wb not in gaps:
                continue
            wb_g = gaps[wb]
            if wb_g["gap"] >= 0:
                continue  # wh 본체도 부족 (gap > 0) 이거나 정확히 desired = effective
            wb_avail = -wb_g["gap"]  # positive surplus of wh body
            shorts = sorted(
                [(l, gaps[l]) for l in store_list if l in gaps and gaps[l]["gap"] > 0],
                key=lambda x: -x[1]["gap"],
            )
            for tgt_loc, tgt_g in shorts:
                if wb_avail <= 0:
                    break
                if tgt_g["gap"] <= 0:
                    continue
                take = min(wb_avail, tgt_g["gap"])
                if take >= PLAN_MIN_ROW_QTY:
                    plan.append({
                        "order_type": "WH_TO_STORE", "isbn": isbn,
                        "src": wb, "tgt": tgt_loc, "qty": take, "stage": 1,
                        "rationale": {
                            "phase": "stage1_wh_to_store",
                            "src_effective": wb_g["effective"], "src_desired": wb_g["desired"],
                            "tgt_effective": tgt_g["effective"], "tgt_desired": tgt_g["desired"],
                        },
                    })
                wb_avail -= take
                tgt_g["gap"] -= take
            wb_g["gap"] = -wb_avail

        # Phase B: cross-wh WH_TRANSFER (WH body ↔ WH body)
        wh_short = sorted(
            [(l, g) for l, g in gaps.items() if g["type"] == "WH" and g["gap"] > 0],
            key=lambda x: -x[1]["gap"],
        )
        wh_surplus = sorted(
            [(l, g) for l, g in gaps.items() if g["type"] == "WH" and g["gap"] < 0],
            key=lambda x: x[1]["gap"],
        )
        si = 0
        for src_loc, src_g in wh_surplus:
            if si >= len(wh_short):
                break
            avail = -src_g["gap"]
            while avail > 0 and si < len(wh_short):
                tgt_loc, tgt_g = wh_short[si]
                if loc_meta[src_loc]["wh"] == loc_meta[tgt_loc]["wh"]:
                    si += 1
                    continue
                if tgt_g["gap"] <= 0:
                    si += 1
                    continue
                take = min(avail, tgt_g["gap"])
                if take >= PLAN_MIN_ROW_QTY:
                    plan.append({
                        "order_type": "WH_TRANSFER", "isbn": isbn,
                        "src": src_loc, "tgt": tgt_loc, "qty": take, "stage": 2,
                        "rationale": {
                            "phase": "stage2_wh_transfer",
                            "src_effective": src_g["effective"], "src_desired": src_g["desired"],
                            "tgt_effective": tgt_g["effective"], "tgt_desired": tgt_g["desired"],
                        },
                    })
                avail -= take
                tgt_g["gap"] -= take
                if tgt_g["gap"] <= 0:
                    si += 1
            src_g["gap"] = -avail

        # Phase C: PUBLISHER_ORDER — residual per wh (aggregate store shortage to WH body)
        for wh_id, store_list in wh_to_stores.items():
            residual = 0
            for l in store_list:
                g = gaps.get(l)
                if g and g["gap"] > 0:
                    residual += g["gap"]
            # WH body residual
            wb = wh_body.get(wh_id)
            if wb is not None and wb in gaps and gaps[wb]["gap"] > 0:
                residual += gaps[wb]["gap"]
            if residual < PLAN_MIN_ROW_QTY or wb is None:
                continue
            plan.append({
                "order_type": "PUBLISHER_ORDER", "isbn": isbn,
                "src": None, "tgt": wb, "qty": max(residual, MIN_EOQ), "stage": 3,
                "rationale": {
                    "phase": "stage3_publisher",
                    "residual_aggregate": residual,
                    "wh_id": wh_id,
                },
            })

    return plan


@router.post("/plan-daily")
def plan_daily(
    body: dict = Body(default={}),
    ctx: AuthContext = Depends(require_auth),
):
    """D+1 forecast 기반 일괄 익일 배치 발의.

    매일 03:30 KST cron 또는 HQ 가 수동 trigger. 1 query → in-memory plan → bulk INSERT.

    Body (optional): {"snapshot_date": "YYYY-MM-DD"}  default = tomorrow KST.
    Response: {snapshot_date, rows_created, by_stage{1,2,3}, isbns_planned}
    """
    if ctx.role not in ("hq-admin", "wh-manager"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="hq-admin/wh-manager only")

    snap = body.get("snapshot_date")
    if snap:
        try:
            snapshot_date = date.fromisoformat(snap)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"snapshot_date 형식 오류: {snap}")
    else:
        # 2026-05-15 v5 사용자 정정: snapshot_date default = today (D+0).
        # "수요예측 D+0 새벽 → 9시 이내 승인 끝 → 그 날 안에 모든 계획 실행".
        # REBALANCE LEAD_DAYS=0 → 발의 당일 매장 도착이 자연 흐름.
        snapshot_date = datetime.utcnow().date()

    with db_conn() as conn:
        with conn.cursor() as cur:
            # 멱등성: 같은 snapshot_date 의 기존 plan row 정리 (재호출 안전)
            # — rationale.plan_snapshot_date 일치 + status PENDING + executed_at NULL 만 delete
            cur.execute(
                """
                DELETE FROM order_approvals
                 WHERE order_id IN (
                       SELECT order_id FROM pending_orders
                        WHERE status = 'PENDING'
                          AND executed_at IS NULL
                          AND forecast_rationale->>'plan_snapshot_date' = %s
                 )
                """,
                (str(snapshot_date),),
            )
            cur.execute(
                """
                DELETE FROM pending_orders
                 WHERE status = 'PENDING'
                   AND executed_at IS NULL
                   AND forecast_rationale->>'plan_snapshot_date' = %s
                """,
                (str(snapshot_date),),
            )
            cleared = cur.rowcount

            plan = _build_daily_plan(cur, snapshot_date)
            if not plan:
                conn.commit()
                return {
                    "snapshot_date": str(snapshot_date),
                    "rows_created": 0, "by_stage": {}, "isbns_planned": 0,
                    "cleared": cleared,
                }

            # Urgency: Stage 3 (PUBLISHER) URGENT + auto_exec, 나머지 NORMAL
            insert_rows = []
            audit_rows = []
            for p in plan:
                order_id = str(uuid4())
                urgency = "URGENT" if p["stage"] == 3 else "NORMAL"
                auto_exec = (p["stage"] == 3 and urgency in ("URGENT", "CRITICAL"))
                rationale = {
                    **p["rationale"],
                    "stage": p["stage"],
                    "selected_order_type": p["order_type"],
                    "source_location_id": p["src"],
                    "plan_snapshot_date": str(snapshot_date),
                    # 도착 예정일 (snapshot_date + stage 별 lead time) — UI grouping
                    "expected_arrival_date": _expected_arrival(p["order_type"], snapshot_date),
                }
                insert_rows.append((
                    order_id, p["order_type"], p["isbn"], p["src"], p["tgt"],
                    p["qty"], urgency, auto_exec, json.dumps(rationale),
                    rationale["expected_arrival_date"],
                ))
                audit_rows.append((
                    ctx.user_id, order_id, json.dumps({
                        "order_type": p["order_type"], "isbn13": p["isbn"], "qty": p["qty"],
                        "stage": p["stage"], "source": "plan-daily",
                    }),
                ))

            cur.executemany(
                """
                INSERT INTO pending_orders
                    (order_id, order_type, isbn13, source_location_id, target_location_id,
                     qty, urgency_level, auto_execute_eligible, forecast_rationale, status,
                     expected_arrival_at)
                VALUES (%s::uuid, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, 'PENDING', %s::date)
                """,
                insert_rows,
            )
            cur.executemany(
                """
                INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, after_state)
                VALUES ('system', %s, 'decision.plan_daily', 'pending_orders', %s, %s::jsonb)
                """,
                audit_rows,
            )
        conn.commit()

    by_stage: dict[int, int] = {0: 0, 1: 0, 2: 0, 3: 0}
    isbns_set: set[str] = set()
    for p in plan:
        by_stage[p["stage"]] = by_stage.get(p["stage"], 0) + 1
        isbns_set.add(p["isbn"])

    # 승인 요청 건이 1건 이상 생성된 경우에만 ForecastCompleted 이메일 발송
    if len(plan) > 0:
        try:
            with httpx.Client(timeout=settings.notification_svc_timeout) as c:
                c.post(
                    f"{settings.notification_svc_url.rstrip('/')}/notification/send",
                    json={
                        "event_type": "ForecastCompleted",
                        "severity": "INFO",
                        "payload_summary": {
                            "snapshot_date": str(snapshot_date),
                            "rows_created": len(plan),
                            "isbns_planned": len(isbns_set),
                            "by_stage": by_stage,
                        },
                    },
                    headers={"Authorization": ctx.token},
                )
        except Exception as e:
            log.warning("ForecastCompleted notification failed: %s", e)

    return {
        "snapshot_date": str(snapshot_date),
        "rows_created": len(plan),
        "by_stage": by_stage,
        "isbns_planned": len(isbns_set),
        "cleared": cleared,
    }


# =============================================================================
# Final Plan 조회 — /plan-daily 발의 결과 (4×4 matrix + list)
# =============================================================================
# 시연 시 사용자가 plan_snapshot_date 별 처리 결과 (PENDING/APPROVED/EXECUTED/REJECTED/AUTO_EXECUTED)
# × stage (REBALANCE/WH_TRANSFER/PUBLISHER_ORDER) 매트릭스 + 상세 list 를 한 번에 확인.
# role/scope 자동 필터 — intervention-svc /queue 와 동일 규약.
# =============================================================================

def _plan_scope_clause(ctx: AuthContext) -> tuple[str, list]:
    """role/scope → SQL where 절 + params. 빈 절이면 ("", []) 반환."""
    if ctx.role == "wh-manager" and ctx.scope_wh_id is not None:
        return (
            "(EXISTS (SELECT 1 FROM locations sl WHERE sl.location_id = po.source_location_id AND sl.wh_id = %s)"
            " OR EXISTS (SELECT 1 FROM locations tl WHERE tl.location_id = po.target_location_id AND tl.wh_id = %s))",
            [ctx.scope_wh_id, ctx.scope_wh_id],
        )
    if ctx.role == "branch-clerk" and ctx.scope_store_id is not None:
        return ("po.target_location_id = %s", [ctx.scope_store_id])
    return ("", [])


@router.get("/plan-daily/{snapshot_date}/summary")
def plan_daily_summary(snapshot_date: str, ctx: AuthContext = Depends(require_auth)):
    """plan_snapshot_date 별 by_stage × by_status 매트릭스 + 총합.

    role/scope 자동 필터:
      - hq-admin: 전체
      - wh-manager + scope_wh_id: source 또는 target wh = scope_wh_id
      - branch-clerk + scope_store_id: target_location_id = scope_store_id

    Response:
      {snapshot_date, by_stage_status: [{order_type, status, cnt, qty_total}],
       totals: {total_orders, total_qty, stages: {...}, statuses: {...}}}
    """
    where = ["forecast_rationale->>'plan_snapshot_date' = %s"]
    params: list = [snapshot_date]
    scope_clause, scope_params = _plan_scope_clause(ctx)
    if scope_clause:
        where.append(scope_clause)
        params.extend(scope_params)

    sql = f"""
        SELECT po.order_type, po.status, COUNT(*)::int AS cnt,
               COALESCE(SUM(po.qty), 0)::int AS qty_total
          FROM pending_orders po
         WHERE {' AND '.join(where)}
         GROUP BY po.order_type, po.status
    """
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, params)
        rows = cur.fetchall()

    by_stage_status = [
        {"order_type": r[0], "status": r[1], "cnt": int(r[2]), "qty_total": int(r[3])}
        for r in rows
    ]
    total_orders = sum(int(r[2]) for r in rows)
    total_qty = sum(int(r[3]) for r in rows)
    stages: dict[str, int] = {"WH_TO_STORE": 0, "REBALANCE": 0, "WH_TRANSFER": 0, "PUBLISHER_ORDER": 0}
    statuses: dict[str, int] = {
        "PENDING": 0, "APPROVED": 0, "EXECUTED": 0, "REJECTED": 0, "AUTO_EXECUTED": 0,
    }
    for r in rows:
        stages[r[0]] = stages.get(r[0], 0) + int(r[2])
        statuses[r[1]] = statuses.get(r[1], 0) + int(r[2])

    return {
        "snapshot_date": snapshot_date,
        "by_stage_status": by_stage_status,
        "totals": {
            "total_orders": total_orders,
            "total_qty": total_qty,
            "stages": stages,
            "statuses": statuses,
        },
    }


@router.get("/plan-daily/{snapshot_date}/items")
def plan_daily_items(
    snapshot_date: str,
    status: str | None = Query(default=None, description="필터: PENDING/APPROVED/EXECUTED/REJECTED/AUTO_EXECUTED"),
    order_type: str | None = Query(default=None, description="필터: REBALANCE/WH_TRANSFER/PUBLISHER_ORDER"),
    q: str | None = Query(default=None, description="검색: isbn13 / 책 제목 / location 이름 ILIKE"),
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
    ctx: AuthContext = Depends(require_auth),
):
    """plan items 상세 list. role/scope + status/order_type/검색 필터 + pagination.

    JOIN books (title) · locations (source/target 이름) 포함.

    Response:
      {total, items: [{order_id, isbn13, title, order_type, status,
                       source_location_id, source_location_name,
                       target_location_id, target_location_name,
                       qty, approved_at, executed_at, reject_reason, urgency_level,
                       created_at}]}
    """
    where = ["po.forecast_rationale->>'plan_snapshot_date' = %s"]
    params: list = [snapshot_date]

    scope_clause, scope_params = _plan_scope_clause(ctx)
    if scope_clause:
        where.append(scope_clause)
        params.extend(scope_params)

    if status:
        where.append("po.status = %s")
        params.append(status)
    if order_type:
        where.append("po.order_type = %s")
        params.append(order_type)
    if q:
        where.append(
            "(po.isbn13 ILIKE %s OR b.title ILIKE %s OR sl.name ILIKE %s OR tl.name ILIKE %s)"
        )
        like = f"%{q}%"
        params.extend([like, like, like, like])

    where_sql = " AND ".join(where)
    base_from = (
        " FROM pending_orders po "
        " LEFT JOIN books b      ON b.isbn13 = po.isbn13 "
        " LEFT JOIN locations sl ON sl.location_id = po.source_location_id "
        " LEFT JOIN locations tl ON tl.location_id = po.target_location_id "
    )

    list_sql = f"""
        SELECT po.order_id, po.isbn13, b.title,
               po.order_type, po.status,
               po.source_location_id, sl.name,
               po.target_location_id, tl.name,
               po.qty, po.urgency_level,
               po.approved_at, po.executed_at, po.reject_reason,
               po.created_at,
               po.forecast_rationale->>'expected_arrival_date' AS expected_arrival_date
          {base_from}
         WHERE {where_sql}
         ORDER BY po.created_at DESC
         LIMIT %s OFFSET %s
    """
    count_sql = f"SELECT COUNT(*)::int {base_from} WHERE {where_sql}"

    list_params = params + [limit, offset]
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(count_sql, params)
        total = int(cur.fetchone()[0])
        cur.execute(list_sql, list_params)
        rows = cur.fetchall()

    items = [
        {
            "order_id": str(r[0]),
            "isbn13": r[1],
            "title": r[2],
            "order_type": r[3],
            "status": r[4],
            "source_location_id": r[5],
            "source_location_name": r[6],
            "target_location_id": r[7],
            "target_location_name": r[8],
            "qty": int(r[9] or 0),
            "urgency_level": r[10],
            "approved_at": r[11].isoformat() if r[11] else None,
            "executed_at": r[12].isoformat() if r[12] else None,
            "reject_reason": r[13],
            "created_at": r[14].isoformat() if r[14] else None,
            # forecast_rationale->>'expected_arrival_date' (LEAD_DAYS 적용 결과)
            "expected_arrival_date": r[15] if len(r) > 15 else None,
        }
        for r in rows
    ]
    return {"total": total, "items": items}
