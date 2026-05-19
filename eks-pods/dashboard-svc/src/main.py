"""dashboard-svc · HUB · 5 pod fan-in HTTP + Redis pub/sub WebSocket broker + SPA serve.

V6.2 PPT 슬라이드 30 원안 회귀 (V6.4 결정): BFF + Frontend 1 Pod 통합.
- /dashboard/* (HTTP fan-in routes)
- /ws/* (WebSocket broker)
- /health (k8s probe)
- / and SPA paths (StaticFiles · Vite-built React bundle, copied from web/dist by Dockerfile)

Read-only RDS (V3 grants - dashboard_svc role · SELECT only). Writes go through other pods.
"""
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from prometheus_fastapi_instrumentator import Instrumentator

from .clients import close_client, init_client
from .db import close_pool, init_pool
from .redis_bridge import close_bridge, init_bridge
from .routes.aggregate import router as aggregate_router
from .routes.master import router as master_router
from .routes.ws import router as ws_router
from .settings import settings

logging.basicConfig(level=settings.log_level)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_client()
    init_pool()
    await init_bridge()
    yield
    await close_bridge()
    close_pool()
    await close_client()


app = FastAPI(title="bookflow-dashboard-svc", version="0.1.0", lifespan=lifespan)
# 정적 path (master /inventory/turnover · by-category 등) 를 먼저 include —
# aggregate 의 /inventory/{wh_id} 가 정적 path 를 흡수하던 422 fix.
app.include_router(master_router)
app.include_router(aggregate_router)
app.include_router(ws_router)


@app.get("/health")
def health():
    return {"status": "ok", "service": "dashboard-svc"}


# Prometheus /metrics — SPA catch-all 보다 먼저 등록되어야 흡수되지 않음.
Instrumentator().instrument(app).expose(app, endpoint="/metrics", include_in_schema=False)


# SPA serve at root LAST so /dashboard, /ws, /health take precedence.
# StaticFiles(html=True) 만으로는 client-side routing path (예 /branch-curation) fallback 안 됨 →
# /assets 같은 정적 자원만 명시 mount 하고, 나머지 모든 path 는 catch-all 로 index.html 반환.
static_dir = Path("/app/static")
if static_dir.is_dir():
    if (static_dir / "assets").is_dir():
        app.mount("/assets", StaticFiles(directory=str(static_dir / "assets")), name="assets")

    @app.get("/{full_path:path}")
    async def spa_fallback(full_path: str):
        target = static_dir / full_path
        if target.is_file():
            return FileResponse(target)
        return FileResponse(static_dir / "index.html")
