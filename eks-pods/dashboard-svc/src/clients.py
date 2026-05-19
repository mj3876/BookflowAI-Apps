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


async def get_pending_orders(
    token: str,
    limit: int = 50,
    offset: int = 0,
    order_type: str | None = None,
    wh_id: int | None = None,
    include_history: bool = False,
    days: int = 7,
    date: str | None = None,
    expected_date: str | None = None,
) -> dict | None:
    """pending_orders 큐 - intervention-svc 의 role/scope 필터링된 큐 사용.

    - expected_date=YYYY-MM-DD: expected_arrival_at 기반 — 캘린더 cell click 정합 (PR-C v2)
    - date=YYYY-MM-DD: COALESCE(approved_at, executed_at, created_at) 기반 (legacy)
    - include_history=true (deprecated): PENDING + 최근 N일. summary+date 로 대체 권장.
    - offset: 페이지네이션 (limit 이전 row skip).
    """
    qs = [f"limit={limit}"]
    if offset:
        qs.append(f"offset={offset}")
    if order_type:
        qs.append(f"order_type={order_type}")
    if wh_id is not None:
        qs.append(f"wh_id={wh_id}")
    if expected_date:
        qs.append(f"expected_date={expected_date}")
    elif date:
        qs.append(f"date={date}")
    elif include_history:
        qs.append("include_history=true")
        qs.append(f"days={days}")
    return await _safe_get(f"{settings.intervention_svc_url}/intervention/queue?{'&'.join(qs)}", token)


async def get_pending_summary(
    token: str,
    days: int = 7,
    order_type: str | None = None,
    wh_id: int | None = None,
) -> dict | None:
    """일자별 status count 가벼운 summary — DateHistoryTabs pill row 카운트용.

    /intervention/queue/summary 프록시. 응답 = {days, items: [{date, PENDING, APPROVED, ...}]}
    """
    qs = [f"days={days}"]
    if order_type:
        qs.append(f"order_type={order_type}")
    if wh_id is not None:
        qs.append(f"wh_id={wh_id}")
    return await _safe_get(f"{settings.intervention_svc_url}/intervention/queue/summary?{'&'.join(qs)}", token)


async def get_intervention_queue(token: str, order_type: str | None = None, wh_id: int | None = None) -> dict | None:
    """intervention-svc 의 PENDING 큐 (V6.2 3-stage 권한 정합 필터)."""
    qs = []
    if order_type: qs.append(f"order_type={order_type}")
    if wh_id is not None: qs.append(f"wh_id={wh_id}")
    qstr = ("?" + "&".join(qs)) if qs else ""
    return await _safe_get(f"{settings.intervention_svc_url}/intervention/queue{qstr}", token)


async def get_intervention_grouped(token: str, date: str | None = None) -> dict | None:
    """오늘 batch 처리 현황 + 사용자 검토 필요 건수 (role-scope 자동 · D2 Home 카드용)."""
    qstr = f"?date={date}" if date else ""
    return await _safe_get(f"{settings.intervention_svc_url}/intervention/grouped{qstr}", token)


async def get_notifications_recent(token: str, limit: int = 50) -> dict | None:
    """notification-svc 의 최근 알림 (`notifications_log`). Phase 3 까지 None."""
    return await _safe_get(f"{settings.notification_svc_url}/notification/recent?limit={limit}", token)


async def _safe_post(url: str, body: dict, token: str, timeout: float | None = None) -> tuple[int, Any]:
    """POST 프록시. (status_code, body_or_None) 반환. downstream pod 미배포면 503.

    timeout: None 이면 _client 기본값 · 큰 batch 요청은 60s 등 override.
    transient connection error (cold start · pod rollout 중) 시 최대 3회 재시도 (0.3s/0.8s).
    """
    import asyncio
    last_err: Exception | None = None
    for attempt in range(3):
        try:
            if timeout is not None:
                r = await _client.post(url, json=body, headers={"Authorization": token}, timeout=timeout)
            else:
                r = await _client.post(url, json=body, headers={"Authorization": token})
            return r.status_code, r.json() if r.content else None
        except (httpx.ConnectError, httpx.RemoteProtocolError, httpx.ReadTimeout, httpx.ConnectTimeout) as e:
            last_err = e
            if attempt < 2:
                await asyncio.sleep(0.3 * (attempt + 1))
                continue
        except Exception as e:
            log.warning("fan-in POST %s failed (non-retryable): %s", url, e)
            return 503, None
    log.warning("fan-in POST %s failed after 3 retries: %s", url, last_err)
    return 503, None


