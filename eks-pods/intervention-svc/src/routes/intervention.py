"""intervention routes - V6.2 4-stage decision authority enforcement (2026-05-14 Stage 0 추가).

Stage / order_type / approval_side 행렬 (시트10 + 시트04 12 events · 2026-05-14 REBALANCE 양측 협의 + WH_TO_STORE 신규):

| Stage | order_type        | approval_side    | 권한                                                      |
|-------|-------------------|------------------|---------------------------------------------------------|
| 0     | WH_TO_STORE       | SOURCE / TARGET  | SOURCE: 자기 wh wh-manager · TARGET: 자기 매장 branch-clerk · hq-admin escalation |
| 1     | REBALANCE         | SOURCE / TARGET  | 해당 측 매장/창고 (양측 모두 승인 시 APPROVED)                   |
| 2     | WH_TRANSFER       | SOURCE / TARGET  | wh-manager (SOURCE 면 source location 의 wh, 동일)           |
| 3     | PUBLISHER_ORDER   | FINAL only       | hq-admin / 자기 권역 wh-manager                              |

Stage 0/1/2 양쪽 (SOURCE+TARGET) 모두 APPROVED → status=APPROVED 자동 전환.
hq-admin 은 모든 stage 의 FINAL/SOURCE/TARGET 권한 가짐 (escalation).

승인/거절 후 notification-svc /notification/send 호출 (시트04 12 events 정합):
  - approve → OrderApproved
  - reject  → OrderRejected
  - returns/approve → ReturnPending (승인 시점에 알림)
  - new-book/approve → NewBookRequest (승인 시점에 알림)
"""
import json
import logging
import os
from datetime import datetime
from uuid import UUID, uuid4

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException, Query, status

from ..auth import AuthContext, require_auth
from ..db import db_conn, redis_client
from ..models import (
    ApprovalResponse,
    ApproveRequest,
    PendingOrderEditRequest,
    PendingOrderEditResponse,
    QueueItem,
    QueueResponse,
    RejectRequest,
    ReturnApproveRequest,
    ReturnApproveResponse,
    ReturnRejectRequest,
    ReturnRejectResponse,
    ReturnRequestRequest,
    ReturnRequestResponse,
)

log = logging.getLogger(__name__)
router = APIRouter(prefix="/intervention", tags=["intervention"])

NOTIFICATION_SVC_URL = os.environ.get(
    "INTERVENTION_NOTIFICATION_SVC_URL",
    "http://notification-svc.bookflow.svc.cluster.local",
)

INVENTORY_SVC_URL = os.environ.get(
    "INTERVENTION_INVENTORY_SVC_URL",
    "http://inventory-svc.bookflow.svc.cluster.local",
)


# Logic Apps 발송 대상 event_type (Notion 알람 명세 2026-05-13).
# 그 외 (OrderApproved/OrderRejected/OrderPending/ReturnPending 등) 는 logic-apps 제외 → spam 방지 · digest 만.
_LOGIC_APPS_EVENTS = {
    "AutoExecutedUrgent", "DailyPlanFinalized", "SpikeUrgent",
    "ApprovalDelayed", "InboundRejected", "NewBookRequest",
    "LambdaAlarm", "DeploymentRollback",
    # 2026-05-14: 양측 협의 최종 거부 (APPROVED → REJECTED) 알림 — 재고 복원 인지
    "OrderRejectedAfterApproval",
}


def _channels_for(event_type: str, severity: str) -> str:
    """severity 별 channel 자동 결정 — Logic Apps spam 방지."""
    if event_type in _LOGIC_APPS_EVENTS:
        if severity == "CRITICAL":
            return "redis,websocket,logic-apps,sms"
        return "websocket,logic-apps"
    # 일반 OrderApproved/OrderRejected/OrderPending/ReturnPending 등 → digest 만
    return "redis,websocket"


def _notify(token: str, event_type: str, severity: str, payload: dict, correlation_id: str | None = None) -> None:
    """notification-svc /send 호출 (실패 비치명 · log only)."""
    body = {
        "event_type": event_type,
        "severity": severity,
        "recipients": [],
        "channels": _channels_for(event_type, severity),
        "payload_summary": payload,
    }
    if correlation_id:
        body["correlation_id"] = correlation_id
    try:
        with httpx.Client(timeout=2.0) as c:
            c.post(
                f"{NOTIFICATION_SVC_URL}/notification/send",
                headers={"Authorization": token},
                json=body,
            )
    except Exception as e:
        log.warning("notification-svc /send (%s) failed (non-fatal): %s", event_type, e)



def _check_and_notify_plan_finalized(token: str) -> None:
    """오늘 PENDING=0 이면 DailyPlanFinalized 1회 발송 (Redis 플래그로 중복 방지)."""
    from datetime import date
    today = date.today().isoformat()
    flag_key = f"daily_plan_finalized:{today}"
    try:
        rc = redis_client()
        if rc.exists(flag_key):
            return
        with db_conn() as conn, conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM pending_orders WHERE status='PENDING'")
            if cur.fetchone()[0] > 0:
                return
            cur.execute(
                """
                SELECT
                    COUNT(*) FILTER (WHERE status IN ('APPROVED','EXECUTED','REJECTED')),
                    COUNT(*) FILTER (WHERE status IN ('APPROVED','EXECUTED')),
                    COUNT(*) FILTER (WHERE status = 'REJECTED'),
                    COUNT(*) FILTER (WHERE auto_execute_eligible AND status IN ('APPROVED','EXECUTED'))
                FROM pending_orders WHERE created_at::date = %s
                """,
                (today,),
            )
            total, approved, rejected, auto = cur.fetchone()
        rc.set(flag_key, "1", ex=86400)
    except Exception as e:
        log.warning("_check_and_notify_plan_finalized error: %s", e)
        return
    _notify(token, "DailyPlanFinalized", severity="INFO", payload={
        "today": today,
        "total": total,
        "approved": approved,
        "rejected": rejected,
        "auto": auto,
        "s1": 0, "s2": 0, "s3": 0,
    })


def _location_wh(cur, location_id: int | None) -> int | None:
    """location_id → wh_id JOIN. None 입력 시 None (PUBLISHER_ORDER source 등)."""
    if location_id is None:
        return None
    cur.execute("SELECT wh_id FROM locations WHERE location_id = %s", (location_id,))
    row = cur.fetchone()
    return row[0] if row else None


# PR-B (2026-05-15) 4-step state machine v2 정합:
# Option B 잔존 _adjust_source_inventory helper 제거.
# inventory 변동은 inventory-svc /adjust HTTP 호출로 단일화 (state_machine.py).
# APPROVED 시 변동 없음. /intervention/orders/{id}/dispatch 호출 시에만 source -qty.


def _validate_authority(cur, ctx: AuthContext, order_id: str, side: str) -> tuple[str, int | None, int | None]:
    """승인 권한 검증.

    Returns (order_type, source_wh, target_wh) for valid case. Raises 403 on violation.

    Rules (2026-05-14 REBALANCE 양측 협의 정정 + Stage 0 WH_TO_STORE 신규):
    - WH_TO_STORE : approval_side in ('SOURCE','TARGET') · SOURCE=wh-manager(source_wh) / TARGET=branch-clerk(target_loc) · hq-admin escalation
    - REBALANCE   : approval_side in ('SOURCE','TARGET') · 해당 측 매장/창고 · 양측 모두 승인 시 APPROVED
    - WH_TRANSFER : approval_side in ('SOURCE','TARGET') · approver wh == 해당 side 의 wh
    - PUBLISHER_ORDER: approval_side='FINAL' only · hq-admin 또는 자기 권역 wh-manager
    - hq-admin escalation: 어느 stage 든 가능 (override)
    """
    cur.execute(
        "SELECT order_type, source_location_id, target_location_id FROM pending_orders WHERE order_id = %s",
        (order_id,),
    )
    row = cur.fetchone()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="order not found")
    order_type, source_loc, target_loc = row
    source_wh = _location_wh(cur, source_loc)
    target_wh = _location_wh(cur, target_loc)

    if order_type == "WH_TO_STORE":
        # Stage 0: 자기 wh 본체 → 자기 권역 매장. 양측 협의 (REBALANCE 와 동일 SOURCE/TARGET).
        # SOURCE 승인자: wh-manager (source_wh == scope_wh_id)
        # TARGET 승인자: branch-clerk (target_loc == scope_store_id)
        # hq-admin escalation: 양측 모두 가능.
        if side not in ("SOURCE", "TARGET"):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                                detail="WH_TO_STORE 는 approval_side in ('SOURCE','TARGET') 만 허용 (양측 협의)")
        if ctx.role == "hq-admin":
            return order_type, source_wh, target_wh
        if side == "SOURCE":
            # source 측: wh-manager 자기 wh
            if ctx.role != "wh-manager" or ctx.scope_wh_id is None:
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                                    detail="WH_TO_STORE SOURCE 는 wh-manager 또는 hq-admin 만 승인 가능")
            if ctx.scope_wh_id != source_wh:
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                                    detail=f"SOURCE 권한 없음 (scope wh_id={ctx.scope_wh_id} · source_wh={source_wh})")
        else:  # TARGET
            # target 측: branch-clerk 자기 매장
            if ctx.role != "branch-clerk" or ctx.scope_store_id is None:
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                                    detail="WH_TO_STORE TARGET 은 branch-clerk 또는 hq-admin 만 승인 가능")
            if ctx.scope_store_id != target_loc:
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                                    detail=f"TARGET 권한 없음 (scope_store_id={ctx.scope_store_id} · target_loc={target_loc})")

    elif order_type == "REBALANCE":
        # 2026-05-14: REBALANCE 도 WH_TRANSFER 와 동일하게 양측 협의 (SOURCE/TARGET 둘 다 승인)
        if side not in ("SOURCE", "TARGET"):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                                detail="REBALANCE 는 approval_side in ('SOURCE','TARGET') 만 허용 (양측 협의)")
        if ctx.role == "hq-admin":
            return order_type, source_wh, target_wh
        my_side_loc = source_loc if side == "SOURCE" else target_loc
        my_side_wh = source_wh if side == "SOURCE" else target_wh
        # FR-A6.6 매장 직원 — 자기 매장 측 (SOURCE 면 source_loc / TARGET 면 target_loc) 만 승인
        if ctx.role == "branch-clerk":
            if ctx.scope_store_id is None:
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                                    detail="branch-clerk scope_store_id 부재 (인증 토큰 손상)")
            if ctx.scope_store_id != my_side_loc:
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                                    detail=f"{side} 권한 없음 (scope_store_id={ctx.scope_store_id} · {side}_loc={my_side_loc})")
            return order_type, source_wh, target_wh
        if ctx.role != "wh-manager" or ctx.scope_wh_id is None:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                                detail="REBALANCE 는 wh-manager · branch-clerk · hq-admin 만 승인 가능")
        if ctx.scope_wh_id != my_side_wh:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                                detail=f"{side} 권한 없음 (scope wh_id={ctx.scope_wh_id} · {side}_wh={my_side_wh})")

    elif order_type == "WH_TRANSFER":
        if side not in ("SOURCE", "TARGET"):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                                detail="WH_TRANSFER 는 approval_side in ('SOURCE','TARGET') 만 허용 (양쪽 승인 필요)")
        if ctx.role == "hq-admin":
            return order_type, source_wh, target_wh
        if ctx.role != "wh-manager" or ctx.scope_wh_id is None:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                                detail="WH_TRANSFER 는 wh-manager 또는 hq-admin 만 승인 가능")
        my_side_wh = source_wh if side == "SOURCE" else target_wh
        if ctx.scope_wh_id != my_side_wh:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                                detail=f"{side} 사이드 권한 없음 (scope wh_id={ctx.scope_wh_id} · {side} wh_id={my_side_wh})")

    elif order_type == "PUBLISHER_ORDER":
        # 사용자 결정 2026-05-03: 물류센터가 발주 주체. wh-manager 자기 권역 OK.
        if side != "FINAL":
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                                detail="PUBLISHER_ORDER 는 approval_side='FINAL' 만 허용")
        if ctx.role == "hq-admin":
            return order_type, source_wh, target_wh
        if ctx.role == "wh-manager" and ctx.scope_wh_id is not None:
            if ctx.scope_wh_id == target_wh:
                return order_type, source_wh, target_wh
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                                detail=f"PUBLISHER_ORDER 자기 권역만 승인 가능 (scope_wh_id={ctx.scope_wh_id} · target_wh={target_wh})")
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                            detail="PUBLISHER_ORDER 는 hq-admin 또는 자기 권역 wh-manager 만 승인 가능")

    else:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail=f"unknown order_type: {order_type}")

    return order_type, source_wh, target_wh


