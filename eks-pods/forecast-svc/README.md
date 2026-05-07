# forecast-svc

V6.3 MSA Pod #3 · AI 수요예측 D+1 캐시 + Vertex AI 후크.

## 책임
- `forecast_cache` 테이블 read/write (D+1만 RDS 보관 · D+2~5 BigQuery)
- Vertex AI Endpoint 호출 (Phase 4 — 현재는 stub)
- BQ → RDS 동기화 (Phase 4 — `kpi-sync` CronJob 가 분담 가능)

## API
- `GET /forecast/{store_id}/{snapshot_date}` — 매장별 D+1 예측 조회
- `POST /forecast/refresh` — bulk UPSERT (hq-admin only)
- `GET /health`

## V3 schema
- `forecast_cache(snapshot_date, isbn13, store_id, predicted_demand, confidence_low, confidence_high, model_version, synced_at)` PK (snapshot_date, isbn13, store_id)

## 환경변수 (`FORECAST_` prefix)
- `RDS_HOST` `RDS_PORT` `RDS_DB` `RDS_USER` `RDS_PASSWORD`
- `REDIS_HOST` `REDIS_PORT` `AUTH_MODE` `LOG_LEVEL`
