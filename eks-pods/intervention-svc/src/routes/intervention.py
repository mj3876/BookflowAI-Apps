"""intervention routes - V6.2 3-stage decision authority enforcement.

Stage / order_type / approval_side 행렬 (시트10 + 시트04 12 events):

| Stage | order_type        | approval_side    | 권한                                                    |
|-------|-------------------|------------------|-------------------------------------------------------|
| 1     | REBALANCE         | FINAL only       | wh-manager (SOURCE/TARGET 같은 wh - 자기 wh 만)            |
| 2     | WH_TRANSFER       | SOURCE / TARGET  | wh-manager (SOURCE 면 source location 의 wh, 동일)         |
| 3     | PUBLISHER_ORDER   | FINAL only       | hq-admin 만                                             |

Stage 2 양쪽 (SOURCE+TARGET) 모두 APPROVED → status=APPROVED 자동 전환.
hq-admin 은 모든 stage 의 FINAL 권한 가짐 (escalation).

승인/거절 후 notification-svc /notification/send 호출 (시트04 12 events 정합):
  - approve → OrderApproved
  - reject  → OrderRejected
  - returns/approve → ReturnPending (승인 시점에 알림)
  - new-book/approve → NewBookRequest (승인 시점에 알림)
"""
import json
import logging
import os
from datetime import datetime
from uuid import UUID, uuid4

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, status

from ..auth import AuthContext, require_auth
from ..db import db_conn
from ..models import (
    ApprovalResponse,
    ApproveRequest,
    QueueItem,
    QueueResponse,
    RejectRequest,
    ReturnApproveRequest,
    ReturnApproveResponse,
    ReturnRejectRequest,
    ReturnRejectResponse,
)

log = logging.getLogger(__name__)
router = APIRouter(prefix="/intervention", tags=["intervention"])

NOTIFICATION_SVC_URL = os.environ.get(
    "INTERVENTION_NOTIFICATION_SVC_URL",
    "http://notification-svc.bookflow.svc.cluster.local",
)

INVENTORY_SVC_URL = os.environ.get(
    "INTERVENTION_INVENTORY_SVC_URL",
    "http://inventory-svc.bookflow.svc.cluster.local",
)


def _notify(token: str, event_type: str, severity: str, payload: dict, correlation_id: str | None = None) -> None:
    """notification-svc /send 호출 (실패 비치명 · log only)."""
    body = {
        "event_type": event_type,
        "severity": severity,
        "recipients": [],
        "channels": "redis,websocket" if event_type == "OrderPending" else "websocket,logic-apps",
        "payload_summary": payload,
    }
    if correlation_id:
        body["correlation_id"] = correlation_id
    try:
        with httpx.Client(timeout=2.0) as c:
            c.post(
                f"{NOTIFICATION_SVC_URL}/notification/send",
                headers={"Authorization": token},
                json=body,
            )
    except Exception as e:
        log.warning("notification-svc /send (%s) failed (non-fatal): %s", event_type, e)


def _location_wh(cur, location_id: int | None) -> int | None:
    """location_id → wh_id JOIN. None 입력 시 None (PUBLISHER_ORDER source 등)."""
    if location_id is None:
        return None
    cur.execute("SELECT wh_id FROM locations WHERE location_id = %s", (location_id,))
    row = cur.fetchone()
    return row[0] if row else None


