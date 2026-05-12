"""Master/aggregate read routes via direct RDS (dashboard_svc SELECT-only).

.pen Service Mesh: dashboard-bff/svc reads books/kpi_mart/sales master tables directly,
not via inventory-svc. These pages don't need transactional consistency.
"""
from fastapi import APIRouter, Depends, Query

from ..auth import AuthContext, _check_store_scope, require_auth
from ..db import db_conn

router = APIRouter(prefix="/dashboard", tags=["dashboard-master"])


@router.get("/recent-sales")
def recent_sales(
    _: AuthContext = Depends(require_auth),
    limit: int = Query(default=20, ge=1, le=200),
):
    """sales_realtime 최근 N건 (POS 트랜잭션 실시간 흐름 모니터링).

    pos-ingestor Lambda 가 INSERT 한 row 가 그대로 보임.
    """
    # 안전망: seed 데이터의 미래 시각 row 가 ORDER BY DESC top 에 잡혀 sim 새 INSERT 가 가려지는 것 방지
    sql = """
        SELECT txn_id, event_ts, isbn13, store_id, channel, qty, revenue
          FROM sales_realtime
         WHERE event_ts <= NOW()
         ORDER BY event_ts DESC
         LIMIT %s
    """
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, (limit,))
        rows = cur.fetchall()

    return {
        "items": [
            {
                "txn_id":   str(r[0]),
                "event_ts": r[1].isoformat() if r[1] else None,
                "isbn13":   r[2],
                "store_id": r[3],
                "channel":  r[4],
                "qty":      r[5],
                "revenue":  r[6],
            }
            for r in rows
        ],
    }


@router.get("/sales-summary")
def sales_summary(_: AuthContext = Depends(require_auth)):
    """집계 요약 - 최근 1시간 매출 합 + 트랜잭션 수 + 채널별 비중."""
    sql = """
        SELECT
            count(*)                       AS n,
            COALESCE(sum(revenue), 0)      AS total_revenue,
            count(*) FILTER (WHERE channel LIKE 'ONLINE%')  AS online_count,
            count(*) FILTER (WHERE channel = 'OFFLINE')     AS offline_count
          FROM sales_realtime
         WHERE event_ts > NOW() - INTERVAL '1 hour'
    """
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(sql)
        n, total_revenue, online_count, offline_count = cur.fetchone()

    return {
        "window": "1h",
        "transactions":   n,
        "total_revenue":  int(total_revenue or 0),
        "online_count":   online_count,
        "offline_count":  offline_count,
    }


@router.get("/books")
def books(
    _: AuthContext = Depends(require_auth),
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    q: str = Query(default=""),
    status: str = Query(default="ACTIVE", description="ACTIVE | SOFT_DC | INACTIVE | ALL"),
    category: str = Query(default=""),
):
    """books 카탈로그 (1000책) - HQ Books 페이지.

    status:
      - ACTIVE   = active=TRUE 만 (기본 · 판매중 + 소진모드 모두 포함)
      - SOFT_DC  = discontinue_mode='SOFT_DISCONTINUE' (소진 모드)
      - INACTIVE = active=FALSE (자동 사이클 정지)
      - ALL      = 필터 없음
    """
    clauses: list[str] = []
    params: list = []

    if status == "ACTIVE":
        clauses.append("active = TRUE")
    elif status == "SOFT_DC":
        clauses.append("discontinue_mode = 'SOFT_DISCONTINUE'")
    elif status == "INACTIVE":
        clauses.append("active = FALSE")
    # ALL = no filter

    if q:
        clauses.append("(title ILIKE %s OR author ILIKE %s OR isbn13 = %s)")
        params.extend([f"%{q}%", f"%{q}%", q])
    if category:
        clauses.append("category_name = %s")
        params.append(category)

    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    params_with_paging = params + [limit, offset]

    sql = f"""
        SELECT isbn13, title, author, publisher, pub_date, category_name,
               price_standard, price_sales, active, discontinue_mode,
               discontinue_reason, discontinue_at, expected_soldout_at, cover_url
          FROM books
          {where}
         ORDER BY isbn13
         LIMIT %s OFFSET %s
    """
    count_sql = f"SELECT count(*) FROM books {where}"
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(count_sql, params)
        total = cur.fetchone()[0]
        cur.execute(sql, params_with_paging)
        rows = cur.fetchall()

    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "items": [
            {
                "isbn13": r[0], "title": r[1], "author": r[2], "publisher": r[3],
                "pub_date": r[4].isoformat() if r[4] else None,
                "category": r[5],
                "price_standard": r[6], "price_sales": r[7],
                "active": r[8],
                "discontinue_mode": r[9],
                "discontinue_reason": r[10],
                "discontinue_at": r[11].isoformat() if r[11] else None,
                "expected_soldout_at": r[12].isoformat() if r[12] else None,
                "cover_url": r[13],
            }
            for r in rows
        ],
    }


