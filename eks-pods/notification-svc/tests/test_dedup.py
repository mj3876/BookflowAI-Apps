"""_check_and_set_dedup unit tests — Redis SET NX 중복 차단 로직."""
from unittest.mock import MagicMock, patch
from uuid import uuid4

from src.routes.notification import _check_and_set_dedup


def _mock_redis(set_return):
    r = MagicMock()
    r.set.return_value = set_return
    return r


def test_first_call_returns_false(monkeypatch):
    """최초 발송: Redis SET NX 성공(True 반환) → 중복 아님 → False."""
    with patch("src.routes.notification.redis_client", return_value=_mock_redis(True)):
        assert _check_and_set_dedup("StockArrivalPending", uuid4()) is False


def test_duplicate_call_returns_true(monkeypatch):
    """중복 발송: Redis SET NX 실패(None 반환) → 중복 → True."""
    with patch("src.routes.notification.redis_client", return_value=_mock_redis(None)):
        assert _check_and_set_dedup("StockArrivalPending", uuid4()) is True


def test_none_correlation_id_skips_dedup():
    """correlation_id 없으면 항상 False (차단 불가)."""
    assert _check_and_set_dedup("StockArrivalPending", None) is False


def test_redis_error_fail_open():
    """Redis 장애 시 fail-open — 발송 허용(False)."""
    r = MagicMock()
    r.set.side_effect = Exception("redis down")
    with patch("src.routes.notification.redis_client", return_value=r):
        assert _check_and_set_dedup("StockArrivalPending", uuid4()) is False


def test_dedup_key_includes_event_type_and_correlation_id():
    """키가 event_type + correlation_id 조합임을 검증 (다른 event_type은 별도 키)."""
    cid = uuid4()
    r = MagicMock()
    r.set.return_value = True
    with patch("src.routes.notification.redis_client", return_value=r):
        _check_and_set_dedup("StockArrivalPending", cid)
        called_key = r.set.call_args[0][0]
        assert "StockArrivalPending" in called_key
        assert str(cid) in called_key


def test_ttl_is_set():
    """SET 호출 시 ex(TTL) 인자가 전달되는지 검증."""
    r = MagicMock()
    r.set.return_value = True
    with patch("src.routes.notification.redis_client", return_value=r):
        _check_and_set_dedup("StockDepartPending", uuid4())
        _, kwargs = r.set.call_args
        assert kwargs.get("ex") == 300
        assert kwargs.get("nx") is True
