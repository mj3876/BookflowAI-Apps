# P1 Backend FR 정밀화 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Pod audit (`docs/plans/2026-05-03-pod-fr-audit.md`) 에서 발견된 P1 11개 갭 + 권한 명세 모순 2건을 TDD 사이클로 정밀 구현하여 모든 backend pod 가 FR-A1~A11 명세에 부합하도록.

**Architecture:** decision-svc 의 cascade 알고리즘 (EOQ + 동적 안전재고 + 정밀 여유분), inventory-svc 의 권한 정정 + 응답 enrichment + POS 자동 차감, publisher-watcher 의 books upsert + 풀 필드 파싱, dashboard-svc 의 RBAC scope 강제. 각 pod 는 단일 책임 유지, single writer 패턴 (inventory-svc만 inventory mutation).

**Tech Stack:** FastAPI 0.115 + psycopg 3 + Redis 5 (이벤트 버스) + pytest (FakeCur stub 패턴) + httpx (pod 간 호출). DB 마이그레이션은 ansible-node SSM send-command 패턴 (`reference_rds_schema_drift.md` 참고).

**참조 문서:**
- Audit 결과: `docs/plans/2026-05-03-pod-fr-audit.md`
- FR 본문: Notion `33eb434359168145b8e1e85da1cb81d3`
- 권한 결정: 메모리 `project_authority_clarifications_2026_05_03.md`
- .pen 디자인: `eks-pods/uiux.pen` 

---

## Task 그룹 구성

각 task 는 **Files / RED / verify-RED / GREEN / verify-GREEN / commit** 5단계 bite-sized.

**T1 그룹 (decision-svc 권한 + cascade 정밀화)** — P1 #1, #4, #5, #6 + 명세모순(a)
**T2 그룹 (intervention 권한 매트릭스 갱신)** — 명세모순(a) tests + (b) preview
**T3 그룹 (inventory-svc 권한 flip + 응답 enrichment)** — P1 #8, #9 + 명세모순(b)
**T4 그룹 (POS Lambda 자동 차감)** — P1 #7
**T5 그룹 (publisher-watcher 풀 파싱 + books upsert)** — P1 #11
**T6 그룹 (dashboard-svc RBAC scope_store_id)** — P1 #10
**T7 (P2 보너스 안 막힘 영역)** — reservation TTL cleanup, 동적 안전재고 batch (옵셔널)

---

## Task 1: decision-svc PUBLISHER_ORDER 권한 확장 (명세모순 a)

**Files:**
- Modify: `BookFlowAI-Apps/eks-pods/intervention-svc/src/routes/intervention.py:130-136`
- Modify: `BookFlowAI-Apps/eks-pods/intervention-svc/tests/test_authority.py` (PUBLISHER_ORDER 케이스 보강)

**Step 1: RED — wh-manager 가 자기 wh 의 PUBLISHER_ORDER 승인 가능해야 한다는 테스트 추가**

```python
# tests/test_authority.py 끝에 추가
def test_publisher_order_wh_manager_own_wh_ok():
    """wh-manager 가 자기 wh 가 target_wh 인 PUBLISHER_ORDER 를 승인할 수 있어야 함."""
    cur = _cur("PUBLISHER_ORDER", None, 3, {3: 1})
    ot, *_ = _validate_authority(cur, _ctx("wh-manager", 1), "x", "FINAL")
    assert ot == "PUBLISHER_ORDER"


def test_publisher_order_wh_manager_other_wh_403():
    """wh-manager 가 타 wh 의 PUBLISHER_ORDER 는 거절되어야 함."""
    cur = _cur("PUBLISHER_ORDER", None, 3, {3: 1})
    with pytest.raises(HTTPException) as e:
        _validate_authority(cur, _ctx("wh-manager", 2), "x", "FINAL")
    assert e.value.status_code == 403
```

**Step 2: Verify RED**
Run: `cd BookFlowAI-Apps/eks-pods/intervention-svc && py -m pytest tests/test_authority.py::test_publisher_order_wh_manager_own_wh_ok -v`
Expected: FAIL with 403 (현재 hq-admin only 차단)

**Step 3: GREEN — intervention.py PUBLISHER_ORDER 분기 확장**

