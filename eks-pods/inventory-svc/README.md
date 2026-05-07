# inventory-svc

V6.3 MSA Pod #6 · 재고 단일 쓰기 (single-writer) + 실시간 push.

## 책임
- `inventory` 테이블 모든 mutation (POS adjust · branch adjust · reservation)
- `reservations` 테이블 생성 (NORMAL/SPIKE/SOLD)
- Redis pub `stock.changed` (dashboard-bff WS broker subscribe)
- audit_log 자동 기록

## API
- `GET /current/{wh_id}` — 창고별 재고 조회 (wh-manager 권한 scope 검증)
- `POST /adjust` — 재고 +/- 조정 (audit + Redis pub)
- `POST /reserve` — 재고 임시 잠금 (TTL 기본 5min)
- `GET /health` — readiness + liveness

## 인증
- Phase 2: mock JWT (`Bearer mock-token-{role}`) — `auth.py::ROLE_USERS`
- Phase 4: real Entra OIDC verification (azure-entra-mock 가 RS256 발급, 같은 형식)

## 환경 변수 (`INVENTORY_` prefix)
- `RDS_HOST` `RDS_PORT` `RDS_DB` `RDS_USER` `RDS_PASSWORD`
- `REDIS_HOST` `REDIS_PORT`
- `AUTH_MODE` (mock | oidc)
- `LOG_LEVEL`

## V3 schema 의존
- `inventory(isbn13, location_id, on_hand, reserved_qty, safety_stock, updated_at, updated_by)`
- `reservations(reservation_id, isbn13, location_id, qty, reason, status, ttl, ...)`
- `audit_log` (write only)
- `locations` (read · wh_id 매핑)

## 빌드 + 배포
```bash
docker build -t bookflow/inventory-svc -f Dockerfile .
docker tag bookflow/inventory-svc $ECR_REGISTRY/bookflow/inventory-svc:latest
docker push $ECR_REGISTRY/bookflow/inventory-svc:latest

envsubst < k8s/configmap.yaml      | kubectl apply -f -
envsubst < k8s/externalsecret.yaml | kubectl apply -f -
envsubst < k8s/deployment.yaml     | kubectl apply -f -
envsubst < k8s/service.yaml        | kubectl apply -f -
```

CodePipeline (평일) 진입 시 buildspec 자동 발견 — 폴더명 = ECR repo + Service 이름 자동 매핑.