@router.get("/books/categories")
def book_categories(_: AuthContext = Depends(require_auth)):
    """books 카테고리 distinct 리스트 - 필터 드롭다운용."""
    sql = """
        SELECT category_name, count(*) AS n
          FROM books
         WHERE category_name IS NOT NULL
         GROUP BY category_name
         ORDER BY n DESC
         LIMIT 50
    """
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(sql)
        rows = cur.fetchall()
    return {"items": [{"category": r[0], "count": r[1]} for r in rows]}


@router.get("/books/{isbn13}/audit")
def book_audit(isbn13: str, _: AuthContext = Depends(require_auth)):
    """도서 변경 이력 - audit_log 에서 entity_type='books' AND entity_id=isbn13."""
    sql = """
        SELECT log_id, ts, actor_id, action, after_state
          FROM audit_log
         WHERE entity_type = 'books' AND entity_id = %s
         ORDER BY ts DESC
         LIMIT 50
    """
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, (isbn13,))
        rows = cur.fetchall()
    return {
        "isbn13": isbn13,
        "items": [
            {
                "log_id":      r[0],
                "ts":          r[1].isoformat() if r[1] else None,
                "actor_id":    str(r[2]) if r[2] else None,
                "action":      r[3],
                "after_state": r[4],
            }
            for r in rows
        ],
    }


@router.get("/spike-events")
def spike_events(
    _: AuthContext = Depends(require_auth),
    limit: int = Query(default=20, ge=1, le=100),
):
    """spike_events 최근 N건 (spike-detect Lambda 가 INSERT 한 row).

    Phase 3.5 데모: cross-ISBN z-score · z>=0.5 위 인기 도서 자동 검출.
    """
    sql = """
        SELECT s.event_id, s.detected_at, s.isbn13, s.z_score, s.mentions_count,
               b.title, b.author, b.category_name
          FROM spike_events s
          LEFT JOIN books b ON b.isbn13 = s.isbn13
         ORDER BY s.detected_at DESC
         LIMIT %s
    """
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, (limit,))
        rows = cur.fetchall()

    return {
        "items": [
            {
                "event_id":       str(r[0]),
                "detected_at":    r[1].isoformat() if r[1] else None,
                "isbn13":         r[2],
                "z_score":        float(r[3]) if r[3] is not None else None,
                "mentions_count": r[4],
                "title":          r[5],
                "author":         r[6],
                "category":       r[7],
            }
            for r in rows
        ],
    }


@router.get("/returns")
def returns(
    _: AuthContext = Depends(require_auth),
    limit: int = Query(default=50, ge=1, le=500),
):
    """returns 큐 (HQ Returns 페이지)."""
    sql = """
        SELECT r.return_id, r.isbn13, r.location_id, r.qty, r.reason,
               r.status, r.requested_at, r.hq_approved_at, r.executed_at,
               b.title, b.author
          FROM returns r
          LEFT JOIN books b ON b.isbn13 = r.isbn13
         ORDER BY r.requested_at DESC
         LIMIT %s
    """
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, (limit,))
        rows = cur.fetchall()

    return {
        "items": [
            {
                "return_id":       str(r[0]),
                "isbn13":          r[1],
                "location_id":     r[2],
                "qty":             r[3],
                "reason":          r[4],
                "status":          r[5],
                "requested_at":    r[6].isoformat() if r[6] else None,
                "hq_approved_at":  r[7].isoformat() if r[7] else None,
                "executed_at":     r[8].isoformat() if r[8] else None,
                "title":           r[9],
                "author":          r[10],
            }
            for r in rows
        ],
    }