@router.get("/grouped")
def grouped(
    ctx: AuthContext = Depends(require_auth),
    date: str | None = Query(default=None, description="YYYY-MM-DD (default = today KST)"),
):
    """오늘 (또는 지정 날짜) 의 batch 처리 현황 + 사용자 검토 필요 건수.

    role-scope 자동 적용:
      - hq-admin: 전사
      - wh-manager: 자기 권역 (source 또는 target 매장이 자기 wh)
      - branch-clerk: 자기 매장 (source 또는 target)

    응답:
      - auto_executed_at_07: 오늘 07:00 batch 가 자동 승인한 건수
      - manual_review: 사용자가 처리해야 할 PENDING 건수
      - auto_reject_at_18_pending: 18:00 batch 가 거절할 예정 (NORMAL · D-1 이전)
      - by_type: order_type 별 PENDING 분포
      - items: PENDING list (사용자가 처리할 것 우선 정렬)
    """
    from datetime import datetime as _dt, timezone, timedelta
    KST = timezone(timedelta(hours=9))
    target_date = date or _dt.now(KST).date().isoformat()

    # role-scope WHERE
    scope_clauses = []
    scope_params: list = []
    if ctx.role == "wh-manager" and ctx.scope_wh_id is not None:
        scope_clauses.append(
            "(EXISTS (SELECT 1 FROM locations sl WHERE sl.location_id = po.source_location_id AND sl.wh_id = %s)"
            " OR EXISTS (SELECT 1 FROM locations tl WHERE tl.location_id = po.target_location_id AND tl.wh_id = %s))"
        )
        scope_params.extend([ctx.scope_wh_id, ctx.scope_wh_id])
    elif ctx.role == "branch-clerk" and ctx.scope_store_id is not None:
        scope_clauses.append(
            "(po.source_location_id = %s OR po.target_location_id = %s)"
        )
        scope_params.extend([ctx.scope_store_id, ctx.scope_store_id])

    scope_sql = (" AND " + " AND ".join(scope_clauses)) if scope_clauses else ""

    with db_conn() as conn, conn.cursor() as cur:
        # 1. 07:00 batch 가 오늘 자동 승인한 건수 (URGENT/CRITICAL + auto_execute_eligible + approved_at::date = target)
        cur.execute(
            f"""
            SELECT COUNT(*) FROM pending_orders po
            WHERE po.status = 'APPROVED' AND po.urgency_level IN ('URGENT','CRITICAL')
              AND po.auto_execute_eligible = TRUE AND po.approved_at::date = %s
              {scope_sql}
            """,
            [target_date] + scope_params,
        )
        auto_executed = cur.fetchone()[0]

        # 2. 사용자가 처리할 PENDING (시점 무관 · scope 내)
        cur.execute(
            f"""
            SELECT COUNT(*) FROM pending_orders po
            WHERE po.status = 'PENDING'
              {scope_sql}
            """,
            scope_params,
        )
        manual_review = cur.fetchone()[0]

        # 3. 18:00 batch reject 예정 (NORMAL · created_at::date < today · 아직 PENDING)
        cur.execute(
            f"""
            SELECT COUNT(*) FROM pending_orders po
            WHERE po.status = 'PENDING' AND po.urgency_level = 'NORMAL'
              AND po.created_at::date < %s
              {scope_sql}
            """,
            [target_date] + scope_params,
        )
        auto_reject_pending = cur.fetchone()[0]

        # 4. PENDING by_type
        cur.execute(
            f"""
            SELECT po.order_type, COUNT(*) FROM pending_orders po
            WHERE po.status = 'PENDING'
              {scope_sql}
            GROUP BY po.order_type
            """,
            scope_params,
        )
        by_type = {row[0]: row[1] for row in cur.fetchall()}

        # 5. items (top 50 · urgency desc + created_at asc — 긴급 먼저)
        cur.execute(
            f"""
            SELECT po.order_id, po.order_type, po.isbn13, b.title,
                   po.source_location_id, po.target_location_id, po.qty,
                   po.urgency_level, po.created_at, po.forecast_rationale, po.auto_execute_eligible
            FROM pending_orders po LEFT JOIN books b USING (isbn13)
            WHERE po.status = 'PENDING'
              {scope_sql}
            ORDER BY
              CASE po.urgency_level WHEN 'CRITICAL' THEN 0 WHEN 'URGENT' THEN 1 WHEN 'NEWBOOK' THEN 2 ELSE 3 END,
              po.created_at ASC
            LIMIT 50
            """,
            scope_params,
        )
        items = [
            {
                "order_id": str(r[0]), "order_type": r[1], "isbn13": r[2], "title": r[3],
                "source_location_id": r[4], "target_location_id": r[5], "qty": r[6],
                "urgency_level": r[7], "created_at": r[8].isoformat() if r[8] else None,
                "forecast_rationale": r[9], "auto_execute_eligible": r[10],
            }
            for r in cur.fetchall()
        ]

    return {
        "date": target_date,
        "auto_executed_at_07": auto_executed,
        "manual_review": manual_review,
        "auto_reject_at_18_pending": auto_reject_pending,
        "by_type": by_type,
        "items": items,
    }


@router.get("/queue/summary")
def queue_summary(
    ctx: AuthContext = Depends(require_auth),
    days: int = Query(default=7, ge=1, le=400),
    order_type: str | None = Query(default=None),
    wh_id: int | None = Query(default=None),
):
    """일자별 status count — 가벼운 응답. DateHistoryTabs pill row + 일자 stats 용.

    효율 설계 (사용자 지적 2026-05-13):
      "일자별로 들어갈 때 그 날짜만 불러와야 함. 통째로 365일 불러오는 거 미친짓."
    → summary 는 일자×status 카운트만 (1행=1일×1status · ~30 rows / week).
      detail row 는 selected date 만 별도 /queue?date=… 호출.

    응답: {"days": N, "items": [{"date": "YYYY-MM-DD", "PENDING": N, "APPROVED": N, ...}]}
    """
    where = [
        "((po.status = 'PENDING') OR "
        f"(po.created_at >= NOW() - INTERVAL '{days} days'))"
    ]
    params: list = []

    # role-scope (queue endpoint 와 동일)
    if ctx.role == "wh-manager" and ctx.scope_wh_id is not None:
        where.append(
            "(EXISTS (SELECT 1 FROM locations sl WHERE sl.location_id = po.source_location_id AND sl.wh_id = %s)"
            " OR EXISTS (SELECT 1 FROM locations tl WHERE tl.location_id = po.target_location_id AND tl.wh_id = %s))"
        )
        params.extend([ctx.scope_wh_id, ctx.scope_wh_id])
    elif ctx.role == "branch-clerk" and ctx.scope_store_id is not None:
        # 2026-05-15 v3 정정: branch-clerk scope filter 누락이었음 (queue 와 동일 패턴).
        where.append("(po.source_location_id = %s OR po.target_location_id = %s)")
        params.extend([ctx.scope_store_id, ctx.scope_store_id])

    if wh_id is not None and ctx.role == "hq-admin":
        where.append(
            "(EXISTS (SELECT 1 FROM locations sl WHERE sl.location_id = po.source_location_id AND sl.wh_id = %s)"
            " OR EXISTS (SELECT 1 FROM locations tl WHERE tl.location_id = po.target_location_id AND tl.wh_id = %s))"
        )
        params.extend([wh_id, wh_id])

    if order_type:
        where.append("po.order_type = %s")
        params.append(order_type)

    sql = f"""
        SELECT
            DATE(COALESCE(po.approved_at, po.executed_at, po.created_at) AT TIME ZONE 'Asia/Seoul') AS d,
            CASE WHEN po.status = 'APPROVED' AND po.auto_execute_eligible THEN 'AUTO_EXECUTED' ELSE po.status END AS effective_status,
            COUNT(*) AS cnt
        FROM pending_orders po
        WHERE {' AND '.join(where)}
        GROUP BY d, effective_status
        ORDER BY d DESC
    """

    from collections import defaultdict
    grouped: dict[str, dict[str, int]] = defaultdict(
        lambda: {"PENDING": 0, "APPROVED": 0, "EXECUTED": 0, "REJECTED": 0, "AUTO_EXECUTED": 0, "total": 0}
    )

    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, params)
        for r in cur.fetchall():
            d = r[0].isoformat() if r[0] else "unknown"
            st = r[1]
            cnt = r[2]
            if st in grouped[d]:
                grouped[d][st] = cnt
            grouped[d]["total"] += cnt

    items = [{"date": d, **counts} for d, counts in sorted(grouped.items(), reverse=True)]
    return {"days": days, "items": items}


