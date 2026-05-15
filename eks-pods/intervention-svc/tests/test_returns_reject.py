"""A4 (FR-A6.8) 반품 거부 단위 테스트.

`returns_reject` endpoint:
- hq-admin only (다른 role 403)
- PENDING → REJECTED · rejected_at + reject_reason
- 이미 처리된 (APPROVED / REJECTED / EXECUTED) 시 404
- audit_log INSERT 호출 확인
"""
from datetime import datetime
from unittest.mock import MagicMock
from uuid import uuid4

import pytest
from fastapi import HTTPException

from src.auth import AuthContext
from src.models import ReturnRejectRequest
from src.routes.intervention import returns_reject


class FakeCur:
    """returns UPDATE + audit_log INSERT 호출을 검증할 cursor stub."""

    def __init__(self, update_row):
        self.update_row = update_row  # tuple(status, rejected_at, reject_reason) or None
        self.calls = []
        self._last = None

    def execute(self, sql, params=()):
        self.calls.append((sql.strip().split()[0], params))
        if "UPDATE returns" in sql:
            self._last = self.update_row
        elif "INSERT INTO audit_log" in sql:
            self._last = None

    def fetchone(self):
        return self._last

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class FakeConn:
    def __init__(self, cur):
        self._cur = cur
        self.committed = False

    def cursor(self):
        return self._cur

    def commit(self):
        self.committed = True

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def _ctx(role: str) -> AuthContext:
    return AuthContext(user_id="u-1", role=role, scope_wh_id=None, scope_store_id=None, token="Bearer mock-token-x")


def _req(reason: str = "예산 미배정") -> ReturnRejectRequest:
    return ReturnRejectRequest(return_id=uuid4(), reject_reason=reason)


def test_returns_reject_hq_admin_pending_ok(monkeypatch):
    cur = FakeCur(update_row=("REJECTED", datetime(2026, 5, 6, 1, 0, 0), "예산 미배정"))
    conn = FakeConn(cur)
    monkeypatch.setattr("src.routes.intervention.db_conn", lambda: conn)

    req = _req()
    resp = returns_reject(req, _ctx("hq-admin"))

    assert resp.status == "REJECTED"
    assert resp.reject_reason == "예산 미배정"
    assert resp.return_id == req.return_id
    assert conn.committed is True
    # 2 calls: UPDATE returns + INSERT audit_log
    sql_starts = [c[0] for c in cur.calls]
    assert "UPDATE" in sql_starts and "INSERT" in sql_starts


def test_returns_reject_branch_clerk_403(monkeypatch):
    monkeypatch.setattr("src.routes.intervention.db_conn", lambda: FakeConn(FakeCur(None)))
    with pytest.raises(HTTPException) as e:
        returns_reject(_req(), _ctx("branch-clerk"))
    assert e.value.status_code == 403


def test_returns_reject_wh_manager_403(monkeypatch):
    monkeypatch.setattr("src.routes.intervention.db_conn", lambda: FakeConn(FakeCur(None)))
    with pytest.raises(HTTPException) as e:
        returns_reject(_req(), _ctx("wh-manager"))
    assert e.value.status_code == 403


def test_returns_reject_already_processed_404(monkeypatch):
    """이미 APPROVED/REJECTED/EXECUTED 인 경우 UPDATE 가 매칭 row 없어서 None 반환 → 404."""
    cur = FakeCur(update_row=None)
    conn = FakeConn(cur)
    monkeypatch.setattr("src.routes.intervention.db_conn", lambda: conn)

    with pytest.raises(HTTPException) as e:
        returns_reject(_req(), _ctx("hq-admin"))
    assert e.value.status_code == 404
    assert conn.committed is False


def test_returns_reject_reason_min_length():
    """reject_reason 빈 문자열은 pydantic Field(min_length=1) 가 거부."""
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        ReturnRejectRequest(return_id=uuid4(), reject_reason="")


def test_returns_reject_reason_max_length():
    """reject_reason 200자 초과는 pydantic Field(max_length=200) 가 거부."""
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        ReturnRejectRequest(return_id=uuid4(), reject_reason="x" * 201)
