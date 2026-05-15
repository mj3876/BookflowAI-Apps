"""5 transition state machine — race-safe SQL + single inventory writer.

V6.3 4-step state machine v2 (PR-B):
  PENDING → [양측 ✓] → APPROVED → [source 발송] → IN_TRANSIT → [target 수령] → EXECUTED
  any → [reject] → REJECTED (rejection_stage 자동 기록)

불변식 (PR-A migration 006 CHECK 강제):
  - dispatched_at IS NOT NULL ⟺ status ∈ {IN_TRANSIT, EXECUTED, AUTO_EXECUTED} OR (REJECTED & rejection_stage='IN_TRANSIT')
  - executed_at IS NOT NULL  ⟺ status ∈ {EXECUTED, AUTO_EXECUTED}
  - rejection_stage IS NOT NULL ⟺ status = 'REJECTED'

Single-writer 정책: 모든 inventory.on_hand 변동은 inventory-svc /adjust HTTP 호출.
  state_machine 은 pending_orders 만 UPDATE · inventory 는 inventory-svc 위임.
  → stock.changed Redis publish 가 한 곳에서 발생 → cross-user WS sync 보장.
"""
from __future__ import annotations

import enum
import logging
import time

import httpx
from fastapi import HTTPException

from .auth import AuthContext
from .settings import settings

log = logging.getLogger(__name__)


class State(enum.Enum):
    APPROVED = "APPROVED"
    IN_TRANSIT = "IN_TRANSIT"
    EXECUTED = "EXECUTED"
    REJECTED = "REJECTED"


# ─── transition entry point ──────────────────────────────────────────────────
def transition(cur, order_id: str, target: State, ctx: AuthContext, **kw) -> dict:
    if target == State.APPROVED:
        return _to_approved(cur, order_id, ctx, kw.get("approval_side"))
    if target == State.IN_TRANSIT:
        return _to_in_transit(cur, order_id, ctx)
    if target == State.EXECUTED:
        return _to_executed(cur, order_id, ctx)
    if target == State.REJECTED:
        return _to_rejected(cur, order_id, ctx, kw["reject_reason"])
    raise ValueError(f"unknown state: {target}")


# ─── PENDING → APPROVED (race-safe via ON CONFLICT + COUNT subquery) ─────────
def _to_approved(cur, order_id: str, ctx: AuthContext, approval_side: str | None) -> dict:
    """양측 동의 → APPROVED.
    side 자동 추정 (ctx.role/scope vs order source/target) · ON CONFLICT 로 race-safe.
    rowcount > 0 인 thread 만 OrderApprovedFinal publish (중복 방지).

    2026-05-15 v3 escalation 지원:
      - "BOTH" = SOURCE + TARGET 두 row 동시 INSERT (hq-admin escalation · 자기 권역 외 wh-manager)
      - "FINAL" = PUBLISHER_ORDER 단독
      - "SOURCE"/"TARGET" = 정상 양측 협의 한쪽
    """
    side = approval_side or _infer_side(cur, order_id, ctx)
    if side not in ("SOURCE", "TARGET", "FINAL", "BOTH"):
        raise HTTPException(status_code=403, detail=f"cannot determine approval side (got {side})")

    # 1. order_approvals INSERT/UPDATE (UNIQUE(order_id, approval_side) 제약 의존)
    sides_to_insert = ["SOURCE", "TARGET"] if side == "BOTH" else [side]
    for s in sides_to_insert:
        cur.execute(
            """
            INSERT INTO order_approvals
                (approval_id, order_id, approver_id, approver_role, approval_side, decision, decided_at)
            VALUES (gen_random_uuid(), %s, %s, %s, %s, 'APPROVED', NOW())
            ON CONFLICT (order_id, approval_side) DO UPDATE
                SET decision = 'APPROVED',
                    decided_at = NOW(),
                    approver_id = EXCLUDED.approver_id,
                    approver_role = EXCLUDED.approver_role
            RETURNING approval_side
            """,
            (order_id, ctx.user_id, ctx.role, s),
            prepare=False,
        )

    # 2. status 전환 (PUBLISHER_ORDER = FINAL 단독 · 그 외 = SOURCE+TARGET 양측)
    cur.execute(
        """
        UPDATE pending_orders
           SET status = 'APPROVED', approved_at = NOW()
         WHERE order_id = %s
           AND status = 'PENDING'
           AND (
             order_type = 'PUBLISHER_ORDER'
             OR (SELECT COUNT(*) FROM order_approvals
                  WHERE order_id = pending_orders.order_id
                    AND decision = 'APPROVED'
                    AND approval_side IN ('SOURCE','TARGET')) >= 2
           )
        RETURNING order_id, order_type, source_location_id, target_location_id
        """,
        (order_id,),
    )
    row = cur.fetchone()
    transitioned = row is not None

    _audit(cur, ctx, f"order.approve.side={side}" + (".final" if transitioned else ""), order_id)
    return {"order_id": order_id, "side": side, "transitioned": transitioned}


