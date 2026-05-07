# BookFlow 역할 × 책임 매트릭스 (R&R)

> **출처**: V6.2 PPT 슬라이드 30 + V6 Data Schema (시트 04 알림/Redis · 시트 11 Vertex AI) + WBS V4 (10.10 SPA 3종) + FR-A1~A11 명세 + 어제 백엔드/프론트엔드 audit + AAA_변경사항_노트.md
> **목적**: 어플리케이션 완성형 작업의 base. 모든 SPA 페이지/홈/사이드바/workflow link 가 이 매트릭스에서 파생.
> **작성일**: 2026-05-07 · 작성자: 영헌

---

## 0. 사용자 역할 3종 + 1 admin

| 역할 | DB role | scope | 매장/권역 |
|---|---|---|---|
| **HQ 본사 관리자** | `hq-admin` | 전사 (전체) | scope_wh_id=NULL · scope_store_id=NULL |
| **WH 창고 매니저 (수도권)** | `wh-manager` | 수도권 권역 | scope_wh_id=1 · scope_store_id=NULL |
| **WH 창고 매니저 (영남)** | `wh-manager` | 영남 권역 | scope_wh_id=2 · scope_store_id=NULL |
| **Branch 지점 직원** | `branch-clerk` | 자기 매장 | scope_wh_id=NULL · scope_store_id=1~12 |

**권한 검증**: auth-pod 가 Entra OIDC group GUID → role 매핑 + JWT 발급 → 7 Pod 가 dual-mode (mock-token-* 또는 JWT) verify + scope check.

---

## 1. HQ 본사 관리자

### 1.1 모니터링 (무엇을 보는가)

| 영역 | 데이터 source | 부르는 endpoint | 페이지 |
|---|---|---|---|
| 전사 KPI (매출/거래/PENDING/Pod 상태) | sales_realtime · pending_orders · health checks | `/dashboard/sales-summary` · `/dashboard/overview/{wh_id}` | KPI |
| 매장별 매출 비교 | sales_realtime aggregate | `/dashboard/sales-by-store` | KPI |
| 매장별 매출 상세 | sales_realtime by store | `/dashboard/sales-by-store/{store_id}` | KPI 드릴다운 |
| 전사 재고 히트맵 (12 location) | inventory + locations | `/dashboard/locations/heatmap` | Inventory |
| 매장별 재고 상세 | inventory by location | `/dashboard/store-inventory/{store_id}` | Inventory 드릴다운 |
| 도서 카탈로그 (1000권 + cover) | books | `/dashboard/books?q=&status=&category=` | Books |
| 도서 카테고리 distinct | books group | `/dashboard/books/categories` | Books 필터 |
| 도서 변경 이력 | audit_log | `/dashboard/books/{isbn13}/audit` | Books 모달 |
| 신간 신청 큐 | new_book_requests | `/dashboard/new-book-requests` | Requests |
| 신간 권역 분배 추천 | sales_realtime category aggregate | `/dashboard/new-book-requests/{request_id}/forecast-hint` | Requests 우측 패널 |
| 반품 큐 | returns | `/dashboard/returns` | Returns |
| SNS 급등 도서 (24h) | spike_events | `/dashboard/spike-events` | Spikes |
| PENDING 의사결정 큐 (전사) | pending_orders | `/dashboard/pending` | Decision · Approval |
| 12 알림 이벤트 | notifications_log | `/dashboard/notifications` | Notifications |
| 실시간 트랜잭션 | sales_realtime · Redis stock.changed | `/ws/live-events` (Phase 3) · `/dashboard/recent-sales` | LiveEvents |

### 1.2 액션 (무엇을 결정/실행하는가)

