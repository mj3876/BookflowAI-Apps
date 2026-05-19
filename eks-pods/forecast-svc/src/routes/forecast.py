"""forecast routes: GET /forecast/{store_id}/{snapshot_date} · POST /forecast/refresh.

D+1 forecast cache only (D+2~5 lives in BigQuery, accessed by dashboard-bff via VPN).
"""
import logging
from datetime import date, datetime, timezone

import httpx
from fastapi import APIRouter, Depends, HTTPException, status

from ..auth import AuthContext, require_auth
from ..db import db_conn
from ..models import (
    ForecastResponse, ForecastRow, RefreshRequest, RefreshResponse,
    InsufficientStockItem, InsufficientStockResponse,
)
from ..settings import settings

log = logging.getLogger(__name__)

router = APIRouter(prefix="/forecast", tags=["forecast"])


def _fetch_bigquery_forecast_rows(days: int) -> list[dict]:
    """Read latest Vertex/BigQuery forecast_results rows for RDS cache sync."""
    if not settings.bq_project_id:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="FORECAST_BQ_PROJECT_ID is required for GCP BigQuery refresh",
        )

    try:
        from google.cloud import bigquery
    except ImportError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="google-cloud-bigquery dependency is not installed",
        ) from exc

    project = settings.bq_project_id
    dataset = settings.bq_dataset_id
    table = settings.bq_forecast_table
    query = f"""
        WITH latest AS (
          SELECT MAX(prediction_date) AS pred_date,
                 MAX(target_date) AS max_tgt
          FROM `{project}.{dataset}.{table}`
        )
        SELECT
          f.target_date AS snapshot_date,
          f.isbn13,
          f.store_id,
          f.predicted_demand,
          f.confidence_low,
          f.confidence_high,
          f.model_version
        FROM `{project}.{dataset}.{table}` f
        JOIN latest ON f.prediction_date = latest.pred_date
        WHERE f.target_date >= DATE_SUB(latest.max_tgt, INTERVAL @days DAY)
        ORDER BY f.target_date, f.store_id, f.isbn13
    """
    client = bigquery.Client(project=project, location=settings.bq_location)
    job_config = bigquery.QueryJobConfig(
        query_parameters=[bigquery.ScalarQueryParameter("days", "INT64", days)]
    )
    rows = list(client.query(query, job_config=job_config, location=settings.bq_location).result())
    log.info("BigQuery forecast refresh fetched %d rows", len(rows))
    return [dict(row) for row in rows]


def _upsert_forecast_rows(cur, rows: list[dict], synced_at: datetime) -> int:
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
    for row in rows:
        cur.execute(sql, (
            row["snapshot_date"], row["isbn13"], int(row["store_id"]),
            float(row["predicted_demand"]),
            float(row["confidence_low"]) if row.get("confidence_low") is not None else None,
            float(row["confidence_high"]) if row.get("confidence_high") is not None else None,
            str(row.get("model_version"))[:30] if row.get("model_version") is not None else None,
            synced_at,
        ))
    return len(rows)


def _check_forecast_store_scope(cur, ctx: AuthContext, store_id: int) -> None:
    """forecast 단건 조회 권한 (권한 매트릭스 · 2026-05-14).

    - hq-admin: 전권
    - wh-manager: scope_wh_id == locations.wh_id (store_id) 만
    - branch-clerk: scope_store_id == store_id 만

    Raises HTTPException 403 on violation.
    """
    if ctx.role == "hq-admin":
        return

    if ctx.role == "branch-clerk":
        if ctx.scope_store_id is None:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                                detail="branch-clerk scope_store_id 부재 (인증 토큰 손상)")
        if ctx.scope_store_id != store_id:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                                detail=f"자기 매장만 조회 가능 (scope_store_id={ctx.scope_store_id} · 요청 store_id={store_id})")
        return

    if ctx.role == "wh-manager":
        if ctx.scope_wh_id is None:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                                detail="wh-manager scope_wh_id 부재 (인증 토큰 손상)")
        cur.execute("SELECT wh_id FROM locations WHERE location_id = %s", (store_id,))
        row = cur.fetchone()
        if row is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND,
                                detail=f"store_id {store_id} locations 미존재")
        if row[0] != ctx.scope_wh_id:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                                detail=f"자기 권역만 조회 가능 (scope_wh_id={ctx.scope_wh_id} · store wh_id={row[0]})")
        return

    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                        detail=f"role '{ctx.role}' 는 forecast 조회 권한 없음")


