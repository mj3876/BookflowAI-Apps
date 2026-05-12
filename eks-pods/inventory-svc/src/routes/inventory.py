"""inventory routes: /current/{wh_id} · /adjust · /reserve.

Single-writer pod: all inventory mutations flow through here. Redis pub on stock.changed.
"""
import json
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, status

from ..auth import AuthContext, require_auth
from ..db import db_conn, redis_client
from ..models import (
    AdjustRequest,
    AdjustResponse,
    InventoryItem,
    ReserveRequest,
    ReserveResponse,
    WarehouseInventoryResponse,
)

router = APIRouter(prefix="/inventory", tags=["inventory"])

REDIS_CHANNEL_STOCK = "stock.changed"


def _check_inventory_write_perm(cur, ctx: AuthContext, location_id: int) -> None:
    """Inventory mutation 권한 검증 (FR-A6.6 + 권한 매트릭스).

    사용자 결정 (2026-05-03 · `project_authority_clarifications`):
    - hq-admin: 모든 location OK (전권)
    - wh-manager: 자기 wh 의 location 만 OK (locations.wh_id == scope_wh_id)
    - branch-clerk: 자기 매장만 OK (scope_store_id == location_id) — FR 매트릭스 '지점 실행' 정합
    - 그 외: 403

    Raises HTTPException 403/404 on violation.
    """
    if ctx.role == "hq-admin":
        return

    if ctx.role == "wh-manager":
        if ctx.scope_wh_id is None:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                                detail="wh-manager scope_wh_id 부재 (인증 토큰 손상)")
        cur.execute("SELECT wh_id FROM locations WHERE location_id = %s", (location_id,))
        row = cur.fetchone()
        if row is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND,
                                detail=f"location_id {location_id} not found")
        if row[0] != ctx.scope_wh_id:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                                detail=f"자기 권역만 inventory 변경 가능 (scope_wh_id={ctx.scope_wh_id} · location wh_id={row[0]})")
        return

    if ctx.role == "branch-clerk":
        if ctx.scope_store_id is None:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                                detail="branch-clerk scope_store_id 부재 (인증 토큰 손상)")
        if ctx.scope_store_id != location_id:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                                detail=f"자기 매장만 inventory 변경 가능 (scope_store_id={ctx.scope_store_id} · location_id={location_id})")
        return

    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                        detail=f"role '{ctx.role}' 는 inventory 변경 권한 없음")


def _inventory_item_from_row(row: tuple) -> InventoryItem:
    """DB row → InventoryItem 매핑 (FR-A7.4 enriched).

    Row column 순서:
      0: isbn13       · 1: location_id · 2: on_hand · 3: reserved_qty
      4: safety_stock · 5: updated_at
      6: title · 7: author · 8: cover_url · 9: expected_soldout_at
      10: incoming_qty · 11: outgoing_qty
    """
    return InventoryItem(
        isbn13=row[0],
        location_id=row[1],
        on_hand=int(row[2] or 0),
        reserved_qty=int(row[3] or 0),
        safety_stock=int(row[4] or 0),
        available=int(row[2] or 0) - int(row[3] or 0),
        updated_at=row[5],
        title=row[6],
        author=row[7],
        cover_url=row[8],
        expected_soldout_at=row[9],
        incoming_qty=int(row[10] or 0),
        outgoing_qty=int(row[11] or 0),
    )


@router.get("/current/{wh_id}", response_model=WarehouseInventoryResponse)
def get_warehouse_inventory(wh_id: int, ctx: AuthContext = Depends(require_auth)):
    """FR-A7.4 실시간 재고 조회 — 현재고 + 안전재고 + 예상소진일 + 입출고 in-transit 합산.

    Notion 2.1: WH-1↔WH-2 서로 read 가능 (2단계 의사결정용 · 상대 여유분 파악). mutate (/adjust /reserve) 만 자기 wh 제한.
    branch-clerk 만 자기 매장 외 차단.
    """
    if ctx.role == "branch-clerk":
        # branch-clerk 는 본인 매장 외 wh 단위 조회 불가
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="branch-clerk 는 wh 단위 조회 불가")

    # Notion 명세: 온라인 매장 재고 출처 = WH 본체 (is_virtual STORE_ONLINE 은 inventory row 없음)
    # → online 매장도 응답에 포함시키되 quantity 는 WH 본체 inventory 를 substitute (UNION)
    sql = """
        SELECT i.isbn13, i.location_id,
               i.on_hand, i.reserved_qty,
               COALESCE(i.safety_stock, 0) AS safety_stock,
               i.updated_at,
               b.title, b.author, b.cover_url, b.expected_soldout_at,
               COALESCE((SELECT SUM(po.qty)::int FROM pending_orders po
                   WHERE po.target_location_id = i.location_id AND po.isbn13 = i.isbn13
                   AND po.status = 'APPROVED' AND po.executed_at IS NULL), 0) AS incoming_qty,
               COALESCE((SELECT SUM(po.qty)::int FROM pending_orders po
                   WHERE po.source_location_id = i.location_id AND po.isbn13 = i.isbn13
                   AND po.status = 'APPROVED' AND po.executed_at IS NULL), 0) AS outgoing_qty
        FROM inventory i
        JOIN locations l ON l.location_id = i.location_id
        LEFT JOIN books b ON b.isbn13 = i.isbn13
        WHERE l.wh_id = %s

        UNION ALL

        -- 온라인 매장: WH 본체 inventory 를 online location_id 로 노출 (출처 = WH)
        SELECT i.isbn13, online.location_id AS location_id,
               i.on_hand, i.reserved_qty,
               COALESCE(i.safety_stock, 0) AS safety_stock,
               i.updated_at,
               b.title, b.author, b.cover_url, b.expected_soldout_at,
               COALESCE((SELECT SUM(po.qty)::int FROM pending_orders po
                   WHERE po.target_location_id = online.location_id AND po.isbn13 = i.isbn13
                   AND po.status = 'APPROVED' AND po.executed_at IS NULL), 0) AS incoming_qty,
               COALESCE((SELECT SUM(po.qty)::int FROM pending_orders po
                   WHERE po.source_location_id = online.location_id AND po.isbn13 = i.isbn13
                   AND po.status = 'APPROVED' AND po.executed_at IS NULL), 0) AS outgoing_qty
        FROM locations online
        JOIN locations wh ON wh.wh_id = online.wh_id AND wh.location_type = 'WH'
        JOIN inventory i ON i.location_id = wh.location_id
        LEFT JOIN books b ON b.isbn13 = i.isbn13
        WHERE online.wh_id = %s AND online.location_type = 'STORE_ONLINE'

        ORDER BY 2, 1
    """
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, (wh_id, wh_id))
        rows = cur.fetchall()

    items = [_inventory_item_from_row(r) for r in rows]
    return WarehouseInventoryResponse(wh_id=wh_id, items=items)


