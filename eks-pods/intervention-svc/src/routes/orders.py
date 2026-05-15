"""orders.py — 4-step state machine v2 entrypoint (PR-B).

전체 endpoint:
  POST   /orders/{order_id}/approve   — PENDING → APPROVED (양측 ✓)
  POST   /orders/batch-approve        — 일괄
  POST   /orders/{order_id}/dispatch  — APPROVED → IN_TRANSIT (source -qty)
  POST   /orders/batch-dispatch       — 일괄
  POST   /orders/{order_id}/receive   — IN_TRANSIT → EXECUTED (target +qty)
  POST   /orders/batch-receive        — 일괄
  POST   /orders/{order_id}/reject    — any → REJECTED (rejection_stage 자동)
  PATCH  /orders/{order_id}           — qty / target / note 수정 (PENDING/APPROVED only)
  GET    /orders/calendar             — 캘린더 cell count (date × {inbound,outbound,in_transit,executed})

prefix: /intervention/orders/* (dashboard-svc proxy 정합)
"""
from __future__ import annotations

import logging
from datetime import date as date_type, datetime
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..auth import AuthContext, require_auth
from ..authority import Authority, _fetch_order_meta, require_authority
from ..db import db_conn
from ..notify import publish as notify_publish
from ..state_machine import State, transition

log = logging.getLogger(__name__)

router = APIRouter(prefix="/orders", tags=["orders"])


# ─── Pydantic models ─────────────────────────────────────────────────────────
class ApproveReq(BaseModel):
    approval_side: Optional[Literal["SOURCE", "TARGET", "FINAL"]] = None


class RejectReq(BaseModel):
    reject_reason: str = Field(..., min_length=1, max_length=200)


class DispatchReq(BaseModel):
    note: Optional[str] = None


class ReceiveReq(BaseModel):
    note: Optional[str] = None


class PatchReq(BaseModel):
    qty: Optional[int] = Field(None, gt=0)
    target_location_id: Optional[int] = None
    note: Optional[str] = None


class BatchReq(BaseModel):
    order_ids: list[str] = Field(..., min_items=1, max_items=200)


class CalendarDay(BaseModel):
    date: date_type
    inbound: int
    outbound: int
    in_transit: int
    executed: int


class CalendarResp(BaseModel):
    items: list[CalendarDay]


# ─── helpers (publish notification after commit) ─────────────────────────────
def _publish_order_event(ctx: AuthContext, event_type: str, order_id: str,
                          meta: dict, extra: dict | None = None) -> None:
    """notification-svc /send 호출 — best-effort fire-and-forget.
    실패해도 transition 자체는 성공이라 raise 안 함.
    severity 는 reject 시 HIGH, 그 외 INFO.
    """
    payload = {
        "order_id": order_id,
        "order_type": meta.get("order_type"),
        "source_location_id": meta.get("source_loc"),
        "target_location_id": meta.get("target_loc"),
    }
    if extra:
        payload.update(extra)
    severity = "HIGH" if "Reject" in event_type else "INFO"
    notify_publish(ctx.token, event_type, severity, payload)


# ─── POST /orders/{order_id}/approve ────────────────────────────────────────
@router.post("/{order_id}/approve", status_code=200)
def approve_order(
    order_id: str,
    req: ApproveReq,
    ctx: AuthContext = Depends(require_authority("approve")),
):
    meta = getattr(ctx, "_order_meta", None)
    with db_conn() as conn:
        with conn.cursor() as cur:
            result = transition(cur, order_id, State.APPROVED, ctx,
                                approval_side=req.approval_side)
        conn.commit()

    # 한쪽 동의 = OrderApproved · 양측 완료 = OrderApprovedFinal
    if result["transitioned"]:
        _publish_order_event(ctx, "OrderApprovedFinal", order_id, meta or {})
    else:
        _publish_order_event(ctx, "OrderApproved", order_id, meta or {},
                             extra={"side": result["side"]})
    return result


# ─── POST /orders/batch-approve ──────────────────────────────────────────────
@router.post("/batch-approve", status_code=200)
def batch_approve_orders(
    req: BatchReq,
    ctx: AuthContext = Depends(require_auth),
):
    """일괄 승인 — row 별 권한 check (hq-admin 외엔 자기 측 order 만 통과).
    실패한 row 는 skip + 결과 dict 에 누적.
    """
    ok, failed = [], []
    with db_conn() as conn:
        with conn.cursor() as cur:
            for oid in req.order_ids:
                try:
                    meta = _fetch_order_meta(cur, oid)
                except HTTPException as e:
                    failed.append({"order_id": oid, "error": e.detail})
                    continue
                if not Authority.can_approve(ctx, meta):
                    failed.append({"order_id": oid, "error": "forbidden"})
                    continue
                try:
                    result = transition(cur, oid, State.APPROVED, ctx, approval_side=None)
                    ok.append({"order_id": oid, **result, "_meta": meta})
                except HTTPException as e:
                    failed.append({"order_id": oid, "error": e.detail})
        conn.commit()
    # publish per-row 이벤트
    for r in ok:
        meta = r.pop("_meta")
        if r.get("transitioned"):
            _publish_order_event(ctx, "OrderApprovedFinal", r["order_id"], meta)
        else:
            _publish_order_event(ctx, "OrderApproved", r["order_id"], meta,
                                 extra={"side": r.get("side")})
    return {"ok": ok, "failed": failed, "total": len(req.order_ids)}