def _forecast_scope_clause(ctx: AuthContext) -> tuple[str, list]:
    """role/scope → forecast_cache 용 SQL where 절 + params.

    - hq-admin: 빈 절
    - wh-manager + scope_wh_id: f.store_id 가 해당 wh 의 location 인 것만
    - branch-clerk + scope_store_id: f.store_id = scope_store_id

    Returns ("", []) 가 빈 절 (필터 없음).
    """
    if ctx.role == "wh-manager" and ctx.scope_wh_id is not None:
        return (
            "EXISTS (SELECT 1 FROM locations sl WHERE sl.location_id = f.store_id AND sl.wh_id = %s)",
            [ctx.scope_wh_id],
        )
    if ctx.role == "branch-clerk" and ctx.scope_store_id is not None:
        return ("f.store_id = %s", [ctx.scope_store_id])
    return ("", [])


@router.get("/{store_id}/{snapshot_date}", response_model=ForecastResponse)
def get_forecast(store_id: int, snapshot_date: date, ctx: AuthContext = Depends(require_auth)):
    sql = """
        SELECT snapshot_date, isbn13, store_id, predicted_demand,
               confidence_low, confidence_high, model_version, synced_at
          FROM forecast_cache
         WHERE store_id = %s AND snapshot_date = %s
         ORDER BY isbn13
    """
    with db_conn() as conn, conn.cursor() as cur:
        _check_forecast_store_scope(cur, ctx, store_id)
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
    ctx: AuthContext = Depends(require_auth),
):
    """P1-4b 시연 trigger: 안전재고 5일치 (predicted_demand × 5) > 가용재고 인 도서 list.

    매일 배치성 처리 가정 (사용자 결정 2026-05-13) — limit default 2000 = 전수 검사.
    안전재고 = 익일 forecast × 5 (forecast 는 권/일 단위 · 5일치를 안전선).
    suggested_qty = gap × 1.2 (min 30, max 500 · 5일치라 더 큰 발주 허용).

    권한 (2026-05-14 백엔드 필터 추가):
    - hq-admin: 전 매장
    - wh-manager + scope_wh_id: 자기 권역 store 만
    - branch-clerk + scope_store_id: 자기 매장만
    """
    # 시연 의도: '익일 (CURRENT_DATE + 1) 지점·물류센터별 수요예측 × 5 vs 현재 가용재고' 비교.
    # 출판사 발주는 매장 직접 X · WH 경유 (사용자 결정 2026-05-13) — recommend_target = store_id 의 WH location.
    scope_clause, scope_params = _forecast_scope_clause(ctx)
    scope_sql = f" AND {scope_clause}" if scope_clause else ""
    sql = f"""
        WITH target AS (
            SELECT MIN(snapshot_date) AS d FROM forecast_cache WHERE snapshot_date > CURRENT_DATE
        ),
        wh_loc AS (
            -- 권역별 WH location_id (location_type='WH')
            SELECT wh_id, location_id AS wh_location_id FROM locations WHERE location_type = 'WH'
        )
        SELECT f.isbn13, b.title, f.store_id,
               f.predicted_demand,
               COALESCE(SUM(GREATEST(i.on_hand - i.reserved_qty, 0)), 0)::int AS available,
               COALESCE(wh.wh_location_id, f.store_id) AS recommend_target
          FROM forecast_cache f
          LEFT JOIN books b ON b.isbn13 = f.isbn13
          LEFT JOIN inventory i ON i.isbn13 = f.isbn13 AND i.location_id = f.store_id
          LEFT JOIN locations sl ON sl.location_id = f.store_id
          LEFT JOIN wh_loc wh ON wh.wh_id = sl.wh_id
          CROSS JOIN target
         WHERE f.snapshot_date = target.d{scope_sql}
         GROUP BY f.isbn13, b.title, f.store_id, f.predicted_demand, wh.wh_location_id
        HAVING f.predicted_demand * 5 > COALESCE(SUM(GREATEST(i.on_hand - i.reserved_qty, 0)), 0)
         ORDER BY (f.predicted_demand * 5 - COALESCE(SUM(GREATEST(i.on_hand - i.reserved_qty, 0)), 0)) DESC
         LIMIT %s
    """
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, (*scope_params, limit))
        rows = cur.fetchall()
        cur.execute("SELECT MIN(snapshot_date) FROM forecast_cache WHERE snapshot_date > CURRENT_DATE")
        snapshot = cur.fetchone()[0]

    items: list[InsufficientStockItem] = []
    for r in rows:
        isbn13, title, store_id, pred, avail = r[0], r[1], r[2], float(r[3]), int(r[4])
        recommend_target = int(r[5])
        safety_5d = int(pred * 5)
        gap = max(0, safety_5d - avail)
        # gap × 1.2 buffer, min 30, max 500 (5일치 기준)
        suggested = max(30, min(500, int(gap * 1.2)))
        items.append(InsufficientStockItem(
            isbn13=isbn13, title=title, store_id=store_id,
            recommend_target_location_id=recommend_target,
            predicted_demand=pred, safety_stock_5days=safety_5d,
            available=avail, gap=gap, suggested_qty=suggested,
        ))

    return InsufficientStockResponse(snapshot_date=snapshot or date.today(), items=items)