# ─── APPROVED → IN_TRANSIT (source -qty · single-writer) ─────────────────────
def _to_in_transit(cur, order_id: str, ctx: AuthContext) -> dict:
    """status 전환 + dispatched_at atomic guard (이중 dispatch 차단).
    rowcount = 0 이면 ABORT — 이미 dispatched 또는 status mismatch.
    """
    cur.execute(
        """
        UPDATE pending_orders
           SET status = 'IN_TRANSIT', dispatched_at = NOW(), dispatched_by = %s
         WHERE order_id = %s AND status = 'APPROVED'
        RETURNING source_location_id, isbn13, qty, order_type
        """,
        (ctx.user_id, order_id),
    )
    row = cur.fetchone()
    if row is None:
        raise HTTPException(
            status_code=409,
            detail="order not in APPROVED state (already dispatched or wrong status)",
        )
    src, isbn, qty, order_type = row

    # inventory-svc /adjust (source -qty) · PUBLISHER_ORDER 는 source=NULL → skip
    if src is not None and order_type != "PUBLISHER_ORDER":
        _call_inventory_adjust(ctx, location_id=src, isbn13=isbn, delta=-qty,
                               reason=f"dispatch:{order_id[:8]}")

    _audit(cur, ctx, "order.dispatch", order_id)
    return {"order_id": order_id, "status": "IN_TRANSIT"}


# ─── IN_TRANSIT → EXECUTED (target +qty) ─────────────────────────────────────
def _to_executed(cur, order_id: str, ctx: AuthContext) -> dict:
    cur.execute(
        """
        UPDATE pending_orders
           SET status = 'EXECUTED', executed_at = NOW(), executed_by = %s
         WHERE order_id = %s AND status = 'IN_TRANSIT'
        RETURNING target_location_id, isbn13, qty, order_type
        """,
        (ctx.user_id, order_id),
    )
    row = cur.fetchone()
    if row is None:
        raise HTTPException(status_code=409, detail="order not in IN_TRANSIT state")
    tgt, isbn, qty, order_type = row

    _call_inventory_adjust(ctx, location_id=tgt, isbn13=isbn, delta=+qty,
                           reason=f"receive:{order_id[:8]}")
    _audit(cur, ctx, "order.receive", order_id)

    # 2026-05-15 v4 GG: chained order automation
    # PUBLISHER_ORDER 또는 WH_TRANSFER 의 target=wh 본체 receive 시 → 부족 매장 1개로 WH_TO_STORE 자동 INSERT
    # (외부 발주 / 권역 이동 모두 wh 도착 후 매장 분배 단계 자연스럽게 trigger)
    chained_id = None
    if order_type in ("PUBLISHER_ORDER", "WH_TRANSFER"):
        chained_id = _trigger_chained_wh_to_store(cur, order_id, tgt, isbn, qty, ctx)
    return {"order_id": order_id, "status": "EXECUTED", "chained_order_id": chained_id}


