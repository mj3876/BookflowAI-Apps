"""intervention routes - V6.2 3-stage decision authority enforcement.

Stage / order_type / approval_side 행렬 (시트10 + 시트04 12 events):

| Stage | order_type        | approval_side    | 권한                                                    |
|-------|-------------------|------------------|-------------------------------------------------------|
| 1     | REBALANCE         | FINAL only       | wh-manager (SOURCE/TARGET 같은 wh - 자기 wh 만)            |
| 2     | WH_TRANSFER       | SOURCE / TARGET  | wh-manager (SOURCE 면 source location 의 wh, 동일)         |
| 3     | PUBLISHER_ORDER   | FINAL only       | hq-admin 만                                             |

Stage 2 양쪽 (SOURCE+TARGET) 모두 APPROVED → status=APPROVED 자동 전환.
hq-admin 은 모든 stage 의 FINAL 권한 가짐 (escalation).

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
from ..db import db_conn
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


def _location_wh(cur, location_id: int | None) -> int | None:
    """location_id → wh_id JOIN. None 입력 시 None (PUBLISHER_ORDER source 등)."""
    if location_id is None:
        return None
    cur.execute("SELECT wh_id FROM locations WHERE location_id = %s", (location_id,))
    row = cur.fetchone()
    return row[0] if row else None


def _validate_authority(cur, ctx: AuthContext, order_id: str, side: str) -> tuple[str, int | None, int | None]:
    """승인 권한 검증.

    Returns (order_type, source_wh, target_wh) for valid case. Raises 403 on violation.

    Rules:
    - REBALANCE  : approval_side='FINAL' only · approver wh == source/target wh (둘 다 같음)
    - WH_TRANSFER: approval_side in ('SOURCE','TARGET') · approver wh == 해당 side 의 wh
    - PUBLISHER_ORDER: approval_side='FINAL' only · role='hq-admin' only
    - hq-admin escalation: 어느 stage 의 FINAL 도 가능 (override)
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

    if order_type == "REBALANCE":
        if side != "FINAL":
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                                detail="REBALANCE 는 approval_side='FINAL' 만 허용 (단일 승인)")
        if ctx.role == "hq-admin":
            return order_type, source_wh, target_wh
        # FR-A6.6 매장 직원 입고 거부 — REBALANCE target 이 자기 매장이면 거부 권한
        if ctx.role == "branch-clerk":
            if ctx.scope_store_id is None:
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                                    detail="branch-clerk scope_store_id 부재 (인증 토큰 손상)")
            if ctx.scope_store_id != target_loc:
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                                    detail=f"자기 매장만 거부 가능 (scope_store_id={ctx.scope_store_id} · target={target_loc})")
            return order_type, source_wh, target_wh
        if ctx.role != "wh-manager" or ctx.scope_wh_id is None:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                                detail="REBALANCE 는 wh-manager · branch-clerk · hq-admin 만 승인 가능")
        if ctx.scope_wh_id not in (source_wh, target_wh):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                                detail=f"본인 창고 외 주문 승인 불가 (scope wh_id={ctx.scope_wh_id} · order wh_id={source_wh}/{target_wh})")

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
    limit: int = Query(default=50, ge=1, le=500),
    order_type: str | None = Query(default=None, description="REBALANCE | WH_TRANSFER | PUBLISHER_ORDER"),
    wh_id: int | None = Query(default=None, description="해당 wh 가 source 또는 target 인 주문만"),
    date: str | None = Query(default=None, description="특정 일자 (YYYY-MM-DD KST) · history detail 용. 주어지면 그 날 처리 row 만"),
    include_history: bool = Query(default=False, description="(deprecated) 과거 처리 row 포함 — 사용 자제. /queue/summary + date 조합 권장"),
    days: int = Query(default=7, ge=1, le=400, description="include_history=true 일 때 조회 기간 (일 · 최대 400)"),
):
    """주문 큐. role 기반 자동 필터:

    - default: PENDING 만 (오늘 처리 대기)
    - date=YYYY-MM-DD: 그 일자 (KST · approved_at|executed_at|created_at) 의 row 만
    - include_history=true (deprecated): PENDING + 최근 N일 처리 row. summary+date 로 대체.
    """
    params: list = []
    if date is not None:
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

    params.append(limit)
    # date / history 모드: 최신 처리/생성 순. PENDING 모드: urgency 우선 + 오래된 것 먼저.
    order_clause = (
        "ORDER BY COALESCE(po.approved_at, po.executed_at, po.created_at) DESC"
        if (include_history or date is not None) else
        "ORDER BY po.urgency_level DESC, po.created_at ASC"
    )
    # 응답 size 줄이기: forecast_rationale 은 detail 호출 시만 (date 또는 PENDING 모드).
    # summary 호환 모드 (include_history 만) 는 rationale 제외 — 가벼운 응답.
    select_rationale = (date is not None) or (not include_history)
    rationale_col = "po.forecast_rationale" if select_rationale else "NULL::jsonb"
    sql = f"""
        SELECT po.order_id, po.order_type, po.isbn13,
               po.source_location_id, po.target_location_id, po.qty,
               po.urgency_level, po.auto_execute_eligible, po.status, po.created_at,
               {rationale_col}, b.title,
               po.approved_at, po.executed_at
          FROM pending_orders po
          LEFT JOIN books b ON b.isbn13 = po.isbn13
         WHERE {' AND '.join(where)}
         {order_clause}
         LIMIT %s
    """
    with db_conn() as conn, conn.cursor() as cur:
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
        )
        for r in rows
    ]
    return QueueResponse(items=items)


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
    #  - REBALANCE / PUBLISHER_ORDER: FINAL APPROVED 1번 → APPROVED
    #  - WH_TRANSFER: SOURCE+TARGET 둘 다 APPROVED → APPROVED
    #  - REJECTED: 어느 side 든 한 번 거절 → REJECTED + reject_count++
    if decision == "APPROVED" and side == "FINAL":
        cur.execute(
            "UPDATE pending_orders SET status = 'APPROVED', approved_at = NOW() WHERE order_id = %s",
            (order_id,),
        )
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
    elif decision == "REJECTED":
        cur.execute(
            "UPDATE pending_orders SET status = 'REJECTED', reject_reason = %s, reject_count = reject_count + 1 WHERE order_id = %s",
            (reject_reason, order_id),
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
    return ApprovalResponse(approval_id=aid, order_id=req.order_id, decision="APPROVED", decided_at=decided_at)


@router.post("/reject", response_model=ApprovalResponse)
def reject(req: RejectRequest, ctx: AuthContext = Depends(require_auth)):
    with db_conn() as conn:
        with conn.cursor() as cur:
            order_type, source_wh, target_wh = _validate_authority(cur, ctx, str(req.order_id), req.approval_side)
        aid, decided_at = _record_approval(conn, str(req.order_id), ctx, req.approval_side, "REJECTED", req.reject_reason)
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
    return ApprovalResponse(approval_id=aid, order_id=req.order_id, decision="REJECTED", decided_at=decided_at)


@router.post("/intervene/batch")
def intervene_batch(body: dict = Body(...), ctx: AuthContext = Depends(require_auth)):
    """일괄 승인/거절 (사용자 결정 2026-05-13).

    frontend N 회 호출 → backend 1 회로 통합. 503 race + 느림 해소.
    body: {action: 'approve'|'reject', items: [{order_id, approval_side, reject_reason?}]}
    response: {total, ok, failed, errors}
    """
    action = body.get("action")
    items = body.get("items", [])
    if action not in ("approve", "reject"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="action 은 'approve' 또는 'reject'")
    if not items or len(items) > 1000:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="items 는 1~1000 개")

    ok = 0
    failed = 0
    errors: list[str] = []
    for it in items:
        try:
            if action == "approve":
                req = ApproveRequest(
                    order_id=it["order_id"],
                    approval_side=it.get("approval_side", "FINAL"),
                    note=it.get("note"),
                )
                approve(req, ctx)
            else:
                req2 = RejectRequest(
                    order_id=it["order_id"],
                    approval_side=it.get("approval_side", "FINAL"),
                    reject_reason=it.get("reject_reason", "일괄 거절"),
                )
                reject(req2, ctx)
            ok += 1
        except HTTPException as e:
            failed += 1
            if len(errors) < 20:
                errors.append(f"{it.get('order_id', '?')}: {e.detail}")
        except Exception as e:
            failed += 1
            if len(errors) < 20:
                errors.append(f"{it.get('order_id', '?')}: {str(e)[:100]}")

    return {"total": len(items), "ok": ok, "failed": failed, "errors": errors}


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
            for wh_id, qty in [(1, wh1_qty), (2, wh2_qty)]:
                if qty <= 0:
                    continue
                cur.execute(
                    "SELECT location_id FROM locations WHERE wh_id = %s AND location_type = 'WAREHOUSE' LIMIT 1",
                    (wh_id,),
                )
                loc = cur.fetchone()
                target_loc = loc[0] if loc else wh_id  # fallback
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
                new_orders.append({"order_id": str(order_id), "wh_id": wh_id, "qty": qty})

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

            # status=EXECUTED + executed_at + audit
            cur.execute(
                """UPDATE pending_orders SET status='EXECUTED', executed_at=NOW()
                    WHERE order_id = %s""",
                (order_id,),
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

    재고 변동 없음 (single writer 룰 — 수령 X). WH 에 알림 발행 → 후속 처리 (재출고 또는 반품).
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

            # pending_orders 에 rejected_at 컬럼 없음 (schema). reject_reason VARCHAR(50) 만 있음.
            # 거부 시점은 audit_log 의 created_at 으로 추적.
            cur.execute(
                """UPDATE pending_orders SET status='REJECTED', reject_reason=%s
                    WHERE order_id = %s""",
                (reject_reason[:50], order_id),
            )
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
