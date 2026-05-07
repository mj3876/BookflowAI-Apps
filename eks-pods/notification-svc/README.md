# notification-svc

V6.3 MSA Pod #7 · 알림 채널 연결지점 · 12 Logic Apps 이벤트 dispatcher.

## 책임
- `notifications_log` INSERT (PENDING) → SENT/FAILED 상태 전이
- Azure Logic Apps webhook 호출 (event_type 별 workflow URL)
- Redis pub: event_type 별 채널 분기 (`stock.changed` · `order.pending` · `spike.detected` · `newbook.request`)
- `audit_log` 자동 기록

## 12 Logic Apps 이벤트 (V3 시트06)
1. OrderPending · 2. OrderApproved · 3. OrderRejected
4. AutoExecutedUrgent · 5. AutoRejectedBatch
6. SpikeUrgent (CRITICAL · SMS 포함)
7. StockDepartPending · 8. StockArrivalPending
9. NewBookRequest
10. ReturnPending
11. LambdaAlarm · 12. DeploymentRollback

## API
- `POST /notification/send` — `{event_type, severity, recipients, payload, correlation_id?}` → Logic Apps + Redis pub + RDS log
- `GET /notification/recent?limit=N` — 최근 알림 (dashboard fan-in)
- `GET /health`

## V3 schema
- `notifications_log(notification_id UUID, event_type, severity, status, correlation_id, payload jsonb, created_at, sent_at)`
- `audit_log` (write)

## 환경변수 (`NOTIFICATION_` prefix)
- `RDS_HOST` `RDS_PORT` `RDS_DB` `RDS_USER` `RDS_PASSWORD`
- `REDIS_HOST` `REDIS_PORT`
- `LOGIC_APPS_URL` (Phase 2-3 = `http://azure-logic-apps-mock.stubs.svc.cluster.local`, Phase 4 = real Azure URL)
- `LOGIC_APPS_TIMEOUT_SECONDS`
- `AUTH_MODE` `LOG_LEVEL`

## Phase 4 swap
Logic Apps URL env 1줄만 갈아끼면 mock → real Azure 전환. NAT (Egress VPC) 통해 outbound 가능 여부 확인 필요.
