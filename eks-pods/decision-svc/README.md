# decision-svc

V6.3 MSA Pod #4 · 3단계 의사결정 (재분배 → 권역이동 → EOQ 발주).

## 책임
- `pending_orders` 테이블 INSERT/UPDATE (단일 큐 — 모든 발주/이동 의사결정)
- Redis publish `order.pending` (notification-svc fan-out)
- forecast-svc + inventory-svc 데이터 조합한 의사결정 로직 (Phase 3 본 구현)
- audit_log 자동 기록

## API
- `POST /decision/decide` — 의사결정 1건 생성 (hq-admin · wh-manager)
- `GET /decision/pending-orders` — PENDING 큐 조회 (urgency desc)
- `GET /health`

## V3 schema
- `pending_orders(order_id UUID, order_type, isbn13, source/target_location_id, qty, urgency_level, auto_execute_eligible, status, ...)`
- `audit_log` (write only)
- `inventory` `forecast_cache` (read · Phase 3 logic 입력)

## 환경변수 (`DECISION_` prefix)
- `RDS_HOST` `RDS_PORT` `RDS_DB` `RDS_USER` `RDS_PASSWORD`
- `REDIS_HOST` `REDIS_PORT` `AUTH_MODE` `LOG_LEVEL`

## Phase 2 / 3 / 4
- Phase 2 (현재): 1건 만들기 + 조회 stub
- Phase 3: 3단계 알고리즘 (재분배 → WH 이동 → EOQ) + auto-execute logic
- Phase 4: GCP Vertex AI Endpoint 호출 + 신뢰도 기반 auto/manual 분기
