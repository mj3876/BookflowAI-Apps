"""inventory-svc /current/{wh_id} 권한 매트릭스 · _check_inventory_read_scope.

권한 매트릭스 (2026-05-14 정정):
- hq-admin: 전체 OK
- wh-manager: scope_wh_id == 요청 wh_id 만 OK
- branch-clerk: 자기 매장 (scope_store_id) 가 속한 wh 만 OK (locations.wh_id 매칭)
- 그 외: 403
"""
import pytest
from fastapi import HTTPException

from src.auth import AuthContext
from src.routes.inventory import _check_inventory_read_scope


class FakeCur:
    """SELECT wh_id FROM locations WHERE location_id=? 만 처리하는 stub."""

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
    return AuthContext(f"u-{role}", role, scope_wh_id, scope_store_id)


# ─── hq-admin: 전 wh OK ───────────────────────────────────────────────────
def test_hq_admin_any_wh_ok():
    cur = FakeCur({})
    _check_inventory_read_scope(cur, _ctx("hq-admin"), wh_id=1)
    _check_inventory_read_scope(cur, _ctx("hq-admin"), wh_id=2)


# ─── wh-manager: 자기 wh 만 OK ────────────────────────────────────────────
def test_wh_manager_own_wh_ok():
    cur = FakeCur({})
    _check_inventory_read_scope(cur, _ctx("wh-manager", scope_wh_id=1), wh_id=1)


def test_wh_manager_other_wh_403():
    cur = FakeCur({})
    with pytest.raises(HTTPException) as e:
        _check_inventory_read_scope(cur, _ctx("wh-manager", scope_wh_id=1), wh_id=2)
    assert e.value.status_code == 403


def test_wh_manager_no_scope_403():
    cur = FakeCur({})
    with pytest.raises(HTTPException) as e:
        _check_inventory_read_scope(cur, _ctx("wh-manager", scope_wh_id=None), wh_id=1)
    assert e.value.status_code == 403


# ─── branch-clerk: 자기 매장의 wh 만 OK ────────────────────────────────────
def test_branch_clerk_same_wh_ok():
    """branch-clerk scope_store=1 · location 1 → wh 1 · 요청 wh_id=1 → OK"""
    cur = FakeCur({1: 1})
    _check_inventory_read_scope(cur, _ctx("branch-clerk", scope_store_id=1), wh_id=1)


def test_branch_clerk_other_wh_403():
    """branch-clerk scope_store=1 (wh=1) · 요청 wh_id=2 → 403"""
    cur = FakeCur({1: 1})
    with pytest.raises(HTTPException) as e:
        _check_inventory_read_scope(cur, _ctx("branch-clerk", scope_store_id=1), wh_id=2)
    assert e.value.status_code == 403


def test_branch_clerk_no_scope_403():
    cur = FakeCur({})
    with pytest.raises(HTTPException) as e:
        _check_inventory_read_scope(cur, _ctx("branch-clerk", scope_store_id=None), wh_id=1)
    assert e.value.status_code == 403


def test_branch_clerk_store_not_in_locations_403():
    cur = FakeCur({})  # scope_store_id=99 → locations 미존재
    with pytest.raises(HTTPException) as e:
        _check_inventory_read_scope(cur, _ctx("branch-clerk", scope_store_id=99), wh_id=1)
    assert e.value.status_code == 403


# ─── 알 수 없는 role 차단 ─────────────────────────────────────────────────
def test_unknown_role_403():
    cur = FakeCur({})
    with pytest.raises(HTTPException) as e:
        _check_inventory_read_scope(cur, _ctx("guest"), wh_id=1)
    assert e.value.status_code == 403
