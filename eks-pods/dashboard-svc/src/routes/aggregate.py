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
    get_pending_summary,
    get_warehouse_inventory,
    post_decision_decide,
    patch_intervention_pending_order,
    post_branch_feedback,
    post_intervention_approve,
    post_intervention_book_status,
    post_intervention_new_book_approve,
    post_intervention_new_book_reject,
    post_intervention_reject,
    post_intervention_returns_approve,
    post_intervention_returns_reject,
    get_insufficient_stock,
    post_inbound_receive,
    post_inbound_reject,
    post_intervention_returns_request,
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


@router.get("/pending/grouped")
async def pending_grouped(
    ctx: AuthContext = Depends(require_auth),
    date: str | None = None,
) -> Any:
    """D2 Home 메인 카드 — 오늘 batch 처리 현황 + 사용자 검토 필요.

    intervention-svc 의 /intervention/grouped proxy. role-scope 자동.
    """
    from ..clients import get_intervention_grouped
    data = await get_intervention_grouped(ctx.token, date=date)
    if data is None:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="intervention-svc unavailable")
    return data


@router.get("/pending")
async def pending(
    ctx: AuthContext = Depends(require_auth),
    limit: int = 50,
    offset: int = 0,
    order_type: str | None = None,
    wh_id: int | None = None,
    include_history: bool = False,
    days: int = 7,
    date: str | None = None,
) -> Any:
    """V6.2 3-stage 의사결정 큐.

    - default: PENDING 만
    - date=YYYY-MM-DD: 그 일자 (KST) 의 row 만 (lazy detail · DateHistoryTabs 가 호출)
    - include_history=true (deprecated): PENDING + 최근 N일. /pending/summary + date 권장.
    intervention-svc 가 role/scope 자동 적용 (wh-manager 는 자기 wh 만, hq-admin 은 옵션 wh_id).
    """
    data = await get_pending_orders(
        ctx.token, limit=limit, offset=offset, order_type=order_type, wh_id=wh_id,
        include_history=include_history, days=days, date=date,
    )
    if data is None:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="intervention-svc unavailable")
    return data


@router.get("/pending/summary")
async def pending_summary(
    ctx: AuthContext = Depends(require_auth),
    days: int = 7,
    order_type: str | None = None,
    wh_id: int | None = None,
) -> Any:
    """일자별 카운트 가벼운 summary — DateHistoryTabs pill row count 용.

    intervention-svc /intervention/queue/summary 프록시.
    응답 = {days, items: [{date, PENDING, APPROVED, EXECUTED, REJECTED, AUTO_EXECUTED, total}]}
    """
    data = await get_pending_summary(ctx.token, days=days, order_type=order_type, wh_id=wh_id)
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


@router.post("/intervene/batch")
async def intervene_batch(body: dict = Body(...), ctx: AuthContext = Depends(require_auth)):
    """일괄 승인/거절 (사용자 결정 2026-05-13).

    body: {action: 'approve'|'reject', items: [{order_id, approval_side, reject_reason?}]}
    response: {total, ok, failed, errors}
    """
    from ..clients import post_intervention_batch
    sc, data = await post_intervention_batch(body, ctx.token)
    return JSONResponse(status_code=sc, content=data or {"detail": "intervention-svc unavailable"})


@router.patch("/pending-orders/{order_id}")
async def edit_pending_order(order_id: str, body: dict = Body(...), ctx: AuthContext = Depends(require_auth)):
    """D5-7 WH AI 추천 수정 (수량/대상 매장 · Notion 2.6) — intervention-svc PATCH 프록시."""
    sc, data = await patch_intervention_pending_order(order_id, body, ctx.token)
    return JSONResponse(status_code=sc, content=data or {"detail": "intervention-svc unavailable"})


@router.post("/branch-feedback")
async def branch_feedback(body: dict = Body(...), ctx: AuthContext = Depends(require_auth)):
    """D5-8 Branch → 본사/물류 의견 제출 (Notion 3.5) — notification-svc 프록시."""
    sc, data = await post_branch_feedback(body, ctx.token)
    return JSONResponse(status_code=sc, content=data or {"detail": "notification-svc unavailable"})


@router.post("/notify/send")
async def notify_send(body: dict = Body(...), ctx: AuthContext = Depends(require_auth)):
    sc, data = await post_notification_send(body, ctx.token)
    return JSONResponse(status_code=sc, content=data or {"detail": "notification-svc unavailable"})


@router.post("/decide")
async def decide(body: dict = Body(...), ctx: AuthContext = Depends(require_auth)):
    """HQ Decision 페이지 - 의사결정 1건 생성 (decision-svc /decide proxy · 3-stage cascade)."""
    sc, data = await post_decision_decide(body, ctx.token)
    return JSONResponse(status_code=sc, content=data or {"detail": "decision-svc unavailable"})


@router.post("/cascade/run-batch")
async def cascade_run_batch(body: dict = Body(...), ctx: AuthContext = Depends(require_auth)):
    """일괄 cascade 결정 — N items 한 번에 (시연 trigger + 매일 03:30 batch).

    기존 frontend N 회 호출 → 503 race / 느림 해소. backend 가 sequential 처리 + 결과 요약.
    body: {items: [{isbn13, target_location_id, qty, note?}]}
    response: {total, s1, s2, s3, failed, errors}
    """
    from ..clients import post_decision_decide_batch
    sc, data = await post_decision_decide_batch(body, ctx.token)
    return JSONResponse(status_code=sc, content=data or {"detail": "decision-svc unavailable"})