def _validate_authority(cur, ctx: AuthContext, order_id: str, side: str) -> tuple[str, int | None, int | None]:
    """승인 권한 검증.

    Returns (order_type, source_wh, target_wh) for valid case. Raises 403 on violation.

    Rules:
    - REBALANCE  : approval_side='FINAL' only · approver wh == source/target wh (둘 다 같음)
    - WH_TRANSFER: approval_side in ('SOURCE','TARGET') · approver wh == 해당 side 의 wh
    - PUBLISHER_ORDER: approval_side='FINAL' only · role='hq-admin' only
    - hq-admin escalation: 어느 stage 의 FINAL 도 가능 (override)
    """
    cur.execute(
        "SELECT order_type, source_location_id, target_location_id FROM pending_orders WHERE order_id = %s",
        (order_id,),
    )
    row = cur.fetchone()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="order not found")
    order_type, source_loc, target_loc = row
    source_wh = _location_wh(cur, source_loc)
    target_wh = _location_wh(cur, target_loc)

    if order_type == "REBALANCE":
        if side != "FINAL":
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                                detail="REBALANCE 는 approval_side='FINAL' 만 허용 (단일 승인)")
        if ctx.role == "hq-admin":
            return order_type, source_wh, target_wh
        # FR-A6.6 매장 직원 입고 거부 — REBALANCE target 이 자기 매장이면 거부 권한
        if ctx.role == "branch-clerk":
            if ctx.scope_store_id is None:
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                                    detail="branch-clerk scope_store_id 부재 (인증 토큰 손상)")
            if ctx.scope_store_id != target_loc:
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                                    detail=f"자기 매장만 거부 가능 (scope_store_id={ctx.scope_store_id} · target={target_loc})")
            return order_type, source_wh, target_wh
        if ctx.role != "wh-manager" or ctx.scope_wh_id is None:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                                detail="REBALANCE 는 wh-manager · branch-clerk · hq-admin 만 승인 가능")
        if ctx.scope_wh_id not in (source_wh, target_wh):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                                detail=f"본인 창고 외 주문 승인 불가 (scope wh_id={ctx.scope_wh_id} · order wh_id={source_wh}/{target_wh})")

    elif order_type == "WH_TRANSFER":
        if side not in ("SOURCE", "TARGET"):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                                detail="WH_TRANSFER 는 approval_side in ('SOURCE','TARGET') 만 허용 (양쪽 승인 필요)")
        if ctx.role == "hq-admin":
            return order_type, source_wh, target_wh
        if ctx.role != "wh-manager" or ctx.scope_wh_id is None:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                                detail="WH_TRANSFER 는 wh-manager 또는 hq-admin 만 승인 가능")
        my_side_wh = source_wh if side == "SOURCE" else target_wh
        if ctx.scope_wh_id != my_side_wh:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                                detail=f"{side} 사이드 권한 없음 (scope wh_id={ctx.scope_wh_id} · {side} wh_id={my_side_wh})")

    elif order_type == "PUBLISHER_ORDER":
        # 사용자 결정 2026-05-03: 물류센터가 발주 주체. wh-manager 자기 권역 OK.
        if side != "FINAL":
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                                detail="PUBLISHER_ORDER 는 approval_side='FINAL' 만 허용")
        if ctx.role == "hq-admin":
            return order_type, source_wh, target_wh
        if ctx.role == "wh-manager" and ctx.scope_wh_id is not None:
            if ctx.scope_wh_id == target_wh:
                return order_type, source_wh, target_wh
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                                detail=f"PUBLISHER_ORDER 자기 권역만 승인 가능 (scope_wh_id={ctx.scope_wh_id} · target_wh={target_wh})")
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                            detail="PUBLISHER_ORDER 는 hq-admin 또는 자기 권역 wh-manager 만 승인 가능")

    else:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail=f"unknown order_type: {order_type}")

    return order_type, source_wh, target_wh


