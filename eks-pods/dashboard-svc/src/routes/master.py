"""Master/aggregate read routes via direct RDS (dashboard_svc SELECT-only).

.pen Service Mesh: dashboard-bff/svc reads books/kpi_mart/sales master tables directly,
not via inventory-svc. These pages don't need transactional consistency.
"""
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Query

from ..auth import AuthContext, _check_location_scope, require_auth
from ..db import db_conn

router = APIRouter(prefix="/dashboard", tags=["dashboard-master"])

_KST = timezone(timedelta(hours=9))


@router.get("/forecast/all")
def forecast_all(
    _: AuthContext = Depends(require_auth),
    snapshot_date: str | None = Query(default=None, description="YYYY-MM-DD · 생략 시 D+1 KST"),
):
    """전 매장 × 전 ISBN forecast_cache batch read (inventory 페이지 AI 수요예측 컬럼용).

    기존 /dashboard/forecast/{store_id}/{date} 는 단일 매장 1일치. 14 매장 × 1000 ISBN
    grid view 에서는 호출 폭증 → 한 번에 모든 row 반환. role-scope 무관 (read-only · 의사결정 미동반).
    """
    if snapshot_date is None:
        snapshot_date = (datetime.now(_KST).date() + timedelta(days=1)).isoformat()

    sql = """
        SELECT snapshot_date, isbn13, store_id, predicted_demand
          FROM forecast_cache
         WHERE snapshot_date = %s
    """
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, (snapshot_date,))
        rows = cur.fetchall()

    return {
        "snapshot_date": snapshot_date,
        "items": [
            {
                "snapshot_date": r[0].isoformat() if hasattr(r[0], "isoformat") else r[0],
                "isbn13": r[1],
                "store_id": r[2],
                "predicted_demand": float(r[3]),
            }
            for r in rows
        ],
    }


@router.get("/recent-sales")
def recent_sales(
    ctx: AuthContext = Depends(require_auth),
    limit: int = Query(default=20, ge=1, le=200),
):
    """sales_realtime 최근 N건 (POS 트랜잭션 실시간 흐름 모니터링). role-scope 자동.

    pos-ingestor Lambda 가 INSERT 한 row 가 그대로 보임.
    """
    # 안전망: seed 데이터의 미래 시각 row 가 ORDER BY DESC top 에 잡혀 sim 새 INSERT 가 가려지는 것 방지
    where: list[str] = ["s.event_ts <= NOW()"]
    params: list = []
    if ctx.role == "wh-manager" and ctx.scope_wh_id is not None:
        where.append(
            "EXISTS (SELECT 1 FROM locations l WHERE l.location_id = s.store_id AND l.wh_id = %s)"
        )
        params.append(ctx.scope_wh_id)
    elif ctx.role == "branch-clerk" and ctx.scope_store_id is not None:
        where.append("s.store_id = %s")
        params.append(ctx.scope_store_id)
    sql = f"""
        SELECT s.txn_id, s.event_ts, s.isbn13, s.store_id, s.channel, s.qty, s.revenue
          FROM sales_realtime s
         WHERE {' AND '.join(where)}
         ORDER BY s.event_ts DESC
         LIMIT %s
    """
    params.append(limit)
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, params)
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
def sales_summary(ctx: AuthContext = Depends(require_auth)):
    """집계 요약 - 최근 1시간 매출 합 + 트랜잭션 수 + 채널별 비중. role-scope 자동."""
    where: list[str] = ["s.event_ts > NOW() - INTERVAL '1 hour'"]
    params: list = []
    if ctx.role == "wh-manager" and ctx.scope_wh_id is not None:
        where.append(
            "EXISTS (SELECT 1 FROM locations l WHERE l.location_id = s.store_id AND l.wh_id = %s)"
        )
        params.append(ctx.scope_wh_id)
    elif ctx.role == "branch-clerk" and ctx.scope_store_id is not None:
        where.append("s.store_id = %s")
        params.append(ctx.scope_store_id)
    sql = f"""
        SELECT
            count(*)                       AS n,
            COALESCE(sum(s.revenue), 0)    AS total_revenue,
            count(*) FILTER (WHERE s.channel LIKE 'ONLINE%%')  AS online_count,
            count(*) FILTER (WHERE s.channel = 'OFFLINE')      AS offline_count
          FROM sales_realtime s
         WHERE {' AND '.join(where)}
    """
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, params)
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
    predicted_qty/triggered_order_id/resolved_at — SNS 급등 발주 plan + 승인 상태 (2026-05-19).
    """
    sql = """
        SELECT s.event_id, s.detected_at, s.isbn13, s.z_score, s.mentions_count,
               b.title, b.author, b.category_name,
               s.predicted_qty, s.triggered_order_id, s.resolved_at
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
                "predicted_qty":  r[8],
                "triggered_order_id": str(r[9]) if r[9] else None,
                "resolved_at":    r[10].isoformat() if r[10] else None,
            }
            for r in rows
        ],
    }


