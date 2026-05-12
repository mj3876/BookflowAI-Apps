# Phase D · Daily UX 완성 + 시드 대량화 + 운영 정합화 Plan

> **baseline**: `PHASE_C_PLAN.md` (Phase C 92% 완료) + `ROLE_RESPONSIBILITY.md`
> **본질**: Phase C 의 "정합성+직관성" 위에 **사용자 실제 흐름** (daily task) 반영. 시연 fixture 16건 → 실 운영 mimic (1000권 × 7일). UX 충돌 3건 해소. 매일 destroy/redeploy 시 자동 정합.
> **작성**: 2026-05-12

---

## 카테고리

| 카테고리 | 내용 |
|---|---|
| **D0** | 운영 자동 정합화 (start-day idempotent · 매번 같은 문제 안 일어나게) |
| **D1** | UX 충돌 해소 (사용자 핵심 인사이트 3건) |
| **D2** | Daily Task UX (날짜별 그루핑 + scope 일괄 승인 + Home 3 페이지) |
| **D3** | 재고 책 단위 + Redis 실시간 push 활용 |
| **D4** | 시드 대량화 (1000권 × 7일 daily forecast · daily-generated PENDING) |
| **D5** | Phase C 잔여 (P1-3 P1-5 P1-6 P2-2 P2-4 P2-5) |

---

## D0 — 운영 자동 정합화 ⭐⭐ (오늘 fix 한 것 + 매일 자동)

### D0-1. configmap RDS_HOST 자동 정합 (오늘 stale 발견 → 7 pod fix)
- **현상**: Apps `*-env` configmap.yaml 의 `*_RDS_HOST` 가 hardcoded (이전 deploy 의 endpoint suffix). admin 매일 RDS 새로 만들 때 stale.
- **fix**:
  1. Apps repo 의 모든 `eks-pods/*/k8s/configmap.yaml` 의 `*_RDS_HOST` 값을 `${RDS_HOST}` envsubst pattern 으로 변경 (cicd-eks 도 buildspec 에서 RDS_HOST inject 추가 필요)
  2. `Platform/scripts/aws/tasks/eks_addons.py` 의 `_apply_with_subs` 에 `RDS_HOST` 동적 fetch 추가:
     ```python
     import boto3
     rds_host = boto3.client('rds').describe_db_instances(DBInstanceIdentifier='bookflow-postgres')['DBInstances'][0]['Endpoint']['Address']
     common_subs['RDS_HOST'] = rds_host
     ```
- **검증**: admin destroy/redeploy 후 7 pod 의 `printenv | grep RDS_HOST` 가 모두 새 endpoint
- **작업량**: S (Platform)

### D0-2. ALTER ROLE 후 6 pod auto-restart
- **현상**: `_sync_rds_pod_roles` 가 11 RDS role password 를 ALTER 하는데, pod 의 connection pool 은 startup 시점 password 캐시 → 매일 stale.
- **fix**: `eks_addons.py` `deploy()` 마지막에 `kubectl rollout restart deployment -l 'app in (auth-pod,dashboard-svc,decision-svc,forecast-svc,intervention-svc,inventory-svc,notification-svc)'` 추가
- **검증**: admin destroy/redeploy 후 7 pod 모두 5분 내 READY 1/1
- **작업량**: S (Platform)

### D0-3. Tier 00 secrets.yaml `jwt-signing-key` 추가 (오늘 추가됨)
- **현재**: admin 만 manual 추가됨. yaml 에는 어제 추가 commit 필요.
- **검증**: secrets.yaml stack update → admin/deploy 양쪽 jwt-signing-key 존재
- **작업량**: S (이미 yaml fix · commit 만)

### D0-4. eks_addons.py 의 envsubst + utf-8 stdin 정합 (오늘 fix)
- **현재**: 오늘 적용 완료. PR α 에 commit.
- **검증**: 7 pod manifest auto-apply · 한글 configmap (dashboard-svc) cp949 회피
- **작업량**: 완료

### D0-5. rds_seed.py · ansible rds-seed.yml column-aware (오늘 fix)
- **현재**: 양쪽 다 column-aware (csv header → DB column list). commit 만 남음.
- **검증**: users.csv (last_login_at 빠진 컬럼) seed 성공
- **작업량**: 완료

