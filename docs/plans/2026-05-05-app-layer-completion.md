# 애플리케이션 레이어 완성형 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** BookFlow 7 Pod + 1 CronJob 백엔드 애플리케이션 레이어를 "완성형" 으로 — FR-A1~A11 전 항목 + 비기능 요구사항 (자동화 · 일관성 · 회복탄력성) 까지 정합.

**Architecture:** 기존 V6.2 명세 + Schema v3 정합. 새 pod 추가 X · 새 테이블 추가는 명시적 정본 버전업. 변경은 (a) 기존 pod 내 endpoint 추가/보강, (b) 신규 CronJob, (c) 공통 헬퍼 추출, (d) Lambda (Platform repo) 의 4 카테고리.

**Tech Stack:** FastAPI 0.115 + psycopg 3 + Redis 5 (Pub/Sub) + httpx + pytest (FakeCur stub) + AWS Lambda (Python 3.12). 정본 4 문서 (`reference_canonical_bookflow_docs`) 우선 cross-check.

**참조:**
- 정본: `kyobo project/BOOKFLOW/02_아키텍처/V6.2_아키텍처 구성도_1조.pptx` + `01_데이터스키마/BOOKFLOW_Data_Schema_v3.xlsx` + `09_WBS/V4_BOOKFLOW_WBS.xlsx` + `사용기술/구성요소 및 사용 기술 (1).pptx`
- 보조: Notion FR (`33eb434359168145b8e1e85da1cb81d3`), MSA Pod (`343b4343591680648865eec8ddac83fa`)
- Audit: `docs/plans/2026-05-03-pod-fr-audit.md`
- 작업 로그: Notion `355b4343591681178913dc244973cf26`

---

## 📊 현재 상태 (2026-05-05 기준)

### ✅ 완료
- **P1 backend FR 정밀화** 10 task (Tasks 2-10, intervention 권한 / decision cascade SQL · EOQ · INACTIVE / inventory enrichment · 권한 / publisher 풀필드 / dashboard RBAC)
- **UX 8 task** (UX-1~8, frontend + 일부 backend)
- **EKS 통합 검증** (Task 11, 6 시나리오)
- **공통 컴포넌트 5종** (InlineMessage / ConfirmModal / EmptyState / HelpHint / AnomalyBanner)

### 🔍 갭 (5 카테고리)

| 카테고리 | 갭 | Phase | 비고 |
|---|---|---|---|
| **권한 정밀화** | branch-clerk REBALANCE TARGET reject | A1 | UX-6 wiring 완성 |
| | inbound receive endpoint 부재 | A1 | UX-6 수령 버튼 placeholder 상태 |
| | returns 거부 endpoint 부재 | A4 | FR-A6.8 (Optional) |
| **자동화 (FR-A4.3)** | decision-svc Redis 자동 트리거 | B1 | inventory-svc stock.changed 구독 누락 |
| | 동적 safety_stock batch | B2 | FR-A4.2 — 컬럼은 있으나 갱신 X |
| **TTL / 정리** | reservation TTL cleanup CronJob | A2 | 만료 예약이 영구 점유 |
| **알림** | Logic Apps 12 events 풀 커버리지 | A3 | 시트 04 vs notification-svc 코드 cross-check |
| | retry + DLQ | E2 | 비기능 |
| **POS / 데이터 정합** | pos-ingestor inventory 자동 차감 | D1 | Platform Lambda · sales 시 on_hand drift |
| **WebSocket / 실시간** | dashboard-svc /ws broker | B4 | Redis pub/sub → WS forward 미구현 |
| **외부 연동** | auth-pod Entra OIDC | E1 | Azure 환경 의존 |
| | forecast-svc Vertex AI | E2 | GCP 환경 의존 |
| | publisher-watcher real API | E3 | 3rd party 협조 |
| **공통 / 일관성** | 권한 헬퍼 분산 | C1 | 4 pod 마다 `_check_*_perm` 중복 |
| | audit_log middleware | C2 | mutation 마다 수동 INSERT |
| | error response 표준 | C3 | detail string 만 |
| | request_id propagation | C4 | 분산 추적 부재 |
| **검증** | e2e cascade 시나리오 | F1 | POS → spike → decision → intervention → inventory → notification |

---

## 🛣️ Phased Delivery