@router.get("/queue", response_model=QueueResponse)
def queue(
    ctx: AuthContext = Depends(require_auth),
    limit: int = Query(default=50, ge=1, le=500),
    order_type: str | None = Query(default=None, description="REBALANCE | WH_TRANSFER | PUBLISHER_ORDER"),
    wh_id: int | None = Query(default=None, description="해당 wh 가 source 또는 target 인 주문만"),
):
    """PENDING 주문 큐. role 기반 자동 필터:

    - hq-admin: 명시적 wh_id/order_type 쿼리 없으면 전체. 보통 PUBLISHER_ORDER 만 보고 싶음 → ?order_type=PUBLISHER_ORDER
    - wh-manager: scope_wh_id 자동 적용 (자기 wh 가 source 또는 target)
    """
    where = ["po.status = 'PENDING'"]
    params: list = []

    # role 자동 scope
    if ctx.role == "wh-manager" and ctx.scope_wh_id is not None:
        where.append(
            "(EXISTS (SELECT 1 FROM locations sl WHERE sl.location_id = po.source_location_id AND sl.wh_id = %s)"
            " OR EXISTS (SELECT 1 FROM locations tl WHERE tl.location_id = po.target_location_id AND tl.wh_id = %s))"
        )
        params.extend([ctx.scope_wh_id, ctx.scope_wh_id])

    # 명시적 wh_id 필터 (hq-admin override)
    if wh_id is not None and ctx.role == "hq-admin":
        where.append(
            "(EXISTS (SELECT 1 FROM locations sl WHERE sl.location_id = po.source_location_id AND sl.wh_id = %s)"
            " OR EXISTS (SELECT 1 FROM locations tl WHERE tl.location_id = po.target_location_id AND tl.wh_id = %s))"
        )
        params.extend([wh_id, wh_id])

    if order_type:
        where.append("po.order_type = %s")
        params.append(order_type)

    params.append(limit)
    sql = f"""
        SELECT po.order_id, po.order_type, po.isbn13,
               po.source_location_id, po.target_location_id, po.qty,
               po.urgency_level, po.auto_execute_eligible, po.status, po.created_at,
               po.forecast_rationale
          FROM pending_orders po
         WHERE {' AND '.join(where)}
         ORDER BY po.urgency_level DESC, po.created_at ASC
         LIMIT %s
    """
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, params)
        rows = cur.fetchall()

    items = [
        QueueItem(
            order_id=r[0], order_type=r[1], isbn13=r[2],
            source_location_id=r[3], target_location_id=r[4],
            qty=r[5], urgency_level=r[6], auto_execute_eligible=r[7],
            status=r[8], created_at=r[9],
            forecast_rationale=r[10],
        )
        for r in rows
    ]
    return QueueResponse(items=items)


