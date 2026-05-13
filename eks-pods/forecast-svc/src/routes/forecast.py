"""forecast routes: GET /forecast/{store_id}/{snapshot_date} · POST /forecast/refresh.

D+1 forecast cache only (D+2~5 lives in BigQuery, accessed by dashboard-bff via VPN).
"""
from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status

from ..auth import AuthContext, require_auth
from ..db import db_conn
from ..models import (
    ForecastResponse, ForecastRow, RefreshRequest, RefreshResponse,
    InsufficientStockItem, InsufficientStockResponse,
)

router = APIRouter(prefix="/forecast", tags=["forecast"])


@router.get("/{store_id}/{snapshot_date}", response_model=ForecastResponse)
def get_forecast(store_id: int, snapshot_date: date, _: AuthContext = Depends(require_auth)):
    sql = """
        SELECT snapshot_date, isbn13, store_id, predicted_demand,
               confidence_low, confidence_high, model_version, synced_at
          FROM forecast_cache
         WHERE store_id = %s AND snapshot_date = %s
         ORDER BY isbn13
    """
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, (store_id, snapshot_date))
        rows = cur.fetchall()

    items = [
        ForecastRow(
            snapshot_date=r[0], isbn13=r[1], store_id=r[2],
            predicted_demand=float(r[3]),
            confidence_low=float(r[4]) if r[4] is not None else None,
            confidence_high=float(r[5]) if r[5] is not None else None,
            model_version=r[6], synced_at=r[7],
        )
        for r in rows
    ]
    return ForecastResponse(snapshot_date=snapshot_date, store_id=store_id, items=items)


@router.get("/insufficient-stock", response_model=InsufficientStockResponse)
def insufficient_stock(
    limit: int = 2000,
    _: AuthContext = Depends(require_auth),
):
    """P1-4b 시연 trigger: 안전재고 5일치 (predicted_demand × 5) > 가용재고 인 도서 list.

    매일 배치성 처리 가정 (사용자 결정 2026-05-13) — limit default 2000 = 전수 검사.
    안전재고 = 익일 forecast × 5 (forecast 는 권/일 단위 · 5일치를 안전선).
    suggested_qty = gap × 1.2 (min 30, max 500 · 5일치라 더 큰 발주 허용).
    """
    # 시연 의도: '익일 (CURRENT_DATE + 1) 지점·물류센터별 수요예측 × 5 vs 현재 가용재고' 비교.
    sql = """
        WITH target AS (
            SELECT MIN(snapshot_date) AS d FROM forecast_cache WHERE snapshot_date > CURRENT_DATE
        )
        SELECT f.isbn13, b.title, f.store_id,
               f.predicted_demand,
               COALESCE(SUM(GREATEST(i.on_hand - i.reserved_qty, 0)), 0)::int AS available
          FROM forecast_cache f
          LEFT JOIN books b ON b.isbn13 = f.isbn13
          LEFT JOIN inventory i ON i.isbn13 = f.isbn13 AND i.location_id = f.store_id
          CROSS JOIN target
         WHERE f.snapshot_date = target.d
         GROUP BY f.isbn13, b.title, f.store_id, f.predicted_demand
        HAVING f.predicted_demand * 5 > COALESCE(SUM(GREATEST(i.on_hand - i.reserved_qty, 0)), 0)
         ORDER BY (f.predicted_demand * 5 - COALESCE(SUM(GREATEST(i.on_hand - i.reserved_qty, 0)), 0)) DESC
         LIMIT %s
    """
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, (limit,))
        rows = cur.fetchall()
        cur.execute("SELECT MIN(snapshot_date) FROM forecast_cache WHERE snapshot_date > CURRENT_DATE")
        snapshot = cur.fetchone()[0]

    items: list[InsufficientStockItem] = []
    for r in rows:
        isbn13, title, store_id, pred, avail = r[0], r[1], r[2], float(r[3]), int(r[4])
        safety_5d = int(pred * 5)
        gap = max(0, safety_5d - avail)
        # gap × 1.2 buffer, min 30, max 500 (5일치 기준)
        suggested = max(30, min(500, int(gap * 1.2)))
        items.append(InsufficientStockItem(
            isbn13=isbn13, title=title, store_id=store_id,
            predicted_demand=pred, safety_stock_5days=safety_5d,
            available=avail, gap=gap, suggested_qty=suggested,
        ))

    return InsufficientStockResponse(snapshot_date=snapshot or date.today(), items=items)


@router.post("/refresh", response_model=RefreshResponse)
def refresh(req: RefreshRequest, ctx: AuthContext = Depends(require_auth)):
    """Bulk UPSERT (idempotent). Phase 2 stub - real BQ -> RDS sync wired later."""
    if ctx.role != "hq-admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="hq-admin only")

    sql = """
        INSERT INTO forecast_cache
            (snapshot_date, isbn13, store_id, predicted_demand,
             confidence_low, confidence_high, model_version, synced_at)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (snapshot_date, isbn13, store_id) DO UPDATE
        SET predicted_demand = EXCLUDED.predicted_demand,
            confidence_low   = EXCLUDED.confidence_low,
            confidence_high  = EXCLUDED.confidence_high,
            model_version    = EXCLUDED.model_version,
            synced_at        = EXCLUDED.synced_at
    """
    now = datetime.now(timezone.utc)
    with db_conn() as conn:
        with conn.cursor() as cur:
            for it in req.items:
                cur.execute(sql, (
                    it.snapshot_date, it.isbn13, it.store_id, it.predicted_demand,
                    it.confidence_low, it.confidence_high, it.model_version, now,
                ))
        conn.commit()

    return RefreshResponse(
        snapshot_date=req.snapshot_date,
        store_id=req.store_id,
        inserted=len(req.items),
    )