@router.get("/returns")
def returns(
    ctx: AuthContext = Depends(require_auth),
    limit: int = Query(default=50, ge=1, le=500),
):
    """returns 큐 (HQ Returns 페이지). role-scope 자동.

    - wh-manager: 자기 권역 매장에서 발생한 반품만
    - branch-clerk: 자기 매장만
    """
    where: list[str] = []
    params: list = []
    if ctx.role == "wh-manager" and ctx.scope_wh_id is not None:
        where.append(
            "EXISTS (SELECT 1 FROM locations l WHERE l.location_id = r.location_id AND l.wh_id = %s)"
        )
        params.append(ctx.scope_wh_id)
    elif ctx.role == "branch-clerk" and ctx.scope_store_id is not None:
        where.append("r.location_id = %s")
        params.append(ctx.scope_store_id)
    where_sql = ("WHERE " + " AND ".join(where)) if where else ""
    sql = f"""
        SELECT r.return_id, r.isbn13, r.location_id, r.qty, r.reason,
               r.status, r.requested_at, r.hq_approved_at, r.executed_at,
               b.title, b.author
          FROM returns r
          LEFT JOIN books b ON b.isbn13 = r.isbn13
        {where_sql}
         ORDER BY r.requested_at DESC
         LIMIT %s
    """
    params.append(limit)
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, params)
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
def sales_by_store(ctx: AuthContext = Depends(require_auth)):
    """매장별 매출 1h - HQ KPI 차트용. role-scope 자동.

    - wh-manager: 자기 권역 매장만
    - branch-clerk: 자기 매장 한 row 만
    """
    where: list[str] = ["s.event_ts > NOW() - INTERVAL '1 hour'"]
    params: list = []
    if ctx.role == "wh-manager" and ctx.scope_wh_id is not None:
        where.append(
            "EXISTS (SELECT 1 FROM locations l WHERE l.location_id = s.store_id AND l.wh_id = %s)"
        )
        params.append(ctx.scope_wh_id)
    elif ctx.role == "branch-clerk" and ctx.scope_store_id is not None:
        where.append("s.store_id = %s")
        params.append(ctx.scope_store_id)
    sql = f"""
        SELECT s.store_id,
               count(*) AS transactions,
               COALESCE(sum(s.revenue), 0) AS revenue,
               count(*) FILTER (WHERE s.channel LIKE 'ONLINE%%') AS online_count
          FROM sales_realtime s
         WHERE {' AND '.join(where)}
         GROUP BY s.store_id
         ORDER BY revenue DESC
    """
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, params)
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
    """매장별 sales_realtime 상세 (Branch Sales 페이지). branch-clerk + wh-manager 스코프 enforce."""
    with db_conn() as conn, conn.cursor() as cur:
        _check_location_scope(ctx, store_id, cur)
        sql = """
            SELECT s.txn_id, s.event_ts, s.isbn13, s.channel, s.qty, s.unit_price, s.revenue,
                   b.title, b.author
              FROM sales_realtime s
              LEFT JOIN books b ON b.isbn13 = s.isbn13
             WHERE s.store_id = %s
             ORDER BY s.event_ts DESC
             LIMIT %s
        """
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
def inventory_heatmap(ctx: AuthContext = Depends(require_auth)):
    """전사 재고 히트맵 - location_id 별 SKU 수 + 보유 수량 + 부족(가용 ≤ 안전재고) + 부족 수량.

    44 위치 = WH 2 + 오프라인 매장 10 + 온라인 가상 2 (V3 plan), 시드 데이터 location_id 1-12.
    role-scope: wh-manager → 자기 권역 location · branch-clerk → 자기 매장 한 row.
    """
    where: list[str] = []
    params: list = []
    if ctx.role == "wh-manager" and ctx.scope_wh_id is not None:
        where.append("l.wh_id = %s")
        params.append(ctx.scope_wh_id)
    elif ctx.role == "branch-clerk" and ctx.scope_store_id is not None:
        where.append("i.location_id = %s")
        params.append(ctx.scope_store_id)
    where_sql = ("WHERE " + " AND ".join(where)) if where else ""
    # incoming = 운송중/승인된 발주의 도착예정 수량 (target_location × isbn 별).
    #   real_short_qty = raw 부족 − incoming → 운송중 차감 후 "실제 추가 발주 필요한" 양.
    #   real_low_count = 운송중 차감 후에도 안전재고 미달인 SKU 수 (low_count 의 실질판).
    sql = f"""
        WITH incoming AS (
            SELECT target_location_id AS loc, isbn13, SUM(qty) AS inc_qty
              FROM pending_orders
             WHERE status IN ('APPROVED', 'IN_TRANSIT')
             GROUP BY target_location_id, isbn13
        )
        SELECT i.location_id,
               l.name, l.location_type, l.region, l.wh_id,
               count(*) AS sku_count,
               sum(i.on_hand)      AS total_qty,
               sum(i.reserved_qty) AS reserved_qty,
               count(*) FILTER (WHERE (i.on_hand - i.reserved_qty) <= COALESCE(i.safety_stock, 0)) AS low_count,
               count(*) FILTER (WHERE i.on_hand = 0) AS zero_count,
               COALESCE(sum(GREATEST(0, COALESCE(i.safety_stock, 0) - (i.on_hand - i.reserved_qty))), 0) AS short_qty,
               COALESCE(sum(GREATEST(0, COALESCE(i.safety_stock, 0) - (i.on_hand - i.reserved_qty)
                                          - COALESCE(inc.inc_qty, 0))), 0) AS real_short_qty,
               count(*) FILTER (WHERE COALESCE(i.safety_stock, 0) - (i.on_hand - i.reserved_qty)
                                        - COALESCE(inc.inc_qty, 0) > 0) AS real_low_count
          FROM inventory i
          LEFT JOIN locations l ON l.location_id = i.location_id
          LEFT JOIN incoming inc ON inc.loc = i.location_id AND inc.isbn13 = i.isbn13
        {where_sql}
         GROUP BY i.location_id, l.name, l.location_type, l.region, l.wh_id
         ORDER BY i.location_id
    """
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, params)
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
                "short_qty":     int(r[10] or 0),
                "real_short_qty": int(r[11] or 0),
                "real_low_count": int(r[12] or 0),
            }
            for r in rows
        ],
    }


@router.get("/sales/store-weekday")
def sales_store_weekday(ctx: AuthContext = Depends(require_auth)):
    """매장 × 요일 매출 heatmap — 최근 30일 sales_realtime 집계.

    dow = Postgres EXTRACT(DOW) (0=일 ~ 6=토) · frontend 가 월~일 라벨로 매핑.
    role-scope: wh-manager → 자기 권역 매장 · branch-clerk → 자기 매장.
    """
    where = ["s.event_ts >= NOW() - INTERVAL '30 days'"]
    params: list = []
    if ctx.role == "wh-manager" and ctx.scope_wh_id is not None:
        where.append("l.wh_id = %s")
        params.append(ctx.scope_wh_id)
    elif ctx.role == "branch-clerk" and ctx.scope_store_id is not None:
        where.append("s.store_id = %s")
        params.append(ctx.scope_store_id)
    sql = f"""
        SELECT s.store_id, l.name AS store_name,
               EXTRACT(DOW FROM (s.event_ts AT TIME ZONE 'Asia/Seoul'))::int AS dow,
               COALESCE(SUM(s.revenue), 0)::bigint AS revenue
          FROM sales_realtime s
          LEFT JOIN locations l ON l.location_id = s.store_id
         WHERE {" AND ".join(where)}
         GROUP BY s.store_id, l.name, dow
         ORDER BY s.store_id, dow
    """
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, params)
        rows = cur.fetchall()

    return {
        "items": [
            {
                "store_id":   r[0],
                "store_name": r[1] or f"매장 {r[0]}",
                "dow":        r[2],
                "revenue":    int(r[3] or 0),
            }
            for r in rows
        ],
    }


@router.get("/store-inventory/{store_id}")
def inventory_by_store(store_id: int, ctx: AuthContext = Depends(require_auth)):
    """특정 매장 재고 (Branch Inventory 페이지). branch-clerk + wh-manager 스코프 enforce."""
    with db_conn() as conn, conn.cursor() as cur:
        _check_location_scope(ctx, store_id, cur)
        sql = """
            SELECT i.isbn13, i.on_hand, i.reserved_qty, COALESCE(i.safety_stock, 0) AS safety_stock,
                   i.updated_at, b.title, b.author, b.category_name, b.price_sales, b.cover_url
              FROM inventory i
              LEFT JOIN books b ON b.isbn13 = i.isbn13
             WHERE i.location_id = %s
             ORDER BY (i.on_hand - i.reserved_qty) ASC, i.isbn13
        """
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
                "cover_url":    r[9],
            }
            for r in rows
        ],
    }


