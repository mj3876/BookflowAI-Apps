"""psycopg3 pool · users upsert on first login."""
import logging
from contextlib import contextmanager

from psycopg_pool import ConnectionPool

from .settings import settings

log = logging.getLogger(__name__)
_pool: ConnectionPool | None = None


def _conninfo() -> str:
    return (
        f"host={settings.rds_host} port={settings.rds_port} "
        f"dbname={settings.rds_db} user={settings.rds_user} password={settings.rds_password} "
        f"sslmode=require"
    )


def init_pool() -> None:
    global _pool
    pool = ConnectionPool(_conninfo(), min_size=1, max_size=5, open=False)
    try:
        pool.open(wait=True, timeout=5)
        _pool = pool
        log.info("auth-pod DB pool ready")
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
        raise RuntimeError("auth-pod DB pool unavailable")
    with _pool.connection() as conn:
        yield conn


def upsert_user(oid: str, email: str, display_name: str, groups: list[str]) -> dict:
    """First-login: INSERT users with default role · subsequent: keep role/scope (admin can edit)."""
    role, scope_wh_id, scope_store_id = _map_groups_to_role(groups)
    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO users (user_id, email, display_name, role, scope_wh_id, scope_store_id, created_at, last_login_at)
                VALUES (%s, %s, %s, %s, %s, %s, NOW(), NOW())
                ON CONFLICT (user_id) DO UPDATE SET
                    email = EXCLUDED.email,
                    display_name = EXCLUDED.display_name,
                    last_login_at = NOW()
                RETURNING user_id, email, display_name, role, scope_wh_id, scope_store_id
            """, (oid, email, display_name, role, scope_wh_id, scope_store_id))
            row = cur.fetchone()
        conn.commit()
    cols = ("user_id", "email", "display_name", "role", "scope_wh_id", "scope_store_id")
    return dict(zip(cols, row))


def _map_groups_to_role(groups: list[str]) -> tuple[str, int | None, int | None]:
    """Entra group (GUID 또는 이름) → BookFlow role 매핑.

    Entra v2 id_token 의 groups claim 은 GUID 로 들어옴. AD hybrid 가 아닌 cloud-only
    그룹은 displayName claim 미지원 → GUID hard-code 매핑 (entra-setup.sh 가 만든 4 그룹).
    """
    # GUID → role (entra-setup.sh 의 4 그룹 · 2026-05-06 확정)
    GUID_TO_ROLE = {
        "ead3f58e-8495-4a72-a4d8-9c9d36f5f221": "hq-admin",     # BF-Admin
        "56ca6f59-176e-4a76-a02b-1d16133075e0": "hq-admin",     # BF-HeadQuarter
        "71d7084d-a821-456d-9a2c-1389b83b3a5e": "wh-manager",   # BF-Logistics
        "06c73511-97d8-4995-afac-9746a3503919": "branch-clerk", # BF-Branch
    }
    g = set(groups)
    # Hybrid AD 환경에서는 group displayName 도 들어올 수 있어 둘 다 지원
    if "BF-Admin" in g or "BF-HeadQuarter" in g or any(GUID_TO_ROLE.get(x) == "hq-admin" for x in g):
        return ("hq-admin", None, None)
    if "BF-Logistics" in g or any(GUID_TO_ROLE.get(x) == "wh-manager" for x in g):
        return ("wh-manager", 1, None)
    if "BF-Branch" in g or any(GUID_TO_ROLE.get(x) == "branch-clerk" for x in g):
        return ("branch-clerk", None, settings.default_store_id)
    return (settings.default_role, None, settings.default_store_id)