| 액션 | 부르는 endpoint | 페이지 | FR | 비고 |
|---|---|---|---|---|
| **의사결정 발의** (3-stage cascade) | `POST /decision/decide` (or `/dashboard/decide` 프록시) | Decision | FR-A4.1 / A4.7 / A5.1 / A5.3 | ISBN/도착지/수량 → Stage 1 REBALANCE → Stage 2 WH_TRANSFER → Stage 3 PUBLISHER_ORDER + EOQ |
| **Stage 3 외부발주 단독 최종 승인** | `POST /intervention/approve` | Approval | FR-A4.5 / A4.6 / FR-A6.6 | PUBLISHER_ORDER 의 FINAL · 비용 발생 → 본사만 |
| **신간 편입 결정** | `POST /intervention/new-book-requests/{id}/approve` | Requests | FR-A4.8 / A11.1 | 권역 분배 (wh1·wh2 수량) + pending_orders 자동 생성 |
| **신간 거절** | `POST /intervention/new-book-requests/{id}/reject` | Requests | FR-A4.8 | new_book_requests.status=REJECTED |
| **도서 ON/OFF + 소진 모드** | `POST /intervention/books/{isbn13}/status` | Books | FR-A6.1 / A6.2 | NORMAL / SOFT_DISCONTINUE / INACTIVE → discontinue_mode + audit_log |
| **반품 승인** | `POST /intervention/returns/approve` | Returns | FR-A6.8 | returns.hq_approved_at + status=APPROVED |
| **반품 거부** | `POST /intervention/returns/reject` | Returns | FR-A6.8 | rejected_at + reject_reason |

### 1.3 제공 (다른 역할에 무엇을 주는가)

| 산출물 | 받는 역할 | 매개 | 트리거 |
|---|---|---|---|
| pending_orders (PENDING) | WH (Stage 1/2 승인 대기) · Branch (Stage 1 입고 지시 시 EXECUTED) | RDS pending_orders | 의사결정 발의 직후 |
| books 마스터 변경 | 모든 역할 | RDS books · audit_log | 도서 ON/OFF |
| new_book_requests APPROVED | WH (출고 지시 + 입고 지시) | RDS pending_orders 자동 생성 | 신간 편입 결정 |
| 반품 결정 | WH (실제 출고 처리) · Branch (반품 결과 알림) | RDS returns + notifications_log | 반품 승인/거부 |

### 1.4 페이지 매핑 (현재 + 신규)

| 페이지 | 역할 | 비고 |
|---|---|---|
| 🆕 **HQ Home** (신규) | 진입 | "오늘의 할일" PENDING 카운트 + 핵심 메트릭 5개 + 다음 액션 링크 |
| KPI | 모니터링 (전사) | 메트릭 카드 + 매장별 차트 + 최근 트랜잭션 |
| Books | 모니터링 + 액션 (마스터 컨트롤) | 1000권 검색/필터/cover · ON/OFF 변경 |
| Inventory | 모니터링 (전사 재고) | 14 location heatmap + 드릴다운 + 급등 |
| Requests | 모니터링 + 액션 | 신간 신청 → 편입 결정 (분배 추천) |
| Decision | 액션 (의사결정 발의) | ISBN/매장/수량 → cascade |
| Approval | 액션 (Stage 3 단독 승인) | PUBLISHER_ORDER 큐 + 승인/거절 |
| Returns | 모니터링 + 액션 | 반품 큐 + 승인/거부 |
| Spikes | 모니터링 → 액션 연계 | SNS 급등 → Decision pre-fill |
| LiveEvents | 모니터링 (실시간) | WebSocket 4채널 |
| Notifications | 모니터링 (12 이벤트) | notifications_log 조회 |

---

## 2. WH 창고 매니저 (수도권 wh_id=1 / 영남 wh_id=2)

### 2.1 모니터링

| 영역 | 데이터 source | endpoint | 페이지 |
|---|---|---|---|
| 권역 매출 + 재고 메트릭 | sales_realtime + inventory by wh | `/dashboard/overview/{wh_id}` (자기 wh) | WhDashboard |
| 권역 매장별 매출 | sales_realtime by wh | `/dashboard/sales-by-store?wh_id=` | WhDashboard |
| 권역 재고 히트맵 | inventory by wh's locations | `/dashboard/locations/heatmap?wh_id=` | WhDashboard |
| 자기 권역 PENDING 큐 | pending_orders + order_approvals | `/intervention/queue?wh_id=` (자동 필터) | WhApprove |
| Stage 2 SOURCE/TARGET 큐 (양측) | pending_orders status + approval_side | `/intervention/queue?order_type=WH_TRANSFER` | WhTransfer |
| 출고/입고 지시서 | pending_orders APPROVED/EXECUTED | `/dashboard/instructions?wh_id=` | WhInstructions (신간 + 일반 분리) |

