"""notification routes:
- POST /notification/send       - dispatch single notification (Logic Apps webhook + Redis pub + RDS log)
- GET  /notification/recent     - recent notifications (used by dashboard fan-in)

V3 columns: notifications_log(notification_id UUID, event_type, correlation_id UUID, severity,
                              recipients jsonb, channels, payload_summary jsonb, sent_at, status)
"""
import json
import logging
from uuid import uuid4

import httpx
from fastapi import APIRouter, Depends, Query

from ..auth import AuthContext, require_auth
from ..db import db_conn, redis_client
from datetime import datetime, timezone
from fastapi import HTTPException, status

from ..models import (
    BranchFeedbackRequest,
    BranchFeedbackResponse,
    NotificationRow,
    RecentResponse,
    SendRequest,
    SendResponse,
)
from ..recipients import get_recipients
from ..settings import settings

log = logging.getLogger(__name__)
router = APIRouter(prefix="/notification", tags=["notification"])


# event_type -> Redis 채널 매핑 (시트04 Pub/Sub matrix · 1:1 정렬)
#
# 시트04 Redis 채널 4종 (Pub/Sub):
#   stock.changed     - inventory-svc 가 직접 publish (notification-svc 경유 X)
#   order.pending     - 신규 PENDING 주문 발생 시점에만 (OrderPending 단 1종)
#   spike.detected    - SNS 급등 도서 (SpikeUrgent 단 1종)
#   newbook.request   - 출판사 신간 신청 (NewBookRequest 단 1종)
#
# 시트04 12 + 운영 확장 1 = 13 events.
# 위 4 종 (Order/Spike/NewBook) 만 Redis 채널 publish, 나머지는 Logic Apps webhook 만.
# OrderExecuted = 운영 확장 (매장 수령 처리 시점 · 시트04 미정의 · A1 inbound receive 신설).
EVENT_CHANNEL = {
    "OrderPending":         "order.pending",
    "OrderApproved":        None,
    "OrderRejected":        None,
    "OrderExecuted":        None,
    "AutoExecutedUrgent":   None,
    "AutoRejectedBatch":    None,
    "SpikeUrgent":          "spike.detected",
    "StockDepartPending":   None,
    "StockArrivalPending":  None,
    "NewBookRequest":       "newbook.request",
    "ReturnPending":        None,
}


_LOGIC_APPS_EVENTS = {
    "AutoExecutedUrgent", "DailyPlanFinalized", "SpikeUrgent",
    "ApprovalDelayed", "InboundRejected", "NewBookRequest",
    "LambdaAlarm", "DeploymentRollback",
}


def _needs_logic_apps(event_type: str) -> bool:
    """Return whether this event should invoke Logic Apps email delivery."""
    return event_type in _LOGIC_APPS_EVENTS


def _logic_apps_endpoint(event_type: str) -> str:
    base = settings.logic_apps_url.rstrip("/")
    if "/triggers/" in base or "sig=" in base:
        return base
    return f"{base}/workflow/{event_type}"


async def _post_logic_apps(
    event_type: str,
    severity: str,
    payload: dict,
    correlation_id,
    recipients: list[dict],
) -> tuple[bool, str | None]:
    body = {
        "event_type": event_type,
        "severity": severity,
        "correlation_id": str(correlation_id) if correlation_id else None,
        "payload": payload,
        "recipients": recipients,  # [{address, displayName}] → ACS Email 수신자
    }
    url = _logic_apps_endpoint(event_type)
    try:
        async with httpx.AsyncClient(timeout=settings.logic_apps_timeout_seconds) as c:
            r = await c.post(url, json=body)
            return (200 <= r.status_code < 300), None if r.is_success else f"{r.status_code} {r.text[:80]}"
    except Exception as e:
        return False, str(e)[:120]


