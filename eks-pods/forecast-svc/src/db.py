"""psycopg3 pool + Redis client. Tolerant init (lazy reopen on demand)."""
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
    # connect_timeout + TCP keepalive: Multi-AZ failover 시 stale TCP 세션을 빠르게 감지
    # → 새 primary endpoint 로 자동 reconnect (60초 이내).
    return (
        f"host={settings.rds_host} port={settings.rds_port} "
        f"dbname={settings.rds_db} user={settings.rds_user} "
        f"password={settings.rds_password} "
        f"sslmode=require connect_timeout=3 "
        f"keepalives=1 keepalives_idle=30 keepalives_interval=10 keepalives_count=3"
    )


def _new_pool() -> ConnectionPool:
    # check=check_connection: pool 에서 connection 꺼낼 때마다 ping
    # → stale connection 자동 폐기 후 새로 발급. max_lifetime: 10분마다 재생성.
    return ConnectionPool(
        _conninfo(),
        min_size=1, max_size=10,
        open=False,
        check=ConnectionPool.check_connection,
        max_lifetime=600,
        timeout=5,
    )


def init_pool() -> None:
    global _pool, _redis
    pool = _new_pool()
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
    pool = _new_pool()
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