### D0-6. 🔥 POS 흐름 fix (2026-05-12 발견 · 시연 critical)
- **현상**: ECS online-sim → Kinesis `bookflow-pos-events` publish 안 됨.
  - Kinesis `IncomingRecords` 15분 = 0 Datapoints
  - pos-ingestor Lambda `Invocations` 15분 = 0 Datapoints · 마지막 호출 2026-05-07 (5일 전)
  - online-sim CW Log `Connect timeout on endpoint URL: ecs.ap-northeast-1.amazonaws.com`
- **진단 후보** (순서대로):
  1. ECS sim app.py 의 `kinesis.put_record` 코드 path 실제 실행 여부 (sim 로직 분기)
  2. ECS task IAM role 의 `kinesis:PutRecord` 권한
  3. sales-data VPC 의 Kinesis endpoint `PrivateDnsEnabled` 여부
  4. sim 코드가 `boto3.client('ecs')` 호출 (불필요 discovery) → endpoint 누락 timeout → 전체 sim hang
- **fix**: 원인 별
  - 코드 분기 문제 → ecs-sims/online-sim/app.py 수정 · cicd-ecs rebuild
  - IAM 누락 → ECS task role yaml 갱신 · CFN stack redeploy
  - VPC endpoint PrivateDns disabled → endpoints-sales-data.yaml fix · redeploy
- **검증**:
  - Kinesis `IncomingRecords` 5분 sum > 0
  - pos-ingestor `Invocations` 5분 sum > 0
  - sales_realtime row 가 `created_at > now() - interval '5 min'` 으로 증가
  - inventory `on_hand` 차감 + Redis `stock.changed` publish 흔적 (CW Log)
- **작업량**: M

---

## D1 — UX 충돌 해소 (사용자 핵심 인사이트 3건)

### D1-1. WhHome "처리 대기" ↔ "권역 간 이동" 데이터 겹침
- **현상**: WhHome 메인 카드 4종 (재분배 / 권역간 출고 / 권역간 입고 / 외부발주). "처리 대기" 와 "권역 간 이동" 카드 모두 WH_TRANSFER 포함하여 중복 카운트.
- **해결**: 카드 정의 명확화 — 권한 기반 분리
  - **"내 권역 단독 승인"** 카드 = REBALANCE (자기 권역) + PUBLISHER_ORDER (자기 권역 분배)
  - **"양측 협의 필요"** 카드 = WH_TRANSFER (출고 → 상대 권역 수락 대기 · 입고 → 내가 수락)
  - 둘이 disjoint · 합산 = 전체 PENDING
- **fix**: `WhHome.tsx` 카드 4 → 2 통합 (단독 승인 카드 vs 협의 카드) + 아래 D1-3 의 WhTransfer source/target tab 으로 detail
- **작업량**: S

### D1-2. 신간 지시서 워크플로 명확화
- **현상**: 본사가 신간 발주 결정 (Requests APPROVED) → 그 다음 매장별 분배 지시서가 어디로 가는지, 매장 매니저 화면에 어떻게 표시되는지 불명확.
- **워크플로 정의**:
  1. **HQ Requests** APPROVED → publisher-watcher 가 출판사 API 호출 (`/publisher/orders` POST)
  2. 출판사 응답 후 → `pending_orders` 에 PUBLISHER_ORDER + urgency=NEWBOOK INSERT (매장별 분배)
  3. **WhInstructions** "🆕 신간 분배 지시" 섹션 (urgency=NEWBOOK 필터 · 별도 색상 노란색 강조)
  4. 운송 EXECUTED 후 → **BranchInbound** "신간 입고 대기" (도서 표지 + 제목 + 분배 수량) → 검수/거부
  5. APPROVED 매장 inventory INSERT 로 신간 등록
