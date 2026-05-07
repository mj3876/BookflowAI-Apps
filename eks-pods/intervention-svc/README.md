# intervention-svc

V6.3 MSA Pod #5 · 승인 · 실행 단일 창구.

## 책임
- `pending_orders` PENDING 큐 → APPROVED/REJECTED 상태 전이
- `order_approvals` 테이블 INSERT (2-stage WH 이동: SOURCE/TARGET 양쪽 APPROVED 시 최종 APPROVED)
- `returns` PENDING → APPROVED (HQ 권한)
- `audit_log` 자동 기록

## API
- `GET /intervention/queue?limit=N` — PENDING 승인 대기 큐 (dashboard fan-in)
- `POST /intervention/approve` — `{order_id, approval_side, note?}` (SOURCE/TARGET/FINAL)
- `POST /intervention/reject` — `{order_id, approval_side, reject_reason}`
- `POST /intervention/returns/approve` — `{return_id, note?}` (hq-admin only)
- `GET /health`

## V3 schema
- `order_approvals(approval_id UUID, order_id, approver_id, approver_role, approver_wh_id, approval_side ENUM(SOURCE/TARGET/FINAL), decision ENUM(APPROVED/REJECTED), reject_reason)` UNIQUE(order_id, approval_side)
- `pending_orders` (read+update status)
- `returns` (update PENDING → APPROVED)
- `audit_log` (write only)

## 환경변수 (`INTERVENTION_` prefix)
- `RDS_HOST` `RDS_PORT` `RDS_DB` `RDS_USER` `RDS_PASSWORD`
- `REDIS_HOST` `REDIS_PORT` `AUTH_MODE` `LOG_LEVEL`

## 권한 행렬
- hq-admin: 모든 endpoint
- wh-manager: approve/reject (`approval_side` SOURCE/TARGET 자기 wh 만 — Phase 3 추가 검증)
- branch-clerk: 호출 불가 (403)