```python
# intervention.py:130-136 (기존 elif PUBLISHER_ORDER 블록 교체)
elif order_type == "PUBLISHER_ORDER":
    if side != "FINAL":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail="PUBLISHER_ORDER 는 approval_side='FINAL' 만 허용")
    if ctx.role == "hq-admin":
        return order_type, source_wh, target_wh
    if ctx.role == "wh-manager" and ctx.scope_wh_id is not None:
        if ctx.scope_wh_id == target_wh:
            return order_type, source_wh, target_wh
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                            detail=f"PUBLISHER_ORDER 는 자기 권역 (target_wh={target_wh}) 만 승인 가능 (scope_wh_id={ctx.scope_wh_id})")
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                        detail="PUBLISHER_ORDER 는 hq-admin 또는 자기 권역 wh-manager 만 승인 가능")
```

**Step 4: Verify GREEN**
Run: `py -m pytest tests/ -v`
Expected: 22 passed (기존 20 + 신규 2). 기존 `test_publisher_order_wh_manager_403` 가 깨질 수 있음 — 그 테스트는 wh-manager-1 이 target_wh=1 PUBLISHER_ORDER 를 거절당하도록 잘못 가정 → 갱신 필요 (`scope=2` 일 때 거절로 변경).

**Step 5: Commit**
```bash
git add eks-pods/intervention-svc
git commit -m "fix(intervention): PUBLISHER_ORDER 승인 권한 wh-manager (자기 권역) 추가 (FR 권한매트릭스 정합)"
```

---

## Task 2: inventory-svc adjust 권한 flip (명세모순 b)

**Files:**
- Modify: `BookFlowAI-Apps/eks-pods/inventory-svc/src/routes/inventory.py:60-112`
- Create: `BookFlowAI-Apps/eks-pods/inventory-svc/tests/test_adjust_authority.py`

**Step 1: RED — branch-clerk 가 자기 매장 inventory 만 adjust 가능 + 타 매장은 403**

```python
# tests/test_adjust_authority.py
import pytest
from src.auth import AuthContext

# inventory.py 의 권한 검증 헬퍼를 추출 후 직접 테스트
# 또는 FastAPI TestClient 로 endpoint 테스트
```

(자세한 RED test 케이스는 TDD red 단계에서 inventory.py 의 코드 구조 보고 확정)

**Step 2: Verify RED** — endpoint 호출 시 branch-clerk 차단 확인

**Step 3: GREEN — 권한 행렬 적용**

```python
# inventory.py 의 adjust 권한 분기:
if ctx.role == "hq-admin":
    pass  # 모든 location OK
elif ctx.role == "wh-manager":
    if not _location_in_wh(cur, location_id, ctx.scope_wh_id):
        raise 403
elif ctx.role == "branch-clerk":
    if ctx.scope_store_id != location_id:
        raise 403
else:
    raise 403
```

**Step 4: Verify GREEN** — 4가지 시나리오 통과 (admin OK, wh own OK, wh other 403, branch own OK, branch other 403)

**Step 5: Commit**
```bash
git commit -m "fix(inventory): branch-clerk inventory adjust 허용 (scope_store_id 검증) - FR 권한매트릭스 + .pen 정합"
```

---

## Task 3: decision-svc Stage 1 SQL 정밀화 (FR-A5.1)

**Files:**
- Modify: `BookFlowAI-Apps/eks-pods/decision-svc/src/routes/decision.py:56-73` (`_stage1_source`)
- Modify/Create: `BookFlowAI-Apps/eks-pods/decision-svc/tests/test_cascade.py`

**Step 1: RED — pure 함수 `_stage1_query` SQL 생성기 또는 효과 테스트**

forecast_cache + pending_orders APPROVED 까지 차감하는 source picker 가 필요. FakeCur stub 으로 다단계 쿼리 검증.

**Step 2: Verify RED**

**Step 3: GREEN**