@router.get("/queue", response_model=QueueResponse)
def queue(
    ctx: AuthContext = Depends(require_auth),
    limit: int = Query(default=50, ge=1, le=5000),
    offset: int = Query(default=0, ge=0, description="페이지네이션 offset (0-based · LIMIT 이전 row skip)"),
    order_type: str | None = Query(default=None, description="REBALANCE | WH_TRANSFER | PUBLISHER_ORDER"),
    wh_id: int | None = Query(default=None, description="해당 wh 가 source 또는 target 인 주문만"),
    date: str | None = Query(default=None, description="특정 일자 (YYYY-MM-DD KST) · history detail 용. 주어지면 그 날 처리 row 만"),
    expected_date: str | None = Query(default=None, description="expected_arrival_at 기준 일자 (YYYY-MM-DD) — 캘린더 cell click → 그 날 도착 예정인 모든 status row"),
    include_history: bool = Query(default=False, description="(deprecated) 과거 처리 row 포함 — 사용 자제. /queue/summary + date 조합 권장"),
    days: int = Query(default=7, ge=1, le=400, description="include_history=true 일 때 조회 기간 (일 · 최대 400)"),
    q: str | None = Query(default=None, description="isbn13/title/location 검색"),
):
    """주문 큐. role 기반 자동 필터:

    - default: PENDING 만 (오늘 처리 대기)
    - date=YYYY-MM-DD: 그 일자 (KST · approved_at|executed_at|created_at) 의 row 만
    - expected_date=YYYY-MM-DD: expected_arrival_at 기준 (캘린더 cell 과 같은 의미 · PR-C 2026-05-15)
    - include_history=true (deprecated): PENDING + 최근 N일 처리 row. summary+date 로 대체.
    """
    params: list = []
    if expected_date is not None:
        # PR-C 4-step state machine v2 — 캘린더 cell click 정합. expected_arrival_at 기반.
        # 완료된 row 도 함께 (executed_at::date == expected_date 인 경우 — 도착 당일 처리)
        where = [
            "(po.expected_arrival_at = %s "
            "OR DATE(po.executed_at AT TIME ZONE 'Asia/Seoul') = %s)"
        ]
        params.extend([expected_date, expected_date])
    elif date is not None:
        # 특정 일자 detail mode — KST 기준 그 날의 처리/생성 row 만
        where = [
            "DATE(COALESCE(po.approved_at, po.executed_at, po.created_at) AT TIME ZONE 'Asia/Seoul') = %s"
        ]
        params.append(date)
    elif include_history:
        # PENDING (시점 무관) OR 최근 N일 처리 row (deprecated · 호환)
        where = [
            "(po.status = 'PENDING' "
            "OR (po.status IN ('APPROVED','EXECUTED','REJECTED') "
            f"AND po.created_at >= NOW() - INTERVAL '{days} days'))"
        ]
    else:
        where = ["po.status = 'PENDING'"]

    # role 자동 scope
    if ctx.role == "wh-manager" and ctx.scope_wh_id is not None:
        where.append(
            "(EXISTS (SELECT 1 FROM locations sl WHERE sl.location_id = po.source_location_id AND sl.wh_id = %s)"
            " OR EXISTS (SELECT 1 FROM locations tl WHERE tl.location_id = po.target_location_id AND tl.wh_id = %s))"
        )
        params.extend([ctx.scope_wh_id, ctx.scope_wh_id])
    elif ctx.role == "branch-clerk" and ctx.scope_store_id is not None:
        # 2026-05-15 v3 정정: branch-clerk scope filter 누락이었음. 자기 매장 source/target 만.
        where.append("(po.source_location_id = %s OR po.target_location_id = %s)")
        params.extend([ctx.scope_store_id, ctx.scope_store_id])

    # 명시적 wh_id 필터 (hq-admin override)
    if wh_id is not None and ctx.role == "hq-admin":
        where.append(
            "(EXISTS (SELECT 1 FROM locations sl WHERE sl.location_id = po.source_location_id AND sl.wh_id = %s)"
            " OR EXISTS (SELECT 1 FROM locations tl WHERE tl.location_id = po.target_location_id AND tl.wh_id = %s))"
        )
        params.extend([wh_id, wh_id])

    if order_type:
        where.append("po.order_type = %s")
        params.append(order_type)

    if q:
        where.append("(po.isbn13 ILIKE %s OR b.title ILIKE %s OR l.name ILIKE %s)")
        params.extend([f"%{q}%", f"%{q}%", f"%{q}%"])

    params.append(limit)
    params.append(offset)
    # date / history 모드: 최신 처리/생성 순. PENDING 모드: urgency 우선 + 오래된 것 먼저.
    order_clause = (
        "ORDER BY COALESCE(po.approved_at, po.executed_at, po.created_at) DESC"
        if (include_history or date is not None) else
        "ORDER BY po.urgency_level DESC, po.created_at ASC"
    )
    # 응답 size 줄이기: forecast_rationale 은 detail 호출 시만 (date 또는 PENDING 모드).
    select_rationale = (date is not None) or (not include_history)
    rationale_col = "po.forecast_rationale" if select_rationale else "NULL::jsonb"
    sql = f"""
        SELECT po.order_id, po.order_type, po.isbn13,
               po.source_location_id, po.target_location_id, po.qty,
               po.urgency_level, po.auto_execute_eligible, po.status, po.created_at,
               {rationale_col}, b.title,
               po.approved_at, po.executed_at,
               sl.wh_id AS source_wh_id, tl.wh_id AS target_wh_id,
               po.expected_arrival_at, po.dispatched_at, po.rejection_stage
          FROM pending_orders po
          LEFT JOIN books b ON b.isbn13 = po.isbn13
          LEFT JOIN locations l ON l.location_id = po.target_location_id
          LEFT JOIN locations sl ON sl.location_id = po.source_location_id
          LEFT JOIN locations tl ON tl.location_id = po.target_location_id
         WHERE {' AND '.join(where)}
         {order_clause}
         LIMIT %s OFFSET %s
    """
    # COUNT(*) + per-order_type COUNT — limit/offset 무관 전체 (top stage cards 용)
    count_params = params[:-2]  # exclude limit + offset
    count_sql = f"""
        SELECT po.order_type, COUNT(*)::int
          FROM pending_orders po
          LEFT JOIN books b ON b.isbn13 = po.isbn13
          LEFT JOIN locations l ON l.location_id = po.target_location_id
         WHERE {' AND '.join(where)}
         GROUP BY po.order_type
    """
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(count_sql, count_params)
        stage_counts = {str(r[0]): int(r[1]) for r in cur.fetchall()}
        total_all = sum(stage_counts.values())

        cur.execute(sql, params)
        rows = cur.fetchall()

    items = [
        QueueItem(
            order_id=r[0], order_type=r[1], isbn13=r[2],
            source_location_id=r[3], target_location_id=r[4],
            qty=r[5], urgency_level=r[6], auto_execute_eligible=r[7],
            status=r[8], created_at=r[9],
            forecast_rationale=r[10], title=r[11],
            approved_at=r[12], executed_at=r[13],
            source_wh_id=r[14], target_wh_id=r[15],
            expected_arrival_at=r[16].isoformat() if r[16] else None,
            dispatched_at=r[17], rejection_stage=r[18],
        )
        for r in rows
    ]
    return QueueResponse(items=items, total=total_all, stage_counts=stage_counts)


def _record_approval(conn, order_id: str, ctx: AuthContext, side: str, decision: str, reject_reason: str | None) -> tuple[str, datetime]:
    """order_approvals INSERT + pending_orders status 전환 + audit_log."""
    approval_id = str(uuid4())
    cur = conn.cursor()
    # psycopg3 의 prepared statement 가 ON CONFLICT + NULL 조합에서 타입 추론 실패하는 이슈 회피.
    # SELECT-then-UPSERT 패턴 + 모든 파라미터에 명시적 cast.
    cur.execute(
        "SELECT approval_id FROM order_approvals WHERE order_id = %s::uuid AND approval_side = %s::varchar",
        (order_id, side),
        prepare=False,
    )
    existing = cur.fetchone()
    if existing:
        cur.execute(
            """
            UPDATE order_approvals
               SET approver_id = %s::varchar, approver_role = %s::varchar, approver_wh_id = %s::smallint,
                   decision = %s::varchar, reject_reason = %s::varchar, decided_at = NOW()
             WHERE approval_id = %s::uuid
            RETURNING approval_id, decided_at
            """,
            (ctx.user_id, ctx.role, ctx.scope_wh_id,
             decision, reject_reason, str(existing[0])),
            prepare=False,
        )
    else:
        cur.execute(
            """
            INSERT INTO order_approvals
                (approval_id, order_id, approver_id, approver_role, approver_wh_id,
                 approval_side, decision, reject_reason)
            VALUES (%s::uuid, %s::uuid, %s::varchar, %s::varchar, %s::smallint,
                    %s::varchar, %s::varchar, %s::varchar)
            RETURNING approval_id, decided_at
            """,
            (approval_id, order_id, ctx.user_id, ctx.role, ctx.scope_wh_id,
             side, decision, reject_reason),
            prepare=False,
        )
    aid, decided_at = cur.fetchone()

    # status 전환:
    #  - PUBLISHER_ORDER: FINAL APPROVED 1번 → APPROVED
    #  - WH_TO_STORE / REBALANCE / WH_TRANSFER: SOURCE+TARGET 둘 다 APPROVED → APPROVED (양측 협의)
    #  - REJECTED: 어느 side 든 한 번 거절 → REJECTED + reject_count++
    if decision == "APPROVED" and side == "FINAL":
        cur.execute(
            "UPDATE pending_orders SET status = 'APPROVED', approved_at = NOW() WHERE order_id = %s",
            (order_id,),
        )
        # PR-B 4-step state machine v2: APPROVED 시 inventory 변동 X
        # 실제 출고는 /intervention/orders/{id}/dispatch 호출 시 source -qty (state_machine.py)
    elif decision == "APPROVED" and side in ("SOURCE", "TARGET"):
        cur.execute(
            """
            UPDATE pending_orders SET status = 'APPROVED', approved_at = NOW()
             WHERE order_id = %s
               AND (SELECT COUNT(*) FROM order_approvals
                     WHERE order_id = %s AND decision = 'APPROVED'
                       AND approval_side IN ('SOURCE', 'TARGET')) >= 2
            """,
            (order_id, order_id),
        )
        # PR-B 4-step state machine v2: 양측 APPROVED 전환 시 inventory 변동 X
        # 실제 출고는 /intervention/orders/{id}/dispatch 호출 시 source -qty (state_machine.py)
        if cur.rowcount > 0:
            # 2026-05-14: 양측 협의 최종 승인 — UI Toast / 시연 시 "출고 완료 · 입고 대기" 명확화
            cur.execute(
                "SELECT order_type, qty FROM pending_orders WHERE order_id = %s",
                (order_id,),
            )
            row = cur.fetchone()
            ot, qty = (row[0], row[1]) if row else (None, None)
            _notify(
                ctx.token, "OrderApprovedFinal",
                severity="INFO",
                payload={
                    "order_id": order_id,
                    "order_type": ot,
                    "qty": qty,
                    "inventory_delta": -qty if qty is not None else None,
                    "approver_role": ctx.role,
                    "approver_wh_id": ctx.scope_wh_id,
                },
                correlation_id=order_id,
            )
    elif decision == "REJECTED":
        # 거부 전 status query → APPROVED 였으면 UPDATE 후 source 복원
        cur.execute("SELECT status, order_type, qty FROM pending_orders WHERE order_id = %s", (order_id,))
        prev_row = cur.fetchone()
        prev_status, prev_ot, prev_qty = (prev_row[0], prev_row[1], prev_row[2]) if prev_row else (None, None, None)
        # PR-B 4-step state machine v2: rejection_stage 자동 분기 (CHECK 충족)
        cur.execute(
            """UPDATE pending_orders SET status = 'REJECTED',
                      rejection_stage = CASE status
                        WHEN 'PENDING'    THEN 'PENDING'
                        WHEN 'APPROVED'   THEN 'APPROVED'
                        WHEN 'IN_TRANSIT' THEN 'IN_TRANSIT'
                      END,
                      reject_reason = %s,
                      reject_count = reject_count + 1
                WHERE order_id = %s""",
            (reject_reason, order_id),
        )
        if prev_status == "APPROVED":
            # PR-B 4-step state machine v2: APPROVED → REJECTED 시 변동 X
            # (Option B 폐기 — APPROVED 단계에선 source -qty 안 했으니 복원도 불필요)
            # IN_TRANSIT 후 reject 만 source +qty 복원 (state_machine._to_rejected)
            # 2026-05-14: APPROVED → REJECTED 전환 — 변동 없음 알림 (logic-apps 포함)
            _notify(
                ctx.token, "OrderRejectedAfterApproval",
                severity="WARNING",
                payload={
                    "order_id": order_id,
                    "order_type": prev_ot,
                    "qty": prev_qty,
                    "inventory_restored": True,
                    "inventory_delta": prev_qty,
                    "reject_reason": reject_reason,
                    "approver_role": ctx.role,
                    "approver_wh_id": ctx.scope_wh_id,
                },
                correlation_id=order_id,
            )

    cur.execute(
        """
        INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, after_state)
        VALUES ('user', %s, %s, 'pending_orders', %s, %s::jsonb)
        """,
        (
            ctx.user_id,
            f"intervention.{decision.lower()}",
            order_id,
            json.dumps({
                "approval_id": str(aid), "side": side, "decision": decision, "reject_reason": reject_reason,
                "approver_role": ctx.role, "approver_wh_id": ctx.scope_wh_id,
            }),
        ),
        prepare=False,
    )
    return str(aid), decided_at