### 2.2 액션

| 액션 | endpoint | 페이지 | FR |
|---|---|---|---|
| **Stage 1 REBALANCE FINAL** 단일 승인 | `POST /intervention/approve` | WhApprove | FR-A6.6 · 자기 wh 의 location 간 재분배 |
| **Stage 2 WH_TRANSFER SOURCE/TARGET** 양측 승인 | `POST /intervention/approve` (각 측 매니저) | WhTransfer | FR-A5.3 · 양쪽 APPROVED 시 자동 EXECUTED |
| **Stage 3 PUBLISHER_ORDER FINAL** 자기 권역 | `POST /intervention/approve` | WhApprove | FR-A4.5 · 외부발주 자기 권역분 |
| **거부** | `POST /intervention/reject` | WhApprove · WhTransfer | reject_count 증가 → 누적 2회 시 자동 종결 |
| **출고 처리** (status=EXECUTED) | (intervention-svc 자동, 양측 승인 후) | WhInstructions | inventory 출고 |

### 2.3 제공

| 산출물 | 받는 역할 | 매개 |
|---|---|---|
| order_approvals (자기 wh 승인) | intervention-svc → 다음 단계 처리 | RDS order_approvals |
| 출고 → 매장 입고 | Branch (입고 수령 대기) | RDS pending_orders status=APPROVED → BranchInbound 큐 |

### 2.4 페이지 매핑

| 페이지 | 역할 |
|---|---|
| 🆕 **WH Home** (신규) | 진입 — 권역 한눈에 + PENDING 카운트 (rebalance/transfer source/transfer target/publisher) + 출고 지시 |
| WhDashboard | 모니터링 (권역) |
| WhApprove | 액션 (Stage 1·3 단독) |
| WhTransfer | 액션 (Stage 2 양측) |
| WhInstructions | 모니터링 (출고/입고 지시 — 신간 + 일반) |

---

## 3. Branch 지점 직원 (매장 location_id 1~12)

### 3.1 모니터링

| 영역 | 데이터 source | endpoint | 페이지 |
|---|---|---|---|
| 매장 재고 + 부족 알림 | inventory by store_id (자기 매장) | `/dashboard/store-inventory/{store_id}` | BranchInventory |
| 매장 매출 (POS 트랜잭션) | sales_realtime by store_id | `/dashboard/sales-by-store/{store_id}` | BranchSales |
| 매장 입고 대기 | pending_orders APPROVED for this store | `/dashboard/instructions?store_id=` | BranchInbound |
| 매장 진열 추천 (24h SNS 급등 + 매장 재고) | spike_events JOIN inventory | `/dashboard/curation/{store_id}` | BranchCuration |

### 3.2 액션

| 액션 | endpoint | 페이지 | FR |
|---|---|---|---|
| **입고 수령** (status=EXECUTED) | `POST /intervention/inbound/{order_id}/receive` (→ inventory-svc /adjust on_hand 증가) | BranchInbound | FR-A6.6 · single writer |
| **입고 거부** (수량 불일치/파손/누락) | `POST /intervention/inbound/{order_id}/reject` (with reason) → notification 물류센터 | BranchInbound | FR-A6.6 |
| **재고 수동 조정** (파손/분실 등) | `POST /inventory/adjust` (delta + reason) | Manual | FR-A6.6 · audit_log 기록 |
| **반품 신청** | `POST /returns/request` (returns INSERT status=REQUESTED) | BranchInbound 또는 별도 | HQ Returns 큐 진입 |
| **진열 결정 마킹** (선택) | (Phase 2 — audit_log 또는 localStorage) | BranchCuration | UX 보조 |
| **입고 요청 발의** (재고 부족 시) | `POST /notification/send` (event=StockArrivalPending → WH) | BranchCuration | FR-A8 (시트04 ⑧) |

