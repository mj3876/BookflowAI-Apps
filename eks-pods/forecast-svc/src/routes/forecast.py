"""forecast routes: GET /forecast/{store_id}/{snapshot_date} · POST /forecast/refresh.

D+1 forecast cache only (D+2~5 lives in BigQuery, accessed by dashboard-bff via VPN).
"""
from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status

from ..auth import AuthContext, require_auth
from ..db import db_conn
from ..models import ForecastResponse, ForecastRow, RefreshRequest, RefreshResponse

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
