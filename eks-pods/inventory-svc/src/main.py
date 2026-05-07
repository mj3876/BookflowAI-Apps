"""inventory-svc · single-writer Pod for inventory + reservations (V3 schema).

V6.3 슬라이드 30 · 7 Pod + 1 CronJob 중 #6.
"""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from .db import close_pool, init_pool
from .routes.inventory import router as inventory_router
from .settings import settings

logging.basicConfig(level=settings.log_level)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_pool()
    yield
    close_pool()


app = FastAPI(title="bookflow-inventory-svc", version="0.1.0", lifespan=lifespan)
app.include_router(inventory_router)


@app.get("/health")
def health():
    return {"status": "ok", "service": "inventory-svc"}
