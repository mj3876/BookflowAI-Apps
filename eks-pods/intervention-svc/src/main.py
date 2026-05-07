"""intervention-svc · 승인 · 실행 단일 창구.

V6.3 MSA Pod #5. order_approvals + returns 승인 처리. pending_orders 상태 전이.
A5 ErrorResponse 표준 + X-Request-ID 미들웨어 (intervention-svc pilot).
"""
import logging
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from .db import close_pool, init_pool
from .models import ErrorResponse
from .routes.intervention import router as intervention_router
from .settings import settings

logging.basicConfig(level=settings.log_level)
log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_pool()
    yield
    close_pool()


app = FastAPI(title="bookflow-intervention-svc", version="0.2.0", lifespan=lifespan)
app.include_router(intervention_router)


# ─── A5 X-Request-ID middleware ──────────────────────────────────────────────
@app.middleware("http")
async def request_id_middleware(request: Request, call_next):
    rid = request.headers.get("X-Request-ID") or uuid.uuid4().hex[:16]
    request.state.request_id = rid
    response = await call_next(request)
    response.headers["X-Request-ID"] = rid
    return response


# ─── A5 ErrorResponse 표준 핸들러 ─────────────────────────────────────────────
_STATUS_TO_CODE = {
    400: "BAD_REQUEST",
    401: "UNAUTHORIZED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    409: "CONFLICT",
    422: "VALIDATION",
    500: "INTERNAL",
    502: "UPSTREAM",
    503: "UNAVAILABLE",
}


def _err_payload(request: Request, status_code: int, message: str, details: dict | None = None) -> ErrorResponse:
    return ErrorResponse(
        error_code=_STATUS_TO_CODE.get(status_code, f"HTTP_{status_code}"),
        message=message,
        details=details,
        request_id=getattr(request.state, "request_id", None),
    )


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    body = _err_payload(request, exc.status_code, str(exc.detail))
    return JSONResponse(status_code=exc.status_code, content=body.model_dump(), headers=getattr(exc, "headers", None) or {})


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    body = _err_payload(
        request,
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "request validation failed",
        details={"errors": exc.errors()},
    )
    return JSONResponse(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, content=body.model_dump())


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    log.exception("unhandled error rid=%s", getattr(request.state, "request_id", "-"))
    body = _err_payload(request, 500, "internal server error")
    return JSONResponse(status_code=500, content=body.model_dump())


@app.get("/health")
def health():
    return {"status": "ok", "service": "intervention-svc"}
