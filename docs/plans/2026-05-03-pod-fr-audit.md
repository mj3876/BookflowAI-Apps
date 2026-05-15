# Pod 백엔드 vs FR-A1~A11 갭 분석 (2026-05-03)

> 대상 브랜치: `ux-frontend` · `BookFlowAI-Apps/eks-pods/*/src/`
> FR 출처: Notion 33eb434359168145b8e1e85da1cb81d3 (Functional Requirements)
> 권한 매트릭스 출처: Notion 33eb43435916812a8fb5cdb2d5b810d5 (서비스 기능 분류)

## 결론 요약
- 평가 대상 FR 항목: **47개** (Optional 제외 핵심 + 일부 Optional 표시 항목)
- ✅ 준수: **18개** / ⚠️ 부분 준수: **15개** / 🔴 미흡: **14개**
- **가장 취약한 영역**: FR-A4 (자동 발주 엔진 — EOQ·동적 안전재고·품절임박예외 알고리즘 모두 누락), FR-A5.3 (2단계 "타 센터 여유분" 정의가 안전재고/예상수요 차감 없음), FR-A6.6/A6.7 (지점 수동개입 + 감사로그 전용 API 없음), FR-A7.4 (in-transit 추적 미구현)
- **잘 구현된 영역**: FR-A6.1·A6.2 (도서 ON/OFF + 소진모드 상태머신), FR-A8 (12 events 이벤트 버스 구조), FR-A6.7 부분 (감사 로그 INSERT 패턴 일관)

---

## Pod 별 상세

### 1. decision-svc (FR-A4 자동발주 + FR-A5 재분배 cascade)

