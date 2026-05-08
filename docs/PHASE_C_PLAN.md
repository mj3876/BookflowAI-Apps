# Phase C · BookFlow 정합성 + UX 완성형 Plan

> **baseline**: `docs/ROLE_RESPONSIBILITY.md` (R&R 매트릭스 382 lines)
> **본질**: backend endpoint × frontend page × FR-A1~A11 의 **정합성** + **사용자 직관성**. 신규 페이지 우선 X · 정합성 우선 O.
> **검증**: backend 7 Pod (45 endpoint) + frontend 20 페이지 vs R&R 매트릭스 cross-check 완료 · 정합도 ~92% · 갭 5건 확인 + 사용자 직접 지적 1건 (P0-1 로그아웃)
> **작성**: 2026-05-08

---

## 카테고리

| 카테고리 | 내용 |
|---|---|
| **P0** | 시연 시 즉시 막히는 회귀/버그 |
| **P1** | R&R 매트릭스 갭 (backend ↔ frontend 정합) |
| **P2** | 사용자 직관성 (Home · ConfirmModal · EmptyState · workflow link) |
| **P3** | 명칭 정정 (R&R 와 mismatch 한 카피) |

---

## P0 — Bug fix (즉시)

### P0-1. 로그아웃 안 되는 문제
- **현상**: 로그아웃 클릭 → 새로고침하면 자동 재로그인됨
- **원인**: `Layout.tsx:97` 의 `onLogout = () => { setRole(null); nav('/login') }` 가 localStorage 만 지움. auth-pod 의 `/auth/logout` (Entra end_session redirect + httpOnly cookie `bookflow_session` 삭제) 호출 안 함 → cookie 살아있음 → `fetchSessionRole()` 가 `/auth/whoami` 로 cookie 검증 → 재진입
- **fix**: `onLogout` 을 `window.location.href = '/auth/logout'` 으로 변경. auth-pod 가 cookie 삭제 + Entra logout flow 처리. mock 로그인 사용자는 어차피 cookie 없으니 그대로 SPA 의 /login 진입.
- **위치**: `eks-pods/dashboard-svc/web/src/Layout.tsx:97`
- **작업량**: S (1 줄)
- **검증**: Microsoft 로그인 → 로그아웃 → 새로고침 시 /login 화면 그대로

---

## P1 — R&R 매트릭스 갭 (정합성)

### P1-1. BranchCuration 입고 요청 actions (G1-2)
- **R&R**: line 145 — `POST /notification/send` event=StockArrivalPending (BranchCuration 의 "입고 요청" 버튼 → WH 알림)
- **현 상태**: api.ts `postNotifySend()` 존재 · backend notification-svc dispatcher 준비 · **frontend onClick 가 `alert()` 만 호출**
- **fix**: `BranchCuration.tsx:120` 의 alert → `postNotifySend({ event_type: 'StockArrivalPending', payload: { isbn13, title, store_id, store_name } })` 실 호출 + ConfirmModal (P2-2 와 통합 가능)
- **작업량**: S

### P1-2. BranchInbound 입고 거부 UI (G4)
- **R&R**: line 141 — `POST /intervention/inbound/{order_id}/reject` (수량 불일치/파손/누락 시 거부 + reason)
- **현 상태**: backend `/intervention/inbound/{order_id}/reject` 구현됨 · api.ts `postInboundReject()` 존재 · **BranchInbound.tsx 에 거부 버튼 없음**
- **fix**: BranchInbound.tsx 에 "입고 거부" 버튼 + reason 입력 (ConfirmModal · P2-2 와 통합)
- **작업량**: S

### P1-3. Branch 반품 신청 endpoint 미구현 (G1-1)
- **R&R**: line 143 — `POST /returns/request` (Branch 입고 후 파손/누락 발견 → returns INSERT status=REQUESTED → HQ Returns 큐)
- **현 상태**: intervention-svc 에 endpoint 없음 · dashboard-svc proxy 없음 · api.ts wrapper 없음
- **fix**:
  1. `intervention-svc/src/routes/returns.py` 에 `POST /returns/request` 추가 (role=branch-clerk · scope=자기 매장 only · returns INSERT)
  2. `dashboard-svc/src/routes/aggregate.py` proxy 또는 ingress 직접
  3. `api.ts` wrapper `postReturnsRequest()`
  4. `BranchInbound.tsx` (또는 BranchInventory) 에 "반품 신청" 버튼
- **작업량**: M