async def _safe_patch(url: str, body: dict, token: str) -> tuple[int, Any]:
    """PATCH 프록시. D5-7 pending order 수정 proxy 용. transient retry 동일 패턴."""
    import asyncio
    last_err: Exception | None = None
    for attempt in range(3):
        try:
            r = await _client.patch(url, json=body, headers={"Authorization": token})
            return r.status_code, r.json() if r.content else None
        except (httpx.ConnectError, httpx.RemoteProtocolError, httpx.ReadTimeout, httpx.ConnectTimeout) as e:
            last_err = e
            if attempt < 2:
                await asyncio.sleep(0.3 * (attempt + 1))
                continue
        except Exception as e:
            log.warning("fan-in PATCH %s failed (non-retryable): %s", url, e)
            return 503, None
    log.warning("fan-in PATCH %s failed after 3 retries: %s", url, last_err)
    return 503, None


async def patch_intervention_pending_order(order_id: str, body: dict, token: str) -> tuple[int, Any]:
    """D5-7 WH AI 추천 수정 — intervention-svc PATCH /pending-orders/{id} 프록시."""
    return await _safe_patch(
        f"{settings.intervention_svc_url}/intervention/pending-orders/{order_id}", body, token
    )


async def post_branch_feedback(body: dict, token: str) -> tuple[int, Any]:
    """D5-8 Branch → 본사/물류 의견 제출 — notification-svc POST /branch-feedback 프록시."""
    return await _safe_post(f"{settings.notification_svc_url}/notification/branch-feedback", body, token)


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


async def get_insufficient_stock(token: str, limit: int = 20) -> dict | None:
    """P1-4b 시연 trigger — forecast-svc /forecast/insufficient-stock 프록시."""
    return await _safe_get(
        f"{settings.forecast_svc_url}/forecast/insufficient-stock?limit={limit}", token
    )


async def post_newbook_predict_demand(body: dict, token: str, mode: str = "auto") -> tuple[int, Any]:
    """v5 2026-05-15: VertexAI 신간 수요예측 — forecast-svc /forecast/newbook/predict-demand 프록시.

    mode (2026-05-19): mock = 항상 동작하는 임시 분포 · real = 실제 GCP/Vertex 호출 · auto = 기존 동작.
    """
    return await _safe_post(
        f"{settings.forecast_svc_url}/forecast/newbook/predict-demand?mode={mode}", body, token
    )


async def post_spike_predict_demand(body: dict, token: str, mode: str = "auto") -> tuple[int, Any]:
    """SNS 급등 발주용 수요예측 — forecast-svc /forecast/spike/predict-demand 프록시.

    body = {isbn13, z_score?, mentions?, category?}
    mode: mock = z-score 기반 추정 (GCP 무관) · real = 실제 Vertex 호출 · auto = 기존 동작.
    """
    return await _safe_post(
        f"{settings.forecast_svc_url}/forecast/spike/predict-demand?mode={mode}", body, token
    )


async def post_intervention_spike_approve(
    event_id: str, body: dict, token: str
) -> tuple[int, Any]:
    """SNS 급등 발주 승인 — intervention-svc /intervention/spike-events/{id}/approve 프록시.

    body = { wh1_qty?: int, wh2_qty?: int }. 승인 시 PUBLISHER_ORDER status=APPROVED 즉시 생성.
    """
    return await _safe_post(
        f"{settings.intervention_svc_url}/intervention/spike-events/{event_id}/approve",
        body or {},
        token,
    )


async def post_inbound_reject(order_id: str, body: dict, token: str) -> tuple[int, Any]:
    """P1-2 매장 입고 거부 — intervention-svc /intervention/inbound/{order_id}/reject 프록시.

    body = {reject_reason: str}. 거부 후 pending_orders.status='REJECTED' + WH 알림.
    """
    return await _safe_post(
        f"{settings.intervention_svc_url}/intervention/inbound/{order_id}/reject", body, token
    )


async def post_intervention_batch(body: dict, token: str) -> tuple[int, Any]:
    """일괄 승인/거절 (사용자 결정 2026-05-13) — frontend N 회 → backend 1 회."""
    return await _safe_post(f"{settings.intervention_svc_url}/intervention/intervene/batch", body, token, timeout=60.0)


async def post_intervention_approve(body: dict, token: str) -> tuple[int, Any]:
    return await _safe_post(f"{settings.intervention_svc_url}/intervention/approve", body, token)


async def post_intervention_reject(body: dict, token: str) -> tuple[int, Any]:
    return await _safe_post(f"{settings.intervention_svc_url}/intervention/reject", body, token)


async def post_notification_send(body: dict, token: str) -> tuple[int, Any]:
    return await _safe_post(f"{settings.notification_svc_url}/notification/send", body, token)


async def post_decision_decide(body: dict, token: str) -> tuple[int, Any]:
    return await _safe_post(f"{settings.decision_svc_url}/decision/decide", body, token)


async def post_decision_decide_batch(body: dict, token: str) -> tuple[int, Any]:
    """일괄 cascade 결정 — N items 한 번에 (시연 + 배치 매일 03:30)."""
    return await _safe_post(f"{settings.decision_svc_url}/decision/decide/batch", body, token, timeout=60.0)


