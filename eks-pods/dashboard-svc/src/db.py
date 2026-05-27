"""Direct RDS read pool for master tables (books · kpi_daily · sales_realtime).

dashboard_svc role: SELECT only (V3 grants). Writes go through other pods.
Skipped if rds_host is empty - lets dashboard-svc work as pure HTTP fan-in only.
"""
import logging
from contextlib import contextmanager

from fastapi import HTTPException, status
from psycopg_pool import ConnectionPool

from .settings import settings

log = logging.getLogger(__name__)

_pool: ConnectionPool | None = None


def _conninfo() -> str:
    # connect_timeout + TCP keepalive: Multi-AZ failover 시 stale TCP 세션을 빠르게 감지
    # → 새 primary endpoint 로 자동 reconnect (60초 이내).
    return (
        f"host={settings.rds_host} port={settings.rds_port} "
        f"dbname={settings.rds_db} user={settings.rds_user} "
        f"password={settings.rds_password} "
        f"sslmode=require connect_timeout=3 "
        f"keepalives=1 keepalives_idle=10 keepalives_interval=3 keepalives_count=3 "
        f"tcp_user_timeout=5000"
    )


def init_pool() -> None:
    global _pool
    if not settings.rds_host or not settings.rds_password:
        log.info("DB read pool skipped (rds_host/password empty - HTTP fan-in only)")
        return
    # check=check_connection: pool 에서 connection 꺼낼 때마다 ping
    # → stale connection 자동 폐기 후 새로 발급. max_lifetime: 10분마다 재생성.
    pool = ConnectionPool(
        _conninfo(),
        min_size=1, max_size=5,
        open=False,
        check=ConnectionPool.check_connection,
        max_lifetime=600,
        timeout=5,
    )
    try:
        pool.open(wait=True, timeout=5)
        _pool = pool
        log.info("DB read pool ready")
    except Exception as e:
        log.warning("DB pool init failed: %s", e)
        _pool = None


def close_pool() -> None:
    global _pool
    if _pool:
        _pool.close()
        _pool = None


@contextmanager
def db_conn():
    if _pool is None:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="db pool unavailable")
    with _pool.connection() as conn:
        yield conn