### Phase A — 즉시 가능 (1-2 일 · 5 task)
사용자 직전 작업 (UX-6) 의 wiring 완성 + 명확한 P2 갭 빠르게 닫기.
- A1: Service Layer Bundle (branch-clerk TARGET reject + inbound receive)
- A2: reservation TTL cleanup CronJob
- A3: Logic Apps 12 events 커버리지 점검
- A4: returns 거부 endpoint (Optional · FR-A6.8)
- A5: error response 표준화

### Phase B — 자동화 핵심 (2-3 일 · 4 task)
FR-A4.3 / A4.2 구현으로 "AI 자동" 명목 달성.
- B1: decision-svc Redis stock.changed 자동 트리거
- B2: 동적 safety_stock batch CronJob
- B3: inventory-svc safety_stock PUT endpoint (B2 가 호출)
- B4: dashboard-svc WebSocket broker (Redis → WS)

### Phase C — Cross-pod 일관성 (1 일 · 4 task)
운영 / 디버깅 편의 + 코드 중복 제거.
- C1: 권한 헬퍼 `_shared/auth_perm.py` 추출
- C2: audit_log middleware (FastAPI dependency)
- C3: error response 표준 형식 (`{code, message, detail, request_id}`)
- C4: request_id propagation (httpx client 자동 헤더)

### Phase D — Platform Lambda (별도 repo · 0.5 일)
POS 사이트 문제 해결 — 재고 drift 차단.
- D1: pos-ingestor Lambda inventory 자동 차감 (atomic SQL UPDATE on conflict)

### Phase E — 외부 연동 (환경 의존 · 시점 미정)
Azure / GCP 환경 활성화 후 처리.
- E1: auth-pod Entra OIDC 실제 구현 (mock JWT → RS256 검증)
- E2: forecast-svc Vertex AI 호출 + 신간 cold start 예측
- E3: publisher-watcher real API 연결 (rate limit · retry)

### Phase F — 통합 검증 (0.5 일)
- F1: 7 pod e2e cascade 시나리오 자동화 (POS sale → 8 events 알림 도달)
- F2: 부하 / 회복탄력성 (pod 1개 down 시 fan-in graceful)

---

## 📦 Phase A 상세 (Task 단위)

각 task 는 `RED / verify-RED / GREEN / verify-GREEN / commit` 5단계.

---

### Task A1: Service Layer Bundle — branch-clerk TARGET reject + inbound receive

**Files:**
- Modify: `eks-pods/intervention-svc/src/routes/intervention.py:103-114` (REBALANCE 분기)
- Modify: `eks-pods/intervention-svc/tests/test_authority.py` (branch-clerk 케이스 5개)
- Create: `eks-pods/intervention-svc/src/routes/intervention.py` 내 `POST /intervention/inbound/{order_id}/receive`
- Modify: `eks-pods/dashboard-svc/src/clients.py` (`post_inbound_receive`)
- Modify: `eks-pods/dashboard-svc/src/routes/aggregate.py` (`POST /dashboard/inbound/{order_id}/receive`)
- Modify: `eks-pods/dashboard-svc/web/src/api.ts` (`postInboundReceive`)
- Modify: `eks-pods/dashboard-svc/web/src/pages/BranchInbound.tsx` (수령 버튼 wiring · approval_side='FINAL' 변경)

**현 상태**: `feat/svc-inbound-receive-and-target-reject` 브랜치에 RED 커밋 (5 unit test 추가 — 1 fail) 진행 중.

**Step 1: GREEN — _validate_authority REBALANCE 분기에 branch-clerk 케이스 추가**

```python
# intervention.py:107 직후 (REBALANCE 분기)
if ctx.role == "branch-clerk":
    if ctx.scope_store_id is None:
        raise HTTPException(403, "branch-clerk scope_store_id 부재")
    if ctx.scope_store_id != target_loc:
        raise HTTPException(403, f"자기 매장만 거부 가능 (scope={ctx.scope_store_id} · target={target_loc})")
    return order_type, source_wh, target_wh
# 기존 wh-manager / 그 외 차단 로직은 그대로
```

**Step 2: Verify GREEN**
Run: `cd eks-pods/intervention-svc && py -m pytest tests/ -v`
Expected: 24 passed (기존 19 + 신규 5)

**Step 3: Commit**

