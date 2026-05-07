"""Fan-in routes: GET /dashboard/inventory|forecast|pending|overview."""
import asyncio
from datetime import date
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status

from ..auth import AuthContext, _check_store_scope, require_auth
from fastapi import Body
from fastapi.responses import JSONResponse

from ..clients import (
    get_forecast,
    get_intervention_queue,
    get_notifications_recent,
    get_pending_orders,
    get_warehouse_inventory,
    post_decision_decide,
    post_intervention_approve,
    post_intervention_book_status,
    post_intervention_new_book_approve,
    post_intervention_new_book_reject,
    post_intervention_reject,
    post_intervention_returns_approve,
    post_intervention_returns_reject,
    post_inbound_receive,
    post_inventory_adjust,
    post_notification_send,
)

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


@router.get("/inventory/{wh_id}")
async def inventory(wh_id: int, ctx: AuthContext = Depends(require_auth)) -> Any:
    data = await get_warehouse_inventory(wh_id, ctx.token)
    if data is None:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="inventory-svc unavailable")
    return data


@router.get("/forecast/{store_id}/{snapshot_date}")
async def forecast(store_id: int, snapshot_date: date, ctx: AuthContext = Depends(require_auth)) -> Any:
    """FR-A7.3 매장 스코프 enforce — branch-clerk 자기 매장만."""
    _check_store_scope(ctx, store_id)
    data = await get_forecast(store_id, str(snapshot_date), ctx.token)
    if data is None:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="forecast-svc unavailable")
    return data


@router.get("/pending")
async def pending(
    ctx: AuthContext = Depends(require_auth),
    limit: int = 50,
    order_type: str | None = None,
    wh_id: int | None = None,
) -> Any:
    """V6.2 3-stage 의사결정 PENDING 큐.

    intervention-svc 가 role/scope 자동 적용 (wh-manager 는 자기 wh 만, hq-admin 은 옵션 wh_id).
    `order_type`: REBALANCE | WH_TRANSFER | PUBLISHER_ORDER 필터.
    """
    data = await get_pending_orders(ctx.token, limit=limit, order_type=order_type, wh_id=wh_id)
    if data is None:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="intervention-svc unavailable")
    return data


@router.get("/interventions")
async def interventions(ctx: AuthContext = Depends(require_auth)) -> dict:
    data = await get_intervention_queue(ctx.token)
    if data is None:
        return {"items": [], "_source": "intervention-svc unavailable (Phase 3 deploy 전)"}
    return data


@router.get("/notifications")
async def notifications(ctx: AuthContext = Depends(require_auth), limit: int = 50) -> dict:
    data = await get_notifications_recent(ctx.token, limit=limit)
    if data is None:
        return {"items": [], "_source": "notification-svc unavailable (Phase 3 deploy 전)"}
    return data


@router.post("/intervene/approve")
async def intervene_approve(body: dict = Body(...), ctx: AuthContext = Depends(require_auth)):
    """HQ Approval / WH Approve 버튼 → intervention-svc /intervention/approve 프록시.
    .pen 시나리오: C-1~C-4 권역이동 · HQ Approval · WH Approve."""
    sc, data = await post_intervention_approve(body, ctx.token)
    return JSONResponse(status_code=sc, content=data or {"detail": "intervention-svc unavailable"})


@router.post("/intervene/reject")
async def intervene_reject(body: dict = Body(...), ctx: AuthContext = Depends(require_auth)):
    sc, data = await post_intervention_reject(body, ctx.token)
    return JSONResponse(status_code=sc, content=data or {"detail": "intervention-svc unavailable"})


@router.post("/notify/send")
async def notify_send(body: dict = Body(...), ctx: AuthContext = Depends(require_auth)):
    sc, data = await post_notification_send(body, ctx.token)
    return JSONResponse(status_code=sc, content=data or {"detail": "notification-svc unavailable"})


@router.post("/decide")
async def decide(body: dict = Body(...), ctx: AuthContext = Depends(require_auth)):
    """HQ Decision 페이지 - 의사결정 1건 생성 (decision-svc /decide proxy · 3-stage cascade)."""
    sc, data = await post_decision_decide(body, ctx.token)
    return JSONResponse(status_code=sc, content=data or {"detail": "decision-svc unavailable"})


@router.post("/inventory/adjust")
async def inventory_adjust(body: dict = Body(...), ctx: AuthContext = Depends(require_auth)):
    """UX-6 Manual 페이지 — 재고 수동 조정 (분실/파손/도난).

    inventory-svc 가 single writer · 권한 검증 (FR-A6.6 + branch-clerk scope_store_id).
    body: { isbn13, location_id, delta, reason }
    """
    sc, data = await post_inventory_adjust(body, ctx.token)
    return JSONResponse(status_code=sc, content=data or {"detail": "inventory-svc unavailable"})


