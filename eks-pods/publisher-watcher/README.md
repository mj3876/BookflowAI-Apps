# publisher-watcher

V6.3 MSA #8 · **CronJob** (Pod 아님) · 출판사 신간 신청 폴러.

## 책임
- 매 1분 (`*/1 * * * *`) 출판사 API stub poll (`GET /new-book-requests`)
- 신규 ISBN 만 `new_book_requests` INSERT (status=NEW, ON CONFLICT DO NOTHING)
- Redis pub `newbook.request` → notification-svc 가 subscribe 해서 NewBookRequest 이벤트 발행
- `audit_log` 자동 기록 (actor_type='cronjob')

## 명세 차이 (Pod ↔ CronJob)
- 단발 실행 → exit. K8s CronJob 이 schedule 마다 새 Job 생성
- HTTP server 없음 (`/health` 없음). 검증은 `kubectl logs` + `kubectl get jobs`
- `concurrencyPolicy: Forbid` — 이전 폴링 끝나기 전에 다음 cron 시작 방지

## V3 schema
- `new_book_requests(id BIGSERIAL, isbn13, publisher_id, title, status, requested_at, ...)` UNIQUE(isbn13)
- `audit_log` (write)

## 환경변수 (`PUBWATCH_` prefix)
- `RDS_HOST` `RDS_PORT` `RDS_DB` `RDS_USER` (= `publish_watcher` role · V3 grants 명) `RDS_PASSWORD`
- `REDIS_HOST` `REDIS_PORT`
- `PUBLISHER_API_URL` (empty 면 no-op · Phase 4 = real 출판사 API URL via Egress NAT)
- `PUBLISHER_API_TIMEOUT_SECONDS`

## 검증
```bash
kubectl get cronjobs -n bookflow         # publisher-watcher 보임
kubectl get jobs -n bookflow             # 매 1분 새 Job 생성
kubectl logs -l app=publisher-watcher --tail=20 -n bookflow
```

## 알려진 명명 비대칭
- Pod 명 (k8s, V6.3 v2): `publisher-watcher`
- RDS role 명 (V3 시트10 grants 그대로): `publish_watcher` (under_score)
- 의도적 — RDS role 은 003_grants.sql 적용 시점 명명 그대로 보존, 변경하면 ALTER ROLE rename 필요