### 3.3 제공

| 산출물 | 받는 역할 | 매개 |
|---|---|---|
| 입고 receipt | inventory-svc → on_hand 갱신 | RDS inventory |
| 거부 사유 | WH (notification) | notifications_log + Logic Apps |
| 반품 신청 | HQ Returns 큐 | RDS returns |
| 재고 수동 조정 | 본사 audit_log | RDS audit_log |
| 입고 요청 알림 | WH | notifications_log + Redis |

### 3.4 페이지 매핑

| 페이지 | 역할 |
|---|---|
| 🆕 **Branch Home** (신규) | 진입 — 매장 한눈에 + 오늘 입고 + 진열 추천 top 5 + 부족 SKU |
| BranchInventory | 모니터링 (매장 재고) |
| BranchInbound | 액션 (수령/거부) |
| BranchSales | 모니터링 (매출) |
| BranchCuration | 모니터링 + 액션 (진열 + 입고 요청) |
| Manual | 액션 (재고 수동 조정) |

---

## 4. 공통 (모든 역할)

| 페이지 | 역할 | 권한별 |
|---|---|---|
| Login | 인증 진입 | Entra OIDC + mock 버튼 (4 role) |
| Notifications | 본인 권한 범위 알림 | role 별 필터 |
| Manual | 도움말 (WH/Branch 만 — 재고 수동 조정) | wh-manager · branch-clerk |
| Logout | 세션 종료 | 모두 |

---

## 5. 역할 간 워크플로우 (5 시나리오 · .pen 정합)

### A. 신간 추론 + 편입 (.pen A-1~A-5)

```
[publisher API] (외부 출판사)
   ↓ 폴 (1분)
[publisher-watcher CronJob] → new_book_requests INSERT (status=NEW · source=PUBLISHER_REQ) + Redis pub `newbook.request`
   ↓
[notification-svc] event=⑨NewBookRequest → HQ Notifications · 알림
   ↓
🏢 [HQ Requests] 검토 → 편입 결정 (수도권/영남 분배 수량 입력 · forecast-hint 60/40 fallback)
   ↓ POST /intervention/new-book-requests/{id}/approve
[intervention-svc] → pending_orders 자동 생성 (각 wh 별 · order_type=PUBLISHER_ORDER · auto_execute_eligible 기본 false)
   ↓ + notification ②OrderApproved
🏭 [WH Approval] → Stage 3 자기 권역 승인
   ↓ status=APPROVED
[WH 출고 처리] → status=EXECUTED → BranchInbound 큐 진입
   ↓
🏪 [Branch Inbound] 수령 → inventory.on_hand += qty (single writer inventory-svc)
   ↓ Redis pub `stock.changed`
[Live Events] WebSocket → 모든 역할 실시간 표시
```

### B. 재고 부족 → 발주 (.pen B-1~B-3 · 일반 cascade)

```
🏢 [HQ Decision] 발의 (ISBN · 매장 · 수량 · urgency)
   ↓ POST /decision/decide
[decision-svc] cascade:
   1. Stage 1 REBALANCE: 같은 wh 의 다른 location 효용재고 ≥ qty? → YES → pending_orders order_type=REBALANCE
   2. NO → Stage 2 WH_TRANSFER: 타 wh surplus ≥ qty? → YES → pending_orders order_type=WH_TRANSFER (approval_side=SOURCE/TARGET)
   3. NO → Stage 3 PUBLISHER_ORDER: 외부 발주 + EOQ 계산 → pending_orders order_type=PUBLISHER_ORDER + auto_execute_eligible (URGENT/CRITICAL 시)
   ↓ + notification ①OrderPending
🏭 Stage 1: [WH Approve] (자기 wh) 단일 승인
🏭 Stage 2: [WH Transfer] 양측 (수도권 SOURCE + 영남 TARGET) → 양쪽 APPROVED 시 자동 EXECUTED
🏢 Stage 3: [HQ Approval] + WH FINAL (자기 권역분)
   ↓ EXECUTED → BranchInbound 큐
🏪 [Branch Inbound] 수령
```

