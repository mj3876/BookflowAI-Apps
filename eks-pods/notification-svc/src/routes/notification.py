"""notification routes:
- POST /notification/send       - dispatch single notification (Logic Apps webhook + Redis pub + RDS log)
- GET  /notification/recent     - recent notifications (used by dashboard fan-in)

V3 columns: notifications_log(notification_id UUID, event_type, correlation_id UUID, severity,
                              recipients jsonb, channels, payload_summary jsonb, sent_at, status)
"""
import asyncio
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

# Logic Apps 동시 호출 1건으로 제한 — ACS Rate Limit(429) 방지
_logic_apps_sem = asyncio.Semaphore(1)

_DEDUP_TTL = 300  # 5분 이내 동일 event_type + correlation_id 재발송 차단


def _check_and_set_dedup(event_type: str, correlation_id) -> bool:
    """Redis SET NX로 중복 발송 여부 확인.
    True  → 이미 발송됨(중복), Logic Apps 호출 건너뜀.
    False → 최초 발송, Redis 키 등록 후 진행.
    correlation_id 없으면 항상 False(차단 불가).
    Redis 장애 시 fail-open(발송 허용).
    """
    if correlation_id is None:
        return False
    key = f"notif:dedup:{event_type}:{correlation_id}"
    try:
        result = redis_client().set(key, 1, nx=True, ex=_DEDUP_TTL)
        return result is None  # None → 키 이미 존재 → 중복
    except Exception as e:
        log.warning("redis dedup check failed (fail-open): %s", e)
        return False


# event_type -> Redis 채널 매핑 (시트04 Pub/Sub matrix · 1:1 정렬)
#
# 시트04 Redis 채널 4종 (Pub/Sub):
#   stock.changed     - inventory-svc 가 직접 publish (notification-svc 경유 X)
#   order.pending     - 신규 PENDING 주문 발생 시점에만 (OrderPending 단 1종)
#   spike.detected    - SNS 급등 도서 (SpikeUrgent 단 1종)
#   newbook.request   - 출판사 신간 신청 (NewBookRequest 단 1종)
#
# PR-B (2026-05-15) 4-step state machine v2 정합 — 8 channel 로 확장:
#   order.pending     - PENDING 발의 (OrderPending · ReturnPending)
#   order.approved    - PENDING → APPROVED (OrderApproved · OrderApprovedFinal)
#   order.dispatched  - APPROVED → IN_TRANSIT (OrderDispatched · AutoExecutedUrgent · StockDepartPending · StockArrivalPending)
#   order.executed    - IN_TRANSIT → EXECUTED (OrderExecuted)
#   order.rejected    - any → REJECTED (OrderRejected · OrderRejectedAfterDispatch · AutoRejectedBatch · payload 에 rejection_stage 포함)
#   stock.changed     - inventory.on_hand 변동 (inventory-svc /adjust 가 직접 publish)
#   spike.detected    - SNS 급등 (SpikeUrgent)
#   newbook.request   - 신간 (NewBookRequest)
#
# 모든 order.* event 는 frontend useLiveInvalidate 가 invalidateQueries 트리거 (cross-user 정합).
EVENT_CHANNEL = {
    "OrderPending":             "order.pending",
    "OrderApproved":            "order.approved",      # PR-B 신규 (한쪽 동의)
    "OrderApprovedFinal":       "order.approved",      # PR-B 신규 (양측 ✓ 완료)
    "OrderDispatched":          "order.dispatched",    # PR-B 신규 (source 발송)
    "OrderExecuted":            "order.executed",
    "OrderRejected":            "order.rejected",
    "OrderRejectedAfterDispatch": "order.rejected",    # PR-B 신규 (IN_TRANSIT 후 반품 · rename from After Approval)
    "AutoExecutedUrgent":       "order.dispatched",    # 07:00 cron 자동 dispatch
    "AutoRejectedBatch":        "order.rejected",      # 18:00 cron 자동 reject
    "SpikeUrgent":              "spike.detected",
    "StockDepartPending":       "order.dispatched",
    "StockArrivalPending":      "order.dispatched",
    "NewBookRequest":           "newbook.request",
    "ReturnPending":            "order.pending",
}


# event_type → Logic Apps 워크플로 매핑
# notification/     → SpikeUrgent, NegotiationDelay, DailyPlanFinalized (긴급 알림)
# approval-request/ → ForecastCompleted (수요예측 완료 → 발주계획 승인요청), OrderPending (개별 승인요청)
# stock-depart/     → StockDepartPending (운송시작 도착지 담당자 1명)
# stock-arrival/    → StockArrivalPending (운송완료 출발지 담당자 1명)
_EVENT_LOGIC_APPS: dict[str, str] = {
    "ForecastCompleted":  "approval_request",
    "OrderPending":       "approval_request",   # la-bookflowmj-approval-request 의 OrderPending case (개별 발주 승인요청)
    "DailyPlanFinalized": "notification",
    "SpikeUrgent":        "notification",
    "NegotiationDelay":   "notification",
    "InboundRejected":    "notification",   # 5분 batch flush 경로 (main.py _flush_inbound_rejected)
    "StockDepartPending": "stock_depart",
    "StockArrivalPending":"stock_arrival",
}


def _get_logic_apps_url(event_type: str) -> str | None:
    """event_type 에 대응하는 Logic Apps SAS URL 반환. 미등록 또는 URL 미설정 시 None."""
    key = _EVENT_LOGIC_APPS.get(event_type)
    if key is None:
        return None
    url_map = {
        "notification":    settings.logic_apps_url,
        "approval_request":settings.logic_apps_approval_request_url,
        "stock_depart":    settings.logic_apps_stock_depart_url,
        "stock_arrival":   settings.logic_apps_stock_arrival_url,
    }
    url = url_map.get(key, "")
    return url.strip() or None


async def _post_logic_apps(
    event_type: str,
    severity: str,
    payload: dict,
    correlation_id,
    recipients: list[dict],
) -> tuple[bool, str | None]:
    url = _get_logic_apps_url(event_type)
    if not url:
        return False, f"logic_apps URL not configured for {event_type}"
    body = {
        "event_type": event_type,
        "severity": severity,
        "correlation_id": str(correlation_id) if correlation_id else None,
        "payload": payload,
        "recipients": recipients,
    }
    # ensure_ascii=False: 한글을 \uXXXX 이스케이프가 아닌 UTF-8 리터럴로 전송.
    # Logic Apps 가 \uXXXX 시퀀스를 디코딩하지 않으면 메일에 '????' 로 표시되는 문제 방지.
    body_bytes = json.dumps(body, ensure_ascii=False).encode("utf-8")
    try:
        async with _logic_apps_sem:
            async with httpx.AsyncClient(timeout=settings.logic_apps_timeout_seconds) as c:
                r = await c.post(
                    url,
                    content=body_bytes,
                    headers={"Content-Type": "application/json; charset=utf-8"},
                )
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
    elif _get_logic_apps_url(req.event_type):
        if _check_and_set_dedup(req.event_type, req.correlation_id):
            ok, err, new_status = True, None, "DEDUP"
        else:
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
