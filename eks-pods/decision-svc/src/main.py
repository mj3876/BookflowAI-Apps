"""decision-svc · 3-stage decision engine (rebalance / WH transfer / EOQ order).

Phase 2: pending_orders create + list. Real logic in Phase 3.
"""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from .db import close_pool, init_pool
from .routes.decision import router as decision_router
from .settings import settings

logging.basicConfig(level=settings.log_level)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_pool()
    yield
    close_pool()


app = FastAPI(title="bookflow-decision-svc", version="0.1.0", lifespan=lifespan)
app.include_router(decision_router)


@app.get("/health")
def health():
    return {"status": "ok", "service": "decision-svc"}