**자동 발주** (urgency=URGENT/CRITICAL 의 Stage 3): 07:00 KST CronJob `intervention-auto-execute` 가 자동 승인 → notification ④AutoExecutedUrgent

### C. 권역 이동 (.pen C-1~C-4 · 양측 승인)

```
🏢 [HQ Decision] Stage 2 발의 (or cascade 자동)
   ↓ pending_orders order_type=WH_TRANSFER · approval_side=SOURCE/TARGET 두 row 생성
🏭 [수도권 WH (SOURCE)] /intervention/approve (자기 wh = SOURCE wh)
🏭 [영남 WH (TARGET)] /intervention/approve (자기 wh = TARGET wh)
   ↓ 양측 APPROVED 시 intervention-svc 자동 status=EXECUTED
[SOURCE WH 출고] → 운송 (BookFlow 범위 밖) → [TARGET WH 입고]
   ↓ inventory location 이전 (single writer)
   ↓ Redis pub `stock.changed`
```

### D. 지점 재고 조회/조정 (.pen D-1~D-3 · Branch ad-hoc)

```
🏪 [Branch Inventory] 매장 SKU 확인 (자기 매장 scope)
   파손/분실/오차 발견
🏪 [Branch Manual] 수동 조정 (delta · reason='파손'/'분실' 등)
   ↓ POST /inventory/adjust
[inventory-svc] inventory UPDATE + audit_log INSERT (action='inventory.adjust' · before/after JSONB)
   ↓ Redis pub `stock.changed`
[HQ KPI] 본사 audit 추적 (감사 + 패턴 분석)
```

### E. SNS 급등 → 자동 발주 (.pen E-2 · 실시간)

```
[external SNS 데이터] (트위터/카페/뉴스 등)
   ↓
[spike-detect Lambda] (10분 cron) → z-score 계산 → spike_events INSERT (z_score · mentions_count) + Redis pub `spike.detected`
   ↓
[notification-svc] event=⑥SpikeUrgent (CRITICAL 이상 SMS)
   ↓
🏢 [HQ Spikes] 페이지 표시 → 클릭 → [HQ Decision] pre-fill (이 책 · 본사 결정 매장 선택)
🏪 [Branch Curation] 매장 재고 있으면 진열 결정 / 없으면 입고 요청 (notification → WH)
   ↓
🏢 [HQ Decision /decide] urgency=CRITICAL → Stage cascade
   Stage 3 진입 시 auto_execute_eligible=True → 07:00 CronJob 자동 승인 (사람 개입 없이)
```

---

## 6. 12 알림 이벤트 (시트 04 정합)

| # | Event | Trigger | Channel | Receiver | Severity |
|---|---|---|---|---|---|
| ① | OrderPending | decision-svc /decide 직후 | Redis `order.pending` + Logic Apps | HQ · WH | INFO |
| ② | OrderApproved | intervention-svc /approve | Logic Apps | HQ · WH · Branch (관련) | INFO |
| ③ | OrderRejected | intervention-svc /reject | Logic Apps | HQ · WH (Stage 별) | WARNING |
| ④ | AutoExecutedUrgent | 07:00 CronJob 자동 승인 | Logic Apps | HQ | WARNING |
| ⑤ | AutoRejectedBatch | 07:00 CronJob 누적 거절 종결 | Logic Apps | HQ · WH | INFO |
| ⑥ | SpikeUrgent | spike-detect Lambda · z_score ≥ 1.5 | Redis `spike.detected` + Logic Apps (CRITICAL=SMS) | HQ · Branch (매장 재고 있으면) | WARNING/CRITICAL |
| ⑦ | StockDepartPending | WH 출고 직전 | Logic Apps | Branch | INFO |
| ⑧ | StockArrivalPending | Branch 입고 요청 (Curation) | Logic Apps | WH (해당 권역) | INFO |
| ⑨ | NewBookRequest | publisher-watcher 신규 detection | Redis `newbook.request` + Logic Apps | HQ | INFO |
| ⑩ | ReturnPending | Branch 반품 신청 | Logic Apps | HQ · WH | INFO |
| ⑪ | LambdaAlarm | Lambda 8개 중 fail | Logic Apps | HQ (oncall) | CRITICAL |
| ⑫ | DeploymentRollback | CICD pipeline rollback | Logic Apps | HQ | CRITICAL |