def _trigger_plan_daily() -> None:
    """Fire-and-forget POST to decision-svc /decision/plan-daily after BQ refresh."""
    url = f"{settings.decision_svc_url}/decision/plan-daily"
    try:
        with httpx.Client(timeout=settings.decision_svc_timeout) as client:
            resp = client.post(url, json={}, headers={"Authorization": "Bearer mock-token-hq-admin"})
        if resp.status_code >= 400:
            log.warning("plan-daily trigger returned %s: %s", resp.status_code, resp.text[:200])
        else:
            log.info("plan-daily triggered via decision-svc: status=%s", resp.status_code)
    except Exception as exc:
        log.warning("plan-daily trigger failed (non-fatal): %s", exc)


@router.post("/refresh", response_model=RefreshResponse)
def refresh(req: RefreshRequest, ctx: AuthContext = Depends(require_auth)):
    """Bulk UPSERT (idempotent), or pull latest forecasts from BigQuery."""
    if ctx.role != "hq-admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="hq-admin only")

    source = "request"
    rows: list[dict]
    if req.items:
        rows = [it.model_dump() for it in req.items]
    else:
        source = "bigquery"
        rows = _fetch_bigquery_forecast_rows(req.days or settings.bq_refresh_days)

    now = datetime.now(timezone.utc)
    with db_conn() as conn:
        with conn.cursor() as cur:
            inserted = _upsert_forecast_rows(cur, rows, now)
        conn.commit()

    if source == "bigquery" and inserted > 0:
        _trigger_plan_daily()

    return RefreshResponse(
        snapshot_date=req.snapshot_date,
        store_id=req.store_id,
        inserted=inserted,
        source=source,
    )


