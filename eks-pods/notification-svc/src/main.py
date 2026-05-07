"""notification-svc · 알림 채널 연결지점 (Logic Apps webhook + Redis pub + notifications_log).

V6.3 MSA Pod #7. 시트06 12 events 분기 dispatcher.
"""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from .db import close_pool, init_pool
from .routes.notification import router as notification_router
from .settings import settings

logging.basicConfig(level=settings.log_level)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_pool()
    yield
    close_pool()


app = FastAPI(title="bookflow-notification-svc", version="0.1.0", lifespan=lifespan)
app.include_router(notification_router)


@app.get("/health")
def health():
    return {"status": "ok", "service": "notification-svc"}