```bash
git add eks-pods/intervention-svc
git commit -m "fix(intervention): REBALANCE FINAL 거부에 branch-clerk 자기 매장 허용 (FR-A6.6)"
```

**Step 4: 신규 endpoint /intervention/inbound/{order_id}/receive — RED**

새 파일 또는 기존 intervention.py 끝에 endpoint 추가. 단위 테스트:

```python
# tests/test_inbound_receive.py 신규
def test_receive_branch_clerk_target_match():
    """branch-clerk 가 자기 매장 inbound 수령 → status=EXECUTED + on_hand += qty"""
    # FakeCur + integration smoke
```

**Step 5: GREEN — endpoint 구현**

```python
@router.post("/inbound/{order_id}/receive")
def receive_inbound(order_id: UUID, ctx: AuthContext = Depends(require_auth)):
    """매장 입고 수령 — pending_orders.status='EXECUTED' + inventory.on_hand += qty.
    
    권한: branch-clerk scope_store_id == target_location_id OR wh-manager target_wh OR hq-admin.
    Single writer 패턴 위반 회피: inventory mutation 은 inventory-svc /adjust 호출.
    """
    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""SELECT order_type, target_location_id, qty, isbn13, status 
                           FROM pending_orders WHERE order_id = %s""", (str(order_id),))
            row = cur.fetchone()
            if row is None:
                raise HTTPException(404, "order not found")
            order_type, target_loc, qty, isbn13, st = row
            if st != 'APPROVED':
                raise HTTPException(409, f"수령은 APPROVED 상태에서만 가능 (현재 {st})")
            target_wh = _location_wh(cur, target_loc)
            
            # 권한 체크
            if ctx.role == "branch-clerk":
                if ctx.scope_store_id != target_loc:
                    raise HTTPException(403, "자기 매장만 수령 가능")
            elif ctx.role == "wh-manager":
                if ctx.scope_wh_id != target_wh:
                    raise HTTPException(403, "자기 권역만 수령 가능")
            elif ctx.role != "hq-admin":
                raise HTTPException(403, "수령 권한 없음")
            
            # status=EXECUTED
            cur.execute("""UPDATE pending_orders SET status='EXECUTED', executed_at=NOW()
                           WHERE order_id = %s""", (str(order_id),))
            cur.execute("""INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, after_state)
                           VALUES ('user', %s, 'inbound.receive', 'pending_orders', %s, %s::jsonb)""",
                        (ctx.user_id, str(order_id), json.dumps({"status": "EXECUTED", "qty": qty})))
        conn.commit()
    
    # inventory-svc /adjust 호출 (delta=+qty · 별도 transaction · 실패 시 status 롤백 X · audit 만 추가)
    try:
        with httpx.Client(timeout=2.0) as c:
            c.post(f"{INVENTORY_SVC_URL}/inventory/adjust",
                   headers={"Authorization": ctx.token},
                   json={"isbn13": isbn13, "location_id": target_loc, "delta": qty, "reason": f"입고수령:{order_id}"})
    except Exception as e:
        log.warning("inventory adjust call failed: %s", e)
    
    # OrderExecuted 알림 (시트04 ④AutoExecutedUrgent variant 또는 신규 추가)
    _notify(ctx.token, "OrderExecuted", severity="INFO", payload={"order_id": str(order_id), "qty": qty})
    
    return {"order_id": str(order_id), "status": "EXECUTED"}
```

**Step 6: Verify GREEN** — 단위 테스트 통과 + EKS 통합 (수령 후 sales-by-store inventory 증가 확인)

**Step 7: dashboard-svc proxy 추가**

```python
# clients.py
async def post_inbound_receive(order_id: str, token: str) -> tuple[int, Any]:
    return await _safe_post(f"{settings.intervention_svc_url}/intervention/inbound/{order_id}/receive", {}, token)

# aggregate.py
@router.post("/inbound/{order_id}/receive")
async def inbound_receive(order_id: str, ctx: AuthContext = Depends(require_auth)):
    sc, data = await post_inbound_receive(order_id, ctx.token)
    return JSONResponse(status_code=sc, content=data or {"detail": "intervention-svc unavailable"})
```

**Step 8: Frontend wiring**