### P1-4. FR-A4.7 자동 발주 CronJob 검증
- **R&R**: line 222 — 07:00 KST CronJob `intervention-auto-execute` 가 URGENT/CRITICAL Stage 3 + auto_execute_eligible=True 자동 승인 → notification ④AutoExecutedUrgent
- **현 상태**: task #34 completed 표시 · 실 cluster 에 CronJob 존재 (`kubectl get cronjobs` 확인됨) · 코드 위치 미확인
- **fix**: intervention-svc 의 CronJob YAML + handler 검증 → 시연용 dummy 데이터 (auto_execute_eligible=True 인 PENDING) 준비 → 다음 cron 실행 시 동작 검증 → notifications_log 에 ④AutoExecutedUrgent INSERT 확인
- **작업량**: M (검증 위주 · 누락 시 구현)

### P1-5. R&R 문서 정정 (G2)
- 명세 갱신만:
  - `POST /intervention/reject` 명시 추가 (현 line 103 "거부" 만 있고 endpoint 명시 없음)
  - 13번째 이벤트 `OrderExecuted` (A1 매장 입고 수령 시) 시트04 추가 — 현 코드 line 757 발행 중
  - `/decision/pending-orders` vs `/dashboard/pending` 중복 정리 — `/dashboard/pending` 으로 통일 권장
- **작업량**: S (문서만)

### P1-6. 사용자 action 표준 (피드백 + ErrorResponse)
> 이 항목 = task #60 (Phase A4+A5: returns reject endpoint + ErrorResponse 표준 · pending) 의 SPA 측면 + backend 통합

- **현 상태**: 액션 마다 try/catch + alert("...") 또는 console.log + queryClient.invalidateQueries 흩어져 있음. 백엔드 throw 시 응답 형식 제각각 (HTTPException · raise · etc).
- **목표**: 모든 사용자 action (R&R 1.2/2.2/3.2 의 ~17 개) 이:
  1. 클릭 → ConfirmModal 로 의사 확인 (P2-1)
  2. submit → loading state (버튼 disabled)
  3. 성공 → toast/inline 성공 메시지 + react-query invalidate (자동 갱신)
  4. 실패 → ErrorResponse 표준 (`{code, message, details}`) 사용자 친화 표시 (권한 없음 / 비즈니스 룰 위반 / 일시 오류 구분)
- **fix**:
  - backend 공통 ErrorResponse pydantic model (intervention-svc pilot · 모든 throw 변환)
  - frontend 공통 `useActionMutation` hook (mutate + onSuccess invalidate + onError ErrorResponse 파싱 + toast)
  - components/Toast.tsx 신규
- **작업량**: M

---

## 사용자 action 매트릭스 — R&R 1.2/2.2/3.2 점검표

> Phase C 완료 시점 모든 액션이 ✓ 가 되어야 시연 가능. P0/P1/P2 task 들이 이 표의 빈칸을 채우는 것이 핵심.

| 역할 | 액션 | 페이지 | endpoint | 버튼 | 확인 | 피드백 | 권한 | task |
|---|---|---|---|---|---|---|---|---|
| HQ | 의사결정 발의 | Decision | POST /decision/decide | ✓ | prompt | alert | ✓ | P2-1 |
| HQ | Stage 3 단독 승인 | Approval | POST /intervention/approve | ✓ | prompt | alert | ✓ | P2-1 |
| HQ | 신간 편입 결정 | Requests | POST /intervention/new-book-requests/{id}/approve | ✓ | inline | alert | ✓ | P2-1 |
| HQ | 신간 거절 | Requests | POST /intervention/new-book-requests/{id}/reject | ✓ | inline | alert | ✓ | P2-1 |
| HQ | 도서 ON/OFF | Books | POST /intervention/books/{isbn13}/status | ✓ | inline | alert | ✓ | P2-1 |
| HQ | 반품 승인 | Returns | POST /intervention/returns/approve | ✓ | inline | alert | ✓ | P2-1 |
| HQ | 반품 거부 | Returns | POST /intervention/returns/reject | ✓ | prompt | alert | ✓ | P2-1, P1-6 |
| WH | Stage 1 승인 | WhApprove | POST /intervention/approve | ✓ | prompt | alert | ✓ | P2-1 |
| WH | Stage 2 SOURCE/TARGET | WhTransfer | POST /intervention/approve | ✓ | inline | alert | ✓ | P2-1 |
| WH | Stage 3 자기 권역 | WhApprove | POST /intervention/approve | ✓ | prompt | alert | ✓ | P2-1 |
| WH | 거부 | WhApprove · WhTransfer | POST /intervention/reject | ✓ | prompt | alert | ✓ | P2-1, P1-5 |
| Branch | **입고 수령** | BranchInbound | POST /intervention/inbound/{order_id}/receive | ✓ | inline | alert | ✓ | P2-1 |
| Branch | **입고 거부** | BranchInbound | POST /intervention/inbound/{order_id}/reject | **✗** | — | — | — | **P1-2** |
| Branch | 재고 수동 조정 | Manual | POST /inventory/adjust | ✓ | inline | alert | ✓ | P2-1 |
| Branch | **반품 신청** | BranchInbound | POST /returns/request | **✗ endpoint 없음** | — | — | — | **P1-3** |
| Branch | **입고 요청 발의** | BranchCuration | POST /notification/send | **✗ alert만** | — | — | — | **P1-1** |
| Branch | 진열 결정 마킹 | BranchCuration | (Phase 2 — localStorage / audit_log 보조) | — | — | — | — | 선택 |