@router.post("/approve", response_model=ApprovalResponse)
def approve(req: ApproveRequest, ctx: AuthContext = Depends(require_auth)):
    with db_conn() as conn:
        with conn.cursor() as cur:
            order_type, source_wh, target_wh = _validate_authority(cur, ctx, str(req.order_id), req.approval_side)
        aid, decided_at = _record_approval(conn, str(req.order_id), ctx, req.approval_side, "APPROVED", None)
        # WH_TRANSFER 양쪽 (SOURCE+TARGET) 모두 APPROVED 됐는지 후-검증 → final notification 보낼지 판단
        with conn.cursor() as cur:
            cur.execute("SELECT status FROM pending_orders WHERE order_id = %s", (str(req.order_id),))
            final_status = cur.fetchone()[0]
        conn.commit()

    # 시트04 ②OrderApproved · 양쪽 다 APPROVED 된 경우만 'final' 알림 (WH_TRANSFER 한쪽만 승인 시 부분 진행)
    _notify(
        ctx.token, "OrderApproved",
        severity="INFO",
        payload={
            "order_id": str(req.order_id),
            "order_type": order_type,
            "approval_side": req.approval_side,
            "approval_id": aid,
            "approver_role": ctx.role,
            "approver_wh_id": ctx.scope_wh_id,
            "final_status": final_status,
        },
        correlation_id=str(req.order_id),
    )
    # Redis 느림/timeout 가 response 차단하지 않도록 background 로 분리
    _check_and_notify_plan_finalized(ctx.token)
    return ApprovalResponse(approval_id=aid, order_id=req.order_id, decision="APPROVED", decided_at=decided_at, final_status=final_status)


@router.post("/reject", response_model=ApprovalResponse)
def reject(req: RejectRequest, ctx: AuthContext = Depends(require_auth)):
    with db_conn() as conn:
        with conn.cursor() as cur:
            order_type, source_wh, target_wh = _validate_authority(cur, ctx, str(req.order_id), req.approval_side)
        aid, decided_at = _record_approval(conn, str(req.order_id), ctx, req.approval_side, "REJECTED", req.reject_reason)
        with conn.cursor() as cur:
            cur.execute("SELECT status FROM pending_orders WHERE order_id = %s", (str(req.order_id),))
            final_status = cur.fetchone()[0]
        conn.commit()

    # 시트04 ③OrderRejected
    _notify(
        ctx.token, "OrderRejected",
        severity="WARNING",
        payload={
            "order_id": str(req.order_id),
            "order_type": order_type,
            "approval_side": req.approval_side,
            "approval_id": aid,
            "approver_role": ctx.role,
            "approver_wh_id": ctx.scope_wh_id,
            "reject_reason": req.reject_reason,
        },
        correlation_id=str(req.order_id),
    )
    _check_and_notify_plan_finalized(ctx.token)
    return ApprovalResponse(approval_id=aid, order_id=req.order_id, decision="REJECTED", decided_at=decided_at, final_status=final_status)


@router.post("/intervene/approve-all-today")
def approve_all_today(body: dict = Body(default={}), ctx: AuthContext = Depends(require_auth)):
    """오늘 PENDING 일괄 승인 — 자기 권한 범위 만. 페이지네이션·batch limit 우회.

    role 별 strict 권한 (단건 escalation 과 달리 hq-admin 도 자기 stage 만):
      - hq-admin    → PUBLISHER_ORDER (Stage 3 FINAL)
      - wh-manager  → 자기 wh 의 WH_TO_STORE/REBALANCE/WH_TRANSFER/PUBLISHER_ORDER (source/target=자기)
      - branch-clerk→ 자기 매장 target WH_TO_STORE/REBALANCE
    body: {order_type?: 'WH_TO_STORE'|'REBALANCE'|'WH_TRANSFER'|'PUBLISHER_ORDER'} (UI 탭 필터)
    response: {total_orders, ok, failed, errors}
    """
    order_type = body.get("order_type")

    where = ["po.status = 'PENDING'"]
    params: list = []
    if ctx.role == "hq-admin":
        where.append("po.order_type = 'PUBLISHER_ORDER'")
    elif ctx.role == "wh-manager" and ctx.scope_wh_id is not None:
        # 모든 stage: 자기 wh 가 source 또는 target 인 row (REBALANCE 도 양측 협의로 변경 → OR)
        where.append(
            "(EXISTS (SELECT 1 FROM locations sl WHERE sl.location_id = po.source_location_id AND sl.wh_id = %s)"
            " OR EXISTS (SELECT 1 FROM locations tl WHERE tl.location_id = po.target_location_id AND tl.wh_id = %s))"
        )
        params.extend([ctx.scope_wh_id, ctx.scope_wh_id])
    elif ctx.role == "branch-clerk" and ctx.scope_store_id is not None:
        # branch-clerk 일괄 승인:
        #   - REBALANCE: 자기 매장이 source 또는 target (양측 협의)
        #   - WH_TO_STORE: 자기 매장이 target (TARGET 측 입고 동의)
        where.append(
            "((po.order_type = 'REBALANCE'"
            "   AND (po.source_location_id = %s OR po.target_location_id = %s))"
            " OR (po.order_type = 'WH_TO_STORE' AND po.target_location_id = %s))"
        )
        params.extend([ctx.scope_store_id, ctx.scope_store_id, ctx.scope_store_id])
    else:
        return {"total_orders": 0, "ok": 0, "failed": 0, "errors": ["권한 부족 (scope 미지정)"]}
    if order_type:
        where.append("po.order_type = %s")
        params.append(order_type)

    sql = f"""
        SELECT po.order_id::text, po.order_type,
               po.source_location_id, po.target_location_id,
               sl.wh_id, tl.wh_id
          FROM pending_orders po
          LEFT JOIN locations sl ON sl.location_id = po.source_location_id
          LEFT JOIN locations tl ON tl.location_id = po.target_location_id
         WHERE {' AND '.join(where)}
    """

    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            rows = cur.fetchall()

        valid_items: list[dict] = []
        errors: list[str] = []
        for r in rows:
            oid, ot, sloc, tloc, swh, twh = r
            meta = {
                "order_type": ot,
                "source_loc": sloc, "target_loc": tloc,
                "source_wh": swh, "target_wh": twh,
            }
            if ot in ("WH_TO_STORE", "REBALANCE", "WH_TRANSFER"):
                for side in ("SOURCE", "TARGET"):
                    try:
                        _check_authority_rules(ctx, meta, side)
                        valid_items.append({"order_id": oid, "side": side, "reject_reason": None})
                    except HTTPException:
                        pass
            else:
                try:
                    _check_authority_rules(ctx, meta, "FINAL")
                    valid_items.append({"order_id": oid, "side": "FINAL", "reject_reason": None})
                except HTTPException as e:
                    if len(errors) < 20:
                        errors.append(f"{oid}: {e.detail}")

        if valid_items:
            _bulk_record_approvals(conn, valid_items, ctx, "APPROVED")
        conn.commit()

    if valid_items:
        _notify(
            ctx.token, "OrderApproved", severity="INFO",
            payload={
                "batch_size": len(valid_items),
                "approver_role": ctx.role,
                "approver_wh_id": ctx.scope_wh_id,
                "scope": "today_all",
                "order_type_filter": order_type,
            },
        )

    # ok = approval row 수 (WH_TRANSFER 는 order 당 2 row · 그 외는 1 row)
    return {
        "total_orders": len(rows),
        "ok": len(valid_items),
        "failed": max(0, len(rows) - len({it["order_id"] for it in valid_items})),
        "errors": errors,
    }


