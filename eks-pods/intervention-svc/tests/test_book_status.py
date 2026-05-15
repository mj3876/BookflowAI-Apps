"""HQ 도서 ON/OFF + 소진 모드 변경 검증.

change_book_status 의 빠른 검증 (role/mode) 만 단위테스트.
DB UPDATE 흐름은 통합 테스트 영역.
"""
import pytest
from fastapi import HTTPException

from src.auth import AuthContext
from src.routes.intervention import change_book_status, _VALID_BOOK_STATUSES


def _ctx(role: str) -> AuthContext:
    return AuthContext("u1", role, None, None, token="Bearer mock-token-x")


def test_valid_modes():
    assert set(_VALID_BOOK_STATUSES) == {"NORMAL", "SOFT_DISCONTINUE", "INACTIVE"}


def test_non_hq_admin_403_wh_manager():
    with pytest.raises(HTTPException) as e:
        change_book_status("9788956746425", {"mode": "NORMAL"}, _ctx("wh-manager"))
    assert e.value.status_code == 403


def test_non_hq_admin_403_branch_clerk():
    with pytest.raises(HTTPException) as e:
        change_book_status("9788956746425", {"mode": "INACTIVE", "reason": "x"}, _ctx("branch-clerk"))
    assert e.value.status_code == 403


def test_invalid_mode_400():
    with pytest.raises(HTTPException) as e:
        change_book_status("9788956746425", {"mode": "BOGUS"}, _ctx("hq-admin"))
    assert e.value.status_code == 400


def test_missing_mode_400():
    with pytest.raises(HTTPException) as e:
        change_book_status("9788956746425", {}, _ctx("hq-admin"))
    assert e.value.status_code == 400


def test_none_body_400():
    with pytest.raises(HTTPException) as e:
        change_book_status("9788956746425", None, _ctx("hq-admin"))
    assert e.value.status_code == 400