@router.get("/instructions")
def instructions(
    ctx: AuthContext = Depends(require_auth),
    wh_id: int | None = Query(default=None),
):
    """출고/입고 지시서 - APPROVED 된 pending_orders (WH Instructions / Branch Inbound).

    `wh_id` 필터링 옵션 (hq-admin 전용 hint).
    role-scope:
      - wh-manager: 자기 권역 (scope_wh_id) 강제 (wh_id 파라미터 무시)
      - branch-clerk: 자기 매장이 source 또는 target 인 row 만
    """
    where: list[str] = ["po.status IN ('APPROVED', 'EXECUTED')"]
    params: list = []
    effective_wh_id: int | None = None
    if ctx.role == "wh-manager" and ctx.scope_wh_id is not None:
        effective_wh_id = ctx.scope_wh_id  # 자기 권역 강제
    elif ctx.role == "hq-admin":
        effective_wh_id = wh_id  # 옵션 hint
    # branch-clerk 는 source/target 매장 일치 필터

    join_sql = ""
    if effective_wh_id is not None:
        join_sql = (
            "LEFT JOIN locations sl ON sl.location_id = po.source_location_id "
            "LEFT JOIN locations tl ON tl.location_id = po.target_location_id"
        )
        where.append("(sl.wh_id = %s OR tl.wh_id = %s)")
        params.extend([effective_wh_id, effective_wh_id])
    elif ctx.role == "branch-clerk" and ctx.scope_store_id is not None:
        where.append("(po.source_location_id = %s OR po.target_location_id = %s)")
        params.extend([ctx.scope_store_id, ctx.scope_store_id])

    sql = f"""
        SELECT po.order_id, po.order_type, po.isbn13, po.source_location_id, po.target_location_id,
               po.qty, po.urgency_level, po.status, po.approved_at, b.title
          FROM pending_orders po
          LEFT JOIN books b ON b.isbn13 = po.isbn13
          {join_sql}
         WHERE {' AND '.join(where)}
         ORDER BY
           CASE po.urgency_level
             WHEN 'NEWBOOK'  THEN 0
             WHEN 'CRITICAL' THEN 1
             WHEN 'URGENT'   THEN 2
             WHEN 'NORMAL'   THEN 3
             ELSE 4
           END,
           po.approved_at DESC NULLS LAST
         LIMIT 200
    """

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


@router.get("/kpi/by-category")
def kpi_by_category(
    days: int = Query(default=30, ge=1, le=365),
    store_id: int | None = Query(default=None),
    ctx: AuthContext = Depends(require_auth),
):
    """카테고리별 매출 (sales_realtime + books JOIN). role-scope 자동.

    - wh-manager: 자기 권역 매장 (locations.wh_id) 만
    - branch-clerk: 자기 매장 (scope_store_id) 만
    """
    # PostgreSQL INTERVAL 은 parameter binding 불가 → f-string (days 는 int 라 safe)
    where = [f"s.event_ts >= NOW() - INTERVAL '{int(days)} days'", "s.event_ts <= NOW()"]
    params: list = []
    if store_id is not None:
        where.append("s.store_id = %s")
        params.append(store_id)

    if ctx.role == "wh-manager" and ctx.scope_wh_id is not None:
        where.append(
            "EXISTS (SELECT 1 FROM locations l WHERE l.location_id = s.store_id AND l.wh_id = %s)"
        )
        params.append(ctx.scope_wh_id)
    elif ctx.role == "branch-clerk" and ctx.scope_store_id is not None:
        where.append("s.store_id = %s")
        params.append(ctx.scope_store_id)

    sql = f"""
        SELECT COALESCE(b.category_name, '미분류') AS category,
               SUM(s.revenue)::bigint AS revenue,
               SUM(s.qty)::int        AS qty,
               COUNT(*)::int          AS tx_count
          FROM sales_realtime s
          LEFT JOIN books b ON b.isbn13 = s.isbn13
         WHERE {' AND '.join(where)}
         GROUP BY category
         ORDER BY revenue DESC
         LIMIT 20
    """
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, params)
        rows = cur.fetchall()
    return {
        "days": days,
        "items": [
            {"category": r[0], "revenue": int(r[1] or 0), "qty": r[2] or 0, "tx_count": r[3] or 0}
            for r in rows
        ],
    }


@router.get("/sales/bestsellers")
def sales_bestsellers(
    days: int = Query(default=7, ge=1, le=365),
    limit: int = Query(default=20, ge=1, le=200),
    store_id: int | None = Query(default=None),
    ctx: AuthContext = Depends(require_auth),
):
    """베스트셀러 (sales_realtime GROUP BY isbn13 ORDER BY qty DESC). role-scope 자동."""
    where = [f"s.event_ts >= NOW() - INTERVAL '{int(days)} days'", "s.event_ts <= NOW()"]
    params: list = []
    if store_id is not None:
        where.append("s.store_id = %s")
        params.append(store_id)

    if ctx.role == "wh-manager" and ctx.scope_wh_id is not None:
        where.append(
            "EXISTS (SELECT 1 FROM locations l WHERE l.location_id = s.store_id AND l.wh_id = %s)"
        )
        params.append(ctx.scope_wh_id)
    elif ctx.role == "branch-clerk" and ctx.scope_store_id is not None:
        where.append("s.store_id = %s")
        params.append(ctx.scope_store_id)

    sql = f"""
        SELECT s.isbn13,
               b.title, b.author,
               SUM(s.qty)::int        AS qty,
               SUM(s.revenue)::bigint AS revenue,
               COUNT(*)::int          AS tx_count
          FROM sales_realtime s
          LEFT JOIN books b ON b.isbn13 = s.isbn13
         WHERE {' AND '.join(where)}
         GROUP BY s.isbn13, b.title, b.author
         ORDER BY qty DESC
         LIMIT %s
    """
    params_with_limit = params + [limit]
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, params_with_limit)
        rows = cur.fetchall()
    return {
        "days": days,
        "items": [
            {
                "isbn13":   r[0],
                "title":    r[1],
                "author":   r[2],
                "qty":      r[3] or 0,
                "revenue":  int(r[4] or 0),
                "tx_count": r[5] or 0,
            }
            for r in rows
        ],
    }