def _trigger_chained_wh_to_store(cur, parent_id: str, wh_loc: int, isbn: str, qty: int, ctx: AuthContext) -> str | None:
    """PUBLISHER_ORDER / WH_TRANSFER 도착 후 매장 분배 (chained WH_TO_STORE).
    가장 부족한 매장 (effective_available 최저) 1개 선택 + 자동 PENDING INSERT.
    """
    # 1. target wh_id 결정 (wh 본체 location 의 wh_id)
    cur.execute("SELECT wh_id FROM locations WHERE location_id = %s AND location_type='WH'", (wh_loc,))
    row = cur.fetchone()
    if not row:
        return None  # wh 가 아니면 chained 안 함 (이미 매장 발주)
    wh_id = row[0]

    # 2. 그 wh 권역의 매장 중 isbn 가용 재고 가장 낮은 1개 선택
    cur.execute(
        """
        SELECT i.location_id, COALESCE(i.on_hand, 0) - COALESCE(i.reserved_qty, 0) AS available
          FROM inventory i
          JOIN locations l ON l.location_id = i.location_id
         WHERE l.wh_id = %s AND l.location_type = 'STORE_OFFLINE' AND l.active = TRUE
           AND i.isbn13 = %s
         ORDER BY available ASC
         LIMIT 1
        """,
        (wh_id, isbn),
    )
    target_row = cur.fetchone()
    if not target_row:
        return None
    target_store = target_row[0]

    # 3. WH_TO_STORE PENDING 자동 INSERT (LEAD_DAYS=1 → expected_arrival_at = NOW + 1d)
    chained_id = None
    cur.execute(
        """
        INSERT INTO pending_orders
            (order_id, order_type, isbn13, source_location_id, target_location_id, qty,
             est_lead_time_hours, est_cost, urgency_level, auto_execute_eligible,
             status, created_at, expected_arrival_at,
             forecast_rationale)
        VALUES (gen_random_uuid(), 'WH_TO_STORE', %s, %s, %s, %s,
                6, %s * 500, 'NORMAL', false,
                'PENDING', NOW(), (NOW() + INTERVAL '1 day')::date,
                jsonb_build_object('reason', 'chained_from_wh_arrival', 'parent_order_id', %s, 'expected_arrival_date', (NOW() + INTERVAL '1 day')::date::text))
        RETURNING order_id
        """,
        (isbn, wh_loc, target_store, qty, qty, parent_id),
    )
    chained = cur.fetchone()
    if chained:
        chained_id = str(chained[0])
        _audit(cur, ctx, f"order.chained_wh_to_store.from={parent_id[:8]}", chained_id)
    return chained_id


# ─── any → REJECTED (rejection_stage 자동 기록 · IN_TRANSIT 시만 source 복원) ─
def _to_rejected(cur, order_id: str, ctx: AuthContext, reject_reason: str) -> dict:
    cur.execute(
        """
        UPDATE pending_orders
           SET status = 'REJECTED',
               rejection_stage = CASE status
                 WHEN 'PENDING'    THEN 'PENDING'
                 WHEN 'APPROVED'   THEN 'APPROVED'
                 WHEN 'IN_TRANSIT' THEN 'IN_TRANSIT'
               END,
               reject_reason = %s,
               reject_count = reject_count + 1
         WHERE order_id = %s
           AND status IN ('PENDING','APPROVED','IN_TRANSIT')
        RETURNING rejection_stage, source_location_id, isbn13, qty, order_type
        """,
        (reject_reason, order_id),
    )
    row = cur.fetchone()
    if row is None:
        raise HTTPException(status_code=409, detail="order already finalized (EXECUTED or REJECTED)")
    stage, src, isbn, qty, order_type = row

    # IN_TRANSIT 거부만 source 복원 (출고된 재고 되돌림)
    if stage == "IN_TRANSIT" and src is not None and order_type != "PUBLISHER_ORDER":
        _call_inventory_adjust(ctx, location_id=src, isbn13=isbn, delta=+qty,
                               reason=f"reject-restore:{order_id[:8]}")

    _audit(cur, ctx, f"order.reject.stage={stage}", order_id)
    return {"order_id": order_id, "status": "REJECTED", "rejection_stage": stage}