def _record_approval(conn, order_id: str, ctx: AuthContext, side: str, decision: str, reject_reason: str | None) -> tuple[str, datetime]:
    """order_approvals INSERT + pending_orders status 전환 + audit_log."""
    approval_id = str(uuid4())
    cur = conn.cursor()
    # psycopg3 의 prepared statement 가 ON CONFLICT + NULL 조합에서 타입 추론 실패하는 이슈 회피.
    # SELECT-then-UPSERT 패턴 + 모든 파라미터에 명시적 cast.
    cur.execute(
        "SELECT approval_id FROM order_approvals WHERE order_id = %s::uuid AND approval_side = %s::varchar",
        (order_id, side),
        prepare=False,
    )
    existing = cur.fetchone()
    if existing:
        cur.execute(
            """
            UPDATE order_approvals
               SET approver_id = %s::varchar, approver_role = %s::varchar, approver_wh_id = %s::smallint,
                   decision = %s::varchar, reject_reason = %s::varchar, decided_at = NOW()
             WHERE approval_id = %s::uuid
            RETURNING approval_id, decided_at
            """,
            (ctx.user_id, ctx.role, ctx.scope_wh_id,
             decision, reject_reason, str(existing[0])),
            prepare=False,
        )
    else:
        cur.execute(
            """
            INSERT INTO order_approvals
                (approval_id, order_id, approver_id, approver_role, approver_wh_id,
                 approval_side, decision, reject_reason)
            VALUES (%s::uuid, %s::uuid, %s::varchar, %s::varchar, %s::smallint,
                    %s::varchar, %s::varchar, %s::varchar)
            RETURNING approval_id, decided_at
            """,
            (approval_id, order_id, ctx.user_id, ctx.role, ctx.scope_wh_id,
             side, decision, reject_reason),
            prepare=False,
        )
    aid, decided_at = cur.fetchone()

    # status 전환:
    #  - REBALANCE / PUBLISHER_ORDER: FINAL APPROVED 1번 → APPROVED
    #  - WH_TRANSFER: SOURCE+TARGET 둘 다 APPROVED → APPROVED
    #  - REJECTED: 어느 side 든 한 번 거절 → REJECTED + reject_count++
    if decision == "APPROVED" and side == "FINAL":
        cur.execute(
            "UPDATE pending_orders SET status = 'APPROVED', approved_at = NOW() WHERE order_id = %s",
            (order_id,),
        )
    elif decision == "APPROVED" and side in ("SOURCE", "TARGET"):
        cur.execute(
            """
            UPDATE pending_orders SET status = 'APPROVED', approved_at = NOW()
             WHERE order_id = %s
               AND (SELECT COUNT(*) FROM order_approvals
                     WHERE order_id = %s AND decision = 'APPROVED'
                       AND approval_side IN ('SOURCE', 'TARGET')) >= 2
            """,
            (order_id, order_id),
        )
    elif decision == "REJECTED":
        cur.execute(
            "UPDATE pending_orders SET status = 'REJECTED', reject_reason = %s, reject_count = reject_count + 1 WHERE order_id = %s",
            (reject_reason, order_id),
        )

    cur.execute(
        """
        INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, after_state)
        VALUES ('user', %s, %s, 'pending_orders', %s, %s::jsonb)
        """,
        (
            ctx.user_id,
            f"intervention.{decision.lower()}",
            order_id,
            json.dumps({
                "approval_id": str(aid), "side": side, "decision": decision, "reject_reason": reject_reason,
                "approver_role": ctx.role, "approver_wh_id": ctx.scope_wh_id,
            }),
        ),
        prepare=False,
    )
    return str(aid), decided_at


@router.post("/approve", response_model=ApprovalResponse)
def approve(req: ApproveRequest, ctx: AuthContext = Depends(require_auth)):
    with db_conn() as conn:
        with conn.cursor() as cur:
            order_type, source_wh, target_wh = _validate_authority(cur, ctx, str(req.order_id), req.approval_side)
        aid, decided_at = _record_approval(conn, str(req.order_id), ctx, req.approval_side, "APPROVED", None)
        # WH_TRANSFER 양쪽 (SOURCE+TARGET) 모두 APPROVED 됐는지 후-검증 → final notification 보낼지 판단
        with conn.cursor() as cur:
            cur.execute("SELECT status FROM pending_orders WHERE order_id = %s", (str(req.order_id),))
            final_status = cur.fetchone()[0]
        conn.commit()

    # 시트04 ②OrderApproved · 양쪽 다 APPROVED 된 경우만 'final' 알림 (WH_TRANSFER 한쪽만 승인 시 부분 진행)
    _notify(
        ctx.token, "OrderApproved",
        severity="INFO",
        payload={
            "order_id": str(req.order_id),
            "order_type": order_type,
            "approval_side": req.approval_side,
            "approval_id": aid,
            "approver_role": ctx.role,
            "approver_wh_id": ctx.scope_wh_id,
            "final_status": final_status,
        },
        correlation_id=str(req.order_id),
    )
    return ApprovalResponse(approval_id=aid, order_id=req.order_id, decision="APPROVED", decided_at=decided_at)