# ──────────────────────────────────────────────────────────────────────────────
# 신간 편입 결정용 — VertexAI 수요예측 호출 (2026-05-15 사용자 결정)
#
# 흐름:
#   1) 출판사 신청 (new_book_requests PENDING) →
#   2) 본사가 이 endpoint 호출 → VertexAI Pipeline 으로 매장별/wh별 수요예측 받음 →
#   3) 결과를 보고 본사가 가치 판단 후 편입 결정 (/intervention/new-book-requests/{id}/approve)
#
# GCP integration:
#   - Existing-book D+1: BigQuery forecast_results -> RDS forecast_cache.
#   - New-book inference: forecast-svc -> GCP new-book-inference Cloud Function.
#   - Mock output is available only when FORECAST_ALLOW_MOCK_FALLBACK=true.
# ──────────────────────────────────────────────────────────────────────────────
import random as _rnd
from pydantic import BaseModel

class NewBookPredictReq(BaseModel):
    isbn13: str
    publisher_id: int | None = None
    category: str | None = None
    expected_price: int | None = None

class NewBookLocationPred(BaseModel):
    location_id: int
    location_name: str
    location_type: str  # 'STORE_OFFLINE' | 'STORE_ONLINE' | 'WH'
    wh_id: int | None
    predicted_demand_7d: float
    predicted_demand_30d: float
    confidence: float  # 0.0~1.0

class NewBookPredictResp(BaseModel):
    isbn13: str
    model_version: str
    predicted_at: str
    predictions: list[NewBookLocationPred]
    total_7d: float
    total_30d: float
    recommendation: str  # 'STRONG_BUY' | 'BUY' | 'NEUTRAL' | 'PASS'


def _recommendation(total_7d: float) -> str:
    if total_7d >= 800:
        return "STRONG_BUY"
    if total_7d >= 400:
        return "BUY"
    if total_7d >= 200:
        return "NEUTRAL"
    return "PASS"


def _load_active_locations() -> list[tuple[int, str, str, int | None]]:
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT location_id, name, location_type, wh_id "
            "FROM locations WHERE active = TRUE AND COALESCE(is_virtual, FALSE) = FALSE "
            "ORDER BY location_type, location_id"
        )
        return cur.fetchall()


def _call_gcp_new_book_inference(req: NewBookPredictReq) -> dict:
    if not settings.gcp_new_book_inference_url:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="FORECAST_GCP_NEW_BOOK_INFERENCE_URL is required for Vertex/new-book inference",
        )

    headers = {}
    if settings.gcp_function_bearer_token:
        headers["Authorization"] = f"Bearer {settings.gcp_function_bearer_token}"

    try:
        with httpx.Client(timeout=settings.gcp_http_timeout_seconds) as client:
            resp = client.post(
                settings.gcp_new_book_inference_url,
                json=req.model_dump(exclude_none=True),
                headers=headers,
            )
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPStatusError as exc:
        detail = exc.response.text[:500] if exc.response is not None else str(exc)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"GCP new-book inference failed: {detail}",
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"GCP new-book inference failed: {exc}",
        ) from exc

    if "error" in data:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"GCP new-book inference error: {data['error']}",
        )
    return data


def _build_vertex_instances(req: NewBookPredictReq) -> list[dict]:
    today = datetime.now(timezone.utc).date()
    category_id = 101
    if req.category:
        category_id = 100 + (abs(hash(req.category)) % 50)
    price = req.expected_price or 15000
    if price < 12000:
        price_tier = "LOW"
    elif price < 25000:
        price_tier = "MID"
    else:
        price_tier = "HIGH"

    instances = []
    for lid, name, ltype, wh_id in _load_active_locations():
        if ltype == "WH":
            continue
        channel = "online" if ltype == "STORE_ONLINE" else "offline"
        instances.append({
            "store_id": int(lid),
            "wh_id": int(wh_id or 1),
            "channel": channel,
            "location_type": ltype,
            "store_size": "M",
            "region": "WH1" if int(wh_id or 1) == 1 else "WH2",
            "on_hand": 0,
            "reserved_qty": 0,
            "safety_stock": 0,
            "holiday_flag": 0,
            "day_of_week": int(today.isoweekday() % 7 + 1),
            "month": int(today.month),
            "weekend_flag": 1 if today.weekday() >= 5 else 0,
            "event_nearby_days": 0,
            "sns_mentions_1d": 0,
            "sns_mentions_7d": 0,
            "book_age_days": 0,
            "days_since_last_stockout": 30,
            "category_id": category_id,
            "price_tier": price_tier,
            "sales_point": 0,
            "bestseller_flag": 0,
            "author_experience_years": 0,
            "qty_lag_1": 1,
            "qty_lag_7": 1,
            "qty_rolling_7d": 1,
            "qty_rolling_28d": 1,
            "demand_segment": "high",
        })
    return instances