```sql
SELECT i.location_id,
       i.on_hand
       - i.reserved_qty
       - COALESCE((SELECT SUM(qty) FROM pending_orders po2
                    WHERE po2.target_location_id = i.location_id
                      AND po2.isbn13 = i.isbn13
                      AND po2.status = 'APPROVED'
                      AND po2.executed_at IS NULL), 0)  -- 입고 예정 차감 (이미 다른 발주에 잡힘)
       - COALESCE((SELECT SUM(predicted_qty) FROM forecast_cache fc
                    WHERE fc.isbn13 = i.isbn13
                      AND fc.store_id = i.location_id
                      AND fc.snapshot_date >= CURRENT_DATE
                      AND fc.snapshot_date < CURRENT_DATE + INTERVAL '14 days'), 0)  -- 14일 예상수요 차감
       AS effective_available
  FROM inventory i
  JOIN locations l ON l.location_id = i.location_id
  JOIN books b ON b.isbn13 = i.isbn13
 WHERE l.wh_id = %s
   AND i.isbn13 = %s
   AND i.location_id != %s    -- target 자기 자신 제외
   AND b.active = TRUE
   AND b.discontinue_mode != 'INACTIVE'
   AND (b.discontinue_mode != 'SOFT_DISCONTINUE' OR %s)  -- 소진모드는 재분배 허용 플래그
HAVING (i.on_hand - i.reserved_qty - ... ) >= %s
 ORDER BY effective_available DESC
 LIMIT 1
```

**Step 4: Verify GREEN** — 시나리오: 같은 wh 내 매장 A on_hand=100, reserved=20, pending APPROVED=30, 14일 예측 25 → effective=25. qty=10 요청 시 source A 선택, qty=30 시 None.

**Step 5: Commit**

---

## Task 4: decision-svc Stage 2 SQL 정밀화 (FR-A5.3)

**Files:**
- Modify: `BookFlowAI-Apps/eks-pods/decision-svc/src/routes/decision.py:76-94` (`_stage2_source`)
- Add to: `tests/test_cascade.py`

**Step 1: RED — Stage 2 가 상대 안전재고 + 예상수요 차감 후 여유분 검증하는 테스트**

**Step 3: GREEN**

```sql
SELECT i.location_id, l.wh_id,
       i.on_hand,
       i.reserved_qty,
       COALESCE(i.safety_stock, 10) AS safety_stock,
       COALESCE((SELECT SUM(predicted_qty) FROM forecast_cache fc
                  WHERE fc.isbn13 = i.isbn13
                    AND fc.store_id = i.location_id
                    AND fc.snapshot_date >= CURRENT_DATE
                    AND fc.snapshot_date < CURRENT_DATE + INTERVAL '14 days'), 0) AS expected_demand_14d,
       (i.on_hand - i.reserved_qty
         - COALESCE(i.safety_stock, 10)
         - COALESCE((SELECT SUM(predicted_qty) ... ), 0)
       ) AS surplus
  FROM inventory i
  JOIN locations l ON l.location_id = i.location_id
  JOIN books b ON b.isbn13 = i.isbn13
 WHERE l.wh_id != %s
   AND i.isbn13 = %s
   AND b.active = TRUE
   AND b.discontinue_mode != 'INACTIVE'
   AND l.location_type = 'WAREHOUSE'  -- 권역 이동은 WH 간만
HAVING surplus >= %s
 ORDER BY surplus DESC
 LIMIT 1
```

rationale dict 풍부화:
```python
rationale.update({
    "stage": 2,
    "selected_order_type": "WH_TRANSFER",
    "source_location_id": source_loc,
    "partner_wh": partner_wh,
    "partner_on_hand": on_hand,
    "partner_reserved": reserved,
    "partner_safety": safety,
    "partner_expected_demand_14d": demand,
    "partner_surplus": surplus,
    "transferable_qty": min(surplus, request_qty),
    "request_qty": request_qty,
})
```

**Step 4: Verify GREEN**

**Step 5: Commit**

---

## Task 5: decision-svc INACTIVE/SOFT_DC enforcement (FR-A6.2/A5.8/A3.8)

**Files:**
- Modify: `decision.py` Stage 1, 2, 3 SQL + `/decide` 진입 시 books active 검증

**Step 1: RED — INACTIVE 도서 /decide 호출 시 400 또는 graceful skip**

