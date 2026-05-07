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
from fastapi.staticfiles import StaticFiles

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
app.include_router(aggregate_router)
app.include_router(master_router)
app.include_router(ws_router)


@app.get("/health")
def health():
    return {"status": "ok", "service": "dashboard-svc"}


# Mount SPA at root LAST so /dashboard, /ws, /health take precedence.
# html=True falls back to index.html for unknown paths (SPA router).
static_dir = Path("/app/static")
if static_dir.is_dir():
    app.mount("/", StaticFiles(directory=str(static_dir), html=True), name="spa")
