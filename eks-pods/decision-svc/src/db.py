"""psycopg3 pool (tolerant init).

decision-svc 는 Redis 직접 publish 안 함 (V6.2 시트10 정합 - notification-svc 가 12 events dispatcher).
notification-svc /send 호출로 OrderPending 등 발행.
"""
import logging
from contextlib import contextmanager

from fastapi import HTTPException, status
from psycopg_pool import ConnectionPool

from .settings import settings

log = logging.getLogger(__name__)

_pool: ConnectionPool | None = None


def _conninfo() -> str:
    return (
        f"host={settings.rds_host} port={settings.rds_port} "
        f"dbname={settings.rds_db} user={settings.rds_user} "
        f"password={settings.rds_password}"
    )


def init_pool() -> None:
    global _pool
    pool = ConnectionPool(_conninfo(), min_size=1, max_size=10, open=False)
    try:
        pool.open(wait=True, timeout=5)
        _pool = pool
        log.info("DB pool ready")
    except Exception as e:
        log.warning("DB pool init failed (will retry on demand): %s", e)
        _pool = None


def close_pool() -> None:
    global _pool
    if _pool:
        _pool.close()
        _pool = None


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