@router.post("/send", response_model=SendResponse)
async def send(req: SendRequest, ctx: AuthContext = Depends(require_auth)) -> SendResponse:
    notification_id = uuid4()

    # InboundRejected: 5분 batch 집계를 위해 Redis 버퍼에 적재 (즉시 발송 X)
    if req.event_type == "InboundRejected":
        wh_id = req.payload_summary.get("target_wh_id", 0)
        try:
            redis_client().rpush(f"inbound_rejected_buffer:{wh_id}", json.dumps(req.payload_summary))
            ok, err = True, None
        except Exception as e:
            ok, err = False, str(e)[:120]
        new_status = "BUFFERED" if ok else "FAILED"
    elif _needs_logic_apps(req.event_type):
        recipients = get_recipients(req.event_type, req.payload_summary)
        ok, err = await _post_logic_apps(
            req.event_type,
            req.severity,
            req.payload_summary,
            req.correlation_id,
            recipients,
        )
        new_status = "SENT" if ok else "FAILED"
    else:
        ok, err, new_status = True, None, "SKIPPED"

    insert_sql = """
        INSERT INTO notifications_log
            (notification_id, event_type, correlation_id, severity,
             recipients, channels, payload_summary, status)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        RETURNING sent_at
    """
    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(insert_sql, (
                str(notification_id), req.event_type,
                str(req.correlation_id) if req.correlation_id else None,
                req.severity,
                json.dumps(req.recipients) if req.recipients else None,
                req.channels,
                json.dumps(req.payload_summary),
                new_status,
            ))
            sent_at = cur.fetchone()[0]
            cur.execute(
                """
                INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, after_state)
                VALUES ('user', %s, 'notification.send', 'notifications_log', %s, %s)
                """,
                (ctx.user_id, str(notification_id),
                 json.dumps({"event_type": req.event_type, "severity": req.severity, "status": new_status, "error": err})),
            )
        conn.commit()

    # Redis publish (event_type 별 채널 분기)
    channel = EVENT_CHANNEL.get(req.event_type)
    if channel:
        try:
            redis_client().publish(channel, json.dumps({
                "notification_id": str(notification_id),
                "event_type": req.event_type,
                "severity": req.severity,
                **req.payload_summary,
            }))
        except Exception as e:
            log.warning("redis publish %s failed: %s", channel, e)

    return SendResponse(
        notification_id=notification_id,
        event_type=req.event_type,
        status=new_status,
        sent_at=sent_at,
    )


@router.post("/branch-feedback", response_model=BranchFeedbackResponse)
def branch_feedback(req: BranchFeedbackRequest, ctx: AuthContext = Depends(require_auth)):
    """D5-8 Notion 3.5 · 매장 → 본사/물류 의견 제출.

    권한: branch-clerk 만. notifications_log INSERT (event_type='BranchFeedback')
    + 본사/물류센터 알림 + audit_log.
    """
    if ctx.role != "branch-clerk":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="branch-clerk 만 의견 제출 가능")
    if ctx.scope_store_id is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="scope_store_id 부재 (토큰 손상)")

    notification_id = uuid4()
    payload = {
        "feedback_type": req.feedback_type,
        "isbn13": req.isbn13,
        "message": req.message,
        "from_store_id": ctx.scope_store_id,
        "from_user": ctx.user_id,
    }
    insert_sql = """
        INSERT INTO notifications_log
            (notification_id, event_type, correlation_id, severity,
             recipients, channels, payload_summary, status)
        VALUES (%s, 'BranchFeedback', NULL, 'INFO',
                %s, NULL, %s, 'SENT')
        RETURNING sent_at
    """
    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(insert_sql, (
                str(notification_id),
                json.dumps(["hq-admin", f"wh-manager-store-{ctx.scope_store_id}"]),
                json.dumps(payload),
            ))
            sent_at = cur.fetchone()[0]
        conn.commit()

    return BranchFeedbackResponse(
        notification_id=notification_id,
        feedback_type=req.feedback_type,
        submitted_at=sent_at if isinstance(sent_at, datetime) else datetime.now(timezone.utc),
    )


@router.get("/recent", response_model=RecentResponse)
def recent(
    _: AuthContext = Depends(require_auth),
    limit: int = Query(default=50, ge=1, le=500),
):
    sql = """
        SELECT notification_id, event_type, correlation_id, severity,
               channels, payload_summary, sent_at, status
          FROM notifications_log
         ORDER BY sent_at DESC
         LIMIT %s
    """
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, (limit,))
        rows = cur.fetchall()

    items = [
        NotificationRow(
            notification_id=r[0], event_type=r[1], correlation_id=r[2],
            severity=r[3], channels=r[4], payload_summary=r[5],
            sent_at=r[6], status=r[7],
        )
        for r in rows
    ]
    return RecentResponse(items=items)