def _check_authority_rules(ctx: AuthContext, meta: dict, side: str) -> None:
    """`_validate_authority` 의 in-memory 변종. 이미 fetch 된 order meta 로 권한 검증.

    Raises HTTPException on violation.
    meta = {order_type, source_wh, target_wh, source_loc, target_loc}.
    """
    order_type = meta["order_type"]
    source_wh = meta["source_wh"]
    target_wh = meta["target_wh"]
    source_loc = meta.get("source_loc")
    target_loc = meta["target_loc"]

    if order_type == "WH_TO_STORE":
        # Stage 0: 자기 wh 본체 → 자기 권역 매장 (양측 협의)
        if side not in ("SOURCE", "TARGET"):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                                detail="WH_TO_STORE 는 SOURCE/TARGET 만 (양측 협의)")
        if ctx.role == "hq-admin":
            return
        if side == "SOURCE":
            if ctx.role != "wh-manager" or ctx.scope_wh_id is None or ctx.scope_wh_id != source_wh:
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                                    detail=f"SOURCE 권한 없음 (scope={ctx.scope_wh_id}/source_wh={source_wh})")
            return
        # TARGET
        if ctx.role != "branch-clerk" or ctx.scope_store_id is None or ctx.scope_store_id != target_loc:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                                detail=f"TARGET 권한 없음 (scope={ctx.scope_store_id}/target_loc={target_loc})")
        return
    elif order_type == "REBALANCE":
        # 2026-05-14: 양측 협의 (WH_TRANSFER 와 동일 패턴)
        if side not in ("SOURCE", "TARGET"):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                                detail="REBALANCE 는 SOURCE/TARGET 만 (양측 협의)")
        if ctx.role == "hq-admin":
            return
        my_side_loc = source_loc if side == "SOURCE" else target_loc
        my_side_wh = source_wh if side == "SOURCE" else target_wh
        if ctx.role == "branch-clerk":
            if ctx.scope_store_id is None or ctx.scope_store_id != my_side_loc:
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                                    detail=f"{side} 권한 없음 (scope={ctx.scope_store_id}/{side}_loc={my_side_loc})")
            return
        if ctx.role != "wh-manager" or ctx.scope_wh_id is None:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="REBALANCE 권한 없음")
        if ctx.scope_wh_id != my_side_wh:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                                detail=f"{side} 권한 없음 (scope={ctx.scope_wh_id}/{side}_wh={my_side_wh})")
    elif order_type == "WH_TRANSFER":
        if side not in ("SOURCE", "TARGET"):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                                detail="WH_TRANSFER 는 SOURCE/TARGET 만")
        if ctx.role == "hq-admin":
            return
        if ctx.role != "wh-manager" or ctx.scope_wh_id is None:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="WH_TRANSFER 권한 없음")
        my_side_wh = source_wh if side == "SOURCE" else target_wh
        if ctx.scope_wh_id != my_side_wh:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                                detail=f"{side} 권한 없음 (scope={ctx.scope_wh_id}/side={my_side_wh})")
    elif order_type == "PUBLISHER_ORDER":
        if side != "FINAL":
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="PUBLISHER_ORDER 는 FINAL 만")
        if ctx.role == "hq-admin":
            return
        if ctx.role == "wh-manager" and ctx.scope_wh_id == target_wh:
            return
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="PUBLISHER_ORDER 권한 없음")
    else:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"unknown order_type: {order_type}")


def _bulk_record_approvals(conn, valid_items: list[dict], ctx: AuthContext, decision: str) -> None:
    """N items 한 transaction 으로 INSERT/UPDATE order_approvals + UPDATE pending_orders + 1 audit_log."""
    cur = conn.cursor()

    # 1) 기존 approval 조회 (order_id, side 동일 페어 → UPDATE 분기)
    pairs_oid = [it["order_id"] for it in valid_items]
    pairs_side = [it["side"] for it in valid_items]
    cur.execute(
        """
        SELECT order_id::text, approval_side, approval_id::text
          FROM order_approvals
         WHERE (order_id::text, approval_side) IN (
               SELECT * FROM UNNEST(%s::text[], %s::varchar[])
         )
        """,
        (pairs_oid, pairs_side),
    )
    existing = {(r[0], r[1]): r[2] for r in cur.fetchall()}

    inserts: list[tuple] = []
    updates: list[tuple] = []
    for it in valid_items:
        key = (it["order_id"], it["side"])
        rej = it.get("reject_reason")
        if key in existing:
            updates.append((ctx.user_id, ctx.role, ctx.scope_wh_id, decision, rej, existing[key]))
        else:
            inserts.append((str(uuid4()), it["order_id"], ctx.user_id, ctx.role, ctx.scope_wh_id, it["side"], decision, rej))

    # 2) Bulk INSERT
    if inserts:
        cur.executemany(
            """
            INSERT INTO order_approvals
                (approval_id, order_id, approver_id, approver_role, approver_wh_id,
                 approval_side, decision, reject_reason)
            VALUES (%s::uuid, %s::uuid, %s, %s, %s, %s, %s, %s)
            """,
            inserts,
        )

    # 3) Bulk UPDATE existing
    if updates:
        cur.executemany(
            """
            UPDATE order_approvals
               SET approver_id = %s, approver_role = %s, approver_wh_id = %s,
                   decision = %s, reject_reason = %s, decided_at = NOW()
             WHERE approval_id = %s::uuid
            """,
            updates,
        )

    # 4) pending_orders status 일괄 전환
    newly_approved_oids: list[str] = []
    restore_oids: list[str] = []
    if decision == "APPROVED":
        # PUBLISHER_ORDER FINAL → 즉시 APPROVED (REBALANCE/WH_TRANSFER 는 양측 협의)
        final_oids = list({it["order_id"] for it in valid_items if it["side"] == "FINAL"})
        if final_oids:
            cur.execute(
                """
                UPDATE pending_orders
                   SET status = 'APPROVED', approved_at = NOW()
                 WHERE order_id = ANY(%s::uuid[])
                   AND status NOT IN ('APPROVED', 'EXECUTED', 'AUTO_EXECUTED')
                RETURNING order_id::text
                """,
                (final_oids,),
            )
            newly_approved_oids.extend(r[0] for r in cur.fetchall())
        # WH_TO_STORE / REBALANCE / WH_TRANSFER SOURCE+TARGET 양측 APPROVED → APPROVED
        wh_oids = list({it["order_id"] for it in valid_items if it["side"] in ("SOURCE", "TARGET")})
        if wh_oids:
            cur.execute(
                """
                UPDATE pending_orders po
                   SET status = 'APPROVED', approved_at = NOW()
                 WHERE po.order_id = ANY(%s::uuid[])
                   AND po.status NOT IN ('APPROVED', 'EXECUTED', 'AUTO_EXECUTED')
                   AND (SELECT COUNT(*) FROM order_approvals oa
                         WHERE oa.order_id = po.order_id
                           AND oa.decision = 'APPROVED'
                           AND oa.approval_side IN ('SOURCE', 'TARGET')) >= 2
                RETURNING po.order_id::text
                """,
                (wh_oids,),
            )
            newly_approved_oids.extend(r[0] for r in cur.fetchall())
        # PR-B 4-step state machine v2: bulk APPROVED 전환 시 inventory 변동 X
        # 실제 출고는 /intervention/orders/batch-dispatch 호출 시 (state_machine.py)
        _ = newly_approved_oids  # noqa: F841 (audit_log 기록 등 다른 곳에서 사용 가능)
    else:  # REJECTED
        # 어느 side 든 REJECTED → 전체 order REJECTED + reject_count++ (per order 1회)
        rej_map: dict[str, str | None] = {}
        for it in valid_items:
            rej_map.setdefault(it["order_id"], it.get("reject_reason"))
        if rej_map:
            # 거부 전 prev_status 사전 query → APPROVED 였던 것만 복원 대상
            oid_list = list(rej_map.keys())
            cur.execute(
                "SELECT order_id::text, status FROM pending_orders WHERE order_id = ANY(%s::uuid[])",
                (oid_list,),
            )
            prev_status_map = {r[0]: r[1] for r in cur.fetchall()}
            # PR-B 4-step state machine v2: rejection_stage 자동 분기 (CHECK 충족)
            cur.executemany(
                """
                UPDATE pending_orders
                   SET status = 'REJECTED',
                       rejection_stage = CASE status
                         WHEN 'PENDING'    THEN 'PENDING'
                         WHEN 'APPROVED'   THEN 'APPROVED'
                         WHEN 'IN_TRANSIT' THEN 'IN_TRANSIT'
                       END,
                       reject_reason = %s,
                       reject_count = reject_count + 1
                 WHERE order_id = %s::uuid
                   AND status NOT IN ('REJECTED', 'EXECUTED')
                """,
                [(reason, oid) for oid, reason in rej_map.items()],
            )
            # PR-B 4-step state machine v2: bulk APPROVED → REJECTED 시 변동 X
            # (APPROVED 단계에선 source -qty 안 했으니 복원도 불필요 — Option B 폐기)
            _ = [oid for oid, st in prev_status_map.items() if st == "APPROVED"]

    # 5) 단일 batch audit_log row
    cur.execute(
        """
        INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, after_state)
        VALUES ('user', %s, %s, 'pending_orders', %s, %s::jsonb)
        """,
        (
            ctx.user_id,
            f"intervention.batch_{decision.lower()}",
            valid_items[0]["order_id"],  # representative id (FK target)
            json.dumps({
                "batch_size": len(valid_items),
                "approver_role": ctx.role,
                "approver_wh_id": ctx.scope_wh_id,
                "sample_orders": [it["order_id"] for it in valid_items[:5]],
            }),
        ),
    )


@router.post("/intervene/batch")
def intervene_batch(body: dict = Body(...), ctx: AuthContext = Depends(require_auth)):
    """일괄 승인/거절 — bulk SQL 1 transaction · 단일 notification (2026-05-13 v2).

    효율 개선:
      - 기존: N items × {2 SQL validate + 3 SQL record + 1 SELECT + 1 HTTP notify} ≈ 7N SQL + N HTTP
      - 신규: 1 fetch + executemany (INSERT/UPDATE) + 2 bulk UPDATE + 1 audit + 1 HTTP notify
      - 1000 items: ~7000 SQL + 1000 HTTP → ~5 SQL + 1 HTTP

    body: {action: 'approve'|'reject', items: [{order_id, approval_side, reject_reason?}]}
    response: {total, ok, failed, errors}
    """
    action = body.get("action")
    items_raw = body.get("items", []) or []
    if action not in ("approve", "reject"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="action 은 'approve' 또는 'reject'")
    if not items_raw or len(items_raw) > 1000:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="items 는 1~1000 개")

    decision = "APPROVED" if action == "approve" else "REJECTED"
    order_ids = list({it["order_id"] for it in items_raw if it.get("order_id")})

    valid_items: list[dict] = []
    errors: list[str] = []

    with db_conn() as conn:
        with conn.cursor() as cur:
            # 1) 한 SQL 로 모든 order metadata + side wh 동시 fetch
            cur.execute(
                """
                SELECT po.order_id::text, po.order_type,
                       po.source_location_id, po.target_location_id,
                       sl.wh_id AS source_wh, tl.wh_id AS target_wh
                  FROM pending_orders po
                  LEFT JOIN locations sl ON sl.location_id = po.source_location_id
                  LEFT JOIN locations tl ON tl.location_id = po.target_location_id
                 WHERE po.order_id = ANY(%s::uuid[])
                """,
                (order_ids,),
            )
            meta_by_oid = {
                r[0]: {
                    "order_type": r[1],
                    "source_loc": r[2], "target_loc": r[3],
                    "source_wh": r[4], "target_wh": r[5],
                }
                for r in cur.fetchall()
            }

        # 2) In-memory 권한 검증 + valid set 구축
        for it in items_raw:
            oid = it.get("order_id")
            side = it.get("approval_side", "FINAL")
            try:
                if oid not in meta_by_oid:
                    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="order not found")
                _check_authority_rules(ctx, meta_by_oid[oid], side)
                valid_items.append({
                    "order_id": oid, "side": side,
                    "reject_reason": (it.get("reject_reason") if action == "reject" else None),
                })
            except HTTPException as e:
                if len(errors) < 20:
                    errors.append(f"{oid}: {e.detail}")

        # 3) Bulk write — 단일 transaction
        if valid_items:
            _bulk_record_approvals(conn, valid_items, ctx, decision)
        conn.commit()

    # 4) 단일 batch notification (1000 HTTP → 1)
    if valid_items:
        event = "OrderApproved" if decision == "APPROVED" else "OrderRejected"
        severity = "INFO" if decision == "APPROVED" else "WARNING"
        _notify(
            ctx.token, event, severity=severity,
            payload={
                "batch_size": len(valid_items),
                "approver_role": ctx.role,
                "approver_wh_id": ctx.scope_wh_id,
                "sample_order_ids": [it["order_id"] for it in valid_items[:5]],
            },
        )

    return {
        "total": len(items_raw),
        "ok": len(valid_items),
        "failed": len(items_raw) - len(valid_items),
        "errors": errors,
    }