@router.get("/sales/hourly")
def sales_hourly(
    store_id: int = Query(...),
    date: str | None = Query(default=None, description="YYYY-MM-DD · 생략 시 오늘 KST"),
    ctx: AuthContext = Depends(require_auth),
):
    """시간대별 매출 (0~23 시 GROUP BY · 특정 매장 · 특정 날짜).

    branch-clerk 자기 매장 + wh-manager 자기 권역 enforce.
    """
    target_date = date or datetime.now(_KST).date().isoformat()
    sql = """
        SELECT EXTRACT(HOUR FROM event_ts AT TIME ZONE 'Asia/Seoul')::int AS hour,
               SUM(qty)::int        AS qty,
               SUM(revenue)::bigint AS revenue,
               COUNT(*)::int        AS tx_count
          FROM sales_realtime
         WHERE store_id = %s
           AND (event_ts AT TIME ZONE 'Asia/Seoul')::date = %s
         GROUP BY hour
         ORDER BY hour
    """
    with db_conn() as conn, conn.cursor() as cur:
        _check_location_scope(ctx, store_id, cur)
        cur.execute(sql, (store_id, target_date))
        rows = cur.fetchall()
    return {
        "date": target_date,
        "store_id": store_id,
        "items": [
            {"hour": r[0], "qty": r[1] or 0, "revenue": int(r[2] or 0), "tx_count": r[3] or 0}
            for r in rows
        ],
    }


@router.get("/cascade/funnel")
def cascade_funnel(
    days: int = Query(default=7, ge=1, le=90),
    ctx: AuthContext = Depends(require_auth),
):
    """cascade 단계별 통계 (pending_orders).

    summary: 전체 status 분포 (AUTO_EXECUTED = status=APPROVED AND auto_execute_eligible=TRUE)
    by_stage: order_type × status 매트릭스
    daily: 일자별 status 분포 (최근 N일)
    role-scope (wh-manager 자기 권역 / branch-clerk 자기 매장).
    """
    scope_clauses: list[str] = []
    scope_params: list = []
    if ctx.role == "wh-manager" and ctx.scope_wh_id is not None:
        scope_clauses.append(
            "(EXISTS (SELECT 1 FROM locations sl WHERE sl.location_id = po.source_location_id AND sl.wh_id = %s)"
            " OR EXISTS (SELECT 1 FROM locations tl WHERE tl.location_id = po.target_location_id AND tl.wh_id = %s))"
        )
        scope_params.extend([ctx.scope_wh_id, ctx.scope_wh_id])
    elif ctx.role == "branch-clerk" and ctx.scope_store_id is not None:
        scope_clauses.append(
            "(po.source_location_id = %s OR po.target_location_id = %s)"
        )
        scope_params.extend([ctx.scope_store_id, ctx.scope_store_id])

    scope_sql = (" AND " + " AND ".join(scope_clauses)) if scope_clauses else ""

    # 기간 (최근 N일) 필터 — created_at 기준 (INTERVAL 은 parameter binding 불가)
    period_clause = f"po.created_at >= NOW() - INTERVAL '{int(days)} days'"

    # status 라벨 (AUTO_EXECUTED 는 APPROVED + auto_execute_eligible 파생)
    status_expr = (
        "CASE WHEN po.status = 'APPROVED' AND po.auto_execute_eligible = TRUE "
        "     THEN 'AUTO_EXECUTED' ELSE po.status END"
    )

    summary: dict[str, int] = {}
    by_stage: dict[str, dict[str, int]] = {}
    daily: list[dict] = []

    with db_conn() as conn, conn.cursor() as cur:
        # 1. summary (status 분포)
        cur.execute(
            f"""
            SELECT {status_expr} AS s, COUNT(*)::int
              FROM pending_orders po
             WHERE {period_clause}{scope_sql}
             GROUP BY s
            """,
            scope_params,
        )
        summary = {r[0]: r[1] for r in cur.fetchall() if r[0] is not None}

        # 2. by_stage (order_type × status)
        cur.execute(
            f"""
            SELECT po.order_type, {status_expr} AS s, COUNT(*)::int
              FROM pending_orders po
             WHERE {period_clause}{scope_sql}
             GROUP BY po.order_type, s
            """,
            scope_params,
        )
        for order_type, st, n in cur.fetchall():
            if order_type is None or st is None:
                continue
            by_stage.setdefault(order_type, {})[st] = n

        # 3. daily (date × status)
        cur.execute(
            f"""
            SELECT po.created_at::date AS d, {status_expr} AS s, COUNT(*)::int
              FROM pending_orders po
             WHERE {period_clause}{scope_sql}
             GROUP BY d, s
             ORDER BY d
            """,
            scope_params,
        )
        daily_map: dict[str, dict[str, int]] = {}
        for d, st, n in cur.fetchall():
            if d is None or st is None:
                continue
            key = d.isoformat() if hasattr(d, "isoformat") else str(d)
            daily_map.setdefault(key, {})[st] = n
        daily = [{"date": k, **v} for k, v in sorted(daily_map.items())]

    return {
        "days": days,
        "summary": summary,
        "by_stage": by_stage,
        "daily": daily,
    }


def _apply_sales_scope(ctx: AuthContext, where: list[str], params: list, store_id: int | None) -> None:
    """sales_realtime 용 role-scope where 절 append (in-place).

    s.store_id alias 가정. wh-manager → locations.wh_id · branch-clerk → s.store_id.
    """
    if store_id is not None:
        where.append("s.store_id = %s")
        params.append(store_id)
    if ctx.role == "wh-manager" and ctx.scope_wh_id is not None:
        where.append(
            "EXISTS (SELECT 1 FROM locations l WHERE l.location_id = s.store_id AND l.wh_id = %s)"
        )
        params.append(ctx.scope_wh_id)
    elif ctx.role == "branch-clerk" and ctx.scope_store_id is not None:
        where.append("s.store_id = %s")
        params.append(ctx.scope_store_id)


_DOW_LABEL = ["일", "월", "화", "수", "목", "금", "토"]


@router.get("/sales/by-weekday")
def sales_by_weekday(
    days: int = Query(default=30, ge=1, le=365),
    store_id: int | None = Query(default=None),
    ctx: AuthContext = Depends(require_auth),
):
    """요일별 매출 평균 (KST 0=일 ~ 6=토). role-scope 자동."""
    where = [f"s.event_ts >= NOW() - INTERVAL '{int(days)} days'", "s.event_ts <= NOW()"]
    params: list = []
    _apply_sales_scope(ctx, where, params, store_id)

    sql = f"""
        SELECT EXTRACT(DOW FROM s.event_ts AT TIME ZONE 'Asia/Seoul')::int AS dow,
               SUM(s.revenue)::bigint AS revenue,
               SUM(s.qty)::int        AS qty,
               COUNT(*)::int          AS tx_count
          FROM sales_realtime s
         WHERE {' AND '.join(where)}
         GROUP BY dow
         ORDER BY dow
    """
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, params)
        rows = cur.fetchall()
    return {
        "days": days,
        "items": [
            {
                "dow": r[0],
                "dow_label": _DOW_LABEL[r[0]] if 0 <= r[0] <= 6 else str(r[0]),
                "revenue": int(r[1] or 0),
                "qty": r[2] or 0,
                "tx_count": r[3] or 0,
            }
            for r in rows
        ],
    }


