"""inventory-svc /adjust 권한 매트릭스 · _check_inventory_write_perm.

FR-A6.6 + 권한 매트릭스 (사용자 결정 2026-05-03):
- hq-admin: 모든 location OK
- wh-manager: 자기 wh 의 location 만 OK (locations.wh_id == scope_wh_id)
- branch-clerk: 자기 매장만 OK (scope_store_id == location_id)
- 그 외: 403

기존 코드 (inventory.py:62-63): branch-clerk 무조건 차단 → 정정.
"""
import pytest
from fastapi import HTTPException

from src.auth import AuthContext
from src.routes.inventory import _check_inventory_write_perm


class FakeCur:
    """단순 cursor stub. SELECT wh_id FROM locations WHERE location_id=? 만 처리."""

    def __init__(self, location_to_wh: dict[int, int]):
        self.location_to_wh = location_to_wh
        self._next = None

    def execute(self, sql, params=()):
        if "FROM locations" in sql:
            loc_id = params[0]
            wh = self.location_to_wh.get(loc_id)
            self._next = (wh,) if wh is not None else None
        else:
            self._next = None

    def fetchone(self):
        return self._next


def _ctx(role: str, scope_wh_id: int | None = None, scope_store_id: int | None = None) -> AuthContext:
    user_id = f"u-{role}"
    return AuthContext(user_id, role, scope_wh_id, scope_store_id)


# ─── hq-admin: 모든 location OK ────────────────────────────────────────────
def test_hq_admin_any_location_ok():
    cur = FakeCur({1: 1, 9: 2})
    _check_inventory_write_perm(cur, _ctx("hq-admin"), location_id=1)  # no raise
    _check_inventory_write_perm(cur, _ctx("hq-admin"), location_id=9)  # no raise


# ─── wh-manager: 자기 wh location 만 OK ───────────────────────────────────
def test_wh_manager_own_wh_ok():
    cur = FakeCur({1: 1, 2: 1, 3: 1})
    _check_inventory_write_perm(cur, _ctx("wh-manager", scope_wh_id=1), location_id=2)


def test_wh_manager_other_wh_403():
    cur = FakeCur({1: 1, 9: 2})
    with pytest.raises(HTTPException) as e:
        _check_inventory_write_perm(cur, _ctx("wh-manager", scope_wh_id=1), location_id=9)
    assert e.value.status_code == 403


def test_wh_manager_no_scope_403():
    cur = FakeCur({1: 1})
    with pytest.raises(HTTPException) as e:
        _check_inventory_write_perm(cur, _ctx("wh-manager", scope_wh_id=None), location_id=1)
    assert e.value.status_code == 403


def test_wh_manager_unknown_location_404():
    cur = FakeCur({})
    with pytest.raises(HTTPException) as e:
        _check_inventory_write_perm(cur, _ctx("wh-manager", scope_wh_id=1), location_id=99)
    assert e.value.status_code == 404


# ─── branch-clerk: 자기 매장만 OK (FR 명세 신규 적용) ───────────────────────
def test_branch_clerk_own_store_ok():
    """FR 매트릭스 정합 - branch-clerk 가 scope_store_id 와 일치하는 location 에 adjust 가능."""
    cur = FakeCur({1: 1})
    _check_inventory_write_perm(cur, _ctx("branch-clerk", scope_store_id=1), location_id=1)


def test_branch_clerk_other_store_403():
    cur = FakeCur({1: 1, 2: 1})
    with pytest.raises(HTTPException) as e:
        _check_inventory_write_perm(cur, _ctx("branch-clerk", scope_store_id=1), location_id=2)
    assert e.value.status_code == 403


def test_branch_clerk_no_scope_403():
    cur = FakeCur({1: 1})
    with pytest.raises(HTTPException) as e:
        _check_inventory_write_perm(cur, _ctx("branch-clerk", scope_store_id=None), location_id=1)
    assert e.value.status_code == 403


# ─── 알 수 없는 role 차단 ─────────────────────────────────────────────────
def test_unknown_role_403():
    cur = FakeCur({1: 1})
    with pytest.raises(HTTPException) as e:
        _check_inventory_write_perm(cur, _ctx("guest"), location_id=1)
    assert e.value.status_code == 403
