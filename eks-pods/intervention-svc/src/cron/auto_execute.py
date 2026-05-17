"""08:00 KST 발의일 일괄 batch — 자동 승인 + 미처리 자동 거절 CronJob entrypoint.

발의된 cascade 계획은 발의 당일 08:00 batch 로 전부 종결된다 (이후 PENDING 잔존 없음):

자동 승인 (auto_execute_eligible=True · status=PENDING):
  - decision-svc 가 URGENT/CRITICAL 주문에 auto_execute_eligible=True 마킹
  - 08:00 batch 에서 일괄 APPROVED 전환 + AutoExecutedUrgent 알림

미처리 자동 거절 (위 자동 승인 후에도 status=PENDING 인 잔존분):
  - 08:00 까지 사람이 승인하지 않은 NORMAL 주문 = 기본값 거절
  - 일괄 REJECTED 종결 + AutoRejectedBatch 알림

실행 방법:
  python -m src.cron.auto_execute

EKS CronJob schedule: '0 23 * * *' (UTC) == 08:00 KST
"""
import json
import logging
import os
import sys
from uuid import uuid4

import httpx
import psycopg

log = logging.getLogger("auto-execute")
logging.basicConfig(level=os.environ.get("INTERVENTION_LOG_LEVEL", "INFO"),
                    format="%(asctime)s %(levelname)s %(name)s %(message)s")

NOTIFICATION_SVC_URL = os.environ.get(
    "INTERVENTION_NOTIFICATION_SVC_URL",
    "http://notification-svc.bookflow.svc.cluster.local",
)
SYSTEM_TOKEN = "Bearer mock-token-system"
SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000099"


def _conn():
    return psycopg.connect(
        host=os.environ["INTERVENTION_RDS_HOST"],
        port=int(os.environ.get("INTERVENTION_RDS_PORT", "5432")),
        dbname=os.environ.get("INTERVENTION_RDS_DB", "bookflow"),
        user=os.environ["INTERVENTION_RDS_USER"],
        password=os.environ["INTERVENTION_RDS_PASSWORD"],
    )


# Logic Apps 발송 대상 (Notion 알람 명세 2026-05-13 정합).
_LOGIC_APPS_EVENTS = {
    "AutoExecutedUrgent", "DailyPlanFinalized", "SpikeUrgent",
    "ApprovalDelayed", "InboundRejected", "NewBookRequest",
    "LambdaAlarm", "DeploymentRollback",
}


def _channels_for(event_type: str, severity: str) -> str:
    if event_type in _LOGIC_APPS_EVENTS:
        if severity == "CRITICAL":
            return "redis,websocket,logic-apps,sms"
        return "websocket,logic-apps"
    return "redis,websocket"


def _notify(event_type: str, severity: str, payload: dict, correlation_id: str | None = None) -> None:
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
                headers={"Authorization": SYSTEM_TOKEN},
                json=body,
            )
    except Exception as e:
        log.warning("notification-svc /send (%s) failed (non-fatal): %s", event_type, e)