```python
def test_decide_skips_inactive_book():
    """INACTIVE 도서는 /decide 진입 즉시 400 으로 거절."""
    # books.active=FALSE, discontinue_mode='INACTIVE' 인 isbn13 으로 호출
    # response: 400 {"detail": "비활성 도서는 의사결정 불가"}
```

**Step 3: GREEN**

```python
# /decide 진입부에 추가
cur.execute("SELECT active, discontinue_mode FROM books WHERE isbn13 = %s", (req.isbn13,))
row = cur.fetchone()
if not row:
    raise HTTPException(404, "isbn13 not found in books master")
active, mode = row
if not active or mode == "INACTIVE":
    raise HTTPException(400, f"비활성 도서 ({mode}) 는 의사결정 불가")
# SOFT_DISCONTINUE 는 Stage 1·2 (재분배) 만 허용, Stage 3 (출판사 발주) 차단
allow_publisher_order = (mode != "SOFT_DISCONTINUE")
```

Stage 3 분기에서 `allow_publisher_order=False` 면 400 반환.

**Step 4: Verify GREEN**

**Step 5: Commit**

---

## Task 6: decision-svc A4.7 Stage 3 품절임박 자동발주 정정

**Files:**
- Modify: `decision.py:183` `auto_execute_eligible` 정의
- Modify: `intervention-svc/src/cron/auto_execute.py` (필요 시 분기 추가)

**Step 1: RED — Stage 3 + 18시 이후 + URGENT/CRITICAL 인 PUBLISHER_ORDER 가 자동 승인되는 테스트**

**Step 3: GREEN**

```python
# decision.py:183
# 기존: auto_exec = stage_num == 1 and urgency in ("URGENT", "CRITICAL")
# 수정: FR-A4.7 = Stage 3 (PUBLISHER_ORDER) + URGENT/CRITICAL · auto_execute CronJob 이 18시 이후 일괄 발주
auto_exec = (
    stage_num == 3 and urgency in ("URGENT", "CRITICAL")
) or (
    stage_num == 1 and urgency == "CRITICAL"  # 권역 내 재분배 중 매우 긴급은 자동
)
```

**Step 4: Verify GREEN**

**Step 5: Commit**

---

## Task 7: decision-svc EOQ 공식 구현 (FR-A4.1)

**Files:**
- Modify: `decision.py` Stage 3 진입 시 EOQ 계산 + qty override
- Migration: `publishers.order_cost` + `books.holding_cost` 컬럼 추가
- Add to: `tests/test_cascade.py`

**Step 1: RED — `_calc_eoq(annual_demand, order_cost, holding_cost)` 가 EOQ 공식 결과 반환하는 단위 테스트**

```python
import math

def test_eoq_basic():
    """EOQ = sqrt(2 * D * S / H). D=1000, S=50000, H=500 → EOQ=sqrt(200000)=447"""
    from src.routes.decision import _calc_eoq
    result = _calc_eoq(annual_demand=1000, order_cost=50000, holding_cost=500)
    assert abs(result - math.sqrt(200000)) < 1.0


def test_eoq_zero_demand_returns_min():
    result = _calc_eoq(annual_demand=0, order_cost=50000, holding_cost=500)
    assert result == 10  # MIN_EOQ
```

**Step 3: GREEN**

```python
import math

MIN_EOQ = 10  # 최소 발주량 (출판사 정책)
DEFAULT_ORDER_COST = 50000  # 발주 1건당 비용 (운송·행정)
DEFAULT_HOLDING_COST_RATIO = 0.20  # 단가 대비 연간 보관비 비율 (20%)

def _calc_eoq(annual_demand: float, order_cost: float, holding_cost: float) -> int:
    """경제적 발주량 EOQ = sqrt(2DS/H)
    
    D: 연간 수요량 (forecast_cache 365일 sum 또는 sales_realtime extrapolate)
    S: 발주 1건당 비용
    H: 단위당 연간 보관비
    """
    if annual_demand <= 0 or order_cost <= 0 or holding_cost <= 0:
        return MIN_EOQ
    eoq = math.sqrt(2 * annual_demand * order_cost / holding_cost)
    return max(MIN_EOQ, int(round(eoq)))
```