@router.get("/sales/by-hour-avg")
def sales_by_hour_avg(
    days: int = Query(default=30, ge=1, le=365),
    store_id: int | None = Query(default=None),
    ctx: AuthContext = Depends(require_auth),
):
    """시간대별 매출 평균 (N일 동안 같은 시간대 sum / 실제 발생 일수).

    AVG = SUM(metric) / COUNT(DISTINCT date) — 0 매출 날은 분모에서 제외 (시드 데이터 sparse 대응).
    """
    where = [f"s.event_ts >= NOW() - INTERVAL '{int(days)} days'", "s.event_ts <= NOW()"]
    params: list = []
    _apply_sales_scope(ctx, where, params, store_id)

    sql = f"""
        WITH hourly AS (
            SELECT EXTRACT(HOUR FROM s.event_ts AT TIME ZONE 'Asia/Seoul')::int AS hour,
                   (s.event_ts AT TIME ZONE 'Asia/Seoul')::date AS day,
                   SUM(s.revenue) AS revenue,
                   SUM(s.qty)     AS qty,
                   COUNT(*)       AS tx_count
              FROM sales_realtime s
             WHERE {' AND '.join(where)}
             GROUP BY hour, day
        )
        SELECT hour,
               AVG(revenue)::bigint   AS avg_revenue,
               AVG(qty)::numeric(10,2) AS avg_qty,
               AVG(tx_count)::numeric(10,2) AS avg_tx_count
          FROM hourly
         GROUP BY hour
         ORDER BY hour
    """
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, params)
        rows = cur.fetchall()
    return {
        "days": days,
        "items": [
            {
                "hour": r[0],
                "avg_revenue": int(r[1] or 0),
                "avg_qty": float(r[2] or 0),
                "avg_tx_count": float(r[3] or 0),
            }
            for r in rows
        ],
    }


@router.get("/sales/by-payment")
def sales_by_payment(
    days: int = Query(default=30, ge=1, le=365),
    store_id: int | None = Query(default=None),
    ctx: AuthContext = Depends(require_auth),
):
    """결제수단 분포. payment_method NULL → 'UNKNOWN'."""
    where = [f"s.event_ts >= NOW() - INTERVAL '{int(days)} days'", "s.event_ts <= NOW()"]
    params: list = []
    _apply_sales_scope(ctx, where, params, store_id)

    sql = f"""
        SELECT COALESCE(s.payment_method, 'UNKNOWN') AS payment,
               SUM(s.revenue)::bigint AS revenue,
               COUNT(*)::int          AS count
          FROM sales_realtime s
         WHERE {' AND '.join(where)}
         GROUP BY payment
         ORDER BY revenue DESC
    """
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, params)
        rows = cur.fetchall()
    return {
        "days": days,
        "items": [
            {"payment": r[0], "revenue": int(r[1] or 0), "count": r[2] or 0}
            for r in rows
        ],
    }


@router.get("/sales/asp")
def sales_asp(
    days: int = Query(default=30, ge=1, le=365),
    store_id: int | None = Query(default=None),
    ctx: AuthContext = Depends(require_auth),
):
    """ASP 일별 트렌드 (객단가 = daily_revenue / daily_tx_count)."""
    where = [f"s.event_ts >= NOW() - INTERVAL '{int(days)} days'", "s.event_ts <= NOW()"]
    params: list = []
    _apply_sales_scope(ctx, where, params, store_id)

    sql = f"""
        SELECT (s.event_ts AT TIME ZONE 'Asia/Seoul')::date AS d,
               SUM(s.revenue)::bigint AS revenue,
               COUNT(*)::int          AS tx_count
          FROM sales_realtime s
         WHERE {' AND '.join(where)}
         GROUP BY d
         ORDER BY d
    """
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, params)
        rows = cur.fetchall()
    return {
        "days": days,
        "items": [
            {
                "date": r[0].isoformat() if hasattr(r[0], "isoformat") else str(r[0]),
                "asp": int(r[1] / r[2]) if r[2] else 0,
                "revenue": int(r[1] or 0),
                "tx_count": r[2] or 0,
            }
            for r in rows
        ],
    }


@router.get("/sales/30days")
def sales_30days(
    store_id: int | None = Query(default=None),
    ctx: AuthContext = Depends(require_auth),
):
    """30일 daily 매출 (kpi_daily 활용). role-scope 자동.

    kpi_daily 시드가 sparse 하면 0 일자가 누락될 수 있으나 시연용 — 있는 일자만 반환.
    """
    where: list[str] = ["k.kpi_date >= CURRENT_DATE - INTERVAL '30 days'"]
    params: list = []
    if store_id is not None:
        where.append("k.store_id = %s")
        params.append(store_id)
    if ctx.role == "wh-manager" and ctx.scope_wh_id is not None:
        where.append(
            "EXISTS (SELECT 1 FROM locations l WHERE l.location_id = k.store_id AND l.wh_id = %s)"
        )
        params.append(ctx.scope_wh_id)
    elif ctx.role == "branch-clerk" and ctx.scope_store_id is not None:
        where.append("k.store_id = %s")
        params.append(ctx.scope_store_id)

    sql = f"""
        SELECT k.kpi_date,
               SUM(k.revenue)::bigint  AS revenue,
               SUM(k.qty_sold)::int    AS qty
          FROM kpi_daily k
         WHERE {' AND '.join(where)}
         GROUP BY k.kpi_date
         ORDER BY k.kpi_date
    """
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, params)
        rows = cur.fetchall()
    return {
        "items": [
            {
                "date": r[0].isoformat() if hasattr(r[0], "isoformat") else str(r[0]),
                "revenue": int(r[1] or 0),
                "qty": r[2] or 0,
            }
            for r in rows
        ],
    }


# granularity → (date_trunc 단위, lookback INTERVAL, 출력 포맷)
_GRAIN = {
    "minute": ("minute", "6 hours"),
    "hour":   ("hour",   "7 days"),
    "day":    ("day",    "30 days"),
}


