# UX 갭 보강 — Design (.pen 정합 + FR-A 명세 정합)

**Goal:** Notion 기획 문서 + V6.2 PPT + `uiux.pen` 와이어프레임에 명시되어 있으나 현재 코드는 thin/누락인 8개 UX 갭을 메워서 **처음 쓰는 사용자도 즉시 이해 + 사용 가능**한 대시보드 완성.

**Source of truth (우선순위 順)**:
1. `.pen` 파일 (`BookFlowAI-Apps/eks-pods/uiux.pen`) — 시각적 단일 진실
2. Notion FR (`33eb434359168145b8e1e85da1cb81d3`) — 백엔드 기능 명세
3. Notion 서비스 분류 (`33eb43435916812a8fb5cdb2d5b810d5`) — 권한 매트릭스
4. V6.2 PPT slide 30 + 구성요소 PPT — 7 Pod + 1 CronJob 구조

## 현 상태

- UX-1 (본사 도서 ON/OFF + 소진 모드) — **완료** (intervention.py + master.py + Books.tsx + 6 unit tests)
- UX-2 backend (신간 편입 + reject + 자동 PUBLISHER_ORDER 생성) — **완료** (intervention.py extension + dashboard-svc proxy)
- UX-2 frontend, UX-3~8 — pending

## 핵심 결정

### 1. TDD 적용 정책

- **UX-3 ~ UX-8 (백엔드 신규)**: 엄격 TDD — 테스트 먼저 작성 → red → 최소 구현 → green → refactor
- **UX-1 + UX-2 backend (이미 작성)**: letter 위반 명시 후 그대로 유지. 사용자 명시 승인 (2026-05-03). 사후 테스트는 통과하지만 "watched fail first" 증거 없음
- **프론트엔드**: vitest 미설치라 컴포넌트 TDD 어려움. **pure logic 헬퍼 함수만 unit test**, 컴포넌트는 `.pen` 시각 비교 + 수동 브라우저 검증

### 2. UX-2 권역별 분배 로직

`.pen` 의 📨 HQ Requests 페이지 우측 사이드 패널에 **AI 정책별 결과 = Bar chart WH-1/WH-2** 가 명시되어 있음 → 추천값 prefill + 사용자 수정 안 채택.

**추천 알고리즘** (dashboard-svc `/dashboard/new-book-requests/{id}/forecast-hint`):
```sql
-- 같은 카테고리 최근 14일 매출 권역별 비율
SELECT l.wh_id, COUNT(*) AS n
  FROM sales_realtime s
  JOIN books b ON b.isbn13 = s.isbn13
  JOIN locations l ON l.location_id = s.store_id
 WHERE b.category_name = (SELECT category_name FROM books WHERE isbn13 = (SELECT isbn13 FROM new_book_requests WHERE id = ?))
   AND s.event_ts > NOW() - INTERVAL '14 days'
   AND l.wh_id IS NOT NULL
 GROUP BY l.wh_id
```
→ wh1_pct, wh2_pct 반환. 데이터 없으면 60/40 fallback (수도권 우세).

기본 발주 수량 = 100 권 (사용자가 자유 수정).

## 디자인 (UX 항목별)

### UX-1 (완료) · 본사 도서 ON/OFF + 소진 모드

**현 상태**: 모달 기반 (변경 + 이력). `.pen` 은 우측 사이드 패널 형태.

**조정**: 현재 모달 유지 (배포된 V0). 향후 폴리싱 단계에서 사이드 패널 전환 (별도 task).

### UX-2 · 본사 신간 편입 결정 (.pen 직접 reference)

**Layout**:
```
┌────────────────────────────────────────────┬─────────────────────────────┐
│  📨 출판사 신간 요청 수신함                  │  요청 상세                   │
│  [NEW] [REVIEWING] [APPROVED] [REJECTED]   │  ─────────                  │
│                                            │  ISBN · 저자 · 출판사 · 가격 │
│  표 (출판사 / 도서명 / 카테고리 / 시작일)    │                             │
│  - 행 클릭 → 우측 패널에 상세 + Bar chart   │  AI 정책별 예측 (Bar Chart) │
│                                            │   WH-1 ████████ 350         │
│                                            │   WH-2 █████ 220            │
│                                            │                             │
│                                            │  권역별 분배                 │
│                                            │   WH-1 [350]  WH-2 [220]   │
│                                            │                             │
│                                            │  [신간 편입 결정] [거절]    │
└────────────────────────────────────────────┴─────────────────────────────┘
```

