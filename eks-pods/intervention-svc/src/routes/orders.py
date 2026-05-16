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
    order_ids: list[str] = Field(..., min_items=1)


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
# plan_view — order_type 기반 계획 단위 분리 (scope 자동 필터와 독립 layer):
#   mine    — 물류센터 계획 (WH-kind face 가 있는 order_type)
#   observe — 지점 계획 (STORE-kind face 가 있는 order_type)
#   all     — 전체 (default)
# 2026-05-16 walkthrough-10 이슈18: observe 에 WH_TO_STORE 추가 —
#   WH_TO_STORE 의 target 은 STORE 라 지점 계획에 매장 입고면이 떠야 함.
#   (tgt_vis 는 이미 WH_TO_STORE 를 STORE-kind 로 잡지만 pv_frag 가 row 자체를 떨궈 cell 0 이었음)
_PLAN_VIEW_TYPES: dict[str, tuple[str, ...]] = {
    "mine": ("WH_TO_STORE", "WH_TRANSFER", "PUBLISHER_ORDER"),
    "observe": ("REBALANCE", "WH_TO_STORE"),
}


# order_type 별 source/target face 의 종류 — frontend lib/orderClassify.ts faceKinds 와 동일.
#   WH_TO_STORE  src=WH tgt=STORE · WH_TRANSFER src=WH tgt=WH
#   REBALANCE    src=STORE tgt=STORE · PUBLISHER_ORDER src=EXT tgt=WH
_FACE_SRC_WH = ("WH_TO_STORE", "WH_TRANSFER")
_FACE_TGT_WH = ("WH_TRANSFER", "PUBLISHER_ORDER")
_FACE_SRC_STORE = ("REBALANCE",)
_FACE_TGT_STORE = ("WH_TO_STORE", "REBALANCE")