Stage 3 진입 시:
```python
if stage_num == 3:
    annual_demand = _annual_demand_from_forecast(cur, req.isbn13)
    order_cost = _order_cost_for_publisher(cur, req.isbn13, default=DEFAULT_ORDER_COST)
    holding_cost = _holding_cost(cur, req.isbn13, default_ratio=DEFAULT_HOLDING_COST_RATIO)
    qty = _calc_eoq(annual_demand, order_cost, holding_cost)
    # 사용자 요청 qty 보다 작으면 사용자 qty (긴급 보충), 크면 EOQ 채택
    qty = max(qty, req.qty)
```

**Step 4: Verify GREEN** — 단위 테스트 + 통합 (Stage 3 진입 시 qty 차이 확인)

**Step 5: Commit**

---

## Task 8: inventory-svc /current 응답 enrichment (FR-A7.4)

**Files:**
- Modify: `BookFlowAI-Apps/eks-pods/inventory-svc/src/routes/inventory.py:27-56` (`/current/{wh_id}`)
- Add to: `tests/test_inventory_response.py`

**Step 1: RED — 응답에 `expected_soldout_at`, `incoming_qty`, `outgoing_qty` 포함되는지 테스트**

**Step 3: GREEN — JOIN books 추가 + pending_orders APPROVED 합산**

```sql
SELECT i.location_id, i.isbn13,
       i.on_hand, i.reserved_qty, i.safety_stock,
       b.expected_soldout_at, b.title,
       COALESCE((SELECT SUM(qty) FROM pending_orders po
                  WHERE po.target_location_id = i.location_id
                    AND po.isbn13 = i.isbn13
                    AND po.status = 'APPROVED'
                    AND po.executed_at IS NULL), 0) AS incoming_qty,
       COALESCE((SELECT SUM(qty) FROM pending_orders po
                  WHERE po.source_location_id = i.location_id
                    AND po.isbn13 = i.isbn13
                    AND po.status = 'APPROVED'
                    AND po.executed_at IS NULL), 0) AS outgoing_qty
  FROM inventory i
  JOIN locations l ON l.location_id = i.location_id
  LEFT JOIN books b ON b.isbn13 = i.isbn13
 WHERE l.wh_id = %s
```

**Step 4: Verify GREEN**

**Step 5: Commit**

---

## Task 9: publisher-watcher 풀 필드 + books upsert (FR-A1.4 + A11.1)

**Files:**
- Modify: `BookFlowAI-Apps/eks-pods/publisher-watcher/src/poll.py`
- Add deps if needed: 알라딘 API caller (있는지 확인)

**Step 1: RED — publisher poll 시 author/genre/marketing_plan/similar_books 까지 INSERT + books 테이블 isbn13 row 존재 검증**

**Step 3: GREEN**

```python
# poll.py 내 fetch_pending() 응답 파싱 시
def _normalize_request(item: dict) -> dict:
    return {
        "isbn13": item["isbn13"],
        "publisher_id": item.get("publisher_id"),
        "title": item.get("title"),
        "author": item.get("author"),
        "genre": item.get("genre") or item.get("category_name"),
        "expected_pub_date": _parse_date(item.get("expected_pub_date")),
        "estimated_initial_sales": item.get("estimated_initial_sales") or 0,
        "marketing_plan": item.get("marketing_plan") or "",
        "similar_books": item.get("similar_books") or [],
        "target_segments": item.get("target_segments") or [],
    }

# books 테이블 upsert
cur.execute("""
    INSERT INTO books (isbn13, title, author, publisher, category_name, source, active, discontinue_mode)
    VALUES (%s, %s, %s, %s, %s, 'PUBLISHER_REQUEST', TRUE, 'NONE')
    ON CONFLICT (isbn13) DO NOTHING
""", (norm["isbn13"], norm["title"], norm["author"], publisher_name, norm["genre"]))

# new_book_requests INSERT
cur.execute("""
    INSERT INTO new_book_requests
        (publisher_id, isbn13, title, author, genre, expected_pub_date,
         estimated_initial_sales, marketing_plan, similar_books, target_segments,
         status, created_at)
    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, 'NEW', NOW())
    ON CONFLICT (isbn13) DO NOTHING
""", (...))
```