| FR ID | FR 명세 | 현재 구현 (파일·라인) | 갭 | 우선순위 |
|---|---|---|---|---|
| **A4.1** | 품목별 EOQ 자동 산출 (수요·주문비·보관비 기반) | 없음. `decision.py:175` Stage 3 진입 시 `qty=req.qty` 그대로 사용 (사용자 입력값) | 🔴 EOQ 공식 (`sqrt(2DS/H)`) 미구현. orders 비용·보관비 파라미터 부재 | **P1** |
| **A4.2** | 안전재고 임계치 동적 조정 (수요변동성 + 리드타임 기반) | 없음. `inventory.safety_stock` 컬럼 SELECT 만 (`inventory.py:36`), 동적 갱신 로직 없음 | 🔴 `safety_stock = z * sigma * sqrt(L)` 공식 미구현. 일 단위 재계산 batch 부재 | **P1** |
| **A4.3** | 임계치 감지 → 발주 트리거 (실시간 이벤트) | 없음. 사용자가 `/decide` 호출해야만 시작됨 | 🔴 자동 트리거 없음 (`stock.changed` 구독자에서 safety_stock 비교 → trigger 누락) | **P1** |
| **A4.4** | 3단계 cascade 분기 (Stage 1·2·3) | `decision.py:167-175` 구현됨. Stage 1 (`_stage1_source`) → Stage 2 (`_stage2_source`) → Stage 3 fallback | ✅ 준수 | — |
| **A4.5** | 발주 지시서 생성 (출판사별 그룹핑·납기·우선순위) | `decision.py:185-198` `pending_orders` INSERT. 출판사 그룹핑 없음, `est_lead_time_hours`·`est_cost` 컬럼은 V3 스키마에 있으나 INSERT 시 채워지지 않음 | ⚠️ pending_orders row 자체는 만듦. 출판사별 묶음·우선순위·리드타임 산출 없음 | P2 |
| **A4.6** | 발주 승인 워크플로우 | intervention-svc 에서 처리 (책임 분담 OK) | ✅ 준수 (intervention 측에서) | — |
| **A4.7** | **품절임박 자동 발주** (승인 지연 + 품절임박 → 승인 우회 자동실행) | `intervention-svc/cron/auto_execute.py:70-118`: `auto_execute_eligible=TRUE` 인 row 일괄 APPROVED. 단 decision.py:183 의 정의가 `Stage 1 + URGENT/CRITICAL` 만 → **Stage 3 (PUBLISHER_ORDER) 품절임박 자동 발주 케이스 누락** | 🔴 FR 명세는 Stage 3 PUBLISHER_ORDER 가 18시 이후 승인 안 됐을 때 자동 실행. 현재 코드는 Stage 1 REBALANCE 만 자동승인 대상 | **P1** |
| **A4.8** | 신간 발주 지시서 자동 실행 (승인 불필요) | `intervention.py:391-482` `approve_new_book_request` 가 `pending_orders` 를 status=APPROVED 로 직접 INSERT (승인 워크플로 우회) | ✅ 준수 | — |
| **A4.9** | 발주 이력·감사 추적 (불변) | `decision.py:201-211`, `intervention.py:273-288` audit_log INSERT 일관 | ✅ 준수 | — |
| **A5.1** | 매장별 과부족 분석 (`예상판매 - 현재고 - 입고예정`) | 없음. `_stage1_source` 는 `on_hand - reserved_qty` 만 사용 (`decision.py:60`), 입고예정·예상판매 차감 없음 | 🔴 입고예정(`pending_orders` APPROVED 합)·forecast_cache 차감 누락 | **P1** |
| **A5.2** | [1단계] 같은 권역 지점 간 재분배 매칭 | `decision.py:56-73` `_stage1_source` 가 같은 wh_id 내 가용 ≥ qty 인 location 1건만 SELECT | ⚠️ 단순 매칭 OK. 단 "여유 매장 → 부족 매장" 양방향 매칭이 아니라 1:1 lookup. 복수 지점 분할 이동 로직 없음 | P2 |
| **A5.3** | **[2단계] 타 센터 여유분 = on_hand - reserved - safety_stock - 예상수요** | `decision.py:76-94` `_stage2_source`: `on_hand - reserved_qty >= qty` 만 검사. **상대 안전재고·예상수요 차감 없음** | 🔴 FR 명세 위반. "상대 안전재고 보존" + "상대 예상수요 보존" 둘 다 차감 안 함. `forecast_cache` JOIN 없음 | **P1** |
| **A5.4** | [3단계] 출판사 발주 fallback | `decision.py:174-175` Stage 1·2 모두 None 시 Stage 3 진입 | ✅ 준수 | — |
| **A5.5** | 재분배 지시서 자동 생성 (발신·수신·수량·비용·우선순위) | `decision.py:185-198` INSERT. `est_lead_time_hours`·`est_cost` 미입력 (NULL) | ⚠️ 핵심 컬럼 (source/target/qty/urgency) 만 채움. 비용·리드타임 누락 | P2 |
| **A5.6** | **재분배 양쪽 승인 (Stage 2 = SOURCE+TARGET 둘 다)** | `intervention.py:116-128` WH_TRANSFER 는 SOURCE/TARGET side 검증 + `_record_approval:256-266` 양쪽 APPROVED 누적 시 status 전환 | ✅ 준수 (스키마+로직 정합) | — |
| **A5.7** | 재분배 효과 추적 (Optional) | 없음 | 🔴 (Optional · Phase 4) | P3 |
| **A5.8** | 비활성 도서 재분배 스킵 (소진모드는 허용) | 없음. `decision.py` 의 cascade 가 `books.discontinue_mode` 체크 안 함 → INACTIVE 도서도 의사결정 생성됨 | 🔴 `_stage1_source`/`_stage2_source` SQL 에 `JOIN books WHERE active=TRUE` 또는 mode 분기 누락 | **P1** |
| **A3.8** (decision 측 책임) | 비활성 도서 예측·발주 스킵 | 위와 동일. forecast-svc 도 미구현 | 🔴 동일 | **P1** |
| Urgency 산출 | `stock_days_remaining < 0.5/1.0` → CRITICAL/URGENT | `decision.py:97-140` `_calc_urgency` 구현됨. forecast_cache 없으면 NORMAL fallback | ✅ 준수 | — |
| WH-manager scope 검증 | 자기 wh 외 의사결정 불가 | `decision.py:156-160` 체크 | ✅ 준수 | — |