@router.post("/reject", response_model=ApprovalResponse)
def reject(req: RejectRequest, ctx: AuthContext = Depends(require_auth)):
    with db_conn() as conn:
        with conn.cursor() as cur:
            order_type, source_wh, target_wh = _validate_authority(cur, ctx, str(req.order_id), req.approval_side)
        aid, decided_at = _record_approval(conn, str(req.order_id), ctx, req.approval_side, "REJECTED", req.reject_reason)
        conn.commit()

    # 시트04 ③OrderRejected
    _notify(
        ctx.token, "OrderRejected",
        severity="WARNING",
        payload={
            "order_id": str(req.order_id),
            "order_type": order_type,
            "approval_side": req.approval_side,
            "approval_id": aid,
            "approver_role": ctx.role,
            "approver_wh_id": ctx.scope_wh_id,
            "reject_reason": req.reject_reason,
        },
        correlation_id=str(req.order_id),
    )
    return ApprovalResponse(approval_id=aid, order_id=req.order_id, decision="REJECTED", decided_at=decided_at)


@router.post("/returns/approve", response_model=ReturnApproveResponse)
def returns_approve(req: ReturnApproveRequest, ctx: AuthContext = Depends(require_auth)):
    if ctx.role != "hq-admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="반품 승인은 hq-admin 만 가능")

    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE returns SET status = 'APPROVED', hq_approved_at = NOW()
                 WHERE return_id = %s AND status = 'PENDING'
                RETURNING status, hq_approved_at
                """,
                (str(req.return_id),),
            )
            row = cur.fetchone()
            if row is None:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="return not found or already processed")
            cur.execute(
                """
                INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, after_state)
                VALUES ('user', %s, 'intervention.returns.approve', 'returns', %s, %s)
                """,
                (ctx.user_id, str(req.return_id), json.dumps({"note": req.note})),
            )
        conn.commit()

    # 시트04 ⑩ReturnPending (HQ 승인 = 반품 처리 시작 시점 알림)
    _notify(
        ctx.token, "ReturnPending",
        severity="INFO",
        payload={
            "return_id": str(req.return_id),
            "approver_role": ctx.role,
            "note": req.note,
        },
        correlation_id=str(req.return_id),
    )

    return ReturnApproveResponse(return_id=req.return_id, status=row[0], hq_approved_at=row[1])


# ─── A4 (FR-A6.8) HQ 반품 거부 ─────────────────────────────────────────────────
@router.post("/returns/reject", response_model=ReturnRejectResponse)
def returns_reject(req: ReturnRejectRequest, ctx: AuthContext = Depends(require_auth)):
    """본사 마스터 반품 기각.

    - 권한: hq-admin only (단일 결정)
    - 상태 전이: PENDING → REJECTED · rejected_at + reject_reason 채움
    - 이미 APPROVED/EXECUTED/REJECTED 상태면 404 (재처리 방지)
    """
    if ctx.role != "hq-admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="반품 거부는 hq-admin 만 가능")

    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE returns
                   SET status = 'REJECTED', rejected_at = NOW(), reject_reason = %s
                 WHERE return_id = %s AND status = 'PENDING'
                RETURNING status, rejected_at, reject_reason
                """,
                (req.reject_reason, str(req.return_id)),
            )
            row = cur.fetchone()
            if row is None:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="return not found or already processed")
            cur.execute(
                """
                INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, after_state)
                VALUES ('user', %s, 'intervention.returns.reject', 'returns', %s, %s)
                """,
                (ctx.user_id, str(req.return_id), json.dumps({"reject_reason": req.reject_reason})),
            )
        conn.commit()

    # Notification: 시트04 미정의이라 audit_log 만 남김 (ReturnRejected 추가 시 _notify 호출 추가)
    return ReturnRejectResponse(
        return_id=req.return_id,
        status=row[0],
        rejected_at=row[1],
        reject_reason=row[2],
    )


