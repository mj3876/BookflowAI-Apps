"""Authority — single-source-of-truth role × action × scope guard.

4-step state machine v2 (PR-B):
  approve / dispatch / receive / reject / patch 각 action 별 권한 판정.
  Authority.can_xxx() + require_authority(action) FastAPI Depends.

권한 매트릭스:
  hq-admin       — 모든 order × 모든 action 허용 (FINAL)
  wh-manager-X   — order 의 source/target 이 wh_id=X 인 경우만
  branch-clerk-S — order 의 source/target 이 store_id=S 인 경우만
  PUBLISHER_ORDER — hq-admin 단독 (외부 발주)

특이 케이스 (반품):
  IN_TRANSIT 상태 reject 는 target 측만 가능 (반품 = 수령 거부)
"""
from __future__ import annotations

from fastapi import Depends, HTTPException

from .auth import AuthContext, require_auth
from .db import db_conn


def _fetch_order_meta(cur, order_id: str) -> dict:
    """order 의 권한 판정용 메타 조회.
    locations.wh_id 로 wh-manager scope 비교 가능하도록 join.
    """
    cur.execute(
        """
        SELECT po.order_type, po.source_location_id, po.target_location_id, po.status,
               s.wh_id AS source_wh, t.wh_id AS target_wh, po.urgency_level
          FROM pending_orders po
          LEFT JOIN locations s ON s.location_id = po.source_location_id
          LEFT JOIN locations t ON t.location_id = po.target_location_id
         WHERE po.order_id = %s
        """,
        (order_id,),
    )
    row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail=f"order not found: {order_id}")
    return {
        "order_type": row[0],
        "source_loc": row[1],
        "target_loc": row[2],
        "status": row[3],
        "source_wh": row[4],
        "target_wh": row[5],
        "urgency_level": row[6],
    }


def _is_source_party(ctx: AuthContext, meta: dict) -> bool:
    if ctx.role == "branch-clerk" and ctx.scope_store_id == meta["source_loc"]:
        return True
    if ctx.role == "wh-manager" and ctx.scope_wh_id == meta["source_wh"]:
        return True
    return False


def _is_target_party(ctx: AuthContext, meta: dict) -> bool:
    if ctx.role == "branch-clerk" and ctx.scope_store_id == meta["target_loc"]:
        return True
    if ctx.role == "wh-manager" and ctx.scope_wh_id == meta["target_wh"]:
        return True
    return False


class Authority:
    """2026-05-15 v3 권한 매트릭스 (사용자 정정):
      - REBALANCE: 양측 매장 branch-clerk (정상) · hq-admin/외부 wh-manager (escalation BOTH)
      - WH_TO_STORE: source wh-manager + target branch-clerk · hq escalation
      - WH_TRANSFER: 양측 wh-manager · hq escalation
      - PUBLISHER_ORDER + NEWBOOK: hq-admin FINAL 단독
      - PUBLISHER_ORDER 그 외: hq-admin 또는 target wh-manager FINAL
    """

    @staticmethod
    def can_approve(ctx: AuthContext, meta: dict) -> bool:
        if ctx.role == "hq-admin":
            return True  # 모든 order 강제 승인 가능 (escalation = BOTH)
        if meta["order_type"] == "PUBLISHER_ORDER":
            # NEWBOOK = hq 단독 · 그 외 = target wh-manager 가능
            if meta.get("urgency_level") == "NEWBOOK":
                return False
            return ctx.role == "wh-manager" and ctx.scope_wh_id == meta["target_wh"]
        # REBALANCE / WH_TO_STORE / WH_TRANSFER — 양측 협의 또는 escalation
        # branch-clerk: source/target 매장 매칭 (정상)
        # wh-manager: source/target wh 매칭 (정상) 또는 escalation (BOTH)
        return _is_source_party(ctx, meta) or _is_target_party(ctx, meta) or ctx.role == "wh-manager"

    @staticmethod
    def can_dispatch(ctx: AuthContext, meta: dict) -> bool:
        if ctx.role == "hq-admin":
            return True
        if meta["order_type"] == "PUBLISHER_ORDER":
            return ctx.role == "wh-manager" and ctx.scope_wh_id == meta["target_wh"]
        # source 측 단독 (양측 협의 이미 끝남)
        return _is_source_party(ctx, meta)

    @staticmethod
    def can_receive(ctx: AuthContext, meta: dict) -> bool:
        if ctx.role == "hq-admin":
            return True
        if meta["order_type"] == "PUBLISHER_ORDER":
            return ctx.role == "wh-manager" and ctx.scope_wh_id == meta["target_wh"]
        return _is_target_party(ctx, meta)

    @staticmethod
    def can_reject(ctx: AuthContext, meta: dict) -> bool:
        if ctx.role == "hq-admin":
            return True
        if meta["order_type"] == "PUBLISHER_ORDER":
            if meta.get("urgency_level") == "NEWBOOK":
                return False
            return ctx.role == "wh-manager" and ctx.scope_wh_id == meta["target_wh"]
        # IN_TRANSIT 후 reject = 반품 (target 측만)
        if meta["status"] == "IN_TRANSIT":
            return _is_target_party(ctx, meta)
        return _is_source_party(ctx, meta) or _is_target_party(ctx, meta)

    @staticmethod
    def can_patch(ctx: AuthContext, meta: dict) -> bool:
        if ctx.role == "hq-admin":
            return True
        if meta["order_type"] == "PUBLISHER_ORDER":
            return False
        # 양측 모두 가능 (단 status IN PENDING/APPROVED 만 — endpoint 내부 추가 check)
        return _is_source_party(ctx, meta) or _is_target_party(ctx, meta)


_ACTION_MAP = {
    "approve":  Authority.can_approve,
    "dispatch": Authority.can_dispatch,
    "receive":  Authority.can_receive,
    "reject":   Authority.can_reject,
    "patch":    Authority.can_patch,
}


def require_authority(action: str):
    """FastAPI Depends factory. action ∈ {approve, dispatch, receive, reject, patch}.

    URL path 의 {order_id} 를 사용해 DB 조회 후 authority check.
    batch endpoint 는 endpoint 내부에서 row 별 check (별도 권한 검사 X).
    """
    check = _ACTION_MAP.get(action)
    if check is None:
        raise ValueError(f"unknown authority action: {action}")

    def dep(order_id: str, ctx: AuthContext = Depends(require_auth)) -> AuthContext:
        with db_conn() as conn:
            with conn.cursor() as cur:
                meta = _fetch_order_meta(cur, order_id)
        if not check(ctx, meta):
            raise HTTPException(
                status_code=403,
                detail=f"not authorized for {action} on order {order_id} "
                       f"(role={ctx.role}, order_type={meta['order_type']})",
            )
        # ctx 에 meta 부착 (endpoint 가 재조회 안 하도록)
        ctx._order_meta = meta  # type: ignore[attr-defined]
        return ctx
    return dep