**Step 4: Verify GREEN** — mock publisher API 응답으로 통합 테스트

**Step 5: Commit**

---

## Task 10: dashboard-svc branch-clerk RBAC scope_store_id (FR-A7.3)

**Files:**
- Modify: `BookFlowAI-Apps/eks-pods/dashboard-svc/src/routes/master.py` `/store-inventory/{store_id}` 등 store-scope endpoint
- Modify: `aggregate.py` 의 store-scope endpoint

**Step 1: RED — branch-clerk 가 자기 매장 외 store_id 호출 시 403 받는지 테스트**

**Step 3: GREEN — 헬퍼 추가 + 모든 `/store-*/{store_id}` endpoint 에 적용**

```python
def _verify_store_scope(ctx: AuthContext, store_id: int) -> None:
    if ctx.role == "branch-clerk":
        if ctx.scope_store_id != store_id:
            raise HTTPException(403, f"자기 매장만 조회 가능 (scope={ctx.scope_store_id})")
```

**Step 4: Verify GREEN**

**Step 5: Commit**

---

## Task 11: 모든 P1 변경사항 EKS 배포 + 통합 검증

**Files:** N/A (CI/CD 활용)

**Step 1:** dashboard-svc + intervention-svc + inventory-svc + publisher-watcher 4개 image 빌드

**Step 2:** ECR push

**Step 3:** kubectl rollout restart 4개 deployment

**Step 4:** Verify GREEN — 통합 시나리오:
- branch-clerk hq endpoint 호출 → 403
- branch-clerk 자기 매장 inventory adjust → 200
- wh-manager-1 PUBLISHER_ORDER (target=1) 승인 → 200
- INACTIVE 도서 /decide → 400
- Stage 2 cascade `pending_orders.forecast_rationale.partner_surplus` 채워짐
- publisher-watcher 폴링 후 books 테이블에 신간 row 생성됨

**Step 5: Commit + 통합 검증 결과 docs/plans/ 에 보고서**

---

## Task 12 (P2 보너스 · 시간 남으면)

- inventory-svc reservation TTL cleanup CronJob (P2 #16)
- decision-svc 동적 안전재고 batch (P1 #2 - DB schema 변경 필요로 후순위)
- POS Lambda 자동 차감 (P1 #7 - Lambda + Platform repo 작업이라 큰 작업)

---

## 검증 (전체 plan 끝나면)

```bash
# 1) 모든 pod 단위 테스트
cd BookFlowAI-Apps/eks-pods/decision-svc && py -m pytest tests/ -v
cd BookFlowAI-Apps/eks-pods/intervention-svc && py -m pytest tests/ -v
cd BookFlowAI-Apps/eks-pods/inventory-svc && py -m pytest tests/ -v
cd BookFlowAI-Apps/eks-pods/dashboard-svc && py -m pytest tests/ -v

# 2) 통합: NLB + curl
NLB=...
TOKEN_HQ="Bearer mock-token-hq-admin"
TOKEN_WH1="Bearer mock-token-wh-manager-1"
TOKEN_BR="Bearer mock-token-branch-clerk"

# branch-clerk 자기 매장 OK / 타 매장 403
curl -H "Authorization: $TOKEN_BR" $NLB/dashboard/store-inventory/1   # 200
curl -H "Authorization: $TOKEN_BR" $NLB/dashboard/store-inventory/5   # 403

# wh-manager PUBLISHER_ORDER 자기 권역 승인
# (시드에 PENDING PUBLISHER_ORDER 만들어서 호출)

# Stage 2 rationale 풍부화 확인
curl -X POST -H "Authorization: $TOKEN_HQ" -d '{"isbn13":"...","target_location_id":...,"qty":...}' $NLB/dashboard/decide
# response 의 rationale 에 partner_surplus, partner_safety, partner_expected_demand_14d 포함 확인

# 3) code-reviewer subagent dispatch
```

---

## 실행 모드

이 plan 은 **단일 세션** 에서 task 1 → 12 순차 실행. 사이즈 보면 ~5-7 시간 추정.

각 task 완료 후 commit + 다음 task 진입. 막히면 사용자에게 즉시 알림 (실패 task ID + 원인).