---

### 2. intervention-svc (FR-A6 수동개입 + 권한)

| FR ID | FR 명세 | 현재 구현 | 갭 | 우선순위 |
|---|---|---|---|---|
| **A6.1** | 도서 ON/OFF 토글 (전사/권역별, NORMAL/SOFT_DISCONTINUE/INACTIVE) | `intervention.py:518-602` `change_book_status`. 3-state 머신. NORMAL → reactivated_at 채움 / SOFT_DC / INACTIVE | ⚠️ 전사 토글은 OK. **권역별 토글 (Optional)** 없음. FR 문서 자체가 Optional 처리했으나 V6.2 PPT 슬라이드 1.5 에서는 strike-through | P3 |
| **A6.2** | 소진 모드 (Soft Discontinue) - 발주 차단·재분배 허용·예측 계속 | `change_book_status` 의 SOFT_DISCONTINUE branch (`intervention.py:559-571`) 가 books 테이블 갱신만. **decision-svc/forecast-svc 가 이 mode 를 체크하지 않음** | 🔴 books.discontinue_mode 가 다른 pod 에서 enforce 되지 않음 (decision-svc 의 cascade SQL 에 mode 필터 없음) | **P1** |
| **A6.3** | AI 추천 거부/수정 API · 사유 기록 + 피드백 루프 | `intervention.py:322-345` `reject` 가 reject_reason 필수, audit_log 기록. **수정 (qty/대상 변경) API 없음** — reject 후 새로 만들어야 함 | ⚠️ 거부는 OK. 수정 (PATCH /pending-orders/{id}) 미구현 | P2 |
| **A6.4** | 임계치 수동 조정 (Optional) | 없음 | 🔴 (Optional) | P3 |
| **A6.5** | 긴급 수동 발주 (Optional) | 없음. /decide 가 사실상 수동 트리거 역할 함 | ⚠️ /decide 가 cascade 자동인 점은 차이 있으나 사용자가 의도적으로 호출 → 부분적 등가 | P3 |
| **A6.6** | **지점 수동개입 (입고 거부·재고 조정)** | `inventory-svc/inventory.py:60-112` `/inventory/adjust` 가 분실/파손 케이스 처리 + audit_log. **단 branch-clerk role 은 차단됨** (62-63 `branch-clerk cannot adjust inventory`) | 🔴 FR 명세 권한 매트릭스: 지점이 "재고 수동 조정 = 실행" 권한. 현재 코드는 거꾸로 차단. 입고 거부 (reject inbound) API 자체가 없음 | **P1** |
| **A6.7** | 수동 개입 감사 로그 (누가·언제·무엇을·왜) | 모든 mutation API 가 audit_log INSERT (decision.py:201, intervention.py:273, inventory.py:73) | ✅ 준수 | — |
| **A6.8** | 반품 관리 (Optional · 본사 승인 워크플로) | `intervention.py:348-387` `/intervention/returns/approve` 구현. 단 reject API · 자동 리스트업 (소진모드 종료 도서 등) 없음 | ⚠️ approve 만 있음. (FR 문서 Optional 표기) | P3 |
| Stage별 권한 매트릭스 | REBALANCE=FINAL · WH_TRANSFER=SOURCE/TARGET · PUBLISHER_ORDER=hq-admin only | `intervention.py:103-141` `_validate_authority` 가 matrix 그대로 enforce | ✅ 준수 (정밀 정합) | — |
| 신간 편입 워크플로 | 출판사 신청 → HQ 승인/거절 → 권역별 발주 자동생성 | `intervention.py:391-515` approve/reject + wh1/wh2 qty 분배 + pending_orders PUBLISHER_ORDER 자동 INSERT | ✅ 준수 | — |
| Auto-execute CronJob | 07:00 KST 일괄 자동 승인 + 누적 거절 종결 | `cron/auto_execute.py:70-157` 구현 | ✅ 준수 (단 A4.7 Stage 3 케이스 미적용 — 위 decision-svc 표 참조) | — |

