"""auth-pod FastAPI app · Entra ID OIDC + BookFlow JWT issuer."""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from . import db
from .routes import auth as auth_routes
from .settings import settings

logging.basicConfig(level=settings.log_level)
log = logging.getLogger("auth-pod")


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_pool()
    yield
    db.close_pool()


app = FastAPI(title="bookflow auth-pod", lifespan=lifespan)
app.include_router(auth_routes.router)


@app.get("/health")
def health():
    return {"status": "ok", "service": "auth-pod"}