```typescript
// api.ts
export const postInboundReceive = (role: Role, order_id: string) =>
  postJson<{ order_id: string; status: string; detail?: string }>(`/dashboard/inbound/${order_id}/receive`, role, {});

// BranchInbound.tsx — handleReceiveConfirm 수정
const receiveMu = useMutation({
  mutationFn: (id: string) => postInboundReceive(role, id),
  onSuccess: (r) => {
    if (r.detail) throw new Error(r.detail);
    setFeedback({ type: 'success', msg: `수령 완료 — 매장 재고에 ${r.qty}권 반영` });
    qc.invalidateQueries({ queryKey: ['instr-all', role] });
  },
});
const handleReceiveConfirm = () => receiveTarget && receiveMu.mutate(receiveTarget.order_id);
```

**Step 9: 또한 거부 body 수정**

```typescript
// approval_side: 'TARGET' → 'FINAL' (REBALANCE 가 흔하므로 FINAL · WH_TRANSFER 는 store target 없음)
reject.mutate({
  order_id: rejectTarget.order_id,
  approval_side: 'FINAL',  // ← 변경
  reject_reason: reasonText,
});
```

**Step 10: Commit + bundle PR**

```bash
git add eks-pods/intervention-svc eks-pods/dashboard-svc
git commit -m "feat(svc): inbound receive endpoint + branch-clerk REBALANCE FINAL 거부 wiring (UX-6 완성)"
git push -u origin feat/svc-inbound-receive-and-target-reject
```

---

### Task A2: reservation TTL cleanup CronJob

**Files:**
- Create: `eks-pods/inventory-svc/src/cron/reservation_cleanup.py`
- Create: `eks-pods/inventory-svc/k8s/cronjob-reservation-cleanup.yaml`
- Modify: `eks-pods/inventory-svc/Dockerfile` (cron entrypoint 분기)

**Schema v3 reservations 테이블**: `ttl TIMESTAMPTZ`, `status VARCHAR(20) DEFAULT 'ACTIVE'`. ttl < NOW() AND status='ACTIVE' 인 row 를 status='EXPIRED' 로 + inventory.reserved_qty 차감.

**Step 1: RED — pure helper `_expire_reservation` 단위 테스트**

```python
# tests/test_reservation_cleanup.py
def test_expire_query_finds_overdue_active():
    """ttl < NOW() + status=ACTIVE 인 row 만 SELECT (FakeCur 검증)"""
```

**Step 2: GREEN**

```python
# cron/reservation_cleanup.py
def main():
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute("""
            WITH expired AS (
                SELECT reservation_id, isbn13, location_id, qty
                  FROM reservations
                 WHERE ttl < NOW() AND status = 'ACTIVE'
                 FOR UPDATE SKIP LOCKED
                 LIMIT 1000
            ),
            updated AS (
                UPDATE reservations r SET status='EXPIRED'
                  FROM expired e WHERE r.reservation_id = e.reservation_id
                  RETURNING r.reservation_id
            )
            UPDATE inventory i SET reserved_qty = reserved_qty - e.qty, updated_at=NOW()
              FROM expired e
             WHERE i.isbn13 = e.isbn13 AND i.location_id = e.location_id
        """)
        conn.commit()
```

**Step 3: CronJob k8s manifest** — schedule `*/5 * * * *` (5분마다)

**Step 4: Commit + 별도 PR**

---

### Task A3: Logic Apps 12 events 커버리지 점검

**Files:**
- Audit: `eks-pods/notification-svc/src/routes/notification.py` 의 `EVENT_*` 상수 vs 시트 04 12 events
- Possibly modify: 누락 event 추가 (예: OrderExecuted, ReturnApproved 등)
- Reference: `kyobo project/BOOKFLOW/01_데이터스키마/BOOKFLOW_Data_Schema_v3.xlsx` 시트 04

**Step 1**: notification.py 의 dispatch 함수가 시트 04 의 12 event 중 어느 것을 covers / misses 매핑 (스프레드시트 컬럼 vs 코드 grep)

**Step 2**: 누락 event 추가 + Logic Apps endpoint 매핑

**Step 3**: 단위 테스트 (FakeRedis · FakeHTTPX) 로 dispatch 분기 검증

---

### Task A4: returns 거부 endpoint (Optional · FR-A6.8)

**Files:**
- Add: `eks-pods/intervention-svc` `POST /intervention/returns/{return_id}/reject`
- Frontend: `Returns.tsx` 거부 버튼

**Step 1**: TDD — branch-clerk / wh-manager / hq-admin 권한 매트릭스 + reject_reason