---

### 3. inventory-svc (FR-A2.5 실시간 재고)

| FR ID | FR 명세 | 현재 구현 | 갭 | 우선순위 |
|---|---|---|---|---|
| **A2.5** | POS 판매 + WMS 입출고 → 재고 증감 → 실시간 DB | `/inventory/adjust` (`inventory.py:59-112`) 가 단일 writer · `stock.changed` Redis publish + cache invalidate. POS 측은 pos-ingestor Lambda 가 sales_realtime 에 INSERT (별도) | ⚠️ adjust API 는 OK. 단 **POS 이벤트 → inventory 자동 차감 로직** 이 inventory-svc 안에 없음 (Lambda 가 sales_realtime 에만 쓰고 inventory 미터치) | **P1** |
| A7.4 (실시간 조회) | 매장/센터/ISBN별 현재고·안전재고·예상소진일·발주 대기/입고 추적 | `/inventory/current/{wh_id}` (`inventory.py:27-56`) 가 wh 단위 SELECT. **예상소진일·발주대기·입고추적 컬럼 없음** | 🔴 응답에 `expected_soldout_at`·`pending_in_transit`·`pending_publisher_order` 결합 누락 (books.expected_soldout_at 컬럼은 존재) | **P1** |
| Reservation TTL | reserve qty + ttl 만료 자동 해제 | `/inventory/reserve` INSERT 만. **만료 cleanup CronJob 없음** | 🔴 `expires_at < NOW()` row 의 reserved_qty 차감 batch 부재 → reserved_qty 영구 누적 | **P2** |
| 권한 분리 | wh-manager scope 자기 wh 만 | `inventory.py:29-30` 체크 | ✅ 준수 | — |
| Single writer 패턴 | 모든 inventory 변경은 inventory-svc 경유 | `/adjust` 만 mutation. 다른 pod 는 read-only | ✅ 준수 | — |

---

### 4. forecast-svc (FR-A3 수요예측)

| FR ID | FR 명세 | 현재 구현 | 갭 | 우선순위 |
|---|---|---|---|---|
| **A3.1** | 시계열 기본 수요예측 (매장별 7일·신뢰도) | `forecast_cache` 테이블 SELECT only (`forecast.py:16-39`). 학습/추론 코드 없음 | 🔴 Vertex AI 호출 client 부재. forecast-svc 는 사실상 cache reader. 학습은 GCP Vertex AI 영역이지만 svc 가 결과를 RDS 로 sync 하는 batch 누락 | **P1** |
| **A3.2** | 신간 cold-start 예측 (저자 과거작 + 장르 + 출판사 데이터) | 없음. `/refresh` 는 단순 UPSERT (`forecast.py:42-74`) — 외부에서 계산된 값을 받아 저장만 | 🔴 cold-start 로직 자체가 없음. publisher-watcher 수신 시 trigger 부재 | P2 |
| **A3.3** | SNS 트렌드 급변 탐지 | spike-detect Lambda 가 별도 (Platform 측 SAM). forecast-svc 가 spike_events 를 forecast 에 반영하는 hook 없음 | ⚠️ 검출 자체는 Lambda OK. forecast 와의 결합 없음 | P2 |
| **A3.4** | 외부 변수 결합 예측 (날씨·이벤트) | 없음 | 🔴 (Vertex 측 책임이지만 svc 측 client 부재) | P2 |
| **A3.5** | 권역별·매장별 예측 산출 + 드릴다운 | `forecast_cache (snapshot_date, isbn13, store_id)` 그래뉼라리티 OK. 권역 집계 (`SUM by wh_id`) 엔드포인트 없음 | ⚠️ 매장별 OK. 권역 roll-up API 누락 | P2 |
| **A3.6** | 예측 vs 실제 비교 (RMSE·MAPE) 저장 | 없음. `forecast_cache` 에 actual_demand 컬럼 없음 | 🔴 정확도 추적 unable | P2 |
| **A3.7** | 예측 급변 자동 알림 (임계치 초과 → notification) | 없음 | 🔴 forecast → notification-svc 호출 없음 | P2 |
| **A3.8** | 비활성 도서 예측 스킵 | `/refresh` UPSERT 가 `books.active`/`discontinue_mode` 체크 없음 → INACTIVE 도서도 forecast row 유지 | 🔴 INSERT 시 `WHERE EXISTS (SELECT 1 FROM books WHERE isbn13=? AND active=TRUE)` 가드 없음 | P2 |
| RBAC | `/refresh` hq-admin only | `forecast.py:45-46` 체크 | ✅ 준수 | — |