**Backend (완료)**: 
- `POST /intervention/new-book-requests/{id}/approve` body `{ wh1_qty, wh2_qty }` → status APPROVED + PUBLISHER_ORDER pending_orders 자동 생성
- `POST /intervention/new-book-requests/{id}/reject` body `{ reason }`

**Backend (남음)**:
- `GET /dashboard/new-book-requests/{id}/forecast-hint` → 추천 split

**Frontend** (`Requests.tsx` 재작성):
- 4탭 (NEW/REVIEWING/APPROVED/REJECTED)
- 마스터-디테일 (좌측 표 + 우측 패널)
- Bar chart (recharts 없이 — 단순 div + width%)
- 폼 (wh1_qty / wh2_qty input, prefill from forecast-hint)

### UX-3 · 물류 권역 재고 히트맵 (WhDashboard)

**.pen ref**: WH Dashboard 페이지 (별도 확인 필요)

**Layout**:
```
[권역 1 (수도권) 카드]              [권역 2 (영남) 카드]
WH-1 + 5 지점 + 온라인 1 = 6 cells   WH-2 + 5 지점 + 온라인 1 = 6 cells

각 cell 색상:
- 빨강 (품절임박: available ≤ safety_stock × 0.5)
- 주황 (부족:    available ≤ safety_stock)
- 초록 (적정:    safety_stock < available ≤ safety_stock × 2)
- 파랑 (과잉:    available > safety_stock × 2)

cell 클릭 → 해당 location 의 ISBN 별 상세 (페이지 전환 또는 모달)
```

**Backend (신규)**:
- `GET /dashboard/wh/{wh_id}/heatmap` — wh_id 관할 location 별 stock_status 집계 (location → {ok, low, urgent, surplus} count + total)

**Frontend** (`WhDashboard.tsx` 재작성):
- 권역 카드 2개 (자기 권역 강조 · scope_wh_id 기반)
- cell grid (3×2 per 권역)
- pure logic: `classifyStock(available, safety): 'OK' | 'LOW' | 'URGENT' | 'SURPLUS'` — TDD

### UX-4 · 물류 타 센터 여유분 계산 (WhTransfer)

**FR-A5.3 명세**: "타 센터의 여유분 = 상대 안전재고 + 상대 예상수요 보존 후 남는 수량"

**현재 코드**: 단순 조회

**조정**:
- decision-svc `/decide` 의 stage-2 결과 활용
- 또는 신규 endpoint `GET /dashboard/transfer/feasibility?isbn13=...&need_qty=N&my_wh=1`
  - 응답: `{ partner_wh, partner_safety_stock, partner_expected_demand, partner_surplus, transferable_qty, can_fulfill }`

**Backend (신규)**:
- `GET /dashboard/transfer/feasibility`
- pure logic: `computeSurplus(onHand, reservedQty, safetyStock, expectedDemand)` — TDD

**Frontend** (`WhTransfer.tsx`):
- 주문 선택 시 자동으로 feasibility 호출
- 표시: 상대 센터 안전재고 / 예상수요 / **여유분** / 요청 수량 / 가능 여부 ✓
- 양쪽 승인 워크플로 명시 (.pen Approval 페이지 패턴 따라)

### UX-5 · 물류 본사 지시서 수신함 (WhInstructions)

**FR-A4.8**: 본사 신간 지시서 → 물류 자동 실행 (승인 불필요, 수신 확인만)

**Backend**:
- 이미 있는 `GET /dashboard/instructions?wh_id=N` 활용 (urgency_level=NEWBOOK 필터 추가)
- 신규: `POST /dashboard/instructions/{order_id}/acknowledge` — 수신 확인 → executed_at 업데이트

**Frontend** (`WhInstructions.tsx`):
- "본사 신간 지시 (자동 수신)" 섹션 + "일반 발주" 섹션 분리
- 신간 행: 수신 확인 버튼 (체크박스 X 명시 액션)
- pure logic: `groupByUrgency(orders)` — TDD

### UX-6 · 지점 입고 거부/보류 + 재고 수동 조정

**FR-A6.6** 명세

**6a. 입고 거부/보류** (`BranchInbound.tsx`):
- 입고 예정 행에 "거부/보류" 버튼 추가
- 거부 시 사유 입력 모달 (예: 매장 사정·공사·재배치)
- → notification-svc `/send` event_type=`InboundReject` (12 events 외 → 시트04 정합 위해 기존 event 매핑 또는 LambdaAlarm 으로 통합)
  - 결정: 시트04 ⑪LambdaAlarm 활용 (시스템 알림 통합 채널)