# ─── helpers ─────────────────────────────────────────────────────────────────
def _call_inventory_adjust(ctx: AuthContext, *, location_id: int, isbn13: str,
                            delta: int, reason: str) -> None:
    """inventory-svc HTTP 호출 · single writer · stock.changed publish 보장.
    timeout 3s + 1 retry (transient failure tolerance).
    """
    url = f"{settings.inventory_svc_url}/inventory/adjust"
    payload = {"location_id": location_id, "isbn13": isbn13, "delta": delta, "reason": reason}
    headers = {"Authorization": f"Bearer {ctx.token}" if not ctx.token.startswith("Bearer ") else ctx.token}

    last_err: Exception | None = None
    for attempt in range(2):
        try:
            with httpx.Client(timeout=3.0) as client:
                r = client.post(url, json=payload, headers=headers)
            if r.status_code >= 400:
                raise HTTPException(status_code=502,
                                    detail=f"inventory-svc adjust failed ({r.status_code}): {r.text[:200]}")
            return
        except (httpx.TimeoutException, httpx.ConnectError, httpx.NetworkError) as e:
            last_err = e
            if attempt == 0:
                time.sleep(0.5)
                continue
    raise HTTPException(status_code=502, detail=f"inventory-svc unreachable after retry: {last_err}")


def _audit(cur, ctx: AuthContext, action: str, order_id: str) -> None:
    cur.execute(
        """
        INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id)
        VALUES ('USER', %s, %s, 'pending_orders', %s)
        """,
        (ctx.user_id, action, order_id),
    )


def _infer_side(cur, order_id: str, ctx: AuthContext) -> str:
    """ctx.role/scope 와 order 의 source/target 비교하여 SOURCE / TARGET / FINAL / BOTH 추정.

    2026-05-15 v3 권한 매트릭스:
      - PUBLISHER_ORDER + NEWBOOK → hq FINAL 단독
      - PUBLISHER_ORDER 그 외 → target wh-manager 또는 hq FINAL
      - REBALANCE: 매장↔매장 (branch-clerk 양측 협의) · hq/외부wh-manager 는 BOTH escalation
      - WH_TO_STORE: source wh-manager + target branch-clerk · hq 는 BOTH escalation
      - WH_TRANSFER: 양측 wh-manager · hq 는 BOTH escalation
    """
    cur.execute(
        """
        SELECT po.order_type, po.source_location_id, po.target_location_id,
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
    order_type, src_loc, tgt_loc, src_wh, tgt_wh, urgency = row

    # PUBLISHER_ORDER
    if order_type == "PUBLISHER_ORDER":
        # NEWBOOK 신간 지시 = hq 단독
        if urgency == "NEWBOOK":
            if ctx.role != "hq-admin":
                raise HTTPException(status_code=403, detail="NEWBOOK PUBLISHER_ORDER 는 hq-admin 단독 권한")
            return "FINAL"
        # 그 외 (forecast/spike) = target wh-manager 또는 hq
        if ctx.role == "hq-admin":
            return "FINAL"
        if ctx.role == "wh-manager" and ctx.scope_wh_id == tgt_wh:
            return "FINAL"
        raise HTTPException(status_code=403, detail="PUBLISHER_ORDER 는 hq-admin 또는 target wh-manager 만 승인 가능")

    # hq-admin: 정상 협의가 아닌 escalation (양측 자동)
    if ctx.role == "hq-admin":
        return "BOTH"

    # branch-clerk: 자기 매장 source/target 정확 매칭
    if ctx.role == "branch-clerk":
        if ctx.scope_store_id == src_loc:
            return "SOURCE"
        if ctx.scope_store_id == tgt_loc:
            return "TARGET"
        raise HTTPException(status_code=403, detail="자기 매장 외 권한 없음")

    # wh-manager: 자기 권역 정확 매칭
    if ctx.role == "wh-manager":
        # WH_TRANSFER: 자기 권역 source 또는 target → SOURCE/TARGET 정상 협의
        if order_type == "WH_TRANSFER":
            if ctx.scope_wh_id == src_wh:
                return "SOURCE"
            if ctx.scope_wh_id == tgt_wh:
                return "TARGET"
            return "BOTH"  # 자기 권역 외 → escalation
        # WH_TO_STORE: source wh-manager (source_wh 매칭) 만 정상. 자기 권역 매장이 target 이면 X (branch 일)
        if order_type == "WH_TO_STORE":
            if ctx.scope_wh_id == src_wh:
                return "SOURCE"
            return "BOTH"  # 다른 권역 wh-manager → escalation
        # REBALANCE: 매장↔매장 (wh-manager 단독은 정상 X) → escalation 만
        if order_type == "REBALANCE":
            return "BOTH"

    raise HTTPException(status_code=403, detail="user not party to this order")