async def post_decision_plan_daily(body: dict, token: str) -> tuple[int, Any]:
    """D+1 forecast 기반 익일 배치 발의 (전 isbn × 전 location 동시 plan)."""
    return await _safe_post(f"{settings.decision_svc_url}/decision/plan-daily", body, token, timeout=120.0)


async def get_plan_summary(snapshot_date: str, token: str) -> dict | None:
    """Final Plan summary — decision-svc /decision/plan-daily/{date}/summary 프록시."""
    return await _safe_get(
        f"{settings.decision_svc_url}/decision/plan-daily/{snapshot_date}/summary", token
    )


async def get_plan_items(
    snapshot_date: str,
    token: str,
    status: str | None = None,
    order_type: str | None = None,
    q: str | None = None,
    offset: int = 0,
    limit: int = 100,
) -> dict | None:
    """Final Plan items — decision-svc /decision/plan-daily/{date}/items 프록시."""
    qs = [f"offset={offset}", f"limit={limit}"]
    if status:
        qs.append(f"status={status}")
    if order_type:
        qs.append(f"order_type={order_type}")
    if q:
        qs.append(f"q={q}")
    return await _safe_get(
        f"{settings.decision_svc_url}/decision/plan-daily/{snapshot_date}/items?{'&'.join(qs)}",
        token,
    )


async def post_intervention_inbound_batch_receive(body: dict, token: str) -> tuple[int, Any]:
    """일괄 입고 수령 (BranchInbound 전체 수령/발송 · WhInstructions 일괄)."""
    return await _safe_post(
        f"{settings.intervention_svc_url}/intervention/inbound/batch-receive",
        body, token, timeout=60.0,
    )


async def post_intervention_approve_all_today(body: dict, token: str) -> tuple[int, Any]:
    """오늘 PENDING 전체 일괄 승인 — 서버측 fetch + bulk (페이지네이션 우회)."""
    return await _safe_post(
        f"{settings.intervention_svc_url}/intervention/intervene/approve-all-today",
        body, token, timeout=120.0,
    )


async def post_intervention_returns_request(body: dict, token: str) -> tuple[int, Any]:
    """P1-3 Branch 반품 신청 (intervention-svc /intervention/returns/request)."""
    return await _safe_post(
        f"{settings.intervention_svc_url}/intervention/returns/request", body, token
    )


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


# ─── PR-B (2026-05-15) 4-step state machine v2 — /intervention/orders/* proxy ─
async def post_orders_approve(order_id: str, body: dict, token: str) -> tuple[int, Any]:
    return await _safe_post(
        f"{settings.intervention_svc_url}/intervention/orders/{order_id}/approve",
        body or {}, token,
    )


async def post_orders_dispatch(order_id: str, body: dict, token: str) -> tuple[int, Any]:
    return await _safe_post(
        f"{settings.intervention_svc_url}/intervention/orders/{order_id}/dispatch",
        body or {}, token,
    )


async def post_orders_receive(order_id: str, body: dict, token: str) -> tuple[int, Any]:
    return await _safe_post(
        f"{settings.intervention_svc_url}/intervention/orders/{order_id}/receive",
        body or {}, token,
    )


async def post_orders_reject(order_id: str, body: dict, token: str) -> tuple[int, Any]:
    """body = { reject_reason: str }"""
    return await _safe_post(
        f"{settings.intervention_svc_url}/intervention/orders/{order_id}/reject",
        body, token,
    )


async def patch_orders(order_id: str, body: dict, token: str) -> tuple[int, Any]:
    """body = { qty?: int, target_location_id?: int, note?: str }"""
    return await _safe_patch(
        f"{settings.intervention_svc_url}/intervention/orders/{order_id}",
        body, token,
    )


async def post_orders_batch_approve(body: dict, token: str) -> tuple[int, Any]:
    return await _safe_post(
        f"{settings.intervention_svc_url}/intervention/orders/batch-approve",
        body, token, timeout=60.0,
    )


async def post_orders_batch_dispatch(body: dict, token: str) -> tuple[int, Any]:
    return await _safe_post(
        f"{settings.intervention_svc_url}/intervention/orders/batch-dispatch",
        body, token, timeout=60.0,
    )


async def post_orders_batch_receive(body: dict, token: str) -> tuple[int, Any]:
    return await _safe_post(
        f"{settings.intervention_svc_url}/intervention/orders/batch-receive",
        body, token, timeout=60.0,
    )


async def get_orders_calendar(
    from_date: str, to_date: str, token: str, plan_view: str = "all",
) -> dict | None:
    return await _safe_get(
        f"{settings.intervention_svc_url}/intervention/orders/calendar"
        f"?from_date={from_date}&to_date={to_date}&plan_view={plan_view}",
        token,
    )