**미구현 4개**: P1-1 입고 요청 actions · P1-2 입고 거부 UI · P1-3 반품 신청 endpoint · (P1-6 일괄 ErrorResponse 표준)

**확인/피드백 일괄 표준화**: P2-1 ConfirmModal + P1-6 toast + ErrorResponse 가 17 액션 모두에 적용되어야 시연 가능.

---

## P2 — 사용자 직관성

### P2-1. ConfirmModal 적용 (prompt 대체)
- **현 prompt() 사용 페이지 3개**: Approval.tsx · Returns.tsx · WhApprove.tsx
- **+ 신규 통합**: BranchCuration 입고 요청 (P1-1) · BranchInbound 입고 거부 (P1-2)
- **방식**: `components/ConfirmModal.tsx` (이미 존재) 사용 — title + reason input + cancel/confirm
- **작업량**: S (5 페이지 일괄)

### P2-2. EmptyState 표준화
- **현 적용 3 페이지**: BranchCuration · BranchInbound · Inventory
- **미적용 17 페이지** 일괄 (KPI · Books · Decision · Approval · Returns · Requests · Spikes · Notifications · LiveEvents · WhDashboard · WhApprove · WhTransfer · WhInstructions · BranchInventory · BranchSales · Manual · Login)
- **방식**: `q.data?.items.length === 0 && !q.isLoading && <EmptyState message="..." hint="..." />` 패턴 일괄 추가
- **작업량**: M (반복 · 30분)

### P2-3. Home 3 페이지 (HQ/WH/Branch)
- **R&R 1.4 / 2.4 / 3.4 의 "🆕 신규"**:
  - **HQ Home**: 오늘 PENDING 카운트 (Decision/Approval/Returns/Requests) + 매출 요약 + 24h 급등 카운트 + 다음 액션 링크
  - **WH Home**: 권역 한눈에 + PENDING 4 카테고리 (rebalance/transfer-source/transfer-target/publisher) + 출고 지시 카운트
  - **Branch Home**: 매장 한눈에 + 오늘 입고 카운트 + SNS 급등 도서 (매장 재고 매칭) + 부족 SKU
- **백엔드**: 새 endpoint 없음 (existing fan-in 재사용 — `/dashboard/sales-summary` `/dashboard/pending` `/dashboard/overview/{wh_id}` `/dashboard/store-inventory/{store_id}` `/dashboard/curation/{store_id}` `/dashboard/spike-events`)
- **frontend**: 3 페이지 신규 + Layout.tsx NAV 첫 항목 + `/` 진입 시 role 별 자동 redirect (`<Route path="/" element={<Navigate to={homePath(role)} />}/>`)
- **작업량**: M (3 페이지 + Layout 변경 + Index redirect)

### P2-4. 페이지 헤더 + workflow link
- **R&R 5. 시나리오 A-E 의 chain** 을 각 페이지의 "다음 단계" 링크로 노출
- 예시:
  - Decision (발의 완료) → "WH Approve 에서 승인 대기 중 (n건)" 링크
  - Approval (Stage 3 승인 완료) → "WH 출고 지시서 생성됨"
  - WhTransfer (양측 승인 완료) → "EXECUTED → BranchInbound 큐"
  - BranchInbound (수령 완료) → "재고 갱신됨 · 매장 재고 페이지에서 확인"
- **작업량**: M (~10 페이지)

