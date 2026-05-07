# dashboard-svc

V6.2 PPT 슬라이드 30 원안 회귀 (V6.4 결정 2026-05-02) — **BFF + Frontend 1 Pod 통합**.

## 책임 (3-in-1)
1. **HTTP fan-in BFF**: 5 pod (inventory · forecast · decision · intervention · notification) GET 호출 결과 집계
2. **WebSocket broker**: 4 Redis 채널 (`stock.changed` · `order.pending` · `spike.detected` · `newbook.request`) → 연결된 모든 WS client 에 브로드캐스트
3. **SPA serve**: Vite + React + TS + TanStack Query + Tailwind + react-router-dom 빌드물 정적 서빙

V3 grants `dashboard_svc` SELECT only (직접 RDS 쓰기 X · write 는 다른 pod 가 수행).

## 구조
```
dashboard-svc/
├── Dockerfile          (multi-stage: node build -> python serve)
├── requirements.txt
├── src/                (FastAPI)
│   ├── main.py         (lifespan + StaticFiles mount("/", html=True))
│   ├── auth.py         (mock JWT Bearer)
│   ├── settings.py     (DASHBOARD_ env prefix)
│   ├── clients.py      (httpx.AsyncClient · _safe_get 부분실패 tolerated)
│   ├── redis_bridge.py (redis.asyncio pubsub -> WS broadcast)
│   └── routes/
│       ├── aggregate.py (/dashboard/inventory · forecast · pending · overview)
│       └── ws.py        (/ws/updates · first frame auth)
├── web/                (Vite React TS)
│   ├── package.json
│   ├── vite.config.ts
│   ├── tailwind.config.js · postcss.config.js
│   ├── index.html
│   └── src/
│       ├── main.tsx    (BrowserRouter)
│       ├── Layout.tsx  (role select + WS counts)
│       ├── api.ts · useLiveStream.ts · styles.css
│       └── pages/
│           ├── Overview.tsx
│           └── Pending.tsx
└── k8s/
    ├── configmap.yaml · deployment.yaml · service.yaml (LoadBalancer NLB)
```

## API
- `GET /dashboard/inventory/{wh_id}`
- `GET /dashboard/forecast/{store_id}/{snapshot_date}`
- `GET /dashboard/pending?limit=N`
- `GET /dashboard/overview/{wh_id}` — 3-way fan-in `asyncio.gather` · `_partial_failures` 부분실패 tolerated
- `WS /ws/updates` — first frame `{"type":"auth","token":"Bearer mock-token-..."}`
- `GET /health`
- `/`, `/overview/:wh`, `/pending` — React SPA (FastAPI StaticFiles, html=True 로 SPA fallback)

## 배포
```bash
# build + push
AWS_PROFILE=bookflow-admin AWS_REGION=ap-northeast-1 ./build.sh dashboard-svc

# K8s apply
ECR_REGISTRY=...dkr.ecr... IMAGE_TAG=latest envsubst < k8s/deployment.yaml | kubectl apply -f -
kubectl apply -f k8s/configmap.yaml -f k8s/service.yaml

# external NLB DNS
kubectl get svc dashboard-svc -n bookflow -o wide
```

## 로컬 dev
```bash
# terminal 1: FastAPI on port 8000
cd src && uvicorn main:app --reload --port 8000

# terminal 2: Vite dev server with HMR
cd web && npm install && npm run dev   # http://localhost:5173
```

## 환경변수 (`DASHBOARD_` prefix)
- `INVENTORY_SVC_URL` `FORECAST_SVC_URL` `DECISION_SVC_URL` `NOTIFICATION_SVC_URL` `INTERVENTION_SVC_URL`
- `REDIS_HOST` `REDIS_PORT`
- `AUTH_MODE` `LOG_LEVEL` `FAN_IN_TIMEOUT_SECONDS`

## 회귀 이력
- V6.2 = `dashboard-svc` (Pod 1 · BFF + Frontend 통합 의도)
- V6.3 v2 (2026-05-02 오전) = `dashboard-bff` + 별도 `dashboard-frontend` 분리 (4 출처 다수결, .pen 디자인 일치) — **폐기**
- **V6.4 (2026-05-02 오후) = `dashboard-svc` 1 Pod 통합** (사용자 결정 · 운영 단순화)