---

### 5. notification-svc (FR-A8 알림 12 events)

| FR ID | FR 명세 | 현재 구현 | 갭 | 우선순위 |
|---|---|---|---|---|
| **A8.1** | 이벤트 버스 기반 (중앙 허브) | `notification.py:65-120` `/send` 가 Logic Apps webhook + Redis publish + notifications_log INSERT | ✅ 준수 | — |
| **A8.2** | 긴급 자동 발주 알림 (AutoExecutedUrgent) | `auto_execute.py:172-179` 에서 발행 | ✅ 준수 | — |
| **A8.3** | 승인 대기 알림 (양쪽 승인 응답상태 포함) | `intervention.py:305-318` OrderApproved payload 에 `final_status` 포함 | ⚠️ payload 에 상대측 status 정보 부분적 포함. "상대 응답 대기 명시 필드" 없음 (예: `pending_side: 'TARGET'`) | P2 |
| **A8.4** | 출판사 신간 신착 알림 (Optional) | publisher-watcher 가 Redis publish 만 (`poll.py:101-105`). **notification-svc 에 NewBookRequest event INSERT 호출 없음** → notifications_log 미기록 | ⚠️ Redis 채널은 OK · 단 notifications_log 누락 (Optional) | P3 |
| **A8.5** | SNS 트렌드 급등 알림 (SpikeUrgent) | EVENT_CHANNEL 매핑은 있음 (`notification.py:40` `spike.detected`). 단 **spike-detect Lambda 가 직접 Redis publish or notification-svc 호출 하는지 확인 필요 — pod 코드 측 발행자 없음** | ⚠️ pod 측 발행 entry 없음 (Lambda 측 책임) | P2 |
| **A8.6** | 전사 재고 이상 감지 알림 | 없음 | 🔴 detection batch 부재 | P2 |
| **A8.7** | 지점 입고 거부·보류 알림 | A6.6 자체가 미구현이므로 알림도 없음 | 🔴 (A6.6 의존) | P2 |
| **A8.8** | 알림 채널 연동 (Email/Slack/Teams/배지) | Logic Apps webhook URL 1종 + Redis 4채널만. recipients/channels 컬럼은 INSERT 됨 | ⚠️ Logic Apps 가 분기 가정 — pod 측에서 Email/Slack 직접 호출 X (Logic Apps 책임) | P3 |
| 12 events 매핑 | 시트06 12종 모두 | `models.py:15-23` Literal 타입에 12종 모두 정의. EVENT_CHANNEL 도 12종 모두 | ✅ 준수 | — |
| Redis 채널 4종 | stock.changed · order.pending · spike.detected · newbook.request | `notification.py:34-47` 매핑 정합 | ✅ 준수 | — |

---

### 6. dashboard-svc (FR-A7 BFF + 권한별 view)

