"""UX-2 신간 편입 권역별 분배 추천 - compute_wh_split 단위 테스트.

순수 함수 (DB 없이) - wh_id 별 카테고리 매출 카운트 → wh1/wh2 분배 수량 + 비율.
"""
import pytest

from src.routes.master import compute_wh_split


def test_split_60_40_fallback_when_no_data():
    """카테고리 sales 데이터 없을 때 60/40 fallback (수도권 우세)."""
    result = compute_wh_split({}, default_qty=100)
    assert result["wh1_qty"] == 60
    assert result["wh2_qty"] == 40
    assert result["source"] == "fallback"


def test_split_uses_category_ratio_when_data_present():
    """카테고리 sales 데이터 있으면 실제 비율로 분배."""
    # wh1=300건, wh2=200건 → 60% / 40%
    result = compute_wh_split({1: 300, 2: 200}, default_qty=100)
    assert result["wh1_qty"] == 60
    assert result["wh2_qty"] == 40
    assert result["source"] == "category"


def test_split_50_50_when_equal_counts():
    """동일 매출이면 50/50."""
    result = compute_wh_split({1: 100, 2: 100}, default_qty=100)
    assert result["wh1_qty"] == 50
    assert result["wh2_qty"] == 50


def test_split_wh1_only_when_wh2_zero():
    """wh2 매출 0 이면 전부 wh1."""
    result = compute_wh_split({1: 500, 2: 0}, default_qty=100)
    assert result["wh1_qty"] == 100
    assert result["wh2_qty"] == 0


def test_split_wh1_only_when_only_wh1_in_data():
    """dict 에 wh2 키 자체가 없으면 wh1=100, wh2=0."""
    result = compute_wh_split({1: 500}, default_qty=100)
    assert result["wh1_qty"] == 100
    assert result["wh2_qty"] == 0


def test_split_default_qty_respected():
    """default_qty=200 일 때 합이 200."""
    result = compute_wh_split({1: 300, 2: 200}, default_qty=200)
    assert result["wh1_qty"] + result["wh2_qty"] == 200
    assert result["wh1_qty"] == 120  # 60% of 200
    assert result["wh2_qty"] == 80


def test_split_handles_unrelated_wh_keys():
    """알 수 없는 wh_id (예: NULL/3) 는 무시하고 wh1+wh2 만 사용."""
    result = compute_wh_split({1: 300, 2: 200, None: 50, 9: 100}, default_qty=100)
    # wh1+wh2 = 500 만 사용 → 60/40
    assert result["wh1_qty"] == 60
    assert result["wh2_qty"] == 40


def test_split_returns_pct_for_chart():
    """Bar chart 표시용 percentage 도 같이 반환."""
    result = compute_wh_split({1: 300, 2: 200}, default_qty=100)
    assert result["wh1_pct"] == 60
    assert result["wh2_pct"] == 40