def _call_gcp_vertex_new_book(req: NewBookPredictReq) -> NewBookPredictResp:
    if not settings.gcp_vertex_invoke_url:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="FORECAST_GCP_VERTEX_INVOKE_URL is required for Vertex endpoint inference",
        )

    headers = {}
    if settings.gcp_function_bearer_token:
        headers["Authorization"] = f"Bearer {settings.gcp_function_bearer_token}"

    loc_rows = [row for row in _load_active_locations() if row[2] != "WH"]
    instances = _build_vertex_instances(req)
    payload = {"instances": instances, "mode": "real"}
    try:
        with httpx.Client(timeout=settings.gcp_http_timeout_seconds) as client:
            resp = client.post(settings.gcp_vertex_invoke_url, json=payload, headers=headers)
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPStatusError as exc:
        detail = exc.response.text[:500] if exc.response is not None else str(exc)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"GCP Vertex endpoint inference failed: {detail}",
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"GCP Vertex endpoint inference failed: {exc}",
        ) from exc

    raw_predictions = data.get("predictions")
    if not isinstance(raw_predictions, list):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="GCP Vertex endpoint response missing predictions",
        )

    predictions: list[NewBookLocationPred] = []
    for row, pred in zip(loc_rows, raw_predictions):
        lid, name, ltype, wh_id = row
        daily = float((pred or {}).get("predicted_demand") or 0)
        low = float((pred or {}).get("confidence_low") or 0)
        high = float((pred or {}).get("confidence_high") or 0)
        confidence = 0.8
        if high > 0:
            confidence = max(0.5, min(0.95, 1 - ((high - low) / max(high, 1))))
        predictions.append(NewBookLocationPred(
            location_id=int(lid),
            location_name=name,
            location_type=ltype,
            wh_id=wh_id,
            predicted_demand_7d=round(daily * 7, 1),
            predicted_demand_30d=round(daily * 30, 1),
            confidence=round(confidence, 2),
        ))

    total_7d = sum(p.predicted_demand_7d for p in predictions)
    total_30d = sum(p.predicted_demand_30d for p in predictions)
    model_version = "vertex-endpoint-3223031419848622080"
    if raw_predictions and isinstance(raw_predictions[0], dict):
        model_version = raw_predictions[0].get("model_version") or model_version

    return NewBookPredictResp(
        isbn13=req.isbn13,
        model_version=model_version,
        predicted_at=datetime.now(timezone.utc).isoformat(),
        predictions=predictions,
        total_7d=round(total_7d, 1),
        total_30d=round(total_30d, 1),
        recommendation=_recommendation(total_7d),
    )