### P2-5. Spike → Decision pre-fill
- **R&R 5.E SNS 급등 시나리오**: Spikes 페이지의 도서 클릭 → Decision 페이지로 ISBN/매장 pre-fill
- **방식**: `<Link to={`/decision?isbn=${isbn13}&urgency=CRITICAL`}>` + Decision.tsx 의 useSearchParams 로 form 초기값
- **작업량**: S

---

## P3 — 명칭 정정

### P3-1. "진열 추천" 명칭 mismatch
- **사용자 지적**: "진열 추천" 자체가 실제 기능이 아님. **SNS 급등 도서 + 매장 재고 매칭 추천**이 정확.
- **변경**:
  - 페이지 헤더 (`BranchCuration.tsx`): "{매장명} · 진열 추천" → "{매장명} · SNS 급등 도서 (매장 재고)"
  - 사이드바 desc (`Layout.tsx:38`): "화제 도서 중 우리 매장에 있는 책 우선 진열" → "최근 24시간 화제가 된 도서 (매장 재고 매칭)"
  - HelpHint: "SNS 언급량 z-score ≥ 0.5" 그대로 유지 (이건 정확한 기준)
  - PAGE_LABEL (`Layout.tsx:76`): "branch-curation": "큐레이션" → "SNS 급등 도서"
- **R&R 문서 갱신**: line 134, 161, 322 의 "진열 추천" 표현 정정
- **작업량**: S

---

## 진행 순서

| # | task | 작업량 | 비고 |
|---|---|---|---|
| 1 | **P0-1** 로그아웃 fix | S | 즉시 시연 막힘 |
| 2 | **P3-1** 명칭 정정 | S | UX 일관성 + 사용자 지적 직접 |
| 3 | **P2-1** ConfirmModal + **P1-1** BranchCuration 입고 요청 + **P1-2** BranchInbound 입고 거부 | S+S+S | 한 commit (관련 UX) |
| 4 | **P1-3** Branch 반품 신청 endpoint | M | backend + frontend |
| 5 | **P1-4** 자동 발주 CronJob 검증 | M | 시연 시나리오 검증 |
| 6 | **P2-2** EmptyState 17 페이지 일괄 | M | 반복 |
| 7 | **P2-3** Home 3 페이지 | M | role 별 진입 |
| 8 | **P2-4** workflow link | M | 시나리오 A-E 연계 |
| 9 | **P2-5** Spike pre-fill | S | E 시나리오 마무리 |
| 10 | **P1-5** R&R 문서 정정 | S | 마지막 정합 |

각 단계 완료 후 cicd 트리거 + 시연 검증 → 다음.

---

## 검증 결과 요약 (agent 분석)

### 시나리오 A-E (R&R line 181~263) — 모두 정합 ✓
| 시나리오 | 상태 |
|---|---|
| A. 신간 추론 (publisher-watcher → Requests → Approve → BranchInbound) | ✓ |
| B. 재고 발주 (Decision → cascade → Approval) | ✓ |
| C. 권역 이동 (Stage 2 양측 승인) | ✓ |
| D. 지점 재고 조정 (Manual → /inventory/adjust) | ✓ |
| E. SNS 급등 (Spike → Decision pre-fill → auto-execute) | ✓ (UI pre-fill 만 미구현 — P2-5) |

### FR-A1~A11 정합 (14항목 검증)
모두 backend 구현 ✓ — 단 **FR-A4.7 자동 발주 CronJob** 코드 위치 미확인 → P1-4 검증 task

### 12 알림 (시트04)
| 발행 중 | 누락 (코드 미제시) |
|---|---|
| ① OrderPending · ② OrderApproved · ③ OrderRejected · ⑧ StockArrivalPending (wrapper) · ⑨ NewBookRequest · ⑩ ReturnPending · +1 OrderExecuted | ④ AutoExecutedUrgent · ⑤ AutoRejectedBatch · ⑥ SpikeUrgent · ⑦ StockDepartPending · ⑪ LambdaAlarm · ⑫ DeploymentRollback |

누락 6개는 CronJob/Lambda/외부 시스템 범위 — Phase C 범위 밖 (P1-4 + Phase 4)

---

## Phase C 범위 밖

- 시트 04 누락 알림 6개 (CronJob/Lambda/외부)
- LiveEvents WebSocket 4채널 — Phase 3+ deploy
- forecast-svc D+2~5 BQ proxy — Phase 4
- auth-pod Entra OIDC 풀 (현 mock + cookie session 으로 시연 가능)