| FR ID | FR 명세 | 현재 구현 | 갭 | 우선순위 |
|---|---|---|---|---|
| **A7.1** | 본사 뷰 (READ-ALL + 드릴다운 + 모든 이력 + 신간 접수함 + 신간 지시서) | `aggregate.py` + `master.py` 다양한 엔드포인트 (`/recent-sales`·`/heatmap`·`/new-book-requests`·`/overview/{wh_id}`). 단 **role 기반 데이터 필터 없음** — branch-clerk 도 hq endpoint 호출 가능 | ⚠️ 엔드포인트 다 있음. RBAC enforcement 가 endpoint 마다 일관되지 않음 (require_auth 만 통과시키고 role 체크 X) | P2 |
| **A7.2** | 물류센터 뷰 (관할 20지점 히트맵·자기 재고·타 센터 조회·승인/거부) | inventory-svc 의 wh-scope 검증은 inventory 측에서. dashboard 는 그대로 fan-in | ⚠️ pass-through OK. 단 `/locations/heatmap` (`master.py:454`) 는 wh_id 필터 없음 (전사 노출 — wh-manager 도 타 wh 다 보임) | P2 |
| **A7.3** | 지점 뷰 (내 매장만·입고예정·출고예정·완료처리·피드백) | `/store-inventory/{store_id}`, `/sales-by-store/{store_id}` 등 store_id 받음. 단 **branch-clerk 의 scope_store_id 자동 적용 없음** — 다른 매장 ID 넣으면 그대로 응답 | 🔴 권한 enforce 부재 (지점이 타 지점 데이터 조회 가능) | **P1** |
| **A7.4** | 실시간 조회 (현재고·안전재고·예상소진일·발주대기/입고추적) | `/store-inventory/{store_id}` 가 on_hand·reserved_qty·safety_stock 반환. **expected_soldout_at·in-transit (입고예정 수량) 누락** | 🔴 books.expected_soldout_at 은 SELECT 안 함. pending_orders APPROVED 합산 (in-transit) 없음 | **P1** |
| **A7.5** | KPI 집계 (일/주/월 + 역할별 스코프) | `/sales-summary` 1h만. 일/주/월 단위 없음 | ⚠️ 1h 만 · 추가 window (24h, 7d, 30d) 누락 | P2 |
| **A7.6** | 이력 조회 (발주·재분배·수동개입 + 필터·검색) | `/books/{isbn13}/audit` (도서 단위만). pending_orders·order_approvals 이력 통합 endpoint 없음 | 🔴 audit_log 통합 조회 + actor·entity_type 필터 미구현 | P2 |
| WebSocket | Redis 4채널 → WS broadcast | `redis_bridge.py:20` 4채널 구독 + `_broadcast` | ✅ 준수 | — |
| BFF Single Pod | V6.2 회귀 (BFF + Frontend 1 Pod 통합) | `main.py:53-55` StaticFiles mount | ✅ 준수 | — |

---

### 7. publisher-watcher (FR-A1.4 출판사 신간 수신)

| FR ID | FR 명세 | 현재 구현 | 갭 | 우선순위 |
|---|---|---|---|---|
| **A1.4** | 출판사 신간 요청 수신 → 파일/JSON 파싱 → 정규화 → 마스터·예측 입력 | `poll.py:43-54` `fetch_pending` 가 publisher API GET, items 파싱. `poll.py:78-87` new_book_requests INSERT (isbn13·publisher_id·title 만) | ⚠️ 핵심 컬럼만 추출. **저자·예상판매량·마케팅 계획·유사도서** 등 FR 명세상 필수 데이터 (cold-start 입력) 미파싱 | **P1** |
| A11.1 (도서 마스터 보강) | 신간 수신 시 books 테이블 upsert | 없음. `new_book_requests` 만 INSERT, `books` 테이블 미터치 | 🔴 신간 도서가 books 카탈로그에 안 들어감 → forecast/decision 측에서 isbn13 조회 시 NULL JOIN | **P1** |
| A3.2 (cold-start trigger) | 수신 시 forecast cold-start 호출 | `poll.py` 가 forecast-svc 호출 안 함. Redis `newbook.request` publish 만 (`poll.py:101-105`) | 🔴 forecast cold-start 미트리거 (notification 만) | P2 |
| Idempotency | isbn13 중복 시 skip | `poll.py:82-83` `ON CONFLICT (isbn13) DO NOTHING` | ✅ 준수 | — |
| Audit log | 발견 row 마다 INSERT | `poll.py:92-98` audit_log INSERT | ✅ 준수 | — |

---

## 권한 매트릭스 vs 코드 정합성 (cross-cutting)