# ─── New book request approval (HQ Requests page) ─────────────────────────────
@router.post("/new-book-requests/{request_id}/approve")
def approve_new_book_request(
    request_id: int,
    body: dict | None = None,
    ctx: AuthContext = Depends(require_auth),
):
    """출판사 신간 신청 → HQ 편입 결정 (FR-A4.8 신간 발주 지시서 자동 실행).

    body = { wh1_qty?: int >= 0, wh2_qty?: int >= 0 } - 권역별 분배 수량.
    둘 다 0/None 이면 status APPROVED 만 (지시서 미발행 호환 모드).

    효과:
    1. new_book_requests.status='APPROVED'
    2. wh1_qty, wh2_qty > 0 면 → pending_orders PUBLISHER_ORDER 자동 생성 (status=APPROVED · 본사 단독 승인)
    3. ⑨NewBookRequest 알림 (시트04 12 events)
    """
    if ctx.role != "hq-admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="신간 승인은 hq-admin 만 가능")

    body = body or {}
    wh1_qty = int(body.get("wh1_qty") or 0)
    wh2_qty = int(body.get("wh2_qty") or 0)
    if wh1_qty < 0 or wh2_qty < 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="qty 는 0 이상")

    new_orders: list[dict] = []
    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE new_book_requests SET status = 'APPROVED', approved_at = NOW() WHERE id = %s AND status IN ('NEW','FETCHED') RETURNING isbn13",
                (request_id,),
            )
            row = cur.fetchone()
            if row is None:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="요청 없음 또는 이미 처리됨")
            isbn13 = row[0]

            # 권역별 발주 지시서 자동 생성 (FR-A4.8 · 본사 신간 지시는 물류센터 자동 실행)
            for wh_id, qty in [(1, wh1_qty), (2, wh2_qty)]:
                if qty <= 0:
                    continue
                cur.execute(
                    "SELECT location_id FROM locations WHERE wh_id = %s AND location_type = 'WAREHOUSE' LIMIT 1",
                    (wh_id,),
                )
                loc = cur.fetchone()
                target_loc = loc[0] if loc else wh_id  # fallback
                order_id = uuid4()
                cur.execute(
                    """
                    INSERT INTO pending_orders
                        (order_id, order_type, isbn13, source_location_id, target_location_id,
                         qty, urgency_level, status, approved_at)
                    VALUES (%s, 'PUBLISHER_ORDER', %s, NULL, %s, %s, 'NEWBOOK', 'APPROVED', NOW())
                    """,
                    (str(order_id), isbn13, target_loc, qty),
                )
                new_orders.append({"order_id": str(order_id), "wh_id": wh_id, "qty": qty})

            cur.execute(
                """
                INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, after_state)
                VALUES ('user', %s, 'intervention.new_book.approve', 'new_book_requests', %s, %s)
                """,
                (ctx.user_id, str(request_id),
                 json.dumps({"isbn13": isbn13, "wh1_qty": wh1_qty, "wh2_qty": wh2_qty, "orders": new_orders})),
            )
        conn.commit()

    # 시트04 ⑨NewBookRequest (publisher-watcher 가 NEW 시점 한 번 발송 + HQ 승인 시 한 번 더)
    _notify(
        ctx.token, "NewBookRequest",
        severity="INFO",
        payload={
            "id": request_id,
            "isbn13": isbn13,
            "stage": "APPROVED",
            "approver_role": ctx.role,
            "wh1_qty": wh1_qty,
            "wh2_qty": wh2_qty,
            "orders_created": len(new_orders),
        },
    )

    return {
        "id": request_id,
        "status": "APPROVED",
        "isbn13": isbn13,
        "wh1_qty": wh1_qty,
        "wh2_qty": wh2_qty,
        "orders": new_orders,
    }


