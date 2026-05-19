"""psycopg3 pool · users upsert on first login."""
import logging
import re
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
    """First-login + every login: UPN 패턴으로 role/scope 결정 (group 보조).

    UPN 매핑 (Entra 시드 정합 · 2026-05-13):
      hq@…           → hq-admin (전역)
      wh{N}@…        → wh-manager (scope_wh_id=N)
      branch{N}@…    → branch-clerk (scope_store_id=N · 1~14)
      engineer@…     → engineer (전역 · 운영 대시보드 Grafana 접근)
      그 외          → group GUID 매핑 fallback
    매번 로그인 시 role/scope 갱신 — UPN 이 정해진 매장과 일치하지 않는 사용자는 변동 없음.
    """
    role, scope_wh_id, scope_store_id = _resolve_role_scope(email, groups)
    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO users (user_id, email, display_name, role, scope_wh_id, scope_store_id, created_at, last_login_at)
                VALUES (%s, %s, %s, %s, %s, %s, NOW(), NOW())
                ON CONFLICT (user_id) DO UPDATE SET
                    email = EXCLUDED.email,
                    display_name = EXCLUDED.display_name,
                    role = EXCLUDED.role,
                    scope_wh_id = EXCLUDED.scope_wh_id,
                    scope_store_id = EXCLUDED.scope_store_id,
                    last_login_at = NOW()
                RETURNING user_id, email, display_name, role, scope_wh_id, scope_store_id
            """, (oid, email, display_name, role, scope_wh_id, scope_store_id))
            row = cur.fetchone()
        conn.commit()
    cols = ("user_id", "email", "display_name", "role", "scope_wh_id", "scope_store_id")
    return dict(zip(cols, row))


# UPN local-part 패턴 (소문자 비교) — 매장/권역당 여러 사용자 지원.
# 예) branch10 · branch10-alice · branch10_bob · wh1-manager · hq-john → 모두 정상 매핑.
_UPN_HQ = re.compile(r"^hq(?:[-_.].*)?$")
_UPN_WH = re.compile(r"^wh(\d+)(?:[-_.].*)?$")
_UPN_BRANCH = re.compile(r"^branch(\d+)(?:[-_.].*)?$")
_UPN_ENGINEER = re.compile(r"^engineer(?:[-_.].*)?$")


def _resolve_role_scope(email: str | None, groups: list[str]) -> tuple[str, int | None, int | None]:
    """UPN local-part 우선 → 그룹 GUID → fallback default.

    UPN 패턴이 명확하면 group claim 무시 (entra-setup.sh 시드 UPN 규약 신뢰).
    """
    if email:
        local = email.split("@", 1)[0].lower().strip()
        if _UPN_HQ.match(local):
            return ("hq-admin", None, None)
        if _UPN_ENGINEER.match(local):
            return ("engineer", None, None)
        m = _UPN_WH.match(local)
        if m:
            return ("wh-manager", int(m.group(1)), None)
        m = _UPN_BRANCH.match(local)
        if m:
            return ("branch-clerk", None, int(m.group(1)))
    return _map_groups_to_role(groups)


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