# ─── POST /orders/{order_id}/dispatch ────────────────────────────────────────
@router.post("/{order_id}/dispatch", status_code=200)
def dispatch_order(
    order_id: str,
    req: DispatchReq,
    ctx: AuthContext = Depends(require_authority("dispatch")),
):
    meta = getattr(ctx, "_order_meta", None)
    with db_conn() as conn:
        with conn.cursor() as cur:
            result = transition(cur, order_id, State.IN_TRANSIT, ctx)
        conn.commit()
    _publish_order_event(ctx, "OrderDispatched", order_id, meta or {})
    return result


# ─── POST /orders/batch-dispatch ─────────────────────────────────────────────
@router.post("/batch-dispatch", status_code=200)
def batch_dispatch_orders(
    req: BatchReq,
    ctx: AuthContext = Depends(require_auth),
):
    ok, failed = [], []
    with db_conn() as conn:
        with conn.cursor() as cur:
            for oid in req.order_ids:
                try:
                    meta = _fetch_order_meta(cur, oid)
                except HTTPException as e:
                    failed.append({"order_id": oid, "error": e.detail}); continue
                if not Authority.can_dispatch(ctx, meta):
                    failed.append({"order_id": oid, "error": "forbidden"}); continue
                try:
                    result = transition(cur, oid, State.IN_TRANSIT, ctx)
                    ok.append({"order_id": oid, **result, "_meta": meta})
                except HTTPException as e:
                    failed.append({"order_id": oid, "error": e.detail})
        conn.commit()
    for r in ok:
        meta = r.pop("_meta")
        _publish_order_event(ctx, "OrderDispatched", r["order_id"], meta)
    return {"ok": ok, "failed": failed, "total": len(req.order_ids)}


# ─── POST /orders/{order_id}/receive ─────────────────────────────────────────
@router.post("/{order_id}/receive", status_code=200)
def receive_order(
    order_id: str,
    req: ReceiveReq,
    ctx: AuthContext = Depends(require_authority("receive")),
):
    meta = getattr(ctx, "_order_meta", None)
    with db_conn() as conn:
        with conn.cursor() as cur:
            result = transition(cur, order_id, State.EXECUTED, ctx)
        conn.commit()
    _publish_order_event(ctx, "OrderExecuted", order_id, meta or {})
    return result


# ─── POST /orders/batch-receive ──────────────────────────────────────────────
@router.post("/batch-receive", status_code=200)
def batch_receive_orders(
    req: BatchReq,
    ctx: AuthContext = Depends(require_auth),
):
    ok, failed = [], []
    with db_conn() as conn:
        with conn.cursor() as cur:
            for oid in req.order_ids:
                try:
                    meta = _fetch_order_meta(cur, oid)
                except HTTPException as e:
                    failed.append({"order_id": oid, "error": e.detail}); continue
                if not Authority.can_receive(ctx, meta):
                    failed.append({"order_id": oid, "error": "forbidden"}); continue
                try:
                    result = transition(cur, oid, State.EXECUTED, ctx)
                    ok.append({"order_id": oid, **result, "_meta": meta})
                except HTTPException as e:
                    failed.append({"order_id": oid, "error": e.detail})
        conn.commit()
    for r in ok:
        meta = r.pop("_meta")
        _publish_order_event(ctx, "OrderExecuted", r["order_id"], meta)
    return {"ok": ok, "failed": failed, "total": len(req.order_ids)}


# ─── POST /orders/{order_id}/reject ──────────────────────────────────────────
@router.post("/{order_id}/reject", status_code=200)
def reject_order(
    order_id: str,
    req: RejectReq,
    ctx: AuthContext = Depends(require_authority("reject")),
):
    meta = getattr(ctx, "_order_meta", None)
    with db_conn() as conn:
        with conn.cursor() as cur:
            result = transition(cur, order_id, State.REJECTED, ctx, reject_reason=req.reject_reason)
        conn.commit()
    # WS payload 에 rejection_stage 포함 (frontend 조건부 invalidate · re: heatmap)
    _publish_order_event(ctx, "OrderRejected", order_id, meta or {},
                         extra={"rejection_stage": result.get("rejection_stage")})
    return result