# ─── New book request reject ──────────────────────────────────────────────────
@router.post("/new-book-requests/{request_id}/reject")
def reject_new_book_request(
    request_id: int,
    body: dict | None = None,
    ctx: AuthContext = Depends(require_auth),
):
    """본사가 신간 시스템 편입 거절. body = { reason?: str }"""
    if ctx.role != "hq-admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="신간 거절은 hq-admin 만 가능")

    reason = (body or {}).get("reason") or None
    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE new_book_requests SET status = 'REJECTED', approved_at = NOW() WHERE id = %s AND status IN ('NEW','FETCHED') RETURNING isbn13",
                (request_id,),
            )
            row = cur.fetchone()
            if row is None:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="요청 없음 또는 이미 처리됨")
            cur.execute(
                """
                INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, after_state)
                VALUES ('user', %s, 'intervention.new_book.reject', 'new_book_requests', %s, %s)
                """,
                (ctx.user_id, str(request_id), json.dumps({"isbn13": row[0], "reason": reason})),
            )
        conn.commit()

    return {"id": request_id, "status": "REJECTED", "isbn13": row[0]}


# ─── HQ 도서 ON/OFF + 소진 모드 (FR-A6.1 + A6.2) ────────────────────────────────
_VALID_BOOK_STATUSES = ("NORMAL", "SOFT_DISCONTINUE", "INACTIVE")


@router.post("/books/{isbn13}/status")
def change_book_status(
    isbn13: str,
    body: dict,
    ctx: AuthContext = Depends(require_auth),
):
    """본사 도서 활성/비활성 마스터 컨트롤.

    - NORMAL: 자동 사이클 정상 (기본값) · active=TRUE · discontinue_mode='NONE'
    - SOFT_DISCONTINUE: 신규 발주 차단, 재분배 허용 (forecast/decision/rebalance 가 mode 체크)
    - INACTIVE: 자동 사이클 완전 정지 (예측·발주·재분배 모두 스킵) · active=FALSE

    body = { mode: NORMAL|SOFT_DISCONTINUE|INACTIVE, reason?: str }
    """
    if ctx.role != "hq-admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                            detail="도서 ON/OFF 는 hq-admin 만 가능 (본사 마스터 컨트롤)")

    mode = (body or {}).get("mode")
    reason = (body or {}).get("reason") or None
    if mode not in _VALID_BOOK_STATUSES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail=f"mode 는 {list(_VALID_BOOK_STATUSES)} 중 하나여야 함")

    if mode == "NORMAL":
        sql = """
            UPDATE books
               SET active = TRUE,
                   discontinue_mode = 'NONE',
                   discontinue_reason = NULL,
                   discontinue_at = NULL,
                   discontinue_by = NULL,
                   reactivated_at = NOW()
             WHERE isbn13 = %s
             RETURNING isbn13, active, discontinue_mode
        """
        params = (isbn13,)
    elif mode == "SOFT_DISCONTINUE":
        sql = """
            UPDATE books
               SET active = TRUE,
                   discontinue_mode = 'SOFT_DISCONTINUE',
                   discontinue_reason = %s,
                   discontinue_at = NOW(),
                   discontinue_by = %s,
                   reactivated_at = NULL
             WHERE isbn13 = %s
             RETURNING isbn13, active, discontinue_mode
        """
        params = (reason, ctx.user_id, isbn13)
    else:  # INACTIVE
        sql = """
            UPDATE books
               SET active = FALSE,
                   discontinue_mode = 'INACTIVE',
                   discontinue_reason = %s,
                   discontinue_at = NOW(),
                   discontinue_by = %s,
                   reactivated_at = NULL
             WHERE isbn13 = %s
             RETURNING isbn13, active, discontinue_mode
        """
        params = (reason, ctx.user_id, isbn13)

    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            row = cur.fetchone()
            if row is None:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND,
                                    detail=f"isbn13 {isbn13} 를 찾을 수 없음")
            cur.execute(
                """
                INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, after_state)
                VALUES ('user', %s, 'intervention.book.status', 'books', %s, %s)
                """,
                (ctx.user_id, isbn13, json.dumps({"mode": mode, "reason": reason})),
            )
        conn.commit()

    return {"isbn13": row[0], "active": row[1], "discontinue_mode": row[2], "mode": mode}