@router.patch("/pending-orders/{order_id}", response_model=PendingOrderEditResponse)
def edit_pending_order(order_id: UUID, req: PendingOrderEditRequest, ctx: AuthContext = Depends(require_auth)):
    """D5-7 Notion 2.6 · WH AI 추천 수정 (수량/대상 매장).

    권한:
      - hq-admin: 전권
      - wh-manager: 자기 권역 (source 또는 target 매장이 자기 wh) 의 PENDING 만
      - branch-clerk: 차단

    제약:
      - status='PENDING' 만 수정 (APPROVED/REJECTED/EXECUTED 차단)
      - qty 또는 target_location_id 중 1개 이상 필수
    """
    if ctx.role == "branch-clerk":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="branch-clerk 는 발주 수정 권한 없음")
    if req.qty is None and req.target_location_id is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="qty 또는 target_location_id 중 1개 이상 필수")

    with db_conn() as conn:
        with conn.cursor() as cur:
            # 현재 row + 권한 확인
            cur.execute(
                """
                SELECT po.qty, po.target_location_id, po.source_location_id, po.status, po.order_type,
                       tl.wh_id AS target_wh, sl.wh_id AS source_wh
                  FROM pending_orders po
                  LEFT JOIN locations tl ON tl.location_id = po.target_location_id
                  LEFT JOIN locations sl ON sl.location_id = po.source_location_id
                 WHERE po.order_id = %s
                """,
                (str(order_id),),
            )
            row = cur.fetchone()
            if row is None:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="order not found")
            cur_qty, cur_target, cur_source, cur_status, order_type, target_wh, source_wh = row
            if cur_status != "PENDING":
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                                    detail=f"수정은 PENDING 상태만 가능 (현재 {cur_status})")
            if ctx.role == "wh-manager":
                if ctx.scope_wh_id is None:
                    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="wh-manager scope_wh_id 부재")
                if target_wh != ctx.scope_wh_id and source_wh != ctx.scope_wh_id:
                    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                                        detail="자기 권역 (source or target) 의 발주만 수정 가능")

            # target_location_id 변경 시 같은 권역 매장인지 검증
            new_target = req.target_location_id if req.target_location_id is not None else cur_target
            if req.target_location_id is not None and ctx.role == "wh-manager":
                cur.execute("SELECT wh_id FROM locations WHERE location_id = %s", (req.target_location_id,))
                r2 = cur.fetchone()
                if r2 is None:
                    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"target_location_id {req.target_location_id} 없음")
                if r2[0] != ctx.scope_wh_id:
                    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                                        detail="대상 매장이 자기 권역 외 — 변경 불가")

            new_qty = req.qty if req.qty is not None else cur_qty
            before = {"qty": cur_qty, "target_location_id": cur_target}
            after  = {"qty": new_qty, "target_location_id": new_target, "note": req.note}

            cur.execute(
                """
                UPDATE pending_orders
                   SET qty = %s, target_location_id = %s, updated_at = NOW()
                 WHERE order_id = %s
                """,
                (new_qty, new_target, str(order_id)),
            )
            edited_at = datetime.utcnow()
            cur.execute(
                """
                INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, before_state, after_state)
                VALUES ('user', %s, 'pending_order.edit', 'pending_order', %s, %s, %s)
                """,
                (ctx.user_id, str(order_id), json.dumps(before), json.dumps(after)),
            )
        conn.commit()

    return PendingOrderEditResponse(
        order_id=order_id,
        qty=new_qty,
        target_location_id=new_target,
        edited_at=edited_at,
        edited_by=ctx.user_id,
    )


@router.post("/returns/request", response_model=ReturnRequestResponse)
def returns_request(req: ReturnRequestRequest, ctx: AuthContext = Depends(require_auth)):
    """P1-3 Branch 반품 신청 (R&R 3.2 line 143).

    매장 직원이 입고 후 파손/불량/누락/계약 종료 등 발견 시 반품 신청.
    returns INSERT status='PENDING' (default) → HQ Returns 큐 진입 + ⑩ReturnPending 알림 발행.

    권한:
      - branch-clerk: scope_store_id == location_id (자기 매장만)
      - hq-admin: 모두 허용 (운영 보조)
      - wh-manager: 거부 (반품은 매장 발의)
    """
    if ctx.role == "branch-clerk":
        if ctx.scope_store_id is None or ctx.scope_store_id != req.location_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"자기 매장만 반품 신청 가능 (scope_store_id={ctx.scope_store_id} · target={req.location_id})",
            )
    elif ctx.role != "hq-admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="반품 신청 권한 없음")

    return_id = uuid4()
    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO returns (return_id, isbn13, location_id, qty, reason)
                VALUES (%s, %s, %s, %s, %s)
                RETURNING status, requested_at
                """,
                (str(return_id), req.isbn13, req.location_id, req.qty, req.reason),
            )
            row = cur.fetchone()
            cur.execute(
                """
                INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, after_state)
                VALUES ('user', %s, 'returns.request', 'returns', %s, %s::jsonb)
                """,
                (ctx.user_id, str(return_id), json.dumps({
                    "isbn13": req.isbn13, "location_id": req.location_id,
                    "qty": req.qty, "reason": req.reason,
                })),
            )
        conn.commit()

    # 시트04 ⑩ReturnPending — HQ Returns 큐 진입 알림 (severity INFO)
    _notify(
        ctx.token, "ReturnPending",
        severity="INFO",
        payload={
            "return_id": str(return_id),
            "isbn13": req.isbn13,
            "location_id": req.location_id,
            "qty": req.qty,
            "reason": req.reason,
            "requester_role": ctx.role,
        },
        correlation_id=str(return_id),
    )

    return ReturnRequestResponse(
        return_id=return_id,
        isbn13=req.isbn13,
        location_id=req.location_id,
        qty=req.qty,
        reason=req.reason,
        status=row[0],
        requested_at=row[1],
    )


@router.post("/returns/approve", response_model=ReturnApproveResponse)
def returns_approve(req: ReturnApproveRequest, ctx: AuthContext = Depends(require_auth)):
    if ctx.role != "hq-admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="반품 승인은 hq-admin 만 가능")

    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE returns SET status = 'APPROVED', hq_approved_at = NOW()
                 WHERE return_id = %s AND status = 'PENDING'
                RETURNING status, hq_approved_at
                """,
                (str(req.return_id),),
            )
            row = cur.fetchone()
            if row is None:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="return not found or already processed")
            cur.execute(
                """
                INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, after_state)
                VALUES ('user', %s, 'intervention.returns.approve', 'returns', %s, %s)
                """,
                (ctx.user_id, str(req.return_id), json.dumps({"note": req.note})),
            )
        conn.commit()

    # 시트04 ⑩ReturnPending (HQ 승인 = 반품 처리 시작 시점 알림)
    _notify(
        ctx.token, "ReturnPending",
        severity="INFO",
        payload={
            "return_id": str(req.return_id),
            "approver_role": ctx.role,
            "note": req.note,
        },
        correlation_id=str(req.return_id),
    )

    return ReturnApproveResponse(return_id=req.return_id, status=row[0], hq_approved_at=row[1])


