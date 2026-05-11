"""
PostgreSQL 커넥션 풀 모듈

psycopg3 ConnectionPool 사용 (auth-pod/src/db.py 와 동일 패턴).
FastAPI lifespan 이벤트에서 init_pool() / close_pool() 호출.

연결 경로:
  EC2 (Egress VPC 10.2.x.x)
    → Transit Gateway (60-network-cross-cloud/tgw.yaml TgwAttachEgress)
    → RDS PostgreSQL (Data VPC 10.3.x.x, 20-data-persistent/rds.yaml)
  RDS SG: 5432 from 10.2.0.0/16 허용 (rds.yaml SecurityGroupIngress 참조)
"""
import logging
from contextlib import contextmanager

from psycopg_pool import ConnectionPool

from .settings import settings

log = logging.getLogger(__name__)
_pool: ConnectionPool | None = None


def _conninfo() -> str:
    return (
        f"host={settings.rds_host} port={settings.rds_port} "
        f"dbname={settings.rds_db} user={settings.rds_user} "
        f"password={settings.rds_password} sslmode=require"
    )


def init_pool() -> None:
    """앱 시작 시 커넥션 풀 초기화. 실패해도 앱은 기동 (헬스체크는 통과)."""
    global _pool
    try:
        pool = ConnectionPool(_conninfo(), min_size=2, max_size=10, open=False)
        pool.open(wait=True, timeout=10)
        _pool = pool
        log.info("publisher-api DB pool ready (host=%s db=%s)", settings.rds_host, settings.rds_db)
    except Exception as e:
        log.warning("DB pool init failed — running without DB: %s", e)
        _pool = None


def close_pool() -> None:
    global _pool
    if _pool:
        _pool.close()
        _pool = None


@contextmanager
def db_conn():
    """커넥션 컨텍스트 매니저. 풀 미초기화 시 RuntimeError."""
    if _pool is None:
        raise RuntimeError("publisher-api DB pool unavailable — check RDS connectivity")
    with _pool.connection() as conn:
        yield conn
