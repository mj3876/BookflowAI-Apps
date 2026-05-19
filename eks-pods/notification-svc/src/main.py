"""notification-svc · 알림 채널 연결지점 (Logic Apps webhook + Redis pub + notifications_log).

V6.3 MSA Pod #7. 시트06 12 events 분기 dispatcher.
"""
import asyncio
import json
import logging
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI
from prometheus_fastapi_instrumentator import Instrumentator

from .db import close_pool, init_pool, redis_client
from .recipients import get_recipients
from .routes.notification import _get_logic_apps_url, router as notification_router
from .settings import settings

logging.basicConfig(level=settings.log_level)
log = logging.getLogger(__name__)


async def _flush_inbound_rejected() -> None:
    """300초마다 InboundRejected Redis 버퍼 집계 → Logic Apps 권역별 1회 발송."""
    while True:
        await asyncio.sleep(300)
        try:
            rc = redis_client()
            keys = rc.keys("inbound_rejected_buffer:*")
            for key in keys:
                items_raw = rc.lrange(key, 0, -1)
                if not items_raw:
                    continue
                rc.delete(key)

                wh_id_str = key.split(":")[-1]
                wh_id = int(wh_id_str) if wh_id_str.isdigit() else 0
                region = "수도권" if wh_id == 1 else "영남"
                items = [json.loads(i) for i in items_raw]
                reasons = list({i.get("reject_reason", "") for i in items if i.get("reject_reason")})

                payload = {
                    "n": len(items),
                    "warehouse_id": wh_id,
                    "region": region,
                    "reasons": ", ".join(reasons[:3]),
                }
                recipients = get_recipients("InboundRejected", {"target_wh_id": wh_id})
                body = {
                    "event_type": "InboundRejected",
                    "severity": "WARNING",
                    "payload": payload,
                    "recipients": recipients,
                }
                la_url = _get_logic_apps_url("InboundRejected")
                if la_url:
                    body_bytes = json.dumps(body, ensure_ascii=False).encode("utf-8")
                    async with httpx.AsyncClient(timeout=settings.logic_apps_timeout_seconds) as c:
                        await c.post(
                            la_url,
                            content=body_bytes,
                            headers={"Content-Type": "application/json; charset=utf-8"},
                        )
                log.info("inbound_rejected flushed wh=%s n=%d", wh_id, len(items))
        except Exception as e:
            log.warning("inbound_rejected flush error: %s", e)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_pool()
    task = asyncio.create_task(_flush_inbound_rejected())
    yield
    task.cancel()
    close_pool()


app = FastAPI(title="bookflow-notification-svc", version="0.1.0", lifespan=lifespan)
app.include_router(notification_router)

Instrumentator().instrument(app).expose(app, endpoint="/metrics", include_in_schema=False)


@app.get("/health")
def health():
    return {"status": "ok", "service": "notification-svc"}
