"""psycopg3 connection pool + Redis client.

Pool opens at startup with short timeout. If RDS is briefly unreachable,
pool stays None — pod still answers /health (loadbalancer keeps it in service).
Routes that use db_conn() raise 503 until pool comes up via lazy reopen.
"""
import logging
from contextlib import contextmanager

import redis
from fastapi import HTTPException, status
from psycopg_pool import ConnectionPool

from .settings import settings

log = logging.getLogger(__name__)

_pool: ConnectionPool | None = None
_redis: redis.Redis | None = None


def _conninfo() -> str:
    return (
        f"host={settings.rds_host} port={settings.rds_port} "
        f"dbname={settings.rds_db} user={settings.rds_user} "
        f"password={settings.rds_password}"
    )


def init_pool() -> None:
    global _pool, _redis
    pool = ConnectionPool(_conninfo(), min_size=1, max_size=10, open=False)
    try:
        pool.open(wait=True, timeout=5)
        _pool = pool
        log.info("DB pool ready")
    except Exception as e:
        log.warning("DB pool init failed (will retry on demand): %s", e)
        _pool = None
    _redis = redis.Redis(host=settings.redis_host, port=settings.redis_port, decode_responses=True)


def close_pool() -> None:
    global _pool, _redis
    if _pool:
        _pool.close()
        _pool = None
    if _redis:
        _redis.close()
        _redis = None


def _try_reopen() -> None:
    global _pool
    pool = ConnectionPool(_conninfo(), min_size=1, max_size=10, open=False)
    try:
        pool.open(wait=True, timeout=5)
        _pool = pool
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=f"db unavailable: {e}")


@contextmanager
def db_conn():
    if _pool is None:
        _try_reopen()
    with _pool.connection() as conn:
        yield conn


def redis_client() -> redis.Redis:
    if _redis is None:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="redis unavailable")
    return _redis
