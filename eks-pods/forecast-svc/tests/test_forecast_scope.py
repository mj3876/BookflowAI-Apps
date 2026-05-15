"""forecast-svc GET 권한 매트릭스 검증.

- _check_forecast_store_scope: GET /forecast/{store_id}/{snapshot_date} 단건 read 권한
- _forecast_scope_clause: GET /forecast/insufficient-stock 의 SQL 필터 절

매트릭스 (2026-05-14):
- hq-admin: 전체 OK
- wh-manager + scope_wh_id: store 가 자기 wh 의 location 일 때만 OK
- branch-clerk + scope_store_id: store_id == scope_store_id 만 OK
"""
import pytest
from fastapi import HTTPException

from src.auth import AuthContext
from src.routes.forecast import _check_forecast_store_scope, _forecast_scope_clause


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


# ─── _check_forecast_store_scope ──────────────────────────────────────────
def test_hq_admin_any_store_ok():
    cur = FakeCur({})
    _check_forecast_store_scope(cur, _ctx("hq-admin"), store_id=1)
    _check_forecast_store_scope(cur, _ctx("hq-admin"), store_id=999)


def test_branch_clerk_own_store_ok():
    cur = FakeCur({})
    _check_forecast_store_scope(cur, _ctx("branch-clerk", scope_store_id=3), store_id=3)


def test_branch_clerk_other_store_403():
    cur = FakeCur({})
    with pytest.raises(HTTPException) as e:
        _check_forecast_store_scope(cur, _ctx("branch-clerk", scope_store_id=3), store_id=4)
    assert e.value.status_code == 403


def test_branch_clerk_no_scope_403():
    cur = FakeCur({})
    with pytest.raises(HTTPException) as e:
        _check_forecast_store_scope(cur, _ctx("branch-clerk", scope_store_id=None), store_id=3)
    assert e.value.status_code == 403


def test_wh_manager_own_wh_store_ok():
    cur = FakeCur({3: 1, 4: 1})  # store 3,4 모두 wh=1
    _check_forecast_store_scope(cur, _ctx("wh-manager", scope_wh_id=1), store_id=3)


def test_wh_manager_other_wh_store_403():
    cur = FakeCur({3: 1, 9: 2})
    with pytest.raises(HTTPException) as e:
        _check_forecast_store_scope(cur, _ctx("wh-manager", scope_wh_id=1), store_id=9)
    assert e.value.status_code == 403


def test_wh_manager_no_scope_403():
    cur = FakeCur({3: 1})
    with pytest.raises(HTTPException) as e:
        _check_forecast_store_scope(cur, _ctx("wh-manager", scope_wh_id=None), store_id=3)
    assert e.value.status_code == 403


def test_wh_manager_store_not_in_locations_404():
    cur = FakeCur({})
    with pytest.raises(HTTPException) as e:
        _check_forecast_store_scope(cur, _ctx("wh-manager", scope_wh_id=1), store_id=99)
    assert e.value.status_code == 404


def test_unknown_role_403():
    cur = FakeCur({})
    with pytest.raises(HTTPException) as e:
        _check_forecast_store_scope(cur, _ctx("guest"), store_id=1)
    assert e.value.status_code == 403


# ─── _forecast_scope_clause ───────────────────────────────────────────────
def test_scope_clause_hq_admin_empty():
    clause, params = _forecast_scope_clause(_ctx("hq-admin"))
    assert clause == ""
    assert params == []


def test_scope_clause_wh_manager():
    clause, params = _forecast_scope_clause(_ctx("wh-manager", scope_wh_id=2))
    assert "EXISTS" in clause and "sl.wh_id = %s" in clause
    assert params == [2]


def test_scope_clause_branch_clerk():
    clause, params = _forecast_scope_clause(_ctx("branch-clerk", scope_store_id=5))
    assert clause == "f.store_id = %s"
    assert params == [5]


def test_scope_clause_wh_manager_no_scope_empty():
    """scope_wh_id 가 None 이면 필터 안 함 (caller 가 별도 가드)."""
    clause, params = _forecast_scope_clause(_ctx("wh-manager", scope_wh_id=None))
    assert clause == ""
    assert params == []


def test_scope_clause_branch_clerk_no_scope_empty():
    clause, params = _forecast_scope_clause(_ctx("branch-clerk", scope_store_id=None))
    assert clause == ""
    assert params == []