@router.post("/adjust", response_model=AdjustResponse)
def adjust(req: AdjustRequest, ctx: AuthContext = Depends(require_auth)):
    """Atomic on_hand adjust + audit_log + Redis publish stock.changed.

    권한 (FR-A6.6 + 사용자 결정 2026-05-03):
    - hq-admin: 전권
    - wh-manager: 자기 wh location 만
    - branch-clerk: 자기 매장만 (분실/파손/도난 등 매장 사정 직접 처리)
    """
    update_sql = """
        UPDATE inventory
           SET on_hand = on_hand + %s,
               updated_at = NOW(),
               updated_by = %s
         WHERE isbn13 = %s AND location_id = %s
        RETURNING on_hand - %s, on_hand
    """
    audit_sql = """
        INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, before_state, after_state)
        VALUES ('user', %s, 'inventory.adjust', 'inventory', %s, %s, %s)
    """
    with db_conn() as conn:
        with conn.cursor() as cur:
            _check_inventory_write_perm(cur, ctx, req.location_id)
            cur.execute(update_sql, (req.delta, ctx.user_id, req.isbn13, req.location_id, req.delta))
            row = cur.fetchone()
            if row is None:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="inventory row not found")
            on_hand_before, on_hand_after = row
            if on_hand_after < 0:
                raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="on_hand would go negative")
            entity_id = f"{req.isbn13}:{req.location_id}"
            cur.execute(
                audit_sql,
                (
                    ctx.user_id,
                    entity_id,
                    json.dumps({"on_hand": on_hand_before}),
                    json.dumps({"on_hand": on_hand_after, "delta": req.delta, "reason": req.reason}),
                ),
            )
        conn.commit()

    payload = json.dumps({
        "isbn13": req.isbn13,
        "location_id": req.location_id,
        "available": on_hand_after,  # caller may further subtract reserved_qty
        "ts": datetime.now(timezone.utc).isoformat(),
    })
    redis_client().publish(REDIS_CHANNEL_STOCK, payload)
    redis_client().delete(f"stock:{req.isbn13}", f"stock:{req.isbn13}:{req.location_id}")

    return AdjustResponse(
        isbn13=req.isbn13,
        location_id=req.location_id,
        on_hand_before=on_hand_before,
        on_hand_after=on_hand_after,
    )


@router.post("/reserve", response_model=ReserveResponse)
def reserve(req: ReserveRequest, ctx: AuthContext = Depends(require_auth)):
    """Reserve qty (subtracts from available). reservations row + inventory.reserved_qty bump."""
    reservation_id = uuid4()
    expires_at = datetime.now(timezone.utc) + timedelta(seconds=req.ttl_seconds)

    bump_sql = """
        UPDATE inventory
           SET reserved_qty = reserved_qty + %s,
               updated_at = NOW(),
               updated_by = %s
         WHERE isbn13 = %s AND location_id = %s
           AND on_hand - reserved_qty >= %s
        RETURNING on_hand, reserved_qty
    """
    insert_sql = """
        INSERT INTO reservations (reservation_id, isbn13, location_id, qty, reason, status, ttl, created_by)
        VALUES (%s, %s, %s, %s, %s, 'ACTIVE', %s, %s)
    """
    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(bump_sql, (req.qty, ctx.user_id, req.isbn13, req.location_id, req.qty))
            row = cur.fetchone()
            if row is None:
                raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="insufficient available stock")
            cur.execute(insert_sql, (str(reservation_id), req.isbn13, req.location_id, req.qty, req.reason, expires_at, ctx.user_id))
        conn.commit()

    return ReserveResponse(
        reservation_id=reservation_id,
        isbn13=req.isbn13,
        location_id=req.location_id,
        qty=req.qty,
        expires_at=expires_at,
    )