---

## 7. Pod 책임 매트릭스 (V6.2 슬라이드 30 · audit 정합)

| Pod | 종류 | 책임 (FR) | RDS 권한 | Redis | 호출 받음 | 호출 함 |
|---|---|---|---|---|---|---|
| **auth-pod** | Pod | Entra OIDC + JWT 발급 + group→role 매핑 (FR-A7.1/A7.2) | users RW | - | (외부 entry) | Entra ID |
| **dashboard-svc** | Pod (HUB) | 5-way fan-in + master read + SPA serve (FR-A7) | books·sales·inventory·spike·etc SELECT only | sub all | (Ingress) | 5 Pod |
| **forecast-svc** | Pod | D+1 RDS cache + D+2~5 BQ proxy + Vertex 호출 (FR-A3) | forecast_cache RW | - | dashboard | BQ · Vertex |
| **decision-svc** | Pod | 3-stage cascade + EOQ (FR-A4/A5) | pending_orders RW · books SELECT | pub `order.pending` | dashboard | notification |
| **intervention-svc** | Pod | 승인/거부/실행 단일창구 + auto-execute CronJob (FR-A4.5/A4.7/A6.6/A6.8) | pending_orders·order_approvals·returns·books RW | - | dashboard | inventory · notification |
| **inventory-svc** | Pod | 단일 writer (모든 inventory 변경) + reservations (FR-A6.6/A7.4) | inventory·reservations RW + audit | pub `stock.changed` | intervention · dashboard | - |
| **notification-svc** | Pod | 12 events dispatcher + Redis 4채널 (FR-A8) | notifications_log RW | pub all + sub | decision · intervention · publisher-watcher | Logic Apps |
| **publisher-watcher** | CronJob (1분) | publisher API 폴 + new_book_requests INSERT + books UPSERT (FR-A1.4/A11.1) | new_book_requests INSERT · books UPSERT | pub `newbook.request` | (cron) | publisher API · notification |
| **reservation-ttl-cleanup** | CronJob (5분) | reservations TTL 만료 정리 | reservations DELETE | - | (cron) | - |
| **intervention-auto-execute** | CronJob (07:00 KST) | 자동 승인 + 누적 거절 종결 | pending_orders UPDATE | - | (cron) | notification |

---

## 8. 데이터 source 정합 (시트 11_Model_Result Vertex 정합)

| 데이터 종류 | 저장소 | 보존 | Pod consumer | 참조 |
|---|---|---|---|---|
| forecast (D+1 only) | RDS forecast_cache | 1일 | forecast-svc · decision-svc | 시트11 4. consumption flow |
| forecast (D+2~5) | BigQuery `bookflow_dw.forecast_results` | 영구 (PARTITION prediction_date) | forecast-svc (BQ proxy) | 시트11 5. exact schema |
| 평가 결과 | BigQuery `bookflow_dw.model_evaluation` | 영구 | Vertex AI Pipeline · ML operator | 시트11 2. recommended table |
| 학습 데이터 검증 | BigQuery `bookflow_dw.training_validation_log` | 영구 | Vertex AI Pipeline | 시트11 3. promotion gates |
| 모델 artifact | GCS · Vertex AI Model Registry | 영구 (passing 만 등록) | forecast-svc · ML operator | 시트11 1. outputs |

**시기**: 04:30 KST batch prediction → 04:30-04:45 D+1 RDS sync → 05:00 decision generation → 07:00 auto-execute.

---

## 9. UI/SPA 완성형 작업 list (이 매트릭스에서 파생)

