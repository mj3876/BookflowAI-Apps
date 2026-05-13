"""decision routes - V6.2 3-stage cascade 자동 결정.

POST /decide:
  Input: isbn13 · target_location_id · qty
  Algorithm:
    Stage 1 (REBALANCE): target wh 내 다른 location 중 가용 ≥ qty 있는가?
    Stage 2 (WH_TRANSFER): 다른 wh 의 warehouse location 가용 ≥ qty?
    Stage 3 (PUBLISHER_ORDER): 위 둘 다 불가 → 외부 발주 (HQ FINAL 승인 필요)
  Auto-derive:
    - urgency_level: stock_days_remaining (forecast_cache 기반) < 1 → URGENT, < 0.5 → CRITICAL
    - auto_execute_eligible: Stage 1 + URGENT/CRITICAL → True

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
) -> int:
    """FR-A5.1 effective available = on_hand - reserved - incoming - max(0, expected_demand)

    incoming_qty: pending_orders APPROVED · target=self · executed_at IS NULL 의 합 (이미 다른 발주에 잡힌 입고)
    expected_demand: forecast_cache 의 향후 14일 일별 predicted_demand 합

    None 입력은 0 으로 처리 (DB NULL 안전).
    expected_demand 가 음수면 0 으로 clamp (이상치/NULL 인 forecast 가 가용량을 늘리는 효과 차단).
    """
    on_hand = int(on_hand or 0)
    reserved = int(reserved_qty or 0)
    incoming = int(incoming_qty or 0)
    demand = max(0, int(expected_demand or 0))
    return on_hand - reserved - incoming - demand


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
                       AND po.status = 'APPROVED'
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

            # Cascade
            stage_num: Literal[1, 2, 3]
            order_type: str
            source_loc: int | None

            # Stage 1 (REBALANCE) 은 매장↔매장 만. target 이 WH 본체 / 온라인(virtual) 이면 스킵.
            s1 = (
                _stage1_source(cur, req.isbn13, target_wh, req.target_location_id, req.qty)
                if target_type == "STORE_OFFLINE"
                else None
            )
            stage2_info: dict | None = None
            if s1 is not None:
                stage_num, order_type, source_loc = 1, "REBALANCE", s1
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

            cur.execute(
                """
                INSERT INTO pending_orders
                    (order_id, order_type, isbn13, source_location_id, target_location_id,
                     qty, urgency_level, auto_execute_eligible, forecast_rationale, status)
                VALUES (%s::uuid, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, 'PENDING')
                RETURNING created_at
                """,
                (
                    str(order_id), order_type, req.isbn13, source_loc, req.target_location_id,
                    final_qty, urgency, auto_exec, json.dumps(rationale),
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
    _: AuthContext = Depends(require_auth),
    limit: int = Query(default=50, ge=1, le=500),
):
    """PENDING 큐 (raw · role 필터 없음). 권한 분리된 큐는 intervention-svc /intervention/queue 사용."""
    sql = """
        SELECT order_id, order_type, isbn13, source_location_id, target_location_id,
               qty, urgency_level, status, created_at
          FROM pending_orders
         WHERE status = 'PENDING'
         ORDER BY urgency_level DESC, created_at ASC
         LIMIT %s
    """
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, (limit,))
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

    counts = {"s1": 0, "s2": 0, "s3": 0}
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
        s1=counts["s1"], s2=counts["s2"], s3=counts["s3"],
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
    """D+1 forecast → optimal placement plan. Returns list of plan dicts."""
    # 1. forecasts for snapshot_date (active books only)
    cur.execute(
        """
        SELECT fc.isbn13, fc.store_id, fc.predicted_demand
          FROM forecast_cache fc
          JOIN books b ON b.isbn13 = fc.isbn13
         WHERE fc.snapshot_date = %s
           AND b.active = TRUE
        """,
        (snapshot_date,),
    )
    fc_rows = cur.fetchall()
    forecast: dict[str, dict[int, float]] = {}
    for isbn, store, pred in fc_rows:
        forecast.setdefault(isbn, {})[int(store)] = float(pred)

    if not forecast:
        return []

    isbns = list(forecast.keys())

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

    # 4. in-transit (already PENDING/APPROVED, not executed) per (isbn, target_loc)
    cur.execute(
        """
        SELECT isbn13, target_location_id, COALESCE(SUM(qty), 0)
          FROM pending_orders
         WHERE status IN ('PENDING', 'APPROVED', 'AUTO_EXECUTED')
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
        fc = forecast[isbn]

        # Compute gap per location
        gaps: dict[int, dict] = {}
        for loc, meta in loc_meta.items():
            if meta["type"] not in ("STORE_OFFLINE", "WH"):
                continue  # online virtual skip
            i = inv.get(loc, {"on_hand": 0, "reserved": 0, "safety": 0})
            in_in = in_transit.get(isbn, {}).get(loc, 0)
            effective = i["on_hand"] - i["reserved"] + in_in

            if meta["type"] == "STORE_OFFLINE":
                pred = fc.get(loc, 0.0)
                desired = math.ceil(pred * PLAN_SAFETY_DAYS) + i["safety"]
            else:  # WH
                same_wh_stores = wh_to_stores.get(meta["wh"], [])
                wh_pred = sum(fc.get(s, 0.0) for s in same_wh_stores)
                desired = math.ceil(wh_pred * PLAN_WH_BUFFER_DAYS) + i["safety"]

            gap = desired - effective
            gaps[loc] = {
                "gap": gap, "effective": effective, "desired": desired,
                "type": meta["type"], "wh": meta["wh"],
            }

        # Phase A: same-wh store-to-store REBALANCE
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
                            "src": src_loc, "tgt": tgt_loc, "qty": take, "stage": 1,
                            "rationale": {
                                "phase": "stage1_rebalance",
                                "src_effective": src_g["effective"], "src_desired": src_g["desired"],
                                "tgt_effective": tgt_g["effective"], "tgt_desired": tgt_g["desired"],
                            },
                        })
                    avail -= take
                    tgt_g["gap"] -= take
                    if tgt_g["gap"] <= 0:
                        si += 1
                src_g["gap"] = -avail

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
        snapshot_date = datetime.utcnow().date() + timedelta(days=1)

    with db_conn() as conn:
        with conn.cursor() as cur:
            plan = _build_daily_plan(cur, snapshot_date)
            if not plan:
                return {"snapshot_date": str(snapshot_date), "rows_created": 0, "by_stage": {}, "isbns_planned": 0}

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
                }
                insert_rows.append((
                    order_id, p["order_type"], p["isbn"], p["src"], p["tgt"],
                    p["qty"], urgency, auto_exec, json.dumps(rationale),
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
                     qty, urgency_level, auto_execute_eligible, forecast_rationale, status)
                VALUES (%s::uuid, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, 'PENDING')
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

    by_stage: dict[int, int] = {1: 0, 2: 0, 3: 0}
    isbns_set: set[str] = set()
    for p in plan:
        by_stage[p["stage"]] = by_stage.get(p["stage"], 0) + 1
        isbns_set.add(p["isbn"])

    return {
        "snapshot_date": str(snapshot_date),
        "rows_created": len(plan),
        "by_stage": by_stage,
        "isbns_planned": len(isbns_set),
    }