@router.get("/sales/timeseries")
def sales_timeseries(
    granularity: str = Query(default="minute", description="minute · hour · day"),
    store_id: int | None = Query(default=None),
    ctx: AuthContext = Depends(require_auth),
):
    """매출 시계열 — 분/시간/일 버킷 집계 (sales_realtime · date_trunc). role-scope 자동.

    사용자 친화 granularity 토글용. minute=최근 6h · hour=최근 7d · day=최근 30d.
    bucket 은 KST 기준 ISO 문자열.
    """
    grain = granularity if granularity in _GRAIN else "minute"
    trunc, lookback = _GRAIN[grain]

    where = [
        f"s.event_ts >= NOW() - INTERVAL '{lookback}'",
        "s.event_ts <= NOW()",
    ]
    params: list = []
    _apply_sales_scope(ctx, where, params, store_id)

    sql = f"""
        SELECT date_trunc('{trunc}', s.event_ts AT TIME ZONE 'Asia/Seoul') AS bucket,
               SUM(s.revenue)::bigint AS revenue,
               SUM(s.qty)::int        AS qty,
               COUNT(*)::int          AS tx_count
          FROM sales_realtime s
         WHERE {' AND '.join(where)}
         GROUP BY bucket
         ORDER BY bucket
    """
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, params)
        rows = cur.fetchall()
    return {
        "granularity": grain,
        "items": [
            {
                "bucket":   r[0].isoformat() if hasattr(r[0], "isoformat") else str(r[0]),
                "revenue":  int(r[1] or 0),
                "qty":      r[2] or 0,
                "tx_count": r[3] or 0,
            }
            for r in rows
        ],
    }


@router.get("/inventory/turnover")
def inventory_turnover(
    days: int = Query(default=7, ge=1, le=90),
    ctx: AuthContext = Depends(require_auth),
):
    """권역 회전율 비교 (wh1, wh2). turnover = (매출 qty / 평균 재고) * (1 / days)."""
    # branch-clerk 는 권역 비교 의미 X — 그대로 자기 매장 wh 만 보이지만 무시 (별 영향 없음)
    sales_where: list[str] = [f"s.event_ts >= NOW() - INTERVAL '{int(days)} days'", "s.event_ts <= NOW()"]
    sales_params: list = []
    if ctx.role == "wh-manager" and ctx.scope_wh_id is not None:
        sales_where.append("l.wh_id = %s")
        sales_params.append(ctx.scope_wh_id)
    elif ctx.role == "branch-clerk" and ctx.scope_store_id is not None:
        sales_where.append("s.store_id = %s")
        sales_params.append(ctx.scope_store_id)

    sales_sql = f"""
        SELECT l.wh_id, SUM(s.qty)::int AS total_qty
          FROM sales_realtime s
          JOIN locations l ON l.location_id = s.store_id
         WHERE {' AND '.join(sales_where)}
           AND l.wh_id IS NOT NULL
         GROUP BY l.wh_id
    """

    inv_where: list[str] = ["l.wh_id IS NOT NULL"]
    inv_params: list = []
    if ctx.role == "wh-manager" and ctx.scope_wh_id is not None:
        inv_where.append("l.wh_id = %s")
        inv_params.append(ctx.scope_wh_id)
    elif ctx.role == "branch-clerk" and ctx.scope_store_id is not None:
        inv_where.append("i.location_id = %s")
        inv_params.append(ctx.scope_store_id)

    inv_sql = f"""
        SELECT l.wh_id, AVG(i.on_hand)::numeric(12,2) AS avg_on_hand
          FROM inventory i
          JOIN locations l ON l.location_id = i.location_id
         WHERE {' AND '.join(inv_where)}
         GROUP BY l.wh_id
    """

    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(sales_sql, sales_params)
        sales_map = {r[0]: r[1] for r in cur.fetchall()}
        cur.execute(inv_sql, inv_params)
        inv_map = {r[0]: float(r[1] or 0) for r in cur.fetchall()}

    wh_ids = sorted(set(sales_map) | set(inv_map))
    items = []
    for wh_id in wh_ids:
        total_sales = sales_map.get(wh_id, 0) or 0
        avg_inventory = inv_map.get(wh_id, 0.0) or 0.0
        turnover = (total_sales / avg_inventory / days) if avg_inventory > 0 else 0.0
        items.append({
            "wh_id": wh_id,
            "turnover": round(turnover, 4),
            "total_sales": total_sales,
            "avg_inventory": round(avg_inventory, 2),
        })
    return {"days": days, "items": items}


@router.get("/inventory/insufficient-trend")
def inventory_insufficient_trend(
    days: int = Query(default=30, ge=1, le=90),
    ctx: AuthContext = Depends(require_auth),
):
    """부족 도서 추이 (available < safety_stock). inventory_snapshot_daily 우선, 비어있으면 fallback."""
    # role-scope: wh-manager → 자기 권역 매장 / branch-clerk → 자기 매장
    scope_clauses: list[str] = []
    scope_params: list = []
    if ctx.role == "wh-manager" and ctx.scope_wh_id is not None:
        scope_clauses.append(
            "EXISTS (SELECT 1 FROM locations l WHERE l.location_id = snap.location_id AND l.wh_id = %s)"
        )
        scope_params.append(ctx.scope_wh_id)
    elif ctx.role == "branch-clerk" and ctx.scope_store_id is not None:
        scope_clauses.append("snap.location_id = %s")
        scope_params.append(ctx.scope_store_id)
    scope_extra = (" AND " + " AND ".join(scope_clauses)) if scope_clauses else ""

    snap_sql = f"""
        SELECT snap.snapshot_date,
               COUNT(*)::int AS insufficient_count
          FROM inventory_snapshot_daily snap
         WHERE snap.snapshot_date >= CURRENT_DATE - INTERVAL '{int(days)} days'
           AND snap.safety_stock IS NOT NULL
           AND snap.available < snap.safety_stock
           {scope_extra}
         GROUP BY snap.snapshot_date
         ORDER BY snap.snapshot_date
    """
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(snap_sql, scope_params)
        rows = cur.fetchall()

    if rows:
        return {
            "days": days,
            "items": [
                {
                    "date": r[0].isoformat() if hasattr(r[0], "isoformat") else str(r[0]),
                    "insufficient_count": r[1] or 0,
                }
                for r in rows
            ],
        }

    # Fallback: 오늘 inventory 기준 단조 가정 (시연용)
    fb_clauses: list[str] = ["i.safety_stock IS NOT NULL", "(i.on_hand - i.reserved_qty) < i.safety_stock"]
    fb_params: list = []
    if ctx.role == "wh-manager" and ctx.scope_wh_id is not None:
        fb_clauses.append(
            "EXISTS (SELECT 1 FROM locations l WHERE l.location_id = i.location_id AND l.wh_id = %s)"
        )
        fb_params.append(ctx.scope_wh_id)
    elif ctx.role == "branch-clerk" and ctx.scope_store_id is not None:
        fb_clauses.append("i.location_id = %s")
        fb_params.append(ctx.scope_store_id)

    fb_sql = f"SELECT COUNT(*)::int FROM inventory i WHERE {' AND '.join(fb_clauses)}"
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(fb_sql, fb_params)
        today_count = cur.fetchone()[0] or 0

    today = datetime.now(_KST).date()
    items = [
        {"date": (today - timedelta(days=i)).isoformat(), "insufficient_count": today_count}
        for i in range(days - 1, -1, -1)
    ]
    return {"days": days, "items": items, "note": "fallback (inventory_snapshot_daily empty)"}