# ─── A4 (FR-A6.8) HQ 반품 거부 ─────────────────────────────────────────────────
@router.post("/returns/reject", response_model=ReturnRejectResponse)
def returns_reject(req: ReturnRejectRequest, ctx: AuthContext = Depends(require_auth)):
    """본사 마스터 반품 기각.

    - 권한: hq-admin only (단일 결정)
    - 상태 전이: PENDING → REJECTED · rejected_at + reject_reason 채움
    - 이미 APPROVED/EXECUTED/REJECTED 상태면 404 (재처리 방지)
    """
    if ctx.role != "hq-admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="반품 거부는 hq-admin 만 가능")

    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE returns
                   SET status = 'REJECTED', rejected_at = NOW(), reject_reason = %s
                 WHERE return_id = %s AND status = 'PENDING'
                RETURNING status, rejected_at, reject_reason
                """,
                (req.reject_reason, str(req.return_id)),
            )
            row = cur.fetchone()
            if row is None:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="return not found or already processed")
            cur.execute(
                """
                INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, after_state)
                VALUES ('user', %s, 'intervention.returns.reject', 'returns', %s, %s)
                """,
                (ctx.user_id, str(req.return_id), json.dumps({"reject_reason": req.reject_reason})),
            )
        conn.commit()

    # Notification: 시트04 미정의이라 audit_log 만 남김 (ReturnRejected 추가 시 _notify 호출 추가)
    return ReturnRejectResponse(
        return_id=req.return_id,
        status=row[0],
        rejected_at=row[1],
        reject_reason=row[2],
    )


# ─── New book request approval (HQ Requests page) ─────────────────────────────
@router.post("/new-book-requests/{request_id}/approve")
def approve_new_book_request(
    request_id: int,
    body: dict | None = None,
    ctx: AuthContext = Depends(require_auth),
):
    """출판사 신간 신청 → HQ 편입 결정 (FR-A4.8 신간 발주 지시서 자동 실행).

    body = { wh1_qty?: int >= 0, wh2_qty?: int >= 0 } - 권역별 분배 수량.
    둘 다 0/None 이면 status APPROVED 만 (지시서 미발행 호환 모드).

    효과:
    1. new_book_requests.status='APPROVED'
    2. wh1_qty, wh2_qty > 0 면 → pending_orders PUBLISHER_ORDER 자동 생성 (status=APPROVED · 본사 단독 승인)
    3. ⑨NewBookRequest 알림 (시트04 12 events)
    """
    if ctx.role != "hq-admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="신간 승인은 hq-admin 만 가능")

    body = body or {}
    wh1_qty = int(body.get("wh1_qty") or 0)
    wh2_qty = int(body.get("wh2_qty") or 0)
    if wh1_qty < 0 or wh2_qty < 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="qty 는 0 이상")

    new_orders: list[dict] = []
    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE new_book_requests SET status = 'APPROVED', approved_at = NOW() WHERE id = %s AND status IN ('NEW','FETCHED') RETURNING isbn13",
                (request_id,),
            )
            row = cur.fetchone()
            if row is None:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="요청 없음 또는 이미 처리됨")
            isbn13 = row[0]

            # 권역별 발주 지시서 자동 생성 (FR-A4.8 · 본사 신간 지시는 물류센터 자동 실행)
            # location_type='WH' (시드 스키마 정합 · 'WAREHOUSE' 는 과거 명명 잔존 버그였음)
            for wh_id, qty in [(1, wh1_qty), (2, wh2_qty)]:
                if qty <= 0:
                    continue
                cur.execute(
                    "SELECT location_id FROM locations WHERE wh_id = %s AND location_type = 'WH' LIMIT 1",
                    (wh_id,),
                )
                loc = cur.fetchone()
                if loc is None:
                    raise HTTPException(
                        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                        detail=f"WH 본체 location 누락 (wh_id={wh_id} · location_type='WH'). 시드 정합 확인 필요",
                    )
                target_loc = loc[0]
                order_id = uuid4()
                cur.execute(
                    """
                    INSERT INTO pending_orders
                        (order_id, order_type, isbn13, source_location_id, target_location_id,
                         qty, urgency_level, status, approved_at)
                    VALUES (%s, 'PUBLISHER_ORDER', %s, NULL, %s, %s, 'NEWBOOK', 'APPROVED', NOW())
                    """,
                    (str(order_id), isbn13, target_loc, qty),
                )
                new_orders.append({"order_id": str(order_id), "wh_id": wh_id, "qty": qty, "target_location_id": target_loc})

                # WH → 매장 자동 분배 (REBALANCE NEWBOOK · 권역 내 균등 분배)
                # 본사 신간 지시 = WH 수신 + 매장 분배 둘 다 자동 (Notion 2.3 "수신 확인만")
                cur.execute(
                    "SELECT location_id FROM locations WHERE wh_id = %s AND location_type = 'STORE_OFFLINE' ORDER BY location_id",
                    (wh_id,),
                )
                stores = [r[0] for r in cur.fetchall()]
                if stores:
                    base = qty // len(stores)
                    extra = qty - base * len(stores)  # 남는 권 → 앞 매장부터 +1
                    for i, store_loc in enumerate(stores):
                        store_qty = base + (1 if i < extra else 0)
                        if store_qty <= 0:
                            continue
                        sub_id = uuid4()
                        cur.execute(
                            """
                            INSERT INTO pending_orders
                                (order_id, order_type, isbn13, source_location_id, target_location_id,
                                 qty, urgency_level, status, approved_at)
                            VALUES (%s, 'REBALANCE', %s, %s, %s, %s, 'NEWBOOK', 'APPROVED', NOW())
                            """,
                            (str(sub_id), isbn13, target_loc, store_loc, store_qty),
                        )
                        new_orders.append({
                            "order_id": str(sub_id), "wh_id": wh_id, "qty": store_qty,
                            "target_location_id": store_loc, "phase": "wh_to_store",
                        })

            cur.execute(
                """
                INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, after_state)
                VALUES ('user', %s, 'intervention.new_book.approve', 'new_book_requests', %s, %s)
                """,
                (ctx.user_id, str(request_id),
                 json.dumps({"isbn13": isbn13, "wh1_qty": wh1_qty, "wh2_qty": wh2_qty, "orders": new_orders})),
            )
        conn.commit()

    # 시트04 ⑨NewBookRequest (publisher-watcher 가 NEW 시점 한 번 발송 + HQ 승인 시 한 번 더)
    _notify(
        ctx.token, "NewBookRequest",
        severity="INFO",
        payload={
            "id": request_id,
            "isbn13": isbn13,
            "stage": "APPROVED",
            "approver_role": ctx.role,
            "wh1_qty": wh1_qty,
            "wh2_qty": wh2_qty,
            "orders_created": len(new_orders),
        },
    )

    return {
        "id": request_id,
        "status": "APPROVED",
        "isbn13": isbn13,
        "wh1_qty": wh1_qty,
        "wh2_qty": wh2_qty,
        "orders": new_orders,
    }


# ─── New book request reject ──────────────────────────────────────────────────
@router.post("/new-book-requests/{request_id}/reject")
def reject_new_book_request(
    request_id: int,
    body: dict | None = None,
    ctx: AuthContext = Depends(require_auth),
):
    """본사가 신간 시스템 편입 거절. body = { reason?: str }"""
    if ctx.role != "hq-admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="신간 거절은 hq-admin 만 가능")

    reason = (body or {}).get("reason") or None
    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE new_book_requests SET status = 'REJECTED', approved_at = NOW() WHERE id = %s AND status IN ('NEW','FETCHED') RETURNING isbn13",
                (request_id,),
            )
            row = cur.fetchone()
            if row is None:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="요청 없음 또는 이미 처리됨")
            cur.execute(
                """
                INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, after_state)
                VALUES ('user', %s, 'intervention.new_book.reject', 'new_book_requests', %s, %s)
                """,
                (ctx.user_id, str(request_id), json.dumps({"isbn13": row[0], "reason": reason})),
            )
        conn.commit()

    return {"id": request_id, "status": "REJECTED", "isbn13": row[0]}


# ─── HQ 도서 ON/OFF + 소진 모드 (FR-A6.1 + A6.2) ────────────────────────────────
_VALID_BOOK_STATUSES = ("NORMAL", "SOFT_DISCONTINUE", "INACTIVE")


@router.post("/books/{isbn13}/status")
def change_book_status(
    isbn13: str,
    body: dict,
    ctx: AuthContext = Depends(require_auth),
):
    """본사 도서 활성/비활성 마스터 컨트롤.

    - NORMAL: 자동 사이클 정상 (기본값) · active=TRUE · discontinue_mode='NONE'
    - SOFT_DISCONTINUE: 신규 발주 차단, 재분배 허용 (forecast/decision/rebalance 가 mode 체크)
    - INACTIVE: 자동 사이클 완전 정지 (예측·발주·재분배 모두 스킵) · active=FALSE

    body = { mode: NORMAL|SOFT_DISCONTINUE|INACTIVE, reason?: str }
    """
    if ctx.role != "hq-admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                            detail="도서 ON/OFF 는 hq-admin 만 가능 (본사 마스터 컨트롤)")

    mode = (body or {}).get("mode")
    reason = (body or {}).get("reason") or None
    if mode not in _VALID_BOOK_STATUSES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail=f"mode 는 {list(_VALID_BOOK_STATUSES)} 중 하나여야 함")

    if mode == "NORMAL":
        sql = """
            UPDATE books
               SET active = TRUE,
                   discontinue_mode = 'NONE',
                   discontinue_reason = NULL,
                   discontinue_at = NULL,
                   discontinue_by = NULL,
                   reactivated_at = NOW()
             WHERE isbn13 = %s
             RETURNING isbn13, active, discontinue_mode
        """
        params = (isbn13,)
    elif mode == "SOFT_DISCONTINUE":
        sql = """
            UPDATE books
               SET active = TRUE,
                   discontinue_mode = 'SOFT_DISCONTINUE',
                   discontinue_reason = %s,
                   discontinue_at = NOW(),
                   discontinue_by = %s,
                   reactivated_at = NULL
             WHERE isbn13 = %s
             RETURNING isbn13, active, discontinue_mode
        """
        params = (reason, ctx.user_id, isbn13)
    else:  # INACTIVE
        sql = """
            UPDATE books
               SET active = FALSE,
                   discontinue_mode = 'INACTIVE',
                   discontinue_reason = %s,
                   discontinue_at = NOW(),
                   discontinue_by = %s,
                   reactivated_at = NULL
             WHERE isbn13 = %s
             RETURNING isbn13, active, discontinue_mode
        """
        params = (reason, ctx.user_id, isbn13)

    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            row = cur.fetchone()
            if row is None:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND,
                                    detail=f"isbn13 {isbn13} 를 찾을 수 없음")
            cur.execute(
                """
                INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, after_state)
                VALUES ('user', %s, 'intervention.book.status', 'books', %s, %s)
                """,
                (ctx.user_id, isbn13, json.dumps({"mode": mode, "reason": reason})),
            )
        conn.commit()

    return {"isbn13": row[0], "active": row[1], "discontinue_mode": row[2], "mode": mode}


# ─── A1 inbound receive (FR-A6.6 + 후속) ──────────────────────────────────
@router.post("/inbound/{order_id}/receive")
def receive_inbound(order_id: str, ctx: AuthContext = Depends(require_auth)):
    """매장/창고 입고 수령 처리 — pending_orders.status='EXECUTED' + inventory.on_hand += qty.

    권한:
      - branch-clerk: scope_store_id == target_location_id
      - wh-manager:   scope_wh_id   == target_wh
      - hq-admin:     모두 허용

    Single writer 패턴 유지: inventory mutation 은 inventory-svc /adjust 프록시 호출 (REST).
    조회·status·audit 는 본 svc 가 담당.
    """
    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """SELECT order_type, target_location_id, qty, isbn13, status
                     FROM pending_orders WHERE order_id = %s""",
                (order_id,),
            )
            row = cur.fetchone()
            if row is None:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="order not found")
            order_type, target_loc, qty, isbn13, st = row
            if st != "APPROVED":
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=f"수령은 APPROVED 상태에서만 가능 (현재 status={st})",
                )
            target_wh = _location_wh(cur, target_loc)

            # 권한
            if ctx.role == "branch-clerk":
                if ctx.scope_store_id is None or ctx.scope_store_id != target_loc:
                    raise HTTPException(
                        status_code=status.HTTP_403_FORBIDDEN,
                        detail=f"자기 매장만 수령 가능 (scope_store_id={ctx.scope_store_id} · target={target_loc})",
                    )
            elif ctx.role == "wh-manager":
                if ctx.scope_wh_id is None or ctx.scope_wh_id != target_wh:
                    raise HTTPException(
                        status_code=status.HTTP_403_FORBIDDEN,
                        detail=f"자기 권역만 수령 가능 (scope_wh_id={ctx.scope_wh_id} · target_wh={target_wh})",
                    )
            elif ctx.role != "hq-admin":
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="수령 권한 없음")

            # PR-B 4-step state machine v2: legacy receive 가 CHECK 충족 위해 dispatched_at + executed_by 도 함께 채움
            # (APPROVED → EXECUTED 직행 시 IN_TRANSIT 거치지 않으므로 dispatched_at = NOW() · single transaction)
            cur.execute(
                """UPDATE pending_orders SET status='EXECUTED',
                          dispatched_at=COALESCE(dispatched_at, NOW()),
                          dispatched_by=COALESCE(dispatched_by, %s),
                          executed_at=NOW(),
                          executed_by=%s
                    WHERE order_id = %s""",
                (ctx.user_id, ctx.user_id, order_id),
            )
            cur.execute(
                """INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, after_state)
                   VALUES ('user', %s, 'inbound.receive', 'pending_orders', %s, %s::jsonb)""",
                (ctx.user_id, order_id, json.dumps({
                    "status": "EXECUTED", "qty": qty, "isbn13": isbn13, "target_location_id": target_loc,
                })),
            )
        conn.commit()

    # inventory-svc /adjust 호출 (별도 transaction · 실패 비치명 · log + 알림)
    inv_status = "PENDING_ADJUST"
    try:
        with httpx.Client(timeout=3.0) as c:
            r = c.post(
                f"{INVENTORY_SVC_URL}/inventory/adjust",
                headers={"Authorization": ctx.token},
                json={
                    "isbn13": isbn13,
                    "location_id": target_loc,
                    "delta": qty,
                    "reason": f"입고수령:{order_id[:8]}",
                },
            )
            if r.status_code == 200:
                inv_status = "ADJUSTED"
            else:
                log.warning("inventory adjust HTTP %s: %s", r.status_code, r.text[:200])
    except Exception as e:
        log.warning("inventory adjust call failed (non-fatal): %s", e)

    # 시트04 변형: 수령 완료 알림 (severity INFO)
    _notify(
        ctx.token,
        "OrderExecuted",
        severity="INFO",
        payload={
            "order_id": order_id,
            "order_type": order_type,
            "isbn13": isbn13,
            "qty": qty,
            "target_location_id": target_loc,
            "inventory_adjust": inv_status,
        },
        correlation_id=order_id,
    )

    return {
        "order_id": order_id,
        "status": "EXECUTED",
        "isbn13": isbn13,
        "qty": qty,
        "inventory_adjust": inv_status,
    }


# ─── 일괄 입고 수령 (BranchInbound 전체 수령/발송 + WhInstructions 일괄 처리) ────────────
@router.post("/inbound/batch-receive")
def batch_receive_inbound(body: dict = Body(...), ctx: AuthContext = Depends(require_auth)):
    """N order_id 일괄 EXECUTED + inventory 일괄 증분 (1 transaction · 1 notification).

    이전: N items × (1 SQL select + 1 SQL update + 1 audit + 1 HTTP inventory + 1 HTTP notify)
    신규: 1 SQL fetch + bulk UPDATE pending_orders + executemany inventory + 1 audit + 1 notify

    body: {order_ids: ["uuid", ...]} (max 1000)
    """
    order_ids = body.get("order_ids", []) or []
    if not order_ids or len(order_ids) > 1000:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="order_ids 1~1000 개")

    valid: list[tuple] = []  # (order_id, target_loc, qty, isbn13, order_type)
    errors: list[str] = []

    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT po.order_id::text, po.order_type, po.target_location_id,
                       po.qty, po.isbn13, po.status,
                       tl.wh_id AS target_wh
                  FROM pending_orders po
                  LEFT JOIN locations tl ON tl.location_id = po.target_location_id
                 WHERE po.order_id = ANY(%s::uuid[])
                """,
                (order_ids,),
            )
            for r in cur.fetchall():
                oid, ot, tloc, qty, isbn, st, twh = r
                if st != "APPROVED":
                    if len(errors) < 20:
                        errors.append(f"{oid}: status={st}")
                    continue
                # 권한 검증
                if ctx.role == "branch-clerk":
                    if ctx.scope_store_id is None or ctx.scope_store_id != tloc:
                        if len(errors) < 20:
                            errors.append(f"{oid}: 자기 매장 외 (target={tloc})")
                        continue
                elif ctx.role == "wh-manager":
                    if ctx.scope_wh_id is None or ctx.scope_wh_id != twh:
                        if len(errors) < 20:
                            errors.append(f"{oid}: 자기 권역 외 (target_wh={twh})")
                        continue
                elif ctx.role != "hq-admin":
                    if len(errors) < 20:
                        errors.append(f"{oid}: 권한 없음")
                    continue
                valid.append((oid, tloc, int(qty or 0), isbn, ot))

            if not valid:
                conn.commit()
                return {"total": len(order_ids), "ok": 0, "failed": len(order_ids), "errors": errors}

            valid_oids = [v[0] for v in valid]
            # PR-B 4-step state machine v2: legacy batch-receive 가 CHECK 충족 위해 dispatched_at + executed_by 채움
            cur.execute(
                """UPDATE pending_orders SET status='EXECUTED',
                          dispatched_at=COALESCE(dispatched_at, NOW()),
                          dispatched_by=COALESCE(dispatched_by, %s),
                          executed_at=NOW(),
                          executed_by=%s
                    WHERE order_id = ANY(%s::uuid[])""",
                (ctx.user_id, ctx.user_id, valid_oids),
            )

            # 인벤토리 증분 — (isbn, location) 별 합산 후 executemany
            agg: dict[tuple, int] = {}
            for _, tloc, qty, isbn, _ in valid:
                if tloc is None:
                    continue
                k = (isbn, tloc)
                agg[k] = agg.get(k, 0) + qty
            if agg:
                cur.executemany(
                    """UPDATE inventory SET on_hand = on_hand + %s
                        WHERE isbn13 = %s AND location_id = %s""",
                    [(q, isbn, loc) for (isbn, loc), q in agg.items()],
                )

            cur.execute(
                """INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, after_state)
                   VALUES ('user', %s, 'inbound.batch_receive', 'pending_orders', %s, %s::jsonb)""",
                (ctx.user_id, valid[0][0],
                 json.dumps({"batch_size": len(valid), "inventory_aggregations": len(agg),
                             "sample_orders": valid_oids[:5]})),
            )
        conn.commit()

    # 단일 batch notification (per-order notify 안 보냄 · 합산)
    _notify(
        ctx.token, "OrderExecuted", severity="INFO",
        payload={
            "batch_size": len(valid),
            "approver_role": ctx.role,
            "approver_wh_id": ctx.scope_wh_id,
            "sample_order_ids": valid_oids[:5],
            "inventory_aggregations": len(agg),
        },
    )

    return {"total": len(order_ids), "ok": len(valid),
            "failed": len(order_ids) - len(valid), "errors": errors}


