"""Redis pub/sub bridge to WebSocket broadcast.

Subscribes to 4 channels (stock.changed · order.pending · spike.detected · newbook.request)
and pushes JSON to all connected WS clients.

Single asyncio task per Pod replica · each replica subscribes independently to all channels.
"""
import asyncio
import json
import logging
from typing import Set

import redis.asyncio as aioredis
from fastapi import WebSocket

from .settings import settings

log = logging.getLogger(__name__)

CHANNELS = ["stock.changed", "order.pending", "spike.detected", "newbook.request"]

_redis: aioredis.Redis | None = None
_pubsub_task: asyncio.Task | None = None
_clients: Set[WebSocket] = set()


def get_redis() -> aioredis.Redis:
    if _redis is None:
        raise RuntimeError("redis not initialized")
    return _redis


def register(ws: WebSocket) -> None:
    _clients.add(ws)


def unregister(ws: WebSocket) -> None:
    _clients.discard(ws)


async def _broadcast(channel: str, payload: dict) -> None:
    if not _clients:
        return
    message = json.dumps({"channel": channel, "data": payload})
    dead: list[WebSocket] = []
    for ws in list(_clients):
        try:
            await ws.send_text(message)
        except Exception:
            dead.append(ws)
    for ws in dead:
        _clients.discard(ws)


async def _pubsub_loop() -> None:
    pubsub = _redis.pubsub()
    await pubsub.subscribe(*CHANNELS)
    log.info("redis pubsub subscribed: %s", CHANNELS)
    async for msg in pubsub.listen():
        if msg.get("type") != "message":
            continue
        try:
            channel = msg["channel"].decode() if isinstance(msg["channel"], bytes) else msg["channel"]
            data = msg["data"]
            payload = json.loads(data) if isinstance(data, (str, bytes)) else data
            await _broadcast(channel, payload)
        except Exception as e:
            log.warning("pubsub broadcast failed: %s", e)


async def init_bridge() -> None:
    global _redis, _pubsub_task
    _redis = aioredis.Redis(host=settings.redis_host, port=settings.redis_port, decode_responses=False)
    _pubsub_task = asyncio.create_task(_pubsub_loop())
    log.info("redis bridge ready")


async def close_bridge() -> None:
    global _redis, _pubsub_task
    if _pubsub_task:
        _pubsub_task.cancel()
        try:
            await _pubsub_task
        except (asyncio.CancelledError, Exception):
            pass
    if _redis:
        await _redis.close()