@router.get("/inventory/by-category")
def inventory_by_category(ctx: AuthContext = Depends(require_auth)):
    """카테고리 재고 분포. inventory LEFT JOIN books JOIN locations. role-scope 자동."""
    where: list[str] = []
    params: list = []
    if ctx.role == "wh-manager" and ctx.scope_wh_id is not None:
        where.append("l.wh_id = %s")
        params.append(ctx.scope_wh_id)
    elif ctx.role == "branch-clerk" and ctx.scope_store_id is not None:
        where.append("i.location_id = %s")
        params.append(ctx.scope_store_id)
    where_sql = ("WHERE " + " AND ".join(where)) if where else ""

    sql = f"""
        SELECT COALESCE(b.category_name, '미분류') AS category,
               SUM(i.on_hand)::bigint AS on_hand,
               SUM(GREATEST(i.on_hand - i.reserved_qty, 0))::bigint AS available
          FROM inventory i
          LEFT JOIN books b ON b.isbn13 = i.isbn13
          JOIN locations l ON l.location_id = i.location_id
        {where_sql}
         GROUP BY category
         ORDER BY on_hand DESC
         LIMIT 30
    """
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, params)
        rows = cur.fetchall()
    return {
        "items": [
            {"category": r[0], "on_hand": int(r[1] or 0), "available": int(r[2] or 0)}
            for r in rows
        ],
    }


@router.get("/sales/category-trend")
def sales_category_trend(
    days: int = Query(default=30, ge=1, le=365),
    ctx: AuthContext = Depends(require_auth),
):
    """카테고리 매출 trend (top 5 by total revenue). 일자 × 카테고리."""
    where = [f"s.event_ts >= NOW() - INTERVAL '{int(days)} days'", "s.event_ts <= NOW()"]
    params: list = []
    _apply_sales_scope(ctx, where, params, None)

    # top 5 카테고리 먼저 결정
    top_sql = f"""
        SELECT COALESCE(b.category_name, '미분류') AS category
          FROM sales_realtime s
          LEFT JOIN books b ON b.isbn13 = s.isbn13
         WHERE {' AND '.join(where)}
         GROUP BY category
         ORDER BY SUM(s.revenue) DESC
         LIMIT 5
    """
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(top_sql, params)
        top_cats = [r[0] for r in cur.fetchall()]

    if not top_cats:
        return {"days": days, "items": []}

    trend_where = where + ["COALESCE(b.category_name, '미분류') = ANY(%s)"]
    trend_params = params + [top_cats]
    trend_sql = f"""
        SELECT (s.event_ts AT TIME ZONE 'Asia/Seoul')::date AS d,
               COALESCE(b.category_name, '미분류') AS category,
               SUM(s.revenue)::bigint AS revenue
          FROM sales_realtime s
          LEFT JOIN books b ON b.isbn13 = s.isbn13
         WHERE {' AND '.join(trend_where)}
         GROUP BY d, category
         ORDER BY d, category
    """
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(trend_sql, trend_params)
        rows = cur.fetchall()
    return {
        "days": days,
        "categories": top_cats,
        "items": [
            {
                "date": r[0].isoformat() if hasattr(r[0], "isoformat") else str(r[0]),
                "category": r[1],
                "revenue": int(r[2] or 0),
            }
            for r in rows
        ],
    }


@router.get("/forecast/accuracy")
def forecast_accuracy(
    days: int = Query(default=7, ge=1, le=90),
    ctx: AuthContext = Depends(require_auth),
):
    """forecast 정확도 (predicted vs actual). snapshot_date 별 MAE/MAPE.

    forecast_cache.snapshot_date 의 predicted_demand 합 vs sales_realtime 의 그 날 qty 합.
    branch-clerk 는 자기 매장만 / wh-manager 는 권역 매장.
    """
    scope_sales_clauses: list[str] = []
    scope_sales_params: list = []
    scope_fc_clauses: list[str] = []
    scope_fc_params: list = []
    if ctx.role == "wh-manager" and ctx.scope_wh_id is not None:
        scope_sales_clauses.append(
            "EXISTS (SELECT 1 FROM locations l WHERE l.location_id = s.store_id AND l.wh_id = %s)"
        )
        scope_sales_params.append(ctx.scope_wh_id)
        scope_fc_clauses.append(
            "EXISTS (SELECT 1 FROM locations l WHERE l.location_id = fc.store_id AND l.wh_id = %s)"
        )
        scope_fc_params.append(ctx.scope_wh_id)
    elif ctx.role == "branch-clerk" and ctx.scope_store_id is not None:
        scope_sales_clauses.append("s.store_id = %s")
        scope_sales_params.append(ctx.scope_store_id)
        scope_fc_clauses.append("fc.store_id = %s")
        scope_fc_params.append(ctx.scope_store_id)

    sales_scope_sql = (" AND " + " AND ".join(scope_sales_clauses)) if scope_sales_clauses else ""
    fc_scope_sql = (" AND " + " AND ".join(scope_fc_clauses)) if scope_fc_clauses else ""

    sql = f"""
        WITH fc AS (
            SELECT fc.snapshot_date, fc.isbn13, fc.store_id, SUM(fc.predicted_demand) AS predicted
              FROM forecast_cache fc
             WHERE fc.snapshot_date >= CURRENT_DATE - INTERVAL '{int(days)} days'
               AND fc.snapshot_date <= CURRENT_DATE
               {fc_scope_sql}
             GROUP BY fc.snapshot_date, fc.isbn13, fc.store_id
        ),
        actual AS (
            SELECT (s.event_ts AT TIME ZONE 'Asia/Seoul')::date AS d,
                   s.isbn13, s.store_id,
                   SUM(s.qty)::numeric AS qty
              FROM sales_realtime s
             WHERE (s.event_ts AT TIME ZONE 'Asia/Seoul')::date >= CURRENT_DATE - INTERVAL '{int(days)} days'
               AND s.event_ts <= NOW()
               {sales_scope_sql}
             GROUP BY d, s.isbn13, s.store_id
        )
        SELECT fc.snapshot_date AS date,
               AVG(ABS(fc.predicted - COALESCE(actual.qty, 0)))::numeric(12,4) AS mae,
               (AVG(
                   CASE WHEN COALESCE(actual.qty, 0) > 0
                        THEN ABS(fc.predicted - actual.qty) / actual.qty
                        ELSE NULL END
               ) * 100)::numeric(8,4) AS mape,
               SUM(fc.predicted)::numeric(12,2) AS total_predicted,
               SUM(COALESCE(actual.qty, 0))::numeric(12,2) AS total_actual
          FROM fc
          LEFT JOIN actual
                 ON actual.d = fc.snapshot_date
                AND actual.isbn13 = fc.isbn13
                AND actual.store_id = fc.store_id
         GROUP BY fc.snapshot_date
         ORDER BY fc.snapshot_date
    """
    params = scope_fc_params + scope_sales_params
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, params)
        rows = cur.fetchall()

    if not rows:
        return {"days": days, "items": [], "note": "no forecast_cache snapshots in range"}

    return {
        "days": days,
        "items": [
            {
                "date": r[0].isoformat() if hasattr(r[0], "isoformat") else str(r[0]),
                "mae": float(r[1] or 0),
                "mape": float(r[2] or 0) if r[2] is not None else 0.0,
                "total_predicted": float(r[3] or 0),
                "total_actual": float(r[4] or 0),
            }
            for r in rows
        ],
    }