@router.post("/inbound/batch-receive")
async def inbound_batch_receive(body: dict = Body(...), ctx: AuthContext = Depends(require_auth)):
    """일괄 입고 수령 — intervention-svc /inbound/batch-receive proxy."""
    from ..clients import post_intervention_inbound_batch_receive
    sc, data = await post_intervention_inbound_batch_receive(body, ctx.token)
    return JSONResponse(status_code=sc, content=data or {"detail": "intervention-svc unavailable"})


@router.post("/intervene/approve-all-today")
async def intervene_approve_all_today(body: dict = Body(default={}), ctx: AuthContext = Depends(require_auth)):
    """오늘 PENDING 전체 일괄 승인 — body: {order_type?} · role/scope 자동.

    페이지네이션 우회: 서버측 fetch + bulk SQL · WH_TRANSFER 양측 자동 처리.
    """
    from ..clients import post_intervention_approve_all_today
    sc, data = await post_intervention_approve_all_today(body, ctx.token)
    return JSONResponse(status_code=sc, content=data or {"detail": "intervention-svc unavailable"})


@router.post("/cascade/plan-daily")
async def cascade_plan_daily(body: dict = Body(default={}), ctx: AuthContext = Depends(require_auth)):
    """D+1 forecast 기반 익일 배치 발의 — decision-svc /decision/plan-daily proxy.

    BQ 결과 테이블 → forecast_cache (정식) / 현재는 RDS 직읽음 임시.
    body (optional): {"snapshot_date": "YYYY-MM-DD"}  default = tomorrow KST.
    response: {snapshot_date, rows_created, by_stage{1,2,3}, isbns_planned}
    """
    from ..clients import post_decision_plan_daily
    sc, data = await post_decision_plan_daily(body, ctx.token)
    return JSONResponse(status_code=sc, content=data or {"detail": "decision-svc unavailable"})


@router.post("/inventory/adjust")
async def inventory_adjust(body: dict = Body(...), ctx: AuthContext = Depends(require_auth)):
    """UX-6 Manual 페이지 — 재고 수동 조정 (분실/파손/도난).

    inventory-svc 가 single writer · 권한 검증 (FR-A6.6 + branch-clerk scope_store_id).
    body: { isbn13, location_id, delta, reason }
    """
    sc, data = await post_inventory_adjust(body, ctx.token)
    return JSONResponse(status_code=sc, content=data or {"detail": "inventory-svc unavailable"})


@router.get("/forecast/insufficient")
async def forecast_insufficient(limit: int = 20, ctx: AuthContext = Depends(require_auth)):
    """P1-4b 시연 trigger — forecast-svc /forecast/insufficient-stock 프록시.

    HQ 만 호출 (시연 자동 cascade 일괄 발의용 list).
    """
    if ctx.role != "hq-admin":
        return JSONResponse(status_code=403, content={"detail": "본사만 가능"})
    data = await get_insufficient_stock(ctx.token, limit)
    return JSONResponse(content=data or {"items": [], "snapshot_date": None})


@router.post("/inbound/{order_id}/receive")
async def inbound_receive(order_id: str, ctx: AuthContext = Depends(require_auth)):
    """UX-6 매장 입고 수령 — intervention-svc /intervention/inbound/{order_id}/receive 프록시.

    매장 직원 (branch-clerk · scope_store_id) 또는 자기 권역 wh-manager / hq-admin 만 호출 가능.
    완료 시 status=EXECUTED + inventory.on_hand += qty (intervention 내부에서 inventory-svc 호출).
    """
    sc, data = await post_inbound_receive(order_id, ctx.token)
    return JSONResponse(status_code=sc, content=data or {"detail": "intervention-svc unavailable"})


@router.post("/inbound/{order_id}/reject")
async def inbound_reject(order_id: str, body: dict = Body(...), ctx: AuthContext = Depends(require_auth)):
    """P1-2 매장 입고 거부 — intervention-svc /intervention/inbound/{order_id}/reject 프록시.

    body = {reject_reason: str}. 권한 = receive 와 동일 (branch-clerk 자기 매장 / wh-manager 자기 권역 / hq-admin).
    완료 시 pending_orders.status='REJECTED' + reject_reason + WH 알림 (InboundRejected).
    """
    sc, data = await post_inbound_reject(order_id, body, ctx.token)
    return JSONResponse(status_code=sc, content=data or {"detail": "intervention-svc unavailable"})


@router.post("/returns/request")
async def returns_request(body: dict = Body(...), ctx: AuthContext = Depends(require_auth)):
    """P1-3 Branch 반품 신청 (intervention-svc /intervention/returns/request proxy).

    body = {isbn13, location_id, qty, reason}. branch-clerk 자기 매장 only (intervention-svc 검증).
    완료 시 returns INSERT status='PENDING' + ⑩ReturnPending 알림.
    """
    sc, data = await post_intervention_returns_request(body, ctx.token)
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
