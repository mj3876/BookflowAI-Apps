"""07:00 KST 자동 승인 / 누적 거절 일괄 처리 CronJob entrypoint.

V6.2 시트04 ④AutoExecutedUrgent · ⑤AutoRejectedBatch 정합:

자동 승인 (auto_execute_eligible=True · status=PENDING):
  - decision-svc 가 Stage 1 + URGENT/CRITICAL 주문에 auto_execute_eligible=True 마킹
  - 07:00 KST 시점에 일괄 APPROVED 전환 + AutoExecutedUrgent 알림

누적 거절 (reject_count >= 2 · status=PENDING):
  - WH 매니저가 두 번 이상 거절 (SOURCE/TARGET 양쪽 또는 재발의)
  - 일괄 REJECTED 종결 + AutoRejectedBatch 알림

실행 방법:
  python -m src.cron.auto_execute

EKS CronJob schedule: '0 22 * * *' (UTC) == 07:00 KST
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


def _notify(event_type: str, severity: str, payload: dict, correlation_id: str | None = None) -> None:
    body = {
        "event_type": event_type,
        "severity": severity,
        "recipients": [],
        "channels": "websocket,logic-apps",
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


def _reject_overaccumulated(conn) -> list[dict]:
    """reject_count >= 2 · status=PENDING → REJECTED (배치 종결)."""
    rejected: list[dict] = []
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT order_id, order_type, isbn13, qty, reject_count
              FROM pending_orders
             WHERE status = 'PENDING'
               AND reject_count >= 2
             ORDER BY reject_count DESC, created_at ASC
            """
        )
        rows = cur.fetchall()
        for r in rows:
            order_id, order_type, isbn13, qty, rc = r
            cur.execute(
                """
                UPDATE pending_orders
                   SET status = 'REJECTED',
                       reject_reason = COALESCE(reject_reason, '누적 거절 자동 종결')
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
                 json.dumps({"reject_count": rc, "order_type": order_type, "auto": True})),
            )
            rejected.append({"order_id": str(order_id), "order_type": order_type, "isbn13": isbn13,
                             "qty": qty, "reject_count": rc})
    conn.commit()
    return rejected


def main() -> int:
    log.info("intervention auto-execute cron start")
    try:
        with _conn() as conn:
            approved = _approve_auto_eligible(conn)
            rejected = _reject_overaccumulated(conn)
    except Exception as e:
        log.exception("cron failed: %s", e)
        return 1

    log.info("auto-approved=%d, auto-rejected=%d", len(approved), len(rejected))

    # 시트04 ④AutoExecutedUrgent (개별 알림 · severity=WARNING/CRITICAL)
    for o in approved:
        _notify(
            "AutoExecutedUrgent",
            severity="CRITICAL" if o["urgency_level"] == "CRITICAL" else "WARNING",
            payload=o,
            correlation_id=o["order_id"],
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
