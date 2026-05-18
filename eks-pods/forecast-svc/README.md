# forecast-svc

V6.3 MSA Pod #3: AI demand forecast cache + GCP inference bridge.

## Responsibilities

- Read/write `forecast_cache` for dashboard and decision-svc.
- `POST /forecast/refresh`: pull latest BigQuery `forecast_results` rows and UPSERT them into RDS, or accept explicit rows for manual/backfill refresh.
- `POST /forecast/newbook/predict-demand`: call the configured GCP `vertex-invoke` Cloud Function backed by Vertex model `3223031419848622080`, then return dashboard-compatible store/WH predictions.

## API

- `GET /forecast/{store_id}/{snapshot_date}`: store forecast lookup.
- `GET /forecast/insufficient-stock`: D+1 shortage candidates based on forecast safety stock.
- `POST /forecast/refresh`: hq-admin only BigQuery/RDS refresh.
- `POST /forecast/newbook/predict-demand`: hq-admin only new-book forecast request.
- `GET /health`

## Required Runtime Config

All values use the `FORECAST_` prefix.

- RDS/Redis: `RDS_HOST`, `RDS_PORT`, `RDS_DB`, `RDS_USER`, `RDS_PASSWORD`, `REDIS_HOST`, `REDIS_PORT`
- BigQuery refresh: `BQ_PROJECT_ID`, `BQ_DATASET_ID`, `BQ_FORECAST_TABLE`, `BQ_LOCATION`, `BQ_REFRESH_DAYS`
- New-book inference: `GCP_VERTEX_INVOKE_URL`, optional legacy `GCP_NEW_BOOK_INFERENCE_URL`, optional `GCP_FUNCTION_BEARER_TOKEN`
- Safety: `ALLOW_MOCK_FALLBACK=false` in production