**Step 2**: GREEN — UPDATE returns SET status='REJECTED' + reject_reason

---

### Task A5: error response 표준화 (cross-pod)

**Files:**
- Create: `eks-pods/_shared/error_response.py` (또는 각 pod 동일 카피)
- Modify: 모든 pod 의 main.py 에 `register_exception_handler`

**Step 1**: Pydantic 모델

```python
class ErrorResponse(BaseModel):
    code: str          # e.g. "INVENTORY_INSUFFICIENT"
    message: str       # 사용자 한글 메시지
    detail: dict | None = None  # 추가 컨텍스트
    request_id: str | None = None
```

**Step 2**: FastAPI exception handler — HTTPException → ErrorResponse

**Step 3**: 점진 적용 (각 pod 마다 별도 PR)

---

## 📦 Phase B 상세 (Task 단위)

### Task B1: decision-svc Redis stock.changed 자동 트리거 (FR-A4.3)

**Files:**
- Create: `eks-pods/decision-svc/src/listener.py` (Redis subscriber)
- Modify: `eks-pods/decision-svc/src/main.py` (background task 시작)

**Architecture:**
- inventory-svc 가 `stock.changed` channel 에 publish 하는 payload `{isbn13, location_id, available, ts}`
- decision-svc background task 가 subscribe → available < safety_stock 이면 internal `/decide` 자동 호출
- 동일 isbn 에 대한 중복 발의 방지: Redis SETNX `decide-lock:{isbn13}:{loc_id}` 30s TTL

**Step 1: RED** — `_should_auto_decide(available, safety, current_pending)` pure helper

**Step 2: GREEN** — listener + lock + /decide 호출

---

### Task B2: 동적 safety_stock batch CronJob (FR-A4.2)

**Files:**
- Create: `eks-pods/decision-svc/src/cron/safety_stock_update.py`
- Migration: `inventory.safety_stock` 컬럼 이미 있음 (NULL 가능 · 0 default)

**공식**: safety_stock = z_score × σ_demand × √(lead_time_days) · 단순화: 14일 평균 일일 수요 표준편차 × 1.65 (z=95%) × √(평균 lead time 7일)

**Step 1: RED** — `_calc_safety_stock(daily_demand_std, lead_time_days, z=1.65)` pure helper

**Step 2: GREEN** — 매일 03:00 KST CronJob, 모든 (isbn, location) 쌍에 대해 forecast_cache + sales_realtime 14일치로 std 계산 → safety_stock UPDATE

---

### Task B3: inventory-svc safety_stock PUT endpoint

**Files:**
- Modify: `eks-pods/inventory-svc/src/routes/inventory.py`

```python
@router.put("/safety-stock")
def update_safety_stock(req: SafetyStockUpdateRequest, ctx: AuthContext = Depends(require_auth)):
    """B2 batch 또는 hq-admin 수동 갱신용. body: {isbn13, location_id, safety_stock}"""
    # 권한: hq-admin 또는 system role only
    # UPDATE inventory SET safety_stock = %s ...
```

---

### Task B4: dashboard-svc WebSocket broker

**Files:**
- Modify: `eks-pods/dashboard-svc/src/routes/ws.py` (현재 stub)

**Architecture:**
- 클라이언트 `ws://nlb/ws` 연결
- Redis pub/sub `stock.changed` + `order.pending` + `spike.detected` + `newbook.request` 4 채널 구독
- 클라이언트로 JSON forward
- 권한 분기: branch-clerk 는 자기 매장 관련 메시지만 (filter)

**Step 1: RED** — `_filter_event_for_role(ctx, channel, payload)` pure 테스트

**Step 2: GREEN** — FastAPI WebSocket + Redis subscriber background task

---

## 📦 Phase C 상세

### Task C1: 권한 헬퍼 공통화

`eks-pods/_shared/auth_perm.py` 생성 — `_check_store_scope`, `_check_wh_scope`, `_check_inbound_target_perm` 등 4 pod 에서 동일 패턴 추출.

각 pod Dockerfile 에 `COPY _shared/ ./_shared/` 추가.

### Task C2: audit_log middleware

FastAPI dependency `audit_action(action: str, entity_type: str)` — 모든 mutation endpoint 에 `audit_action("decision.create", "pending_orders")` 추가하면 자동으로 audit_log INSERT.

