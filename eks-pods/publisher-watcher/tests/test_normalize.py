"""publisher-watcher payload 정규화 단위 테스트 (FR-A1.4 풀 필드).

출판사 신간 신청 API 응답 row 를 DB INSERT 가능한 정규 형식으로 변환.
- isbn13 / publisher_id / title / author / genre
- expected_pub_date (DATE)
- estimated_initial_sales (INT)
- marketing_plan (TEXT)
- similar_books (JSONB list)
- target_segments (JSONB list)
"""
from datetime import date

from src.poll import _normalize_request, _parse_date


# ─── _parse_date ───────────────────────────────────────────────────────────
def test_parse_date_valid_iso():
    assert _parse_date("2026-06-01") == date(2026, 6, 1)


def test_parse_date_none_returns_none():
    assert _parse_date(None) is None


def test_parse_date_empty_string_returns_none():
    assert _parse_date("") is None


def test_parse_date_invalid_returns_none():
    """이상한 문자열 → None (parse 실패 swallow · 다른 row 처리 진행)"""
    assert _parse_date("tomorrow") is None
    assert _parse_date("2026/06/01") is None  # ISO 만 허용


# ─── _normalize_request ───────────────────────────────────────────────────
def test_normalize_full_payload():
    """모든 필드 채워진 풀 payload"""
    payload = {
        "isbn13": "9788912345678",
        "publisher_id": "PUB001",
        "title": "신간 도서 A",
        "author": "김작가",
        "genre": "소설",
        "expected_pub_date": "2026-06-01",
        "estimated_initial_sales": 5000,
        "marketing_plan": "TV 광고 + SNS 인플루언서",
        "similar_books": ["9788900000001", "9788900000002"],
        "target_segments": ["20대 여성", "30대 직장인"],
    }
    n = _normalize_request(payload)
    assert n["isbn13"] == "9788912345678"
    assert n["publisher_id"] == "PUB001"
    assert n["title"] == "신간 도서 A"
    assert n["author"] == "김작가"
    assert n["genre"] == "소설"
    assert n["expected_pub_date"] == date(2026, 6, 1)
    assert n["estimated_initial_sales"] == 5000
    assert n["marketing_plan"] == "TV 광고 + SNS 인플루언서"
    assert n["similar_books"] == ["9788900000001", "9788900000002"]
    assert n["target_segments"] == ["20대 여성", "30대 직장인"]


def test_normalize_minimal_payload():
    """필수 필드만 (isbn13 + publisher_id + title) → 나머지 default"""
    payload = {"isbn13": "9788900000003", "publisher_id": "PUB002", "title": "최소 페이로드"}
    n = _normalize_request(payload)
    assert n["isbn13"] == "9788900000003"
    assert n["author"] is None
    assert n["genre"] is None
    assert n["expected_pub_date"] is None
    assert n["estimated_initial_sales"] == 0
    assert n["marketing_plan"] == ""
    assert n["similar_books"] == []
    assert n["target_segments"] == []


def test_normalize_genre_falls_back_to_category_name():
    """genre 필드 없고 category_name 있으면 그것 사용 (출판사마다 명칭 다름)"""
    payload = {"isbn13": "9788900000004", "publisher_id": "PUB003", "category_name": "자기계발"}
    n = _normalize_request(payload)
    assert n["genre"] == "자기계발"


def test_normalize_invalid_pub_date_clamped_to_none():
    """expected_pub_date 가 잘못된 형식 → None (스킵 · 다른 필드는 살림)"""
    payload = {
        "isbn13": "9788900000005",
        "publisher_id": "PUB004",
        "title": "날짜오류",
        "expected_pub_date": "2026-13-99",  # invalid month
    }
    n = _normalize_request(payload)
    assert n["expected_pub_date"] is None
    assert n["title"] == "날짜오류"  # 다른 필드 보존


def test_normalize_estimated_sales_string_to_int():
    """estimated_initial_sales 가 string 으로 와도 int 로 변환"""
    payload = {
        "isbn13": "9788900000006",
        "publisher_id": "PUB005",
        "estimated_initial_sales": "3000",
    }
    n = _normalize_request(payload)
    assert n["estimated_initial_sales"] == 3000


def test_normalize_null_lists_become_empty():
    """similar_books / target_segments 가 None 이면 빈 list (JSONB 안전)"""
    payload = {
        "isbn13": "9788900000007",
        "publisher_id": "PUB006",
        "similar_books": None,
        "target_segments": None,
    }
    n = _normalize_request(payload)
    assert n["similar_books"] == []
    assert n["target_segments"] == []