- **fix**:
  - WhInstructions 의 NEWBOOK 섹션 이미 분리됨 (Task #42 completed) — 시연 가이드에 흐름 명시
  - BranchInbound 에 NEWBOOK 도서 별도 표시 (색상/아이콘 차별화) — 신규
  - 시연 시나리오 A (신간 추론) 가이드 md 에 chain 명시
- **작업량**: S (UI 마킹) + 시연 가이드

### D1-3. 권역 간 이동 source/target 매장 동일 list 헷갈림
- **현상**: WhTransfer 페이지에서 "내가 보낼 재고" 와 "받을 재고" row 가 같은 매장명 list 사용 → 어떤 게 출고/입고인지 헷갈림.
- **해결**: 2 tab 또는 2 column 분리
  - 📤 **출고 (내 권역 → 상대)** — `source_location_id` ∈ 내 권역 6 매장
  - 📥 **입고 (상대 → 내 권역)** — `target_location_id` ∈ 내 권역 6 매장
  - row 마다 "[내 권역 매장명] → [상대 권역 매장명]" 화살표 + 양쪽 매장명 한글 + 내 권역 매장명 파란색 강조
- **시각화 보강**: 권역 박스 다이어그램 (이미 일부 구현 · Task #41 의 WhTransfer rationale + 매장명 한글 · #76) — 폴리시 → 시드 정합 후 UI 확인
- **작업량**: S (이미 부분 구현 · 분리만)

### D1-3a. 🔴 WhTransfer 권역 분리 버그 + 물류센터 라벨 (2026-05-12 발견)
- **현상**: `WhTransfer.tsx` line 134-135
  ```typescript
  const inbound = transfers.filter((o) => o.target_location_id !== null);
  const outbound = transfers.filter((o) => o.source_location_id !== null);
  ```
  → WH_TRANSFER 의 source/target 은 둘 다 not-null 이라 **모든 row 가 양쪽 list 에 중복 표시**. wh_id 기준 권역 분리 X.
- **fix**:
  1. `useLocations` 또는 별도 hook 으로 `location_id → wh_id` 매핑 확보
  2. `outbound = transfers.filter(o => locWhId(o.source_location_id) === myWh)` (내 권역 매장이 출고측)
  3. `inbound = transfers.filter(o => locWhId(o.target_location_id) === myWh)` (내 권역 매장이 입고측)
  4. row 의 "출발 → 도착" cell 에 **권역 배지** 추가 — `[수도권 · 강남교보] → [영남 · 부산서면]` 형식
  5. `nameOf` 강화: `nameOf(locId) → "강남교보 (수도권)"` 또는 row 셀에 권역명 prefix
- **검증**: WhTransfer 진입 → outbound 와 inbound 가 disjoint (중복 0건) · 각 row 에 권역명 배지
- **작업량**: S

### D1-4. 🆕 매장 출처 UI (online 매장 = WH 본체 재고 출처 · Notion 1.1)
- **현재**: 백엔드 done — `inventory-svc /current` UNION ALL · `pos-ingestor` channel=ONLINE → WH 본체 차감
- **UI 미완**:
  1. `BranchInventory.tsx` — STORE_ONLINE location 진입 시 안내 메시지 ("권역 거점창고 재고에서 출하 — 실제 재고는 WH-{1,2} 본체")
  2. `HqInventory.tsx` — 매장별 분포 drilldown 에서 STORE_ONLINE row 에 ⓘ 아이콘 + tooltip
- **작업량**: S

### D1-5. 🆕 WH 타센터 재고 실시간 조회 (Notion 2.1 · 2단계 의사결정용)
- **현재**: `WhDashboard.tsx` 에 `otherOv` query 추가됨 · UI rendering 미완
- **fix**:
  1. WhDashboard 메인 카드 아래 "타 센터 재고 현황" 섹션 추가
  2. 타 센터 (WH 1↔2) 의 합계 재고 + 도서별 top-N 여유분 + 안전재고 표시
  3. row 클릭 → WhTransfer 페이지로 이동 (해당 ISBN 자동 발의 prefill)
- **작업량**: S

### D1-6. 🆕 신간 권역별 예측·수량 수정 (Notion 1.2)
- **현재**: `Requests.tsx` 가 단일 수량 input 만 · 권역별 split X
- **fix**:
  1. AI 권역별 예측 결과 표시 — WH-1 (수도권) / WH-2 (영남) 별 예상 수요
  2. 권역별 수량 input 2개 (총합 = 출판사 요청 수량 자동 검증)
  3. publisher-watcher 가 pending_orders INSERT 시 권역별 분리 (wh_id 별 row 2개)
- **작업량**: M

### D1-7. 🆕 양쪽 승인 발의자 추적 (Notion 2.3)
- **현재**: WhTransfer 가 "출고측이 먼저 발의" 가정만 · 실제 row 가 누가 발의 했는지 X
- **fix**:
  1. `pending_orders` 또는 `order_approvals` 에 `initiated_by_wh_id` 컬럼 (없으면 created_by user 의 wh_id 추출)
  2. WhTransfer row 에 "🟦 우리가 발의" / "🟧 상대 발의" 배지 표시
  3. inbound 중 "상대 발의 + 우리 수락 대기" 별도 강조 (red dot · 액션 필요)
- **작업량**: M

---

## D2 — Daily Task UX (batch monitor 메인 + 검토 필요 action 보조)

> **핵심 인사이트** (사용자 2026-05-12): V6.2 + 시트04 의 운영 흐름은 **batch CronJob 메인** · 사람은 검토 필요한 ~10-20건만 처리.

### 하루 batch 흐름

| 시각 | CronJob | 역할 | 시트04 |
|------|---------|------|--------|
| 00:00 | snapshot | inventory_snapshot_daily INSERT | — |
| 02:00 | forecast-batch | Vertex AI D+1 → forecast_cache | — |
| 03:30 | decision-cascade | Stage 1→2→3 자동 발의 (모든 PENDING 생성) | ① OrderPending |
| 03:30 | kpi-sync | BQ → kpi_daily MERGE | — |
| **07:00** | **intervention-auto-execute** | URGENT/CRITICAL + auto_execute_eligible 자동 승인 | ④ AutoExecutedUrgent |
| **18:00** | **intervention-auto-reject** | NORMAL 미처리 D-1 일괄 거절 | ⑤ AutoRejectedBatch |
| 매 1분 | publisher-watcher | 출판사 신간 폴링 | ⑨ NewBookRequest |

→ 09:00~18:00 사이 사용자가 처리할 것 = **검토 필요한 ~10-20건만**.

### D2-1. 백엔드 — batch 결과 reflect + 검토 action API

- **신규 endpoint** `GET /pending/grouped?date=YYYY-MM-DD` (dashboard-svc) — role-scope 자동
  ```json
  {
    "date": "2026-05-12",
    "auto_executed_at_07": 80,            // 07:00 batch 완료 건수
    "manual_review": 14,                  // 사용자가 처리해야 할 건수
    "auto_reject_at_18_pending": 28,      // 18:00 batch 예정 건수
    "by_type": {"REBALANCE": 5, "WH_TRANSFER": 6, "PUBLISHER_ORDER": 3},
    "items": [{order_id, isbn13, title, urgency, reason, created_at, ...}]
  }
  ```
- **신규 CronJob** `intervention-auto-reject` (18:00 KST · 기존 auto-execute pattern 복제)
  - 조건: `status=PENDING AND urgency='NORMAL' AND created_at < CURRENT_DATE - INTERVAL '1 day'`
  - 결과: bulk REJECT + audit_log + ⑤ AutoRejectedBatch notify
- **선택 보조 endpoint** `POST /pending/bulk-approve` (검토 보류분 일괄 재처리용 · 사람이 명시 클릭 시만)
- **작업량**: M

### D2-2. Home 3 페이지 — batch monitor 메인

**HqHome 메인 카드**:
```
┌─────────────────────────────────────────┐
│ 오늘 (2026-05-12) 처리 현황              │
│                                         │
│  ✅ 07:00 자동 승인 완료: 80건           │
│  📋 검토 필요: 14건 [➡ 처리하러 가기]    │
│  ⏰ 18:00 자동 거절 예정: 28건           │
│                                         │
│  📊 오늘 매출 ₩X / SNS 급등 N건         │
└─────────────────────────────────────────┘
```

- **HqHome / WhHome 재설계** (어제 stash 한 4 PENDING 카드 → batch monitor 메인)
  - 메인 = batch 결과 + "검토 필요 X건" CTA
  - secondary = 기존 4 카운트 카드 (drill-down)
- **BranchHome 신규**:
  - 메인: 오늘 입고 대기 (NEWBOOK 분배 / 권역간이동 도착) + 매장 부족 도서 top 5
  - 책 단위 표시 (D3 와 연계 · 표지 + 제목 + 가용/안전재고 + 색상)
- **main.tsx routing**: `/` → role 별 redirect
- **Layout NAV**: 첫 항목 "홈"
- **auth-pod/k8s/deployment.yaml** `namespace: bookflow` 명시 (오늘 발견 fix · 어제 stash 와 함께 commit)
- **작업량**: M (3 페이지 + Layout + routing)

### D2-3. 검토 action confirm + 결과 표시 (P1-6 ErrorResponse 표준 통합)

- 14건 처리 흐름: row 클릭 → 상세 → APPROVE/REJECT → `<ConfirmModal>` → 실행 → toast
- "검토 보류분 일괄 재처리" 보조 버튼 클릭 시만 `bulk-approve` 호출
- 실패 (일부) → ErrorResponse 표준 표시 (`{code, message, details: [{order_id, reason}]}`)
- `components/Toast.tsx` 신규 + `useActionMutation` hook (P1-6 와 통합)
- **작업량**: S

---

## D3 — 재고 화면 책 단위 + Redis 실시간 ⭐ (사용자 강조)

### D3-1. BranchInventory 책 단위 list (현재 location-level summary 폐기)
- 자기 매장 1000권 도서 list
  - 표지 (alad가 image_url) · 제목 · 저자 · 출판사 · 카테고리
  - 현재고 · 예약 · **가용** · 안전재고 · 임계 색상:
    - 가용 ≤ 안전재고: 🔴 적색 (긴급)
    - 가용 ≤ 2 × 안전재고: 🟡 황색 (주의)
    - 그 외: 🟢 녹색 (정상)
  - 검색 (제목/저자/ISBN) · 카테고리 필터 · sort (가용/판매량/제목)
- 도서 클릭 → 우측 상세 panel (수동조정 · 반품신청 · sales 추이)
- **작업량**: M

### D3-2. WhDashboard 권역 6 매장 × 책 heatmap
- 현재 매장-level summary → **책 단위 heatmap**
- column = 매장 (6 매장) · row = 도서 (top-N 부족 SKU 또는 사용자 필터)
- 셀 색상 = 가용재고 (적/황/녹)
- 셀 클릭 → 그 책 그 매장의 detail
- **작업량**: M

### D3-3. HqInventory 전사 도서별 + 매장 분포 drill-down
- 전사 12 매장 × 1000권 = 12,000 SKU 페이징
- 도서별 list (Books 페이지와 분리 · 재고 중심 view)
- 도서 클릭 → 12 매장 분포 (heatmap or bar)
- 검색/필터/sort 동일
- **작업량**: M

### D3-4. Redis 실시간 push 활용 (본래 목적)
- `stock:{isbn13}:{location_id}` Hash (5s TTL) + Pub/Sub `stock.changed` Channel — **이미 inventory-svc 의 /adjust /reserve 가 publish 중**
- **frontend WebSocket subscribe**: dashboard-svc 의 `/ws/stock` 채널 (이미 broker 있음)
- 화면 cell flash 애니메이션 (POS 결제·재고조정 발생 시 즉시 cell 색 변경)
- `useStockUpdates(isbn13_list)` hook 신규
- **작업량**: M (frontend WebSocket integration)

---

## D4 — 시드 대량화 (시연 fixture → 실 운영 mimic)

### D4-1. `generate.py` 진화
- `forecast_cache` 1000 (D+1 만) → **7d × 1000 = 7000 row** (D+0 ~ D+6 rolling)
  - 시나리오 B fixture 8 도서는 7일 모두 동일 패턴 (SHORT_PAIRS)
  - 일반 random fill 도 day 별
- `pending_orders` 16 fixture **유지** + `gen_pending_orders_daily(days=7, per_day=100)` 신규 **700 row 추가** = 총 **716 row**
  - urgency: NORMAL 60% / URGENT 30% / CRITICAL 10%
  - order_type: REBALANCE 50% / WH_TRANSFER 30% / PUBLISHER_ORDER 20%
  - status: PENDING 80% / APPROVED 15% / REJECTED 5%
  - auto_execute_eligible: URGENT/CRITICAL 만 (= 약 280 건)
  - created_at: D-7 ~ D-0 분포
- `inventory_snapshot_daily` 0 → 14d × 12000 = 168k (이미 ansible aggregate query 있음 · 동작 검증)
- `notifications_log` 50 → 350 (7일 × 50)
- `audit_log` 200 → 700 (7일 × 100)
- **작업량**: M

### D4-2. ECS sim daily-volume 정합
- 현 sim 이 매분 N건 sales_realtime INSERT → daily 1000권 시나리오 정합 검증
- 너무 적으면 N 늘리기 / 너무 많으면 줄이기
- **작업량**: S

---

## D5 — Phase C 잔여 (P1-3 P1-5 P1-6 P2-2 P2-4 P2-5)

### D5-1. P1-3 Branch 반품 신청 endpoint (M)
- `intervention-svc/src/routes/returns.py` 에 `POST /returns/request` (role=branch-clerk · scope 자기 매장)
- dashboard-svc proxy + api.ts wrapper
- BranchInbound (또는 BranchInventory) "반품 신청" 버튼

### D5-2. P1-5 R&R 문서 정정 (S · 문서만)
- `POST /intervention/reject` 명시
- 13번째 알림 `OrderExecuted` 시트04 추가
- `/decision/pending-orders` vs `/dashboard/pending` 중복 정리

### D5-3. P1-6 ErrorResponse 표준 (M · D2-3 와 통합)
- backend 공통 ErrorResponse pydantic (intervention-svc pilot)
- frontend `useActionMutation` hook + Toast.tsx 신규

### D5-4. P2-2 EmptyState 17 페이지 일괄 (M)
- KPI · Books · Decision · Approval · Returns · Requests · Spikes · Notifications · LiveEvents · WhDashboard · WhApprove · WhTransfer · WhInstructions · BranchInventory · BranchSales · Manual · Login

### D5-5. P2-4 workflow link (M)
- Decision (발의 완료) → "WH Approve 에서 승인 대기 중 (n건)" 링크
- Approval → "WH 출고 지시서 생성됨"
- WhTransfer → "EXECUTED → BranchInbound 큐"
- BranchInbound (수령 완료) → "재고 갱신됨"

### D5-6. P2-5 Spike → Decision pre-fill (S)
- `<Link to={`/decision?isbn=${isbn13}&urgency=CRITICAL`}>` + Decision.tsx useSearchParams

### D5-7. 🆕 WH AI 추천 수정 (수량/대상/시점 · Notion 2.6)
- **현재**: intervention-svc reject 만 부분 구현 · 수정 X
- **fix**:
  1. `intervention-svc PATCH /pending-orders/{id}` (role=wh-manager · 자기 권역 only)
     - 변경 가능: `qty` (수량 조정) · `target_location_id` (대상 매장 변경) · `scheduled_at` (시점 미루기)
     - 수정 후 audit_log INSERT + Redis publish
  2. WhApprove / WhInstructions row 의 [수정] 버튼 → 모달 (3 field input)
- **작업량**: M

### D5-8. 🆕 Branch → 본사/물류 의견 제출 채널 (Notion 3.5)
- **현재**: 미구현
- **fix**:
  1. `notification-svc POST /branch-feedback` (role=branch-clerk · 자기 매장)
     - body: `{type: 'SLOW_SELLER' | 'STOCK_REQUEST' | 'OTHER', isbn13?, message}`
     - notifications_log INSERT (event_type=BranchFeedback) + Logic Apps notify
  2. BranchInventory 도서별 [의견 제출] 버튼 + 모달
  3. HqHome / WhHome 알림 영역에 의견 표시
- **작업량**: M

### D5-9. 🆕 KPI 권역별(WH-1 vs WH-2) 비교 대시보드 (Notion 1.3)
- **현재**: KPI.tsx 가 전사 집계만
- **fix**:
  1. `dashboard-svc GET /kpi/by-wh?date=...` — 권역별 결품률/회전율/매출/반품률
  2. KPI.tsx 에 2 column 비교 카드 추가 (수도권 vs 영남 · 강세 장르 표시)
- **작업량**: S

---

## PR 묶음 전략 (재정비 2026-05-12 · Notion 갭 + POS fix 반영)

| # | PR | 레포 | 내용 | 작업량 | 상태 |
|---|---|---|---|---|---|
| **α** | Platform | D0-1~5 운영 정합 + D4 시드 진화 | configmap envsubst · RDS_HOST · auto-restart · jwt · utf-8 · column-aware · generate.py 7d · ECS sim 정합 | L | ✅ done |
| **β** | Apps | D2 일괄 승인 + Home 3 페이지 + D1-1/2/3 UX 충돌 | pending grouped + bulk-approve · HqHome/WhHome/BranchHome + routing · WhHome 카드 · 신간 마킹 · WhTransfer tab · auth-pod ns | L | 진행 중 |
| **γ** | Apps | D3 재고 책 단위 + Redis 실시간 | BranchInventory/WhDashboard/HqInventory 책 단위 · Redis WS flash | L | ✅ done |
| **🔥 P0** | Platform + Apps | **D0-6 POS 흐름 fix** | ECS sim → Kinesis publish 복구 · pos-ingestor Invocations 살리기 · sales_realtime 실시간 갱신 검증 | M | 🔲 진행 |
| **δ** | Apps | D5-1 + D5-3 + D1-3a + D1-4 + D1-5 + D1-7 (크게 묶음) | returns request · ErrorResponse · **WhTransfer 권역 버그 fix** · 매장 출처 UI · 타센터 재고 조회 · 발의자 추적 | L | 🔲 |
| **ε** | Apps | D5-4 + D5-5 + D5-6 + D5-2 + D5-7 + D5-8 + D5-9 + D1-6 (크게 묶음) | EmptyState 17 · workflow link · Spike pre-fill · R&R 문서 · WH AI 추천 수정 · Branch 의견 채널 · KPI 권역별 비교 · 신간 권역별 수량 | L | 🔲 |

각 PR 후 cicd 트리거 (deploy 계정 자동) + admin 로컬 build/apply → 시연 검증 → 다음.

### 시연일 (2026-06-02) 까지 3주 일정
- **Week 1 (05/12 ~ 05/18)**: 🔥 P0 (오늘) → PR δ (3일)
- **Week 2 (05/19 ~ 05/25)**: PR ε (4일) → 통합 검증 6 시나리오
- **Week 3 (05/26 ~ 06/01)**: 시연 리허설 + bug fix + 발표 자료

---

## 시연 시나리오 (5종 · D2-2 Home 페이지 진화 후 시연 흐름)

| 시나리오 | Home 진입 → 흐름 |
|---|---|
| **A. 신간 추론** | HQ Home "신간 편입 대기 24건" → Requests → APPROVE → WH Home "신간 분배 지시 24건" → WhInstructions → EXECUTED → Branch Home "신간 입고 24건" → BranchInbound |
| **B. 재고 부족** | HQ Home "오늘 124건 · 자동 80건" → 일괄 승인 → cascade (REBALANCE → WH_TRANSFER → PUBLISHER_ORDER + EOQ) |
| **C. 권역 이동** | WH Home "권역 간 협의 8건" → WhTransfer 📤 출고 4 / 📥 입고 4 → 상대 권역과 양측 승인 |
| **D. 매장 조정** | Branch Home "내 매장 부족 4권" → BranchInventory 책 단위 → 도서 클릭 → Manual /adjust |
| **E. SNS 급등** | HQ Home "🔥 SNS 급등 3건" → Spikes → Decision pre-fill → URGENT 자동 승인 → 즉시 cascade |

---

## 검증 (각 PR 후)

### PR α 검증
- admin destroy/redeploy → 7 pod 모두 5분 내 READY
- 7 pod ENV `RDS_HOST` = admin RDS endpoint
- RDS row count: pending_orders 716 · forecast_cache 7000 · inventory_snapshot 168k

### PR β 검증
- `GET /pending/grouped?date=...` role 별 응답
- `POST /pending/bulk-approve` audit_log 생성 + 결과 toast
- HqHome / WhHome / BranchHome 진입 → 메인 카드 정상

### PR γ 검증
- BranchInventory 1000권 list 페이징 + 색상
- WhDashboard heatmap cell click
- inventory-svc /adjust 호출 시 화면 cell flash 애니메이션

### PR δ 검증
- BranchInbound 반품 신청 → returns 테이블 INSERT · HQ Returns 큐 표시
- ErrorResponse 표준 (권한 없음 / 비즈니스 룰 / 일시 오류)

### PR ε 검증
- 모든 페이지 빈 상태 EmptyState 표시
- workflow link 다음 단계 이동
- Spikes → Decision pre-fill

---

## 메모리 (다음 세션 참고)

- `feedback_admin_no_github_cicd` — admin 엔 cicd 없음 · 모든 build/apply 로컬
- `project_authority_clarifications_2026_05_03` — 권한 매트릭스
- `feedback_destroy_redeploy_idempotent` — 매일 destroy/redeploy 자동 재현 · 매뉴얼 X
- `reference_canonical_bookflow_docs` — V6.2 PPT + WBS V4 + Schema v3 정본

## Phase D 범위 밖
- 시트 04 누락 알림 6개 (CronJob/Lambda/외부) — Phase E
- LiveEvents WebSocket 4채널 (D3-4 이외) — Phase E
- forecast-svc D+2~5 BQ proxy — Phase E
- 실 시연 후 Phase F: 12 매장 × 1000권 × 매일 수천 건 PENDING 의 운영 자동 승인 정책 (사용자 강조 · memory `project_real_scale_auto_approval`)