def compute_wh_split(wh_counts: dict, default_qty: int) -> dict:
    """카테고리 sales 권역별 카운트 → wh1/wh2 분배 수량 + 비율.

    wh_counts: {wh_id: count} - sales_realtime 14일치 카운트.
                None/wh_id != 1,2 키는 무시.
    default_qty: 총 발주 수량 (사용자가 폼에서 수정 가능, 합산은 100% 유지).

    Returns:
      { wh1_qty, wh2_qty, wh1_pct, wh2_pct, source: 'category'|'fallback' }

    데이터 없으면 60/40 fallback (수도권 우세 휴리스틱).
    """
    n1 = wh_counts.get(1, 0) or 0
    n2 = wh_counts.get(2, 0) or 0
    total = n1 + n2
    if total == 0:
        return {
            "wh1_qty": int(round(default_qty * 0.6)),
            "wh2_qty": int(round(default_qty * 0.4)),
            "wh1_pct": 60,
            "wh2_pct": 40,
            "source": "fallback",
        }
    wh1_pct = int(round(100 * n1 / total))
    wh2_pct = 100 - wh1_pct
    return {
        "wh1_qty": int(round(default_qty * wh1_pct / 100)),
        "wh2_qty": int(round(default_qty * wh2_pct / 100)),
        "wh1_pct": wh1_pct,
        "wh2_pct": wh2_pct,
        "source": "category",
    }


@router.get("/new-book-requests/{request_id}/forecast-hint")
def new_book_forecast_hint(
    request_id: int,
    _: AuthContext = Depends(require_auth),
    default_qty: int = Query(default=100, ge=10, le=10000),
):
    """UX-2 신간 편입 결정 - 권역별 분배 추천.

    같은 카테고리 최근 14일 매출의 권역별 비율로 wh1/wh2 수량 prefill.
    데이터 없으면 60/40 fallback (수도권 우세).

    .pen 'HQ Requests' 우측 패널의 'AI 정책별 결과' Bar chart 데이터 소스.
    """
    sql = """
        WITH req AS (
            SELECT nbr.id, nbr.isbn13, b.category_name
              FROM new_book_requests nbr
              LEFT JOIN books b ON b.isbn13 = nbr.isbn13
             WHERE nbr.id = %s
        )
        SELECT l.wh_id, COUNT(*) AS n
          FROM sales_realtime s
          JOIN books b ON b.isbn13 = s.isbn13
          JOIN locations l ON l.location_id = s.store_id
          JOIN req ON b.category_name = req.category_name
         WHERE s.event_ts > NOW() - INTERVAL '14 days'
           AND l.wh_id IS NOT NULL
         GROUP BY l.wh_id
    """
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, (request_id,))
        rows = cur.fetchall()

    wh_counts = {r[0]: r[1] for r in rows}
    split = compute_wh_split(wh_counts, default_qty)
    return {
        "request_id": request_id,
        "default_qty": default_qty,
        **split,
        "raw_counts": [{"wh_id": k, "n": v} for k, v in wh_counts.items() if k in (1, 2)],
    }


@router.get("/new-book-requests")
def new_book_requests(
    _: AuthContext = Depends(require_auth),
    limit: int = Query(default=50, ge=1, le=500),
):
    """new_book_requests (HQ Requests · 출판사 신간 신청 큐).

    실제 스키마는 created_at (DDL 문서는 requested_at 이지만 시드 적재 시 created_at 으로 적재됨).
    프론트 호환 위해 SQL alias 로 requested_at 노출.
    """
    sql = """
        SELECT id, isbn13, publisher_id, title, status,
               created_at AS requested_at, fetched_at, approved_at
          FROM new_book_requests
         ORDER BY created_at DESC
         LIMIT %s
    """
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, (limit,))
        rows = cur.fetchall()

    return {
        "items": [
            {
                "id":           r[0],
                "isbn13":       r[1],
                "publisher_id": r[2],
                "title":        r[3],
                "status":       r[4],
                "requested_at": r[5].isoformat() if r[5] else None,
            }
            for r in rows
        ],
    }


@router.get("/sales-by-store")
def sales_by_store(_: AuthContext = Depends(require_auth)):
    """매장별 매출 1h - HQ KPI 차트용."""
    sql = """
        SELECT store_id,
               count(*) AS transactions,
               COALESCE(sum(revenue), 0) AS revenue,
               count(*) FILTER (WHERE channel LIKE 'ONLINE%') AS online_count
          FROM sales_realtime
         WHERE event_ts > NOW() - INTERVAL '1 hour'
         GROUP BY store_id
         ORDER BY revenue DESC
    """
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(sql)
        rows = cur.fetchall()

    return {
        "items": [
            {
                "store_id":     r[0],
                "transactions": r[1],
                "revenue":      int(r[2]),
                "online_count": r[3],
            }
            for r in rows
        ],
    }


