"""forecast-svc · D+1 forecast cache + Vertex AI hook (Phase 2 stub)."""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from .db import close_pool, init_pool
from .routes.forecast import router as forecast_router
from .settings import settings

logging.basicConfig(level=settings.log_level)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_pool()
    yield
    close_pool()


app = FastAPI(title="bookflow-forecast-svc", version="0.1.0", lifespan=lifespan)
app.include_router(forecast_router)


@app.get("/health")
def health():
    return {"status": "ok", "service": "forecast-svc"}
