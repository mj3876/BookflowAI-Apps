"""notify — notification-svc /send 단일 publish helper.

기존 intervention.py 의 _notify 분리 (PR-B · 4-step state machine v2 정합).
fire-and-forget: 실패 시 log only, transition 자체는 성공.
"""
from __future__ import annotations

import logging

import httpx

from .settings import settings

log = logging.getLogger(__name__)


def _channels_for(event_type: str, severity: str) -> str:
    """severity 별 channel routing (intervention.py 와 동일 규약).
    CRITICAL → email,redis,websocket · HIGH → redis,websocket · 그 외 → redis,websocket
    """
    if severity == "CRITICAL":
        return "email,redis,websocket"
    return "redis,websocket"


def publish(token: str, event_type: str, severity: str, payload: dict,
            correlation_id: str | None = None) -> None:
    """notification-svc /send 호출.
    notification-svc 가 EVENT_CHANNEL 매핑에 따라 Redis publish + Logic Apps fan-out.

    payload 에 order_id / order_type / source_location_id / target_location_id / rejection_stage 포함 권장
    (frontend useLiveInvalidate 가 조건부 분기 위해).
    """
    body = {
        "event_type": event_type,
        "severity": severity,
        "recipients": [],
        "channels": _channels_for(event_type, severity),
        "payload_summary": payload,
    }
    if correlation_id:
        body["correlation_id"] = correlation_id
    auth_header = token if token.startswith("Bearer ") else f"Bearer {token}"
    try:
        with httpx.Client(timeout=2.0) as c:
            c.post(
                f"{settings.notification_svc_url}/notification/send",
                headers={"Authorization": auth_header},
                json=body,
            )
    except Exception as e:  # noqa: BLE001
        log.warning("notification-svc /send (%s) failed (non-fatal): %s", event_type, e)