# ─── A1 inbound receive (FR-A6.6 + 후속) ──────────────────────────────────
@router.post("/inbound/{order_id}/receive")
def receive_inbound(order_id: str, ctx: AuthContext = Depends(require_auth)):
    """매장/창고 입고 수령 처리 — pending_orders.status='EXECUTED' + inventory.on_hand += qty.

    권한:
      - branch-clerk: scope_store_id == target_location_id
      - wh-manager:   scope_wh_id   == target_wh
      - hq-admin:     모두 허용

    Single writer 패턴 유지: inventory mutation 은 inventory-svc /adjust 프록시 호출 (REST).
    조회·status·audit 는 본 svc 가 담당.
    """
    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """SELECT order_type, target_location_id, qty, isbn13, status
                     FROM pending_orders WHERE order_id = %s""",
                (order_id,),
            )
            row = cur.fetchone()
            if row is None:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="order not found")
            order_type, target_loc, qty, isbn13, st = row
            if st != "APPROVED":
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=f"수령은 APPROVED 상태에서만 가능 (현재 status={st})",
                )
            target_wh = _location_wh(cur, target_loc)

            # 권한
            if ctx.role == "branch-clerk":
                if ctx.scope_store_id is None or ctx.scope_store_id != target_loc:
                    raise HTTPException(
                        status_code=status.HTTP_403_FORBIDDEN,
                        detail=f"자기 매장만 수령 가능 (scope_store_id={ctx.scope_store_id} · target={target_loc})",
                    )
            elif ctx.role == "wh-manager":
                if ctx.scope_wh_id is None or ctx.scope_wh_id != target_wh:
                    raise HTTPException(
                        status_code=status.HTTP_403_FORBIDDEN,
                        detail=f"자기 권역만 수령 가능 (scope_wh_id={ctx.scope_wh_id} · target_wh={target_wh})",
                    )
            elif ctx.role != "hq-admin":
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="수령 권한 없음")

            # status=EXECUTED + executed_at + audit
            cur.execute(
                """UPDATE pending_orders SET status='EXECUTED', executed_at=NOW()
                    WHERE order_id = %s""",
                (order_id,),
            )
            cur.execute(
                """INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, after_state)
                   VALUES ('user', %s, 'inbound.receive', 'pending_orders', %s, %s::jsonb)""",
                (ctx.user_id, order_id, json.dumps({
                    "status": "EXECUTED", "qty": qty, "isbn13": isbn13, "target_location_id": target_loc,
                })),
            )
        conn.commit()

    # inventory-svc /adjust 호출 (별도 transaction · 실패 비치명 · log + 알림)
    inv_status = "PENDING_ADJUST"
    try:
        with httpx.Client(timeout=3.0) as c:
            r = c.post(
                f"{INVENTORY_SVC_URL}/inventory/adjust",
                headers={"Authorization": ctx.token},
                json={
                    "isbn13": isbn13,
                    "location_id": target_loc,
                    "delta": qty,
                    "reason": f"입고수령:{order_id[:8]}",
                },
            )
            if r.status_code == 200:
                inv_status = "ADJUSTED"
            else:
                log.warning("inventory adjust HTTP %s: %s", r.status_code, r.text[:200])
    except Exception as e:
        log.warning("inventory adjust call failed (non-fatal): %s", e)

    # 시트04 변형: 수령 완료 알림 (severity INFO)
    _notify(
        ctx.token,
        "OrderExecuted",
        severity="INFO",
        payload={
            "order_id": order_id,
            "order_type": order_type,
            "isbn13": isbn13,
            "qty": qty,
            "target_location_id": target_loc,
            "inventory_adjust": inv_status,
        },
        correlation_id=order_id,
    )

    return {
        "order_id": order_id,
        "status": "EXECUTED",
        "isbn13": isbn13,
        "qty": qty,
        "inventory_adjust": inv_status,
    }
