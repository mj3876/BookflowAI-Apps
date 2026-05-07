"""dashboard-svc branch-clerk store-scope RBAC 단위 테스트 (FR-A7.3).

매장 단위 endpoint (`/sales-by-store/{store_id}` · `/store-inventory/{store_id}` ·
`/curation/{store_id}` · `/forecast/{store_id}/*`) 는 branch-clerk 가 자기 매장만 조회 가능.

본사 (hq-admin) 와 물류센터 (wh-manager) 는 전체 매장 조회 OK (FR-A7.1 / A7.2 정합).
"""
import pytest
from fastapi import HTTPException

from src.auth import AuthContext, _check_store_scope


def _ctx(role: str, scope_wh_id: int | None = None, scope_store_id: int | None = None) -> AuthContext:
    return AuthContext(
        user_id=f"u-{role}",
        role=role,
        scope_wh_id=scope_wh_id,
        scope_store_id=scope_store_id,
        token="mock-token-x",
    )


# ─── branch-clerk: 자기 매장만 OK ───────────────────────────────────────────
def test_branch_clerk_own_store_ok():
    """branch-clerk 가 scope_store_id == store_id 인 endpoint 조회 → no raise"""
    _check_store_scope(_ctx("branch-clerk", scope_store_id=1), store_id=1)


def test_branch_clerk_other_store_403():
    """branch-clerk 가 다른 매장 조회 시도 → 403"""
    with pytest.raises(HTTPException) as e:
        _check_store_scope(_ctx("branch-clerk", scope_store_id=1), store_id=5)
    assert e.value.status_code == 403


def test_branch_clerk_no_scope_403():
    """branch-clerk 가 scope_store_id 없으면 (토큰 손상) → 403"""
    with pytest.raises(HTTPException) as e:
        _check_store_scope(_ctx("branch-clerk", scope_store_id=None), store_id=1)
    assert e.value.status_code == 403


# ─── 다른 role: 모든 매장 OK (FR-A7.1 / A7.2) ──────────────────────────────
def test_hq_admin_any_store_ok():
    """본사는 전사 READ-ALL"""
    _check_store_scope(_ctx("hq-admin"), store_id=99)


def test_wh_manager_any_store_ok():
    """물류센터 매니저는 자기 권역 + 타 센터 read OK (FR-A7.2)"""
    _check_store_scope(_ctx("wh-manager", scope_wh_id=1), store_id=10)
    _check_store_scope(_ctx("wh-manager", scope_wh_id=2), store_id=3)