# ─── PATCH /orders/{order_id} — qty / target 수정 ────────────────────────────
@router.patch("/{order_id}", status_code=200)
def patch_order(
    order_id: str,
    req: PatchReq,
    ctx: AuthContext = Depends(require_authority("patch")),
):
    meta = getattr(ctx, "_order_meta", {})
    if meta.get("status") not in ("PENDING", "APPROVED"):
        raise HTTPException(status_code=409,
                            detail=f"patch only allowed for PENDING/APPROVED (got {meta.get('status')})")
    if req.qty is None and req.target_location_id is None and req.note is None:
        raise HTTPException(status_code=400, detail="no field to update")
    sets, vals = [], []
    if req.qty is not None:
        sets.append("qty = %s"); vals.append(req.qty)
    if req.target_location_id is not None:
        sets.append("target_location_id = %s"); vals.append(req.target_location_id)
    vals.append(order_id)
    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(f"UPDATE pending_orders SET {', '.join(sets)} WHERE order_id = %s "
                        f"AND status IN ('PENDING','APPROVED')", tuple(vals))
            if cur.rowcount == 0:
                raise HTTPException(status_code=409, detail="status changed (race)")
            cur.execute(
                "INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id) "
                "VALUES ('USER', %s, 'order.patch', 'pending_orders', %s)",
                (ctx.user_id, order_id),
            )
        conn.commit()
    return {"order_id": order_id, "updated": True}


# ─── GET /orders/calendar — date × count matrix ──────────────────────────────
@router.get("/calendar", response_model=CalendarResp)
def calendar(
    from_date: date_type,
    to_date: date_type,
    ctx: AuthContext = Depends(require_auth),
):
    """캘린더 cell count — role/scope 자동 필터.
      inbound:    target = ctx scope · status IN (PENDING, APPROVED, IN_TRANSIT)
      outbound:   source = ctx scope · status IN (PENDING, APPROVED)
      in_transit: 자기 측 (source or target) · status = IN_TRANSIT
      executed:   자기 측 · status IN (EXECUTED, AUTO_EXECUTED) · executed_at::date = day
    """
    # scope filter SQL fragment
    if ctx.role == "hq-admin":
        scope_src = "TRUE"; scope_tgt = "TRUE"; params: list = []
    elif ctx.role == "wh-manager":
        scope_src = "s.wh_id = %s"; scope_tgt = "t.wh_id = %s"
        params = [ctx.scope_wh_id, ctx.scope_wh_id]
    elif ctx.role == "branch-clerk":
        scope_src = "po.source_location_id = %s"; scope_tgt = "po.target_location_id = %s"
        params = [ctx.scope_store_id, ctx.scope_store_id]
    else:
        raise HTTPException(status_code=403, detail=f"unknown role: {ctx.role}")

    # 2026-05-15 v4: 캘린더 = 입출고 (logistics) 현황만 표시 — 협의 (PENDING) 제외.
    # 사용자 요구 "승인과 입출고를 명확히 분리".
    # 단계별 의미:
    #   📥 inbound  = target=내 측 · APPROVED + IN_TRANSIT (출고 대기 + 운송 중 도착 예정)
    #   📤 outbound = source=내 측 · APPROVED (발송 대기)
    #   🚚 in_transit = 양측 · IN_TRANSIT (운송 중)
    #   ✅ executed = 양측 · EXECUTED/AUTO_EXECUTED · executed_at = day
    sql = f"""
        WITH base AS (
            SELECT po.order_id, po.status, po.expected_arrival_at,
                   po.executed_at::date AS exec_date,
                   ({scope_src}) AS is_src,
                   ({scope_tgt}) AS is_tgt
              FROM pending_orders po
              LEFT JOIN locations s ON s.location_id = po.source_location_id
              LEFT JOIN locations t ON t.location_id = po.target_location_id
             WHERE po.status IN ('APPROVED','IN_TRANSIT','EXECUTED','AUTO_EXECUTED')
               AND (po.expected_arrival_at BETWEEN %s AND %s
                    OR (po.executed_at IS NOT NULL AND po.executed_at::date BETWEEN %s AND %s))
        )
        SELECT
            COALESCE(expected_arrival_at, exec_date) AS day,
            COUNT(*) FILTER (WHERE is_tgt AND status IN ('APPROVED','IN_TRANSIT')) AS inbound,
            COUNT(*) FILTER (WHERE is_src AND status = 'APPROVED') AS outbound,
            COUNT(*) FILTER (WHERE (is_src OR is_tgt) AND status = 'IN_TRANSIT') AS in_transit,
            COUNT(*) FILTER (WHERE (is_src OR is_tgt) AND status IN ('EXECUTED','AUTO_EXECUTED')
                                   AND exec_date = COALESCE(expected_arrival_at, exec_date)) AS executed
          FROM base
         WHERE COALESCE(expected_arrival_at, exec_date) BETWEEN %s AND %s
         GROUP BY 1 ORDER BY 1
    """
    # params 는 scope_src + scope_tgt %s 매칭용 (hq-admin=[]·wh-manager=[wh,wh]·branch=[store,store])
    qparams = (*params, from_date, to_date, from_date, to_date, from_date, to_date)
    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, qparams)
            rows = cur.fetchall()
    items = [
        CalendarDay(date=r[0], inbound=r[1] or 0, outbound=r[2] or 0,
                    in_transit=r[3] or 0, executed=r[4] or 0)
        for r in rows
    ]
    return CalendarResp(items=items)