@router.get("/curation/{store_id}")
def curation(store_id: int, ctx: AuthContext = Depends(require_auth)):
    """매장 큐레이션 - spike_events (인기 도서) + 매장 재고 가용성 (Branch Curation).

    `spike_events` 와 `inventory(location=store)` JOIN 해서 "인기 + 매장 재고 OK" 도서 우선 표시.
    branch-clerk 자기 매장 + wh-manager 자기 권역 enforce.
    """
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
        _check_location_scope(ctx, store_id, cur)
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


@router.get("/execution/by-location")
def execution_by_location(
    ctx: AuthContext = Depends(require_auth),
    date: str | None = Query(default=None, description="YYYY-MM-DD KST · 생략 시 오늘"),
):
    """위치별 입·출고 실행 추적 (2026-05-14 신규).

    오늘 (또는 지정 일자) 의 pending_orders APPROVED/EXECUTED/AUTO_EXECUTED row 를
    source(-qty) / target(+qty) location 별로 집계.

    role/scope 자동 필터:
      - hq-admin: 전체
      - wh-manager + scope_wh_id: 자기 wh 소속 location 만
      - branch-clerk + scope_store_id: 자기 매장만

    응답: items[] = {location_id, name, outbound_qty, inbound_qty, net_change,
                     executed_count, approved_count, by_order_type{...}}
    """
    target_date = date or datetime.now(_KST).date().isoformat()

    # 모든 4 order_type 의 source/target 별 집계
    # status IN ('APPROVED', 'EXECUTED', 'AUTO_EXECUTED') · approved_at::date = target_date
    sql = """
        WITH active_orders AS (
            SELECT
                po.order_id, po.order_type, po.status,
                po.source_location_id, po.target_location_id, po.qty,
                po.approved_at, po.executed_at
              FROM pending_orders po
             WHERE po.status IN ('APPROVED', 'EXECUTED', 'AUTO_EXECUTED')
               AND COALESCE(po.approved_at::date, po.created_at::date) = %s::date
        ),
        agg AS (
            -- source side: 출고 (qty 양수로 외부 저장 · 응답 시 outbound_qty)
            SELECT source_location_id AS location_id, order_type,
                   SUM(qty)::int AS qty_sum,
                   COUNT(*)::int AS cnt,
                   COUNT(*) FILTER (WHERE status = 'EXECUTED')::int AS exec_cnt,
                   'OUT' AS side
              FROM active_orders
             WHERE source_location_id IS NOT NULL
             GROUP BY source_location_id, order_type
            UNION ALL
            SELECT target_location_id AS location_id, order_type,
                   SUM(qty)::int AS qty_sum,
                   COUNT(*)::int AS cnt,
                   COUNT(*) FILTER (WHERE status = 'EXECUTED')::int AS exec_cnt,
                   'IN' AS side
              FROM active_orders
             WHERE target_location_id IS NOT NULL
             GROUP BY target_location_id, order_type
        )
        SELECT a.location_id, l.name, l.location_type, l.wh_id,
               a.order_type, a.side, a.qty_sum, a.cnt, a.exec_cnt
          FROM agg a
          JOIN locations l ON l.location_id = a.location_id
         WHERE 1 = 1
    """
    params: list = [target_date]

    if ctx.role == "wh-manager" and ctx.scope_wh_id is not None:
        sql += " AND l.wh_id = %s"
        params.append(ctx.scope_wh_id)
    elif ctx.role == "branch-clerk" and ctx.scope_store_id is not None:
        sql += " AND a.location_id = %s"
        params.append(ctx.scope_store_id)

    sql += " ORDER BY a.location_id"

    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, params)
        rows = cur.fetchall()

    # location_id 별 누적
    by_loc: dict[int, dict] = {}
    for r in rows:
        loc_id, name, ltype, wh_id, ot, side, qty_sum, cnt, exec_cnt = r
        cell = by_loc.setdefault(loc_id, {
            "location_id": loc_id,
            "name": name or f"loc {loc_id}",
            "location_type": ltype,
            "wh_id": wh_id,
            "outbound_qty": 0,
            "inbound_qty": 0,
            "net_change": 0,
            "executed_count": 0,
            "approved_count": 0,
            "by_order_type": {
                "WH_TO_STORE":     {"outbound": 0, "inbound": 0},
                "REBALANCE":       {"outbound": 0, "inbound": 0},
                "WH_TRANSFER":     {"outbound": 0, "inbound": 0},
                "PUBLISHER_ORDER": {"outbound": 0, "inbound": 0},
            },
        })
        cell["approved_count"] += int(cnt or 0)
        cell["executed_count"] += int(exec_cnt or 0)
        if side == "OUT":
            cell["outbound_qty"] += int(qty_sum or 0)
            if ot in cell["by_order_type"]:
                cell["by_order_type"][ot]["outbound"] += int(cnt or 0)
        else:
            cell["inbound_qty"] += int(qty_sum or 0)
            if ot in cell["by_order_type"]:
                cell["by_order_type"][ot]["inbound"] += int(cnt or 0)

    for cell in by_loc.values():
        cell["net_change"] = cell["inbound_qty"] - cell["outbound_qty"]

    return {
        "date": target_date,
        "items": sorted(by_loc.values(), key=lambda x: (x["wh_id"] or 0, x["location_id"])),
    }
