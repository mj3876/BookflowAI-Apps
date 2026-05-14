# ECS Sim 트랜잭션 발생 빈도 조정

**날짜:** 2026-05-13
**작업자:** 민지
**브랜치:** BookFlowAI-Apps `main`
**커밋:** `ba42acf`

---

## 문제 원인

기본값 기준으로 계산 시 트랜잭션 발생량이 현실과 동떨어지게 과도했음.

| Sim | 간격 (이전) | 건수/사이클 (이전) | 하루 추정 건수 |
|---|---|---|---|
| online-sim | 10~30초 | qty 최대 3 | 약 8,640~17,280건 |
| offline-sim | 30~90초 × 12개 매장 | L:3-8 · M:2-5 · S:1-3 | 약 17,000~46,000건 |

→ 12개 매장 × 평균 단가 1.5만원 기준 **하루 수백억원 수준**으로 현실 불일치

**중형 서점 체인 현실 기준 (교보 지방점 수준):** 하루 2~3천만원 (전체 체인 합산)

---

## 수정 파일

### 1. `ecs-sims/online-sim/app.py`

**INTERVAL_SEC — 트랜잭션 발생 간격**

```python
# 이전
INTERVAL_SEC = (int(os.environ.get("INTERVAL_MIN", "10")),
                int(os.environ.get("INTERVAL_MAX", "30")))

# 이후
INTERVAL_SEC = (int(os.environ.get("INTERVAL_MIN", "180")),
                int(os.environ.get("INTERVAL_MAX", "360")))
```

**make_record() — 주문 수량 상한**

```python
# 이전
max_qty = min(3, stock["available"])

# 이후
max_qty = min(2, stock["available"])
```

---

### 2. `ecs-sims/offline-sim/app.py`

**INTERVAL_SEC — 배치 사이 대기 시간**

```python
# 이전
INTERVAL_SEC = (int(os.environ.get("INTERVAL_MIN", "30")),
                int(os.environ.get("INTERVAL_MAX", "90")))

# 이후
INTERVAL_SEC = (int(os.environ.get("INTERVAL_MIN", "480")),
                int(os.environ.get("INTERVAL_MAX", "900")))
```

**BATCH_QTY_RANGE — 배치당 거래 건수**

```python
# 이전
BATCH_QTY_RANGE = {"L": (3, 8), "M": (2, 5), "S": (1, 3)}

# 이후
BATCH_QTY_RANGE = {"L": (1, 3), "M": (1, 2), "S": (1, 1)}
```

---

## 변경 전후 비교

| 항목 | 이전 | 이후 |
|---|---|---|
| Online 간격 | 10~30초 | 3~6분 (180~360초) |
| Online max qty | 3권 | 2권 |
| Offline 간격 | 30~90초 | 8~15분 (480~900초) |
| Offline 배치 L | 3~8건 | 1~3건 |
| Offline 배치 M | 2~5건 | 1~2건 |
| Offline 배치 S | 1~3건 | 1건 |

**예상 일 매출 (수정 후):** 약 2~3천만원 (중형 서점 체인 현실 수준)

---

## 해결 방법 (배포 절차)

1. `ecs-sims/online-sim/app.py`, `ecs-sims/offline-sim/app.py` 수정
2. `BookFlowAI-Apps` `main` 브랜치에 커밋 & push
3. **AWS CodePipeline** `bookflow-cicd-ecs` 자동 트리거
   - CodeBuild: Docker 이미지 3개 빌드 (online-sim · offline-sim · inventory-api)
   - ECR push: `:latest` + `:ba42acf` 태그
   - ECS `force-new-deployment`: Fargate 태스크 rolling 교체
4. **CodePipeline Succeeded** 확인 → 배포 완료

---

## 참고: 환경변수로 런타임 조정 가능

ECS Task Definition의 환경변수로 재빌드 없이 간격 조정 가능:

```
INTERVAL_MIN=180   # 최소 대기 초
INTERVAL_MAX=360   # 최대 대기 초
```
