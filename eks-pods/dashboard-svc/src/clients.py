"""httpx-based async clients for fan-in to other Pods.

Auth header forwarded as-is to downstream (mock token Phase 2 / real JWT Phase 4).
Per-route timeout · gather() for parallel fan-in · partial failure tolerated.
"""
import logging
from typing import Any

import httpx

from .settings import settings

log = logging.getLogger(__name__)

_client: httpx.AsyncClient | None = None


def init_client() -> None:
    global _client
    _client = httpx.AsyncClient(timeout=settings.fan_in_timeout_seconds)


async def close_client() -> None:
    if _client:
        await _client.aclose()


async def _safe_get(url: str, token: str) -> Any:
    try:
        r = await _client.get(url, headers={"Authorization": token})
        r.raise_for_status()
        return r.json()
    except Exception as e:
        log.warning("fan-in GET %s failed: %s", url, e)
        return None


async def get_warehouse_inventory(wh_id: int, token: str) -> dict | None:
    # NOTE: .pen Service Mesh spec is `/inventory/store/{id}`. Phase 3 path-alignment.
    return await _safe_get(f"{settings.inventory_svc_url}/inventory/current/{wh_id}", token)


async def get_forecast(store_id: int, snapshot_date: str, token: str) -> dict | None:
    return await _safe_get(f"{settings.forecast_svc_url}/forecast/{store_id}/{snapshot_date}", token)


async def get_pending_orders(token: str, limit: int = 50, order_type: str | None = None, wh_id: int | None = None) -> dict | None:
    """pending_orders 큐 - intervention-svc 의 role/scope 필터링된 큐 사용.

    intervention-svc 가 인증 토큰 의 role+scope_wh_id 기반으로 자동 필터:
    - hq-admin: 전체 (또는 명시적 wh_id/order_type)
    - wh-manager: scope_wh_id 자동 적용

    decision-svc /pending-orders 는 raw SELECT 라 권한 분리 미적용 → 사용 안 함.
    """
    qs = [f"limit={limit}"]
    if order_type:
        qs.append(f"order_type={order_type}")
    if wh_id is not None:
        qs.append(f"wh_id={wh_id}")
    return await _safe_get(f"{settings.intervention_svc_url}/intervention/queue?{'&'.join(qs)}", token)


async def get_intervention_queue(token: str, order_type: str | None = None, wh_id: int | None = None) -> dict | None:
    """intervention-svc 의 PENDING 큐 (V6.2 3-stage 권한 정합 필터)."""
    qs = []
    if order_type: qs.append(f"order_type={order_type}")
    if wh_id is not None: qs.append(f"wh_id={wh_id}")
    qstr = ("?" + "&".join(qs)) if qs else ""
    return await _safe_get(f"{settings.intervention_svc_url}/intervention/queue{qstr}", token)


async def get_notifications_recent(token: str, limit: int = 50) -> dict | None:
    """notification-svc 의 최근 알림 (`notifications_log`). Phase 3 까지 None."""
    return await _safe_get(f"{settings.notification_svc_url}/notification/recent?limit={limit}", token)


async def _safe_post(url: str, body: dict, token: str) -> tuple[int, Any]:
    """POST 프록시. (status_code, body_or_None) 반환. downstream pod 미배포면 503."""
    try:
        r = await _client.post(url, json=body, headers={"Authorization": token})
        return r.status_code, r.json() if r.content else None
    except Exception as e:
        log.warning("fan-in POST %s failed: %s", url, e)
        return 503, None


async def post_inventory_adjust(body: dict, token: str) -> tuple[int, Any]:
    """UX-6 Manual 재고 수동 조정 — inventory-svc /inventory/adjust 프록시.

    inventory-svc 가 single writer 라서 dashboard-svc 가 직접 DB 안 건드리고 proxy.
    """
    return await _safe_post(f"{settings.inventory_svc_url}/inventory/adjust", body, token)


async def post_inbound_receive(order_id: str, token: str) -> tuple[int, Any]:
    """UX-6 매장 입고 수령 — intervention-svc /intervention/inbound/{order_id}/receive 프록시."""
    return await _safe_post(
        f"{settings.intervention_svc_url}/intervention/inbound/{order_id}/receive", {}, token
    )


async def post_intervention_approve(body: dict, token: str) -> tuple[int, Any]:
    return await _safe_post(f"{settings.intervention_svc_url}/intervention/approve", body, token)


async def post_intervention_reject(body: dict, token: str) -> tuple[int, Any]:
    return await _safe_post(f"{settings.intervention_svc_url}/intervention/reject", body, token)


async def post_notification_send(body: dict, token: str) -> tuple[int, Any]:
    return await _safe_post(f"{settings.notification_svc_url}/notification/send", body, token)


async def post_decision_decide(body: dict, token: str) -> tuple[int, Any]:
    return await _safe_post(f"{settings.decision_svc_url}/decision/decide", body, token)


async def post_intervention_returns_approve(body: dict, token: str) -> tuple[int, Any]:
    return await _safe_post(f"{settings.intervention_svc_url}/intervention/returns/approve", body, token)


async def post_intervention_returns_reject(body: dict, token: str) -> tuple[int, Any]:
    """A4 (FR-A6.8) HQ 반품 거부 · body = {return_id, reject_reason}"""
    return await _safe_post(f"{settings.intervention_svc_url}/intervention/returns/reject", body, token)


async def post_intervention_new_book_approve(
    request_id: int, body: dict, token: str
) -> tuple[int, Any]:
    """body = { wh1_qty?: int, wh2_qty?: int }"""
    return await _safe_post(
        f"{settings.intervention_svc_url}/intervention/new-book-requests/{request_id}/approve",
        body or {},
        token,
    )


async def post_intervention_new_book_reject(
    request_id: int, body: dict, token: str
) -> tuple[int, Any]:
    """body = { reason?: str }"""
    return await _safe_post(
        f"{settings.intervention_svc_url}/intervention/new-book-requests/{request_id}/reject",
        body or {},
        token,
    )


async def post_intervention_book_status(isbn13: str, body: dict, token: str) -> tuple[int, Any]:
    """HQ 도서 ON/OFF + 소진 모드 (intervention-svc /intervention/books/{isbn13}/status)."""
    return await _safe_post(
        f"{settings.intervention_svc_url}/intervention/books/{isbn13}/status",
        body,
        token,
    )