@router.post("/inbound/{order_id}/receive")
async def inbound_receive(order_id: str, ctx: AuthContext = Depends(require_auth)):
    """UX-6 매장 입고 수령 — intervention-svc /intervention/inbound/{order_id}/receive 프록시.

    매장 직원 (branch-clerk · scope_store_id) 또는 자기 권역 wh-manager / hq-admin 만 호출 가능.
    완료 시 status=EXECUTED + inventory.on_hand += qty (intervention 내부에서 inventory-svc 호출).
    """
    sc, data = await post_inbound_receive(order_id, ctx.token)
    return JSONResponse(status_code=sc, content=data or {"detail": "intervention-svc unavailable"})


@router.post("/returns/approve")
async def returns_approve(body: dict = Body(...), ctx: AuthContext = Depends(require_auth)):
    """반품 승인 (intervention-svc /intervention/returns/approve proxy)."""
    sc, data = await post_intervention_returns_approve(body, ctx.token)
    return JSONResponse(status_code=sc, content=data or {"detail": "intervention-svc unavailable"})


@router.post("/returns/reject")
async def returns_reject(body: dict = Body(...), ctx: AuthContext = Depends(require_auth)):
    """A4 (FR-A6.8) 반품 거부 (intervention-svc /intervention/returns/reject proxy).

    body = {return_id, reject_reason}. hq-admin only (intervention-svc 가 검증).
    """
    sc, data = await post_intervention_returns_reject(body, ctx.token)
    return JSONResponse(status_code=sc, content=data or {"detail": "intervention-svc unavailable"})


@router.post("/new-book-requests/{request_id}/approve")
async def new_book_approve(
    request_id: int,
    body: dict = Body(default_factory=dict),
    ctx: AuthContext = Depends(require_auth),
):
    """신간 편입 결정 (intervention-svc proxy).

    body = { wh1_qty?: int, wh2_qty?: int } - 권역별 분배 수량.
    승인 시 자동으로 PUBLISHER_ORDER pending_orders 2건 생성 (FR-A4.8).
    """
    sc, data = await post_intervention_new_book_approve(request_id, body, ctx.token)
    return JSONResponse(status_code=sc, content=data or {"detail": "intervention-svc unavailable"})


@router.post("/new-book-requests/{request_id}/reject")
async def new_book_reject(
    request_id: int,
    body: dict = Body(default_factory=dict),
    ctx: AuthContext = Depends(require_auth),
):
    """신간 편입 거절 (intervention-svc proxy). body = { reason?: str }"""
    sc, data = await post_intervention_new_book_reject(request_id, body, ctx.token)
    return JSONResponse(status_code=sc, content=data or {"detail": "intervention-svc unavailable"})


@router.post("/books/{isbn13}/status")
async def book_status_change(isbn13: str, body: dict = Body(...), ctx: AuthContext = Depends(require_auth)):
    """HQ 도서 ON/OFF + 소진 모드 (intervention-svc /intervention/books/{isbn13}/status proxy).

    body = { mode: NORMAL|SOFT_DISCONTINUE|INACTIVE, reason?: str }
    """
    sc, data = await post_intervention_book_status(isbn13, body, ctx.token)
    return JSONResponse(status_code=sc, content=data or {"detail": "intervention-svc unavailable"})


@router.get("/overview/{wh_id}")
async def overview(wh_id: int, ctx: AuthContext = Depends(require_auth)) -> dict:
    """5-way fan-in (.pen Service Mesh + Call Graph 명세).

    intervention-svc + notification-svc 는 Phase 3 까지 미배포 → None tolerated.
    """
    today = date.today().isoformat()
    inv, fcst, pend, intv, noti = await asyncio.gather(
        get_warehouse_inventory(wh_id, ctx.token),
        get_forecast(wh_id, today, ctx.token),
        get_pending_orders(ctx.token, limit=20),
        get_intervention_queue(ctx.token),
        get_notifications_recent(ctx.token, limit=20),
    )
    return {
        "wh_id": wh_id,
        "inventory": inv,
        "forecast": fcst,
        "pending_orders": pend,
        "interventions": intv,
        "notifications": noti,
        "_partial_failures": [
            name for name, val in [
                ("inventory", inv), ("forecast", fcst), ("pending", pend),
                ("intervention", intv), ("notification", noti),
            ] if val is None
        ],
    }