- pending_orders 의 reject_count++ 또는 별도 `inbound_holds` (시드 안 된 테이블이라 재사용 권장)
- **간단화**: notification 만 발송, 데이터 변경은 향후 task

**6b. 재고 수동 조정** (`Manual.tsx`):
- 이미 inventory-svc `/adjust` proxy 일부 구현됨 (확인 필요)
- 분실/파손/도난 사유 dropdown + 수량 입력 + confirm 모달
- audit_log 기록 (inventory-svc 가 처리)

**Backend**: 거의 그대로 활용 (inventory-svc /adjust + notification-svc /send)

**Frontend**: 거부 모달 추가 + Manual 폼 사유 dropdown 강화

### UX-7 · 공통 UX 패턴

**EmptyState 컴포넌트** (`web/src/components/EmptyState.tsx`):
- props: `{ title, hint, action? }`
- 사용처: 모든 빈 테이블

**LoadingSkeleton 컴포넌트** (`web/src/components/Skeleton.tsx`):
- 표/카드 placeholder

**ConfirmModal 컴포넌트** (`web/src/components/ConfirmModal.tsx`):
- 위험 액션용 (거절·삭제·소진모드 진입 등)

**HelpButton** (Layout 헤더 우측):
- 페이지별 1줄 설명 + "다음 할 일" 가이드
- props: `{ pageKey: string }` → lookup table

**Toast** (`web/src/components/Toast.tsx`):
- 성공/실패 메시지 (현재 inline text)

**Pure logic TDD**: HelpButton 의 `getHelpContent(pageKey, role): { title, body, nextAction }` 

### UX-8 · 전사 드릴다운 + 이상 감지 배너

**8a. 드릴다운** (KPI.tsx + Inventory.tsx):
- 현재 page → 권역 → 지점 → ISBN 클릭 이동
- breadcrumb 표시
- 신규 라우트 `/inventory/wh/:wh_id`, `/inventory/location/:location_id`, `/inventory/isbn/:isbn13`

**8b. 이상 감지 배너** (KPI.tsx 상단):
- 안전재고 대비 50% 이하 location 수가 N% 초과 시 빨강 배너
- pure logic: `detectAnomaly(heatmap): { critical: number, severity: 'normal'|'warning'|'critical' }` — TDD

**Backend**: `GET /dashboard/locations/heatmap` 이미 존재 — `low_count`, `zero_count` 활용

## 테스트 전략

| 항목 | 테스트 방식 |
|---|---|
| 백엔드 (Python) | pytest + FakeCur stub · TDD red-green |
| 프론트 pure logic | (vitest 추가 X로) Python 으로 TS 동작 확인 어려움 → **TS 자체 file:** assert pattern 또는 별도 .test.ts 작성 시 vitest 셋업 추가 |
| 프론트 컴포넌트 | `.pen` 시각 비교 + 수동 브라우저 검증 |
| 통합 | EKS dev cluster 에 배포 + curl + 브라우저 smoke |

**vitest 추가 결정**: UX-3 의 `classifyStock`, UX-4 의 `computeSurplus`, UX-7 의 `getHelpContent`, UX-8 의 `detectAnomaly` 이렇게 4개 pure 함수가 있으니 추가 가치 있음 → vitest + @testing-library/react 설치, devDep 만 추가 (실행 시 빌드 영향 X).

## 구현 순서 (8 task)

1. **UX-2 frontend** (Requests.tsx 재작성) — backend 이미 완료
2. **UX-7 공통 컴포넌트** (EmptyState, Toast, ConfirmModal) — 이후 task 가 의존
3. **UX-3 권역 히트맵** (WhDashboard) — TDD `classifyStock`
4. **UX-4 타 센터 여유분** (WhTransfer + neue endpoint) — TDD `computeSurplus`
5. **UX-5 지시서 수신함** (WhInstructions + acknowledge endpoint) — TDD `groupByUrgency`
6. **UX-6 지점 거부/조정** (BranchInbound + Manual) 
7. **UX-8 드릴다운 + 이상감지** (KPI + Inventory + 라우트) — TDD `detectAnomaly`
8. **HelpButton 적용** (전 페이지 헤더) — TDD `getHelpContent`

## 검증 (전체 작업 후)

- `cd eks-pods/intervention-svc && py -m pytest tests/ -v` → 모든 테스트 통과
- `cd web && npm run build` → TS 컴파일 0 에러
- `kubectl apply` 후 브라우저 접속 → 8개 갭 항목 모두 동작 확인
- code-reviewer subagent dispatch 후 critical/important 이슈 fix

---

**승인 받음**: 사용자 2026-05-03 "너의 최적의 판단으로 맡길게"
