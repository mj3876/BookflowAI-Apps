"""WebSocket route: /ws/updates."""
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from fastapi.websockets import WebSocketState

from ..auth import parse_bearer
from ..redis_bridge import register, unregister

log = logging.getLogger(__name__)

router = APIRouter()


@router.websocket("/ws/updates")
async def updates(ws: WebSocket) -> None:
    await ws.accept()
    try:
        first = await ws.receive_json()
        token = first.get("token")
        parse_bearer(token)
    except Exception as e:
        await ws.close(code=4401, reason=f"auth failed: {e}")
        return

    register(ws)
    log.info("ws client connected")
    try:
        while True:
            try:
                await ws.receive_text()
            except WebSocketDisconnect:
                break
    finally:
        unregister(ws)
        if ws.client_state != WebSocketState.DISCONNECTED:
            await ws.close()