def _response_from_gcp_new_book(req: NewBookPredictReq, data: dict) -> NewBookPredictResp:
    lead_days = int(data.get("lead_days") or 30)
    model_version = str(data.get("model_version") or data.get("source") or "gcp-new-book-inference")
    wh_qty = {
        1: float(data.get("wh1_qty") or 0),
        2: float(data.get("wh2_qty") or 0),
    }
    wh_locations = {
        int(wh_id): (int(lid), name, ltype)
        for lid, name, ltype, wh_id in _load_active_locations()
        if ltype == "WH" and wh_id is not None
    }

    predictions: list[NewBookLocationPred] = []
    for wh_id, qty_30d in wh_qty.items():
        lid, name, ltype = wh_locations.get(wh_id, (wh_id, f"WH{wh_id}", "WH"))
        predictions.append(NewBookLocationPred(
            location_id=lid,
            location_name=name,
            location_type=ltype,
            wh_id=wh_id,
            predicted_demand_7d=round(qty_30d * 7 / lead_days, 1) if lead_days else 0,
            predicted_demand_30d=round(qty_30d, 1),
            confidence=float(data.get("confidence") or 0.8),
        ))

    total_7d = sum(p.predicted_demand_7d for p in predictions)
    total_30d = sum(p.predicted_demand_30d for p in predictions)
    return NewBookPredictResp(
        isbn13=req.isbn13,
        model_version=model_version,
        predicted_at=datetime.now(timezone.utc).isoformat(),
        predictions=predictions,
        total_7d=round(total_7d, 1),
        total_30d=round(total_30d, 1),
        recommendation=_recommendation(total_7d),
    )


def _call_vertex_sdk_direct(req: NewBookPredictReq) -> NewBookPredictResp:
    """Call Vertex AI private endpoint directly via SDK — VPN path, no Cloud Function proxy."""
    try:
        from google.cloud import aiplatform
    except ImportError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="google-cloud-aiplatform dependency is not installed",
        ) from exc

    project = settings.gcp_vertex_project_id or settings.bq_project_id
    if not project:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="FORECAST_GCP_VERTEX_PROJECT_ID (or FORECAST_BQ_PROJECT_ID) is required",
        )

    init_kwargs: dict = {"project": project, "location": settings.gcp_vertex_location}
    if settings.gcp_vertex_private_api_endpoint:
        init_kwargs["api_endpoint"] = settings.gcp_vertex_private_api_endpoint

    aiplatform.init(**init_kwargs)
    endpoint = aiplatform.Endpoint(endpoint_name=settings.gcp_vertex_endpoint_name)
    instances = _build_vertex_instances(req)
    try:
        prediction = endpoint.predict(instances=instances)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Vertex AI SDK prediction failed: {exc}",
        ) from exc

    raw_predictions = list(prediction.predictions)
    if not raw_predictions:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Vertex AI endpoint returned empty predictions",
        )

    loc_rows = [row for row in _load_active_locations() if row[2] != "WH"]
    predictions: list[NewBookLocationPred] = []
    for row, pred in zip(loc_rows, raw_predictions):
        lid, name, ltype, wh_id = row
        pred_dict = pred if isinstance(pred, dict) else {}
        daily = float(pred_dict.get("predicted_demand") or 0)
        low = float(pred_dict.get("confidence_low") or 0)
        high = float(pred_dict.get("confidence_high") or 0)
        confidence = 0.8
        if high > 0:
            confidence = max(0.5, min(0.95, 1 - ((high - low) / max(high, 1))))
        predictions.append(NewBookLocationPred(
            location_id=int(lid),
            location_name=name,
            location_type=ltype,
            wh_id=wh_id,
            predicted_demand_7d=round(daily * 7, 1),
            predicted_demand_30d=round(daily * 30, 1),
            confidence=round(confidence, 2),
        ))

    model_version = "vertex-sdk-direct"
    if raw_predictions and isinstance(raw_predictions[0], dict):
        model_version = raw_predictions[0].get("model_version") or model_version

    total_7d = sum(p.predicted_demand_7d for p in predictions)
    total_30d = sum(p.predicted_demand_30d for p in predictions)
    return NewBookPredictResp(
        isbn13=req.isbn13,
        model_version=model_version,
        predicted_at=datetime.now(timezone.utc).isoformat(),
        predictions=predictions,
        total_7d=round(total_7d, 1),
        total_30d=round(total_30d, 1),
        recommendation=_recommendation(total_7d),
    )