# ─── A1 inbound reject (FR-A6.6 · 수량 불일치/파손/누락) ──────────────────────────────────
@router.post("/inbound/{order_id}/reject")
def reject_inbound(
    order_id: str,
    body: dict = Body(...),
    ctx: AuthContext = Depends(require_auth),
):
    """매장/창고 입고 거부 — pending_orders.status='REJECTED' + audit_log + notification.

    Body: {"reject_reason": "...수량 불일치/파손/누락 사유"}

    권한:
      - branch-clerk: scope_store_id == target_location_id
      - wh-manager:   scope_wh_id   == target_wh
      - hq-admin:     모두 허용

    APPROVED → REJECTED 면 source 복원 (Option B). WH 에 알림 발행 → 후속 처리 (재출고 또는 반품).
    """
    reject_reason = (body.get("reject_reason") or "").strip()
    if not reject_reason:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="reject_reason 필수")

    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """SELECT order_type, target_location_id, qty, isbn13, status
                     FROM pending_orders WHERE order_id = %s""",
                (order_id,),
            )
            row = cur.fetchone()
            if row is None:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="order not found")
            order_type, target_loc, qty, isbn13, st = row
            if st != "APPROVED":
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=f"입고 거부는 APPROVED 상태에서만 가능 (현재 status={st})",
                )
            target_wh = _location_wh(cur, target_loc)

            # 권한 (수령과 동일 매트릭스)
            if ctx.role == "branch-clerk":
                if ctx.scope_store_id is None or ctx.scope_store_id != target_loc:
                    raise HTTPException(
                        status_code=status.HTTP_403_FORBIDDEN,
                        detail=f"자기 매장만 거부 가능 (scope_store_id={ctx.scope_store_id} · target={target_loc})",
                    )
            elif ctx.role == "wh-manager":
                if ctx.scope_wh_id is None or ctx.scope_wh_id != target_wh:
                    raise HTTPException(
                        status_code=status.HTTP_403_FORBIDDEN,
                        detail=f"자기 권역만 거부 가능 (scope_wh_id={ctx.scope_wh_id} · target_wh={target_wh})",
                    )
            elif ctx.role != "hq-admin":
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="입고 거부 권한 없음")

            # PR-B 4-step state machine v2: legacy 입고거부 (반품) — rejection_stage 자동 분기 (CHECK 충족)
            # APPROVED 상태에서 거부 시 rejection_stage='APPROVED', IN_TRANSIT 후 거부 시 'IN_TRANSIT'
            cur.execute(
                """UPDATE pending_orders SET status='REJECTED',
                          rejection_stage = CASE status
                            WHEN 'PENDING'    THEN 'PENDING'
                            WHEN 'APPROVED'   THEN 'APPROVED'
                            WHEN 'IN_TRANSIT' THEN 'IN_TRANSIT'
                          END,
                          reject_reason=%s
                    WHERE order_id = %s""",
                (reject_reason[:50], order_id),
            )
            # PR-B 4-step state machine v2: legacy 입고거부 — inventory 복원 불필요
            # (APPROVED 단계 시 source -qty 안 했으니 복원 X · 신규 흐름은 /orders/{id}/reject 사용)
            cur.execute(
                """INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, after_state)
                   VALUES ('user', %s, 'inbound.reject', 'pending_orders', %s, %s::jsonb)""",
                (ctx.user_id, order_id, json.dumps({
                    "status": "REJECTED", "qty": qty, "isbn13": isbn13,
                    "target_location_id": target_loc, "reject_reason": reject_reason,
                })),
            )
        conn.commit()

    # WH 에 알림 발행 (시트04 변형 · severity WARNING)
    _notify(
        ctx.token,
        "InboundRejected",
        severity="WARNING",
        payload={
            "order_id": order_id,
            "order_type": order_type,
            "isbn13": isbn13,
            "qty": qty,
            "target_location_id": target_loc,
            "target_wh_id": target_wh,
            "reject_reason": reject_reason,
        },
        correlation_id=order_id,
    )

    return {
        "order_id": order_id,
        "status": "REJECTED",
        "isbn13": isbn13,
        "qty": qty,
        "reject_reason": reject_reason,
    }