### 9.1 신규 페이지 (3개)
- 🆕 **HQ Home** — 오늘의 할일 PENDING 카운트 4종 (Decision 발의 / Approval / Requests / Returns) + 핵심 메트릭 + 다음 액션 링크
- 🆕 **WH Home** — 권역 메트릭 + PENDING 카운트 4종 (REBALANCE / TRANSFER SOURCE / TARGET / PUBLISHER) + 출고 지시 카운트
- 🆕 **Branch Home** — 매장 메트릭 + 오늘 입고 카운트 + 진열 추천 top 5 + 부족 SKU 카운트

### 9.2 기존 페이지 헤더 강화 (각 페이지)
- h1: "{역할명} {기능}" (예: "본사 · 전사 KPI 모니터링")
- subtitle: "이 페이지에서 할 수 있는 일" 3줄
- HelpHint: 각 메트릭/컬럼에 의미 설명

### 9.3 페이지 간 workflow link
- Decision → "결정 후 [Approval 페이지에서 Stage 3 외부발주 최종 승인]"
- Spikes → "이 책으로 [Decision 페이지에서 발주 시작]"
- BranchInbound 거부 → "물류센터 알림 발송 — [WhInstructions 에서 후속 처리]"
- Requests 편입 → "분배 결정 후 [WhApprove 에서 Stage 3 승인 대기]"

### 9.4 사이드바 재구성
- **그룹 1: 진입** (Home — 역할별 1개)
- **그룹 2: 모니터링** (KPI · Inventory · Books · Sales · Curation · Spikes · LiveEvents · Notifications)
- **그룹 3: 액션** (Decision · Approval · Requests · Returns · Inbound · Manual · WhApprove · WhTransfer)
- **그룹 4: 도움말** (Manual · Help)
- 각 항목 desc 일반화 ("매출·거래·주문 5초 갱신" — 기술 용어 X)

### 9.5 EmptyState/Loading/Error 일관화
- 모든 페이지 EmptyState 컴포넌트 (icon + message + hint)
- 로딩 스켈레톤 또는 spinner
- 에러 InlineMessage (red tint + retry)

### 9.6 ConfirmModal (prompt() 대체)
- Approval 거절 사유 모달
- BranchInbound 거부 사유 모달
- Returns 거부 사유 모달
- 사유 dropdown 제공 (사전 정의된 사유)

### 9.7 백엔드 누락 endpoint
- `POST /returns/request` (Branch 반품 신청 발의 — 현재 미명시)
- `POST /notification/send` event=StockArrivalPending (Branch 입고 요청)
- ErrorResponse 표준화 (intervention-svc 패턴 → 다른 6 pod)

---

## 10. 발표일 시연 시나리오 매핑 (Phase 4)

| 시나리오 | 페이지 흐름 | 시간 |
|---|---|---|
| **A 신간 추론** | Notifications (NewBookRequest 알림) → HQ Requests 편입 → 분배 추천 → 승인 → WhInstructions 출고 → BranchInbound 수령 | 3분 |
| **B 재고 발주** | HQ Decision 발의 (ISBN/매장/수량) → cascade 결과 표시 → Stage 별 (Approval / WhApprove) 승인 → BranchInbound | 3분 |
| **C 권역 이동** | Decision Stage 2 발의 → WhTransfer (수도권 SOURCE 승인 + 영남 TARGET 승인) → 양측 APPROVED 자동 EXECUTED | 2분 |
| **D 지점 조정** | BranchInventory 부족 발견 → BranchManual 수동 조정 → audit_log → HQ KPI 추적 | 2분 |
| **E SNS 급등** | Spikes (CRITICAL 표시) → Decision pre-fill → 자동 발주 (07:00 CronJob) → AutoExecutedUrgent 알림 | 3분 |

총 시연 13분 (백업 시간 포함).

---

## 11. 변경 이력 (이 문서)

| 버전 | 날짜 | 변경 |
|---|---|---|
| v1.0 | 2026-05-07 | 초안 — V6.2 PPT 슬라이드 30 + V6 schema + WBS V4 + audit 결과 종합. C-0 작업의 산출물. |

---

> **다음 step**: 이 매트릭스 기반으로 SPA 페이지/홈/사이드바/workflow link 작업 (Phase C). 매트릭스가 single source of truth — 모든 UI 변경은 이 문서 매핑에 따름.