def _approve_auto_eligible(conn) -> list[dict]:
    """auto_execute_eligible=True · status=PENDING → APPROVED 일괄 전환."""
    approved: list[dict] = []
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT order_id, order_type, isbn13, source_location_id, target_location_id, qty, urgency_level
              FROM pending_orders
             WHERE status = 'PENDING'
               AND auto_execute_eligible = TRUE
             ORDER BY urgency_level DESC, created_at ASC
            """
        )
        rows = cur.fetchall()
        for r in rows:
            order_id, order_type, isbn13, src, tgt, qty, urgency = r
            approval_id = str(uuid4())
            cur.execute(
                """
                INSERT INTO order_approvals
                    (approval_id, order_id, approver_id, approver_role, approver_wh_id,
                     approval_side, decision, reject_reason)
                VALUES (%s::uuid, %s::uuid, %s::varchar, 'system'::varchar, NULL,
                        'FINAL'::varchar, 'APPROVED'::varchar, NULL)
                ON CONFLICT (order_id, approval_side) DO UPDATE
                  SET decision = 'APPROVED', approver_id = EXCLUDED.approver_id,
                      approver_role = 'system', decided_at = NOW()
                """,
                (approval_id, str(order_id), SYSTEM_USER_ID),
            )
            cur.execute(
                "UPDATE pending_orders SET status = 'APPROVED', approved_at = NOW() WHERE order_id = %s",
                (str(order_id),),
            )
            cur.execute(
                """
                INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, after_state)
                VALUES ('system', %s, 'intervention.auto_execute', 'pending_orders', %s, %s::jsonb)
                """,
                (SYSTEM_USER_ID, str(order_id),
                 json.dumps({"order_type": order_type, "urgency": urgency, "auto": True})),
            )
            approved.append({
                "order_id": str(order_id), "order_type": order_type, "isbn13": isbn13,
                "source_location_id": src, "target_location_id": tgt, "qty": qty,
                "urgency_level": urgency,
            })
    conn.commit()
    return approved


def _reject_remaining_pending(conn) -> list[dict]:
    """자동 승인 후에도 status=PENDING 인 잔존분 → REJECTED 일괄 종결.

    발의 당일 08:00 batch: URGENT/CRITICAL 자동 승인 후 남은 PENDING =
    08:00 까지 사람이 승인하지 않은 NORMAL 주문 → 기본값(미승인=거절)으로 종결.
    이 함수는 반드시 _approve_auto_eligible 다음에 호출 (그래야 URGENT 가 제외됨).
    """
    rejected: list[dict] = []
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT order_id, order_type, isbn13, qty
              FROM pending_orders
             WHERE status = 'PENDING'
             ORDER BY created_at ASC
            """
        )
        rows = cur.fetchall()
        for r in rows:
            order_id, order_type, isbn13, qty = r
            # PR-B 4-step state machine v2: rejection_stage='PENDING' (자동 reject 는 PENDING 상태에서만 작동)
            cur.execute(
                """
                UPDATE pending_orders
                   SET status = 'REJECTED',
                       rejection_stage = 'PENDING',
                       reject_reason = COALESCE(reject_reason, '발의일 08:00 batch 미승인 자동 거절')
                 WHERE order_id = %s
                """,
                (str(order_id),),
            )
            cur.execute(
                """
                INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, after_state)
                VALUES ('system', %s, 'intervention.auto_reject_batch', 'pending_orders', %s, %s::jsonb)
                """,
                (SYSTEM_USER_ID, str(order_id),
                 json.dumps({"order_type": order_type, "auto": True, "reason": "08:00_batch_unhandled"})),
            )
            rejected.append({"order_id": str(order_id), "order_type": order_type,
                             "isbn13": isbn13, "qty": qty})
    conn.commit()
    return rejected


def main() -> int:
    log.info("intervention auto-execute cron start")
    try:
        with _conn() as conn:
            approved = _approve_auto_eligible(conn)
            rejected = _reject_remaining_pending(conn)
    except Exception as e:
        log.exception("cron failed: %s", e)
        return 1

    log.info("auto-approved=%d, auto-rejected=%d", len(approved), len(rejected))

    # Notion 알람 명세 (2026-05-13): AutoExecutedUrgent 는 묶음 1회만 발송 (N건 본사 검토 필요)
    if approved:
        critical_count = sum(1 for o in approved if o["urgency_level"] == "CRITICAL")
        urgent_count = len(approved) - critical_count
        _notify(
            "AutoExecutedUrgent",
            severity="CRITICAL" if critical_count else "WARNING",
            payload={
                "total": len(approved),
                "critical": critical_count,
                "urgent": urgent_count,
                "items": approved[:10],  # top 10 sample
            },
        )

    # 시트04 ⑤AutoRejectedBatch (1건 묶음 알림)
    if rejected:
        _notify(
            "AutoRejectedBatch",
            severity="WARNING",
            payload={
                "count": len(rejected),
                "items": rejected[:20],
            },
        )

    return 0


if __name__ == "__main__":
    sys.exit(main())