### Task C3: error response 표준 — Phase A5 후속 적용

### Task C4: request_id propagation

`httpx` client request hook 으로 `X-Request-ID` 자동 설정 + 받는 pod 에서 contextvar 저장 → audit_log + error response 포함.

---

## 📦 Phase D 상세 (Platform repo)

### Task D1: pos-ingestor Lambda inventory 자동 차감

**Files (Platform repo):**
- Modify: `infra/aws/lambda/pos-ingestor/handler.py`

**현재**: `sales_realtime` INSERT + `spike_events` INSERT 만.

**추가 로직**:
```python
# 각 sale 마다
cur.execute("""
    UPDATE inventory SET on_hand = on_hand - %s, updated_at=NOW()
     WHERE isbn13 = %s AND location_id = %s
       AND on_hand >= %s
    RETURNING on_hand
""", (qty, isbn13, store_id, qty))
row = cur.fetchone()
if row is None:
    # 재고 부족 — alert 또는 spike-detect 가 처리
    pass
```

**Atomic** — `WHERE on_hand >= qty` 로 negative 방지. 동시성 OK (PG row-level lock).

---

## 📦 Phase E 상세 (외부 환경)

### Task E1: auth-pod Entra OIDC 실 구현
- mock JWT (mock-token-{role}) → RS256 검증
- Entra ID JWKS endpoint (https://login.microsoftonline.com/{tenant}/discovery/keys)
- Redis cache `jwks:entra` 600s TTL (시트 04)

### Task E2: forecast-svc Vertex AI 통합
- VPC Peering / VPN 으로 GCP Vertex AI Endpoint 호출
- `forecast_cache` 채우는 daily batch + 실시간 신간 cold start

### Task E3: publisher-watcher real API
- 출판사 API endpoint 받으면 PUBWATCH_PUBLISHER_API_URL 환경변수 설정
- 현재 stub-mode 코드는 그대로 동작

---

## 📦 Phase F 상세 (검증)

### Task F1: e2e cascade 시나리오 자동화 스크립트
- POS sale 시뮬레이션 → spike-detect 트리거 → decision /decide 자동 발의 → intervention 승인 → inventory 차감 → notification 8 events 도달
- pytest 또는 bash + curl 으로 시나리오 1개 통과 확인

### Task F2: 부하 / 회복탄력성
- 1 pod kill 후 재시작 → 다른 pod 영향 없음 (graceful degradation)
- dashboard-svc fan-in 부분 응답 (`_partial_failures`) UI 반영

---

## 🚦 검증 (전체 plan 끝나면)

1. **단위 테스트**: 각 pod `py -m pytest tests/ -v` 모두 GREEN
2. **EKS 배포 + 통합 시나리오**: F1 스크립트
3. **Notion dev log + plan 체크박스 갱신**

---

## 📝 Critical files (Phase A 우선)

| 파일 | 변경 |
|---|---|
| `eks-pods/intervention-svc/src/routes/intervention.py` | A1: REBALANCE branch-clerk + receive endpoint |
| `eks-pods/intervention-svc/tests/test_authority.py` | A1: 5 신규 케이스 |
| `eks-pods/dashboard-svc/src/clients.py` | A1: post_inbound_receive |
| `eks-pods/dashboard-svc/src/routes/aggregate.py` | A1: /inbound/{id}/receive proxy |
| `eks-pods/dashboard-svc/web/src/api.ts` | A1: postInboundReceive |
| `eks-pods/dashboard-svc/web/src/pages/BranchInbound.tsx` | A1: 수령/거부 wiring |
| `eks-pods/inventory-svc/src/cron/reservation_cleanup.py` | A2: 신규 |
| `eks-pods/notification-svc/src/routes/notification.py` | A3: 누락 event 추가 |

---

## 🎯 실행 모드

이 plan 은 **여러 세션에 걸쳐 단계 실행** (Phase A → B → C → D → E → F).

각 task 완료 시:
- TDD red-green cycle
- 작은 commit · feature 별 브랜치
- 2-3 task 묶어 PR (메모리 `feedback_pr_bundle_2_to_3_tasks`)
- Notion dev log append
- 정본 문서 변경 시 버전업 (메모리 `feedback_canonical_doc_version_bump`)

막히면 사용자 즉시 알림 (실패 task ID + 원인).