FR 권한 매트릭스 vs 실제 enforcement:

| 매트릭스 항목 | 명세 | 코드 enforcement | 갭 |
|---|---|---|---|
| 도서 ON/OFF | 본사 전권 | intervention.py:536-538 hq-admin only | ✅ |
| 자동 발주 추천 | wh-manager 승인 | intervention.py:103-141 stage별 wh-scope | ✅ |
| 권역 내 재분배 | wh-manager 승인 | REBALANCE FINAL = wh-manager 본인 wh | ✅ |
| 센터 간 이동 | 양쪽 승인 | WH_TRANSFER SOURCE+TARGET 둘 다 | ✅ |
| 출판사 발주 | wh-manager 승인 (FR 매트릭스) | **PUBLISHER_ORDER hq-admin only** (`intervention.py:134`) | ⚠️ FR 권한매트릭스(`물류센터 승인`) vs 코드(`hq-admin only`) 불일치. V6.2 슬라이드 1.5 본사 마스터 권한 정황 상 코드가 맞을 수도 있으나 **명세 모순** — 사용자 확인 필요 |
| 입고 거부·보류 | 지점 실행 | inventory.py:62-63 branch-clerk **차단** | 🔴 매트릭스 정면 위반 |
| 재고 수동 조정 | 지점 실행 | 동일하게 차단 | 🔴 매트릭스 정면 위반 |
| 전사 재고 모니터링 | 본사 전체·wh 권역+타센터·지점 자기 매장 | dashboard-svc 측 role 필터 없음 | ⚠️ 부분 |

---

## 우선순위별 보강 task 제안

### P1 (필수 · 정밀화 핵심)

1. **decision-svc · A4.1 EOQ 알고리즘 구현**
   `decision.py` 에 `_calc_eoq(annual_demand, order_cost, holding_cost) = sqrt(2DS/H)` 헬퍼 추가. Stage 3 진입 시 user `req.qty` 가 아닌 EOQ 값 사용. publishers 테이블에 order_cost 컬럼·books 에 holding_cost 추가 필요.

2. **decision-svc · A4.2 동적 안전재고 batch**
   `safety_stock = z * stddev(daily_sales) * sqrt(lead_time_days)` 일단위 batch (CronJob 또는 forecast-svc 협업). z=1.65 (95%) 고정.

3. **decision-svc · A4.3 임계치 자동 트리거**
   inventory-svc 의 `stock.changed` Redis 채널 구독 → `available < safety_stock` 감지 시 `/decide` 자동 호출. 또는 inventory-svc 측에서 직접 호출.

4. **decision-svc · A4.7 Stage 3 품절임박 자동발주**
   현재 `auto_execute_eligible = stage 1 + URGENT/CRITICAL` (decision.py:183). FR 명세는 **Stage 3 PUBLISHER_ORDER + 18시 이후 + 승인 지연** 케이스. 별도 분기 추가 필요.

5. **decision-svc · A5.1+A5.3 cascade SQL 정밀화**
   `_stage1_source` 에 `forecast_cache` JOIN (예상판매 차감) + `pending_orders APPROVED` (입고예정) JOIN. `_stage2_source` 에 상대 안전재고 + 상대 forecast_cache 차감.

6. **decision-svc + forecast-svc · A5.8/A3.8/A6.2 비활성 도서 enforce**
   모든 cascade/forecast SQL 에 `JOIN books b ON b.isbn13=... WHERE b.active=TRUE AND (b.discontinue_mode != 'INACTIVE')` 추가. SOFT_DISCONTINUE 는 발주만 차단·재분배 허용.

7. **inventory-svc · A2.5 POS → inventory 자동차감**
   현재 pos-ingestor Lambda 는 sales_realtime 만 INSERT. inventory.on_hand 차감 로직 (트리거 또는 Lambda 추가 step) 필수.

8. **inventory-svc · A7.4 응답 결합**
   `/inventory/current/{wh_id}` 응답에 `expected_soldout_at` (books) + `incoming_qty` (pending_orders APPROVED status·target=내 위치 합) + `outgoing_qty` 추가.