@router.get("/sales-by-store/{store_id}")
def sales_by_specific_store(
    store_id: int,
    ctx: AuthContext = Depends(require_auth),
    limit: int = Query(default=50, ge=1, le=500),
):
    """매장별 sales_realtime 상세 (Branch Sales 페이지). FR-A7.3 매장 스코프 enforce."""
    _check_store_scope(ctx, store_id)
    sql = """
        SELECT s.txn_id, s.event_ts, s.isbn13, s.channel, s.qty, s.unit_price, s.revenue,
               b.title, b.author
          FROM sales_realtime s
          LEFT JOIN books b ON b.isbn13 = s.isbn13
         WHERE s.store_id = %s
         ORDER BY s.event_ts DESC
         LIMIT %s
    """
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, (store_id, limit))
        rows = cur.fetchall()

    return {
        "store_id": store_id,
        "items": [
            {
                "txn_id":     str(r[0]),
                "event_ts":   r[1].isoformat() if r[1] else None,
                "isbn13":     r[2],
                "channel":    r[3],
                "qty":        r[4],
                "unit_price": r[5],
                "revenue":    r[6],
                "title":      r[7],
                "author":     r[8],
            }
            for r in rows
        ],
    }


@router.get("/locations")
def locations(_: AuthContext = Depends(require_auth)):
    """UX-9 location 마스터 (id · 이름 · 권역 · 타입). 모든 페이지가 ID → 이름 변환에 사용.

    가벼운 SELECT (heatmap 과 달리 sku/qty 집계 X).
    """
    sql = """
        SELECT location_id, name, location_type, wh_id, region, is_virtual, active
          FROM locations
         ORDER BY wh_id NULLS LAST, location_id
    """
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(sql)
        rows = cur.fetchall()

    return {
        "items": [
            {
                "location_id":   r[0],
                "name":          r[1],
                "location_type": r[2],
                "wh_id":         r[3],
                "region":        r[4],
                "is_virtual":    r[5],
                "active":        r[6],
            }
            for r in rows
        ],
    }


@router.get("/locations/heatmap")
def inventory_heatmap(_: AuthContext = Depends(require_auth)):
    """전사 재고 히트맵 - location_id 별 SKU 수 + 보유 수량 + 부족(SKU 가용≤10) (HQ Inventory).

    44 위치 = WH 2 + 오프라인 매장 10 + 온라인 가상 2 (V3 plan), 시드 데이터 location_id 1-12.
    """
    sql = """
        SELECT i.location_id,
               l.name, l.location_type, l.region, l.wh_id,
               count(*) AS sku_count,
               sum(i.on_hand)      AS total_qty,
               sum(i.reserved_qty) AS reserved_qty,
               count(*) FILTER (WHERE (i.on_hand - i.reserved_qty) <= 10) AS low_count,
               count(*) FILTER (WHERE i.on_hand = 0) AS zero_count
          FROM inventory i
          LEFT JOIN locations l ON l.location_id = i.location_id
         GROUP BY i.location_id, l.name, l.location_type, l.region, l.wh_id
         ORDER BY i.location_id
    """
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(sql)
        rows = cur.fetchall()

    return {
        "items": [
            {
                "location_id":   r[0],
                "name":          r[1] or f"location {r[0]}",
                "location_type": r[2],
                "region":        r[3],
                "wh_id":         r[4],
                "sku_count":     r[5],
                "total_qty":     int(r[6] or 0),
                "reserved_qty":  int(r[7] or 0),
                "low_count":     r[8],
                "zero_count":    r[9],
            }
            for r in rows
        ],
    }


@router.get("/store-inventory/{store_id}")
def inventory_by_store(store_id: int, ctx: AuthContext = Depends(require_auth)):
    """특정 매장 재고 (Branch Inventory 페이지). FR-A7.3 매장 스코프 enforce."""
    _check_store_scope(ctx, store_id)
    sql = """
        SELECT i.isbn13, i.on_hand, i.reserved_qty, COALESCE(i.safety_stock, 0) AS safety_stock,
               i.updated_at, b.title, b.author, b.category_name, b.price_sales
          FROM inventory i
          LEFT JOIN books b ON b.isbn13 = i.isbn13
         WHERE i.location_id = %s
         ORDER BY (i.on_hand - i.reserved_qty) ASC, i.isbn13
    """
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, (store_id,))
        rows = cur.fetchall()

    return {
        "store_id": store_id,
        "items": [
            {
                "isbn13":       r[0],
                "on_hand":      r[1],
                "reserved_qty": r[2],
                "available":    r[1] - r[2],
                "safety_stock": r[3],
                "updated_at":   r[4].isoformat() if r[4] else None,
                "title":        r[5],
                "author":       r[6],
                "category":     r[7],
                "price_sales":  r[8],
            }
            for r in rows
        ],
    }