def _mock_new_book_response(req: NewBookPredictReq) -> NewBookPredictResp:
    import random as _rnd

    base_demand = 30 + (req.publisher_id or 1) % 50
    rng = _rnd.Random(hash(req.isbn13) & 0xFFFFFFFF)
    predictions: list[NewBookLocationPred] = []
    for lid, name, ltype, wh_id in _load_active_locations():
        if ltype == "WH":
            d7 = base_demand * 6 * rng.uniform(0.7, 1.3)
        elif ltype == "STORE_ONLINE":
            d7 = base_demand * rng.uniform(1.5, 2.5)
        else:
            d7 = base_demand * rng.uniform(0.6, 1.4)
        d30 = d7 * 4.2
        predictions.append(NewBookLocationPred(
            location_id=lid,
            location_name=name,
            location_type=ltype,
            wh_id=wh_id,
            predicted_demand_7d=round(d7, 1),
            predicted_demand_30d=round(d30, 1),
            confidence=round(rng.uniform(0.65, 0.92), 2),
        ))

    total_7d = sum(p.predicted_demand_7d for p in predictions if p.location_type != "WH")
    total_30d = sum(p.predicted_demand_30d for p in predictions if p.location_type != "WH")
    return NewBookPredictResp(
        isbn13=req.isbn13,
        model_version="mock-pending-gcp-vertexai-v0.1",
        predicted_at=datetime.now(timezone.utc).isoformat(),
        predictions=predictions,
        total_7d=round(total_7d, 1),
        total_30d=round(total_30d, 1),
        recommendation=_recommendation(total_7d),
    )


def _real_new_book_response(req: NewBookPredictReq) -> NewBookPredictResp:
    """실제 GCP/Vertex 경로 — Cloud Function/Vertex endpoint 우선순위로 호출.

    GCP 설정이 하나도 없으면 503 (mock fallback 없음 — real 경로는 fail closed).
    """
    if settings.gcp_vertex_endpoint_name:
        return _call_vertex_sdk_direct(req)

    if settings.gcp_vertex_invoke_url:
        return _call_gcp_vertex_new_book(req)

    if settings.gcp_new_book_inference_url:
        return _response_from_gcp_new_book(req, _call_gcp_new_book_inference(req))

    raise HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="GCP new-book inference is not configured (mock 모드를 사용하거나 GCP 설정을 확인하세요)",
    )


@router.post("/newbook/predict-demand", response_model=NewBookPredictResp)
def newbook_predict_demand(
    req: NewBookPredictReq,
    mode: str = "auto",
    ctx: AuthContext = Depends(require_auth),
):
    """신간 편입 결정용 매장별/wh별 7d/30d 수요예측. hq-admin only.

    mode 쿼리파라미터 (2026-05-19 — mock/real 명시 분리):
    - mock: 항상 동작하는 mock 예측 (GCP 연결 무관 · 평소 시연용).
    - real: 실제 GCP/Vertex 호출 — 미설정 시 503 (fallback 없음).
    - auto (default): GCP 설정 있으면 real · 없으면 allow_mock_fallback 에 따름 (기존 동작 유지).
    """
    if ctx.role != "hq-admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="hq-admin only (신간 편입 결정 권한)")

    mode = (mode or "auto").lower()
    if mode not in ("mock", "real", "auto"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"mode 는 mock|real|auto 중 하나여야 합니다 (받은 값: {mode})",
        )

    if mode == "mock":
        return _mock_new_book_response(req)

    if mode == "real":
        return _real_new_book_response(req)

    # mode == "auto" — GCP 설정 우선, 없으면 mock fallback (기존 동작)
    if settings.gcp_vertex_endpoint_name or settings.gcp_vertex_invoke_url or settings.gcp_new_book_inference_url:
        return _real_new_book_response(req)

    if not settings.allow_mock_fallback:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="GCP new-book inference is not configured and mock fallback is disabled",
        )
    return _mock_new_book_response(req)