9. **inventory-svc · A6.6 권한 매트릭스 수정**
   branch-clerk 차단(`inventory.py:62-63`) 제거 + scope_store_id 검증으로 전환 (`location_id` 가 자기 store 일 때만 허용). 입고 거부 별도 endpoint `/inventory/inbound/{order_id}/reject` 추가.

10. **dashboard-svc · A7.3/A7.4 RBAC + in-transit**
    `/store-inventory/{store_id}` 에 `branch-clerk` 면 `ctx.scope_store_id == store_id` 강제 검증. 응답에 `expected_soldout_at`·`in_transit_qty` 결합.

11. **publisher-watcher · A1.4 풀 데이터 파싱 + books upsert**
    `poll.py` 에 author·publisher·marketing_plan·similar_isbns 등 추가 컬럼 파싱. **isbn13 받으면 알라딘 OpenAPI 호출하여 books 테이블 upsert** (없으면 신간 도서가 카탈로그에 없어서 모든 JOIN 깨짐).

### P2 (중요 · 데이터 정밀도/UX)

12. forecast-svc · A3.6 actual_demand 컬럼 + RMSE/MAPE batch
13. forecast-svc · A3.7 예측급변 알림 발행 (notification-svc /send 호출)
14. forecast-svc · A3.5 권역 roll-up endpoint
15. intervention-svc · A6.3 PATCH /pending-orders/{id} (qty/대상 수정)
16. inventory-svc · reservation TTL cleanup CronJob
17. dashboard-svc · A7.5 KPI window 확장 (24h, 7d, 30d)
18. dashboard-svc · A7.6 audit_log 통합 조회 endpoint
19. dashboard-svc · A7.2 heatmap wh_id 필터 RBAC
20. notification-svc · A8.3 양쪽 승인 응답대기 명시 필드 (`pending_side`)
21. publisher-watcher · A3.2 forecast cold-start trigger 호출
22. decision-svc · A5.5 est_lead_time_hours / est_cost INSERT 시 채우기 (publishers 테이블 lookup)

### P3 (Phase 4 / Optional · FR 자체가 stretch goal)

23. A6.1 권역별 ON/OFF 토글
24. A6.4 임계치 수동 조정
25. A6.5 긴급 수동 발주 (별도 endpoint)
26. A6.8 반품 자동 리스트업 batch
27. A8.4 NewBookRequest notifications_log 기록
28. A8.6 전사 재고 이상 감지 batch
29. FR-A10 Smart Merchandising 전체

---

## 명세 모순 (사용자 확인 필요)

- **출판사 발주 승인 권한**: FR 권한매트릭스 (서비스 기능 분류 페이지) 는 "물류센터 승인" / FR-A4.6 본문은 명시 없음 / 코드는 hq-admin only. **V6.2 슬라이드 1.5 "본사 마스터 권한" + 출판사 발주 비용을 본사가 부담한다는 정황 상 코드(hq-admin only)가 맞을 가능성 높음** — 명세 갱신 필요.
- **지점 입고 거부/재고 조정 권한**: FR 매트릭스 명확히 "지점 실행" / 코드는 branch-clerk 차단 → **코드 수정 필수** (P1 #9).

---

## 정리

전반적으로 **권한 매트릭스(FR-A6/A9), 12 events 알림 구조(FR-A8), 3-stage cascade 분기(FR-A4.4/A5.4/A5.6), 도서 ON/OFF 상태머신(FR-A6.1/A6.2)** 은 V6.2 명세에 정밀하게 맞춰져 있습니다.

반면 **수요예측 알고리즘 본체(FR-A3), EOQ/안전재고(FR-A4.1-3), 재분배 여유분 정의(FR-A5.3), 비활성 도서 enforce(A6.2 의 다른 pod 측), 지점 권한(A6.6) 그리고 in-transit/예상소진(FR-A7.4)** 는 명세와 격차가 큽니다. P1 11개 task 가 정밀화 핵심입니다.
