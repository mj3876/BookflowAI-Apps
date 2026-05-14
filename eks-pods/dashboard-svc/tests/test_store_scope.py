"""dashboard-svc role/scope RBAC 단위 테스트.

`_check_store_scope`: branch-clerk 매장 path-param 검사 (DB 무관).
`_check_location_scope`: branch-clerk 매장 + wh-manager 권역 동시 검사 (DB cursor 필요).

권한 매트릭스 (2026-05-14 정정):
  - hq-admin: 전체
  - wh-manager + scope_wh_id: locations.wh_id == scope_wh_id 인 location 만
  - branch-clerk + scope_store_id: scope_store_id == location_id 만
"""
import pytest
from fastapi import HTTPException

from src.auth import AuthContext, _check_location_scope, _check_store_scope


def _ctx(role: str, scope_wh_id: int | None = None, scope_store_id: int | None = None) -> AuthContext:
    return AuthContext(
        user_id=f"u-{role}",
        role=role,
        scope_wh_id=scope_wh_id,
        scope_store_id=scope_store_id,
        token="mock-token-x",
    )


class _FakeCursor:
    """psycopg cursor stub — locations.wh_id 조회를 흉내 (location_id → wh_id mapping)."""

    def __init__(self, location_to_wh: dict[int, int | None]):
        self._map = location_to_wh
        self._last: int | None = None

    def execute(self, sql: str, params=None):
        # _check_location_scope 는 SELECT wh_id FROM locations WHERE location_id = %s 하나만 실행
        self._last = (params[0] if params else None)

    def fetchone(self):
        if self._last is None or self._last not in self._map:
            return None
        return (self._map[self._last],)


# ─── _check_store_scope: branch-clerk only ─────────────────────────────────
def test_branch_clerk_own_store_ok():
    _check_store_scope(_ctx("branch-clerk", scope_store_id=1), store_id=1)


def test_branch_clerk_other_store_403():
    with pytest.raises(HTTPException) as e:
        _check_store_scope(_ctx("branch-clerk", scope_store_id=1), store_id=5)
    assert e.value.status_code == 403


def test_branch_clerk_no_scope_403():
    with pytest.raises(HTTPException) as e:
        _check_store_scope(_ctx("branch-clerk", scope_store_id=None), store_id=1)
    assert e.value.status_code == 403


def test_hq_admin_check_store_scope_passthrough():
    """`_check_store_scope` 는 branch-clerk 만 검사 → hq-admin/wh-manager 통과."""
    _check_store_scope(_ctx("hq-admin"), store_id=99)
    _check_store_scope(_ctx("wh-manager", scope_wh_id=1), store_id=10)


# ─── _check_location_scope: branch-clerk + wh-manager ──────────────────────
def test_location_scope_hq_admin_pass():
    """hq-admin 은 어떤 location_id 도 통과 (DB 조회조차 안 함)."""
    cur = _FakeCursor({})
    _check_location_scope(_ctx("hq-admin"), location_id=99, cur=cur)


def test_location_scope_wh_manager_own_wh_ok():
    """wh-manager scope_wh_id=1 · location wh_id=1 → 통과."""
    cur = _FakeCursor({10: 1, 11: 2})
    _check_location_scope(_ctx("wh-manager", scope_wh_id=1), location_id=10, cur=cur)


def test_location_scope_wh_manager_other_wh_403():
    """wh-manager scope_wh_id=1 · location wh_id=2 → 403."""
    cur = _FakeCursor({11: 2})
    with pytest.raises(HTTPException) as e:
        _check_location_scope(_ctx("wh-manager", scope_wh_id=1), location_id=11, cur=cur)
    assert e.value.status_code == 403


def test_location_scope_wh_manager_no_scope_403():
    """wh-manager scope_wh_id None (토큰 손상) → 403."""
    cur = _FakeCursor({})
    with pytest.raises(HTTPException) as e:
        _check_location_scope(_ctx("wh-manager", scope_wh_id=None), location_id=10, cur=cur)
    assert e.value.status_code == 403


def test_location_scope_wh_manager_missing_location_404():
    """존재하지 않는 location → 404."""
    cur = _FakeCursor({})
    with pytest.raises(HTTPException) as e:
        _check_location_scope(_ctx("wh-manager", scope_wh_id=1), location_id=999, cur=cur)
    assert e.value.status_code == 404


def test_location_scope_branch_clerk_own_store_ok():
    """branch-clerk scope_store_id=1 · location 1 → 통과 (DB 조회 X)."""
    cur = _FakeCursor({})
    _check_location_scope(_ctx("branch-clerk", scope_store_id=1), location_id=1, cur=cur)


def test_location_scope_branch_clerk_other_store_403():
    """branch-clerk scope_store_id=1 · location 5 → 403."""
    cur = _FakeCursor({})
    with pytest.raises(HTTPException) as e:
        _check_location_scope(_ctx("branch-clerk", scope_store_id=1), location_id=5, cur=cur)
    assert e.value.status_code == 403