@router.get("/calendar", response_model=CalendarResp)
def calendar(
    from_date: date_type,
    to_date: date_type,
    plan_view: Literal["all", "mine", "observe"] = "all",
    ctx: AuthContext = Depends(require_auth),
):
    """캘린더 cell count — frontend lib/orderClassify.ts classify 와 동일 face 기반 규칙.

    각 order 를 source face / target face 2면으로 분해, 노출 face 만 카운트:
      outbound   : source face 노출 · status = APPROVED
      in_transit : source face 노출 · status = IN_TRANSIT
      inbound    : target face 노출 · status IN (APPROVED, IN_TRANSIT)
      executed   : 노출 face 1개 이상 · status IN (EXECUTED, AUTO_EXECUTED) · exec_date = day

    face 가시성:
      wh-manager / branch-clerk — 내 scope 가 닿는 face 만.
      hq-admin — all: 양면 · mine: WH face 만 · observe: STORE face 만.
    4 탭 합계 = CalendarDetail 4 탭 placement 합계 (정합 보장).
    """
    # face 가시성 SQL — src_vis / tgt_vis. 각 face 가 cell 에 카운트되는지.
    if ctx.role == "hq-admin":
        if plan_view == "mine":
            # WH face 만 — order_type 으로 판정.
            src_in = ",".join(["%s"] * len(_FACE_SRC_WH))
            tgt_in = ",".join(["%s"] * len(_FACE_TGT_WH))
            src_vis = f"(po.order_type IN ({src_in}))"
            tgt_vis = f"(po.order_type IN ({tgt_in}))"
            params: list = [*_FACE_SRC_WH, *_FACE_TGT_WH]
        elif plan_view == "observe":
            # STORE face 만.
            src_in = ",".join(["%s"] * len(_FACE_SRC_STORE))
            tgt_in = ",".join(["%s"] * len(_FACE_TGT_STORE))
            src_vis = f"(po.order_type IN ({src_in}))"
            tgt_vis = f"(po.order_type IN ({tgt_in}))"
            params = [*_FACE_SRC_STORE, *_FACE_TGT_STORE]
        else:  # all — 양면 다.
            src_vis = "TRUE"; tgt_vis = "TRUE"; params = []
    elif ctx.role == "wh-manager":
        # 2026-05-16 walkthrough-10 이슈19: WH-kind face 만 — 그 face 가 WH 이고 내 창고일 때.
        #   기존 (s.wh_id=%s) 는 WH_TO_STORE 의 target(STORE) 도 그 STORE 의 권역이 내 권역이면
        #   tgt_vis=true 로 잡아 wh-manager 가 매장 입고면을 잘못 보던 버그.
        #   location_type='WH' 조건으로 WH-kind face 만 노출 (frontend visibleFaces 와 동일 규칙).
        src_vis = "(s.location_type = 'WH' AND s.wh_id = %s)"
        tgt_vis = "(t.location_type = 'WH' AND t.wh_id = %s)"
        params = [ctx.scope_wh_id, ctx.scope_wh_id]
    elif ctx.role == "branch-clerk":
        # STORE-kind face 만 — location_id 가 유일하므로 source/target_location_id 일치로 충분.
        src_vis = "(po.source_location_id = %s)"; tgt_vis = "(po.target_location_id = %s)"
        params = [ctx.scope_store_id, ctx.scope_store_id]
    else:
        raise HTTPException(status_code=403, detail=f"unknown role: {ctx.role}")

    # plan_view → order_type IN (...) fragment (scope 필터와 독립).
    #   hq-admin mine/observe 는 src_vis/tgt_vis 가 이미 order_type 으로 면을 거르지만
    #   row 자체도 plan_view 집합으로 제한해야 다른 order_type 의 노출 0-면 row 가 안 섞임.
    pv_types = _PLAN_VIEW_TYPES.get(plan_view)
    if pv_types:
        pv_frag = "AND po.order_type IN (" + ",".join(["%s"] * len(pv_types)) + ")"
        pv_params: list = list(pv_types)
    else:
        pv_frag = ""
        pv_params = []

    sql = f"""
        WITH base AS (
            SELECT po.order_id, po.status, po.order_type, po.expected_arrival_at,
                   po.executed_at::date AS exec_date,
                   ({src_vis}) AS src_vis,
                   ({tgt_vis}) AS tgt_vis
              FROM pending_orders po
              LEFT JOIN locations s ON s.location_id = po.source_location_id
              LEFT JOIN locations t ON t.location_id = po.target_location_id
             WHERE po.status IN ('APPROVED','IN_TRANSIT','EXECUTED','AUTO_EXECUTED')
               {pv_frag}
               AND (po.expected_arrival_at BETWEEN %s AND %s
                    OR (po.executed_at IS NOT NULL AND po.executed_at::date BETWEEN %s AND %s))
        )
        SELECT
            COALESCE(expected_arrival_at, exec_date) AS day,
            -- inbound: APPROVED/IN_TRANSIT + target face 노출
            COUNT(*) FILTER (WHERE status IN ('APPROVED','IN_TRANSIT') AND tgt_vis) AS inbound,
            -- outbound: APPROVED + source face 노출
            COUNT(*) FILTER (WHERE status = 'APPROVED' AND src_vis) AS outbound,
            -- in_transit: IN_TRANSIT + source face 노출
            COUNT(*) FILTER (WHERE status = 'IN_TRANSIT' AND src_vis) AS in_transit,
            -- executed: EXECUTED/AUTO_EXECUTED + 노출 face 1개 이상 + executed_at = day
            COUNT(*) FILTER (WHERE status IN ('EXECUTED','AUTO_EXECUTED') AND (src_vis OR tgt_vis)
                                   AND exec_date = COALESCE(expected_arrival_at, exec_date)) AS executed
          FROM base
         WHERE COALESCE(expected_arrival_at, exec_date) BETWEEN %s AND %s
         GROUP BY 1 ORDER BY 1
    """
    # params 순서: src_vis/tgt_vis(SELECT 절) → plan_view(WHERE) → date×3.
    qparams = (*params, *pv_params, from_date, to_date, from_date, to_date, from_date, to_date)
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