@router.get("/instructions")
def instructions(
    _: AuthContext = Depends(require_auth),
    wh_id: int | None = Query(default=None),
):
    """출고/입고 지시서 - APPROVED 된 pending_orders (WH Instructions / Branch Inbound).

    `wh_id` 필터링 옵션 (WH manager 자기 창고 또는 매장 매니저 자기 매장).
    """
    if wh_id is not None:
        sql = """
            SELECT po.order_id, po.order_type, po.isbn13, po.source_location_id, po.target_location_id,
                   po.qty, po.urgency_level, po.status, po.approved_at, b.title
              FROM pending_orders po
              LEFT JOIN books b ON b.isbn13 = po.isbn13
              LEFT JOIN locations sl ON sl.location_id = po.source_location_id
              LEFT JOIN locations tl ON tl.location_id = po.target_location_id
             WHERE po.status IN ('APPROVED', 'EXECUTED')
               AND (sl.wh_id = %s OR tl.wh_id = %s)
             ORDER BY po.urgency_level DESC, po.approved_at DESC NULLS LAST
             LIMIT 100
        """
        params = (wh_id, wh_id)
    else:
        sql = """
            SELECT po.order_id, po.order_type, po.isbn13, po.source_location_id, po.target_location_id,
                   po.qty, po.urgency_level, po.status, po.approved_at, b.title
              FROM pending_orders po
              LEFT JOIN books b ON b.isbn13 = po.isbn13
             WHERE po.status IN ('APPROVED', 'EXECUTED')
             ORDER BY po.urgency_level DESC, po.approved_at DESC NULLS LAST
             LIMIT 100
        """
        params = ()

    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, params)
        rows = cur.fetchall()

    return {
        "items": [
            {
                "order_id":          str(r[0]),
                "order_type":        r[1],
                "isbn13":            r[2],
                "source_location_id": r[3],
                "target_location_id": r[4],
                "qty":               r[5],
                "urgency_level":     r[6],
                "status":            r[7],
                "approved_at":       r[8].isoformat() if r[8] else None,
                "title":             r[9],
            }
            for r in rows
        ],
    }


@router.get("/curation/{store_id}")
def curation(store_id: int, ctx: AuthContext = Depends(require_auth)):
    """매장 큐레이션 - spike_events (인기 도서) + 매장 재고 가용성 (Branch Curation).

    `spike_events` 와 `inventory(location=store)` JOIN 해서 "인기 + 매장 재고 OK" 도서 우선 표시.
    FR-A7.3 매장 스코프 enforce.
    """
    _check_store_scope(ctx, store_id)
    sql = """
        SELECT s.isbn13, s.z_score, s.mentions_count, s.detected_at,
               b.title, b.author, b.category_name, b.price_sales, b.cover_url,
               COALESCE(i.on_hand, 0) AS on_hand, COALESCE(i.reserved_qty, 0) AS reserved_qty
          FROM spike_events s
          LEFT JOIN books b ON b.isbn13 = s.isbn13
          LEFT JOIN inventory i ON i.isbn13 = s.isbn13 AND i.location_id = %s
         WHERE s.detected_at > NOW() - INTERVAL '24 hours'
         ORDER BY s.z_score DESC NULLS LAST, s.detected_at DESC
         LIMIT 20
    """
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, (store_id,))
        rows = cur.fetchall()

    return {
        "store_id": store_id,
        "items": [
            {
                "isbn13":         r[0],
                "z_score":        float(r[1]) if r[1] is not None else None,
                "mentions_count": r[2],
                "detected_at":    r[3].isoformat() if r[3] else None,
                "title":          r[4],
                "author":         r[5],
                "category":       r[6],
                "price_sales":    r[7],
                "cover_url":      r[8],
                "on_hand":        r[9],
                "available":      r[9] - r[10],
            }
            for r in rows
        ],
    }
