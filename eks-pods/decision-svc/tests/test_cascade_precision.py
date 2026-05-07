"""decision-svc cascade 정밀화 단위 테스트.

FR-A5.1 (Stage 1 effective available):
  effective_available = on_hand - reserved_qty - incoming_qty - expected_demand_14d

incoming_qty: pending_orders APPROVED 중 target_location_id == self · executed_at IS NULL 합
expected_demand_14d: forecast_cache 의 향후 14일 SUM(predicted_demand)

Stage 1 source picker 가 effective_available >= qty 인 location 만 선택해야 함.

FR-A5.3 (Stage 2 partner surplus · 권역간 이동 가능 여유분):
  partner_surplus = on_hand - reserved_qty - safety_stock - max(0, expected_demand_14d)

타 권역 WH 가 자기 안전재고 + 14일 예상수요를 보전하고도 보낼 수 있는 양.
음수면 보낼 수 없음 (자기도 부족).

FR-A6.2 / A5.8 / A3.8 (INACTIVE / SOFT_DISCONTINUE 도서 의사결정 통제):
  - active=FALSE 또는 discontinue_mode='INACTIVE' → 모든 의사결정 차단 (400)
  - discontinue_mode='SOFT_DISCONTINUE' → 재분배(Stage 1) + 권역이동(Stage 2) OK · 신규 발주(Stage 3) 차단
  - 그 외 (active=TRUE + mode IN ('NONE', NULL)) → 모든 단계 허용
"""
import pytest

import math

from src.routes.decision import (
    _auto_execute_eligible,
    _calc_eoq,
    _check_book_decision_eligibility,
    _effective_available,
    _partner_surplus,
)


# ─── pure formula tests (FR-A5.1 정의) ──────────────────────────────────
def test_effective_available_basic():
    """on_hand 100, reserved 20, incoming 30, demand 15 → 35"""
    assert _effective_available(on_hand=100, reserved_qty=20, incoming_qty=30, expected_demand=15) == 35


def test_effective_available_no_reserve_no_incoming_no_demand():
    """only on_hand → on_hand 그대로"""
    assert _effective_available(on_hand=50, reserved_qty=0, incoming_qty=0, expected_demand=0) == 50


def test_effective_available_can_go_negative():
    """예상수요 > on_hand → 음수 (부족 표시 · 의사결정 입력으로 사용)"""
    assert _effective_available(on_hand=50, reserved_qty=0, incoming_qty=0, expected_demand=100) == -50


def test_effective_available_negative_demand_clamped_to_zero():
    """예상수요 음수 (이상치 / NULL) → 0 으로 clamp · on_hand 만큼 사용 가능"""
    assert _effective_available(on_hand=50, reserved_qty=0, incoming_qty=0, expected_demand=-5) == 50


def test_effective_available_all_components():
    """100 - 10 - 5 - 30 = 55"""
    assert _effective_available(on_hand=100, reserved_qty=10, incoming_qty=5, expected_demand=30) == 55


def test_effective_available_zero_when_balanced():
    """100 - 100 - 0 - 0 = 0"""
    assert _effective_available(on_hand=100, reserved_qty=100, incoming_qty=0, expected_demand=0) == 0


def test_effective_available_handles_none_reserved_as_zero():
    """reserved_qty None (DB NULL) → 0"""
    assert _effective_available(on_hand=50, reserved_qty=None, incoming_qty=0, expected_demand=0) == 50


def test_effective_available_handles_none_incoming_demand():
    """incoming_qty / expected_demand None → 0"""
    assert _effective_available(on_hand=50, reserved_qty=10, incoming_qty=None, expected_demand=None) == 40


# ─── partner_surplus pure formula tests (FR-A5.3 정의) ─────────────────────
def test_partner_surplus_basic():
    """on_hand 200, reserved 30, safety 50, demand 40 → 200-30-50-40 = 80"""
    assert _partner_surplus(on_hand=200, reserved_qty=30, safety_stock=50, expected_demand=40) == 80


def test_partner_surplus_no_safety():
    """safety_stock NULL → 0 으로 처리 · 200-30-0-40 = 130"""
    assert _partner_surplus(on_hand=200, reserved_qty=30, safety_stock=None, expected_demand=40) == 130


def test_partner_surplus_negative_demand_clamped():
    """demand 음수 (이상치 forecast) → 0 으로 clamp · 100-10-20-0 = 70"""
    assert _partner_surplus(on_hand=100, reserved_qty=10, safety_stock=20, expected_demand=-5) == 70


def test_partner_surplus_can_go_negative():
    """수요 + 안전재고 합계가 가용 초과 → 음수 (이전 가능 X · 자기도 부족)"""
    assert _partner_surplus(on_hand=50, reserved_qty=10, safety_stock=30, expected_demand=20) == -10


def test_partner_surplus_zero_when_balanced():
    """surplus 0 = 안전재고 + 예상수요만 정확히 보전"""
    assert _partner_surplus(on_hand=100, reserved_qty=0, safety_stock=80, expected_demand=20) == 0


def test_partner_surplus_handles_none_reserved():
    """reserved_qty None (DB NULL) → 0 · 100-0-30-20 = 50"""
    assert _partner_surplus(on_hand=100, reserved_qty=None, safety_stock=30, expected_demand=20) == 50


def test_partner_surplus_all_zero():
    """완전 신간 location · 모두 0 → 0"""
    assert _partner_surplus(on_hand=0, reserved_qty=0, safety_stock=0, expected_demand=0) == 0


# ─── _stage2_source 반환 형태 (FR-A5.3 enriched rationale 지원) ────────────
# Stage 2 source picker 는 단순 location_id 가 아닌 enriched dict 를 반환해야
# decide() 에서 rationale 에 partner_* 필드를 채울 수 있음.
class _FakeCur:
    def __init__(self, rows):
        self._rows = list(rows)
        self.last_sql = None
        self.last_params = None

    def execute(self, sql, params=()):
        self.last_sql = sql
        self.last_params = params

    def fetchone(self):
        return self._rows.pop(0) if self._rows else None


def test_stage2_source_returns_enriched_dict_when_partner_found():
    """partner WH 가 surplus 충족 → location_id + partner_* 필드 dict 반환"""
    from src.routes.decision import _stage2_source
    # 행 형태: (location_id, partner_wh, on_hand, reserved, safety, expected_demand_14d, surplus)
    cur = _FakeCur([(101, 2, 200, 30, 50, 40, 80)])
    result = _stage2_source(cur, isbn13="1234567890123", target_wh=1, qty=50)
    assert result is not None
    assert result["location_id"] == 101
    assert result["partner_wh"] == 2
    assert result["partner_on_hand"] == 200
    assert result["partner_reserved"] == 30
    assert result["partner_safety"] == 50
    assert result["partner_expected_demand_14d"] == 40
    assert result["partner_surplus"] == 80


def test_stage2_source_returns_none_when_no_partner():
    """surplus ≥ qty 인 partner 없음 → None (Stage 3 fallback)"""
    from src.routes.decision import _stage2_source
    cur = _FakeCur([])
    assert _stage2_source(cur, isbn13="x", target_wh=1, qty=50) is None


def test_stage2_source_passes_target_wh_isbn_qty_to_sql():
    """SQL params 로 target_wh, isbn13, qty 가 전달되어 권역간 + isbn 필터 + 최소량 보장."""
    from src.routes.decision import _stage2_source
    cur = _FakeCur([])
    _stage2_source(cur, isbn13="9876543210987", target_wh=2, qty=100)
    assert "9876543210987" in cur.last_params
    assert 2 in cur.last_params
    assert 100 in cur.last_params


# ─── _check_book_decision_eligibility (FR-A6.2 / A5.8 / A3.8) ──────────────
def test_book_eligibility_active_normal_all_allowed():
    """active=TRUE + discontinue_mode='NONE' → 의사결정 OK · 출판사 발주 OK"""
    allow_dec, allow_pub = _check_book_decision_eligibility(active=True, discontinue_mode="NONE")
    assert allow_dec is True
    assert allow_pub is True


def test_book_eligibility_active_mode_null_all_allowed():
    """discontinue_mode NULL (legacy row) → 'NONE' 과 동일 처리"""
    allow_dec, allow_pub = _check_book_decision_eligibility(active=True, discontinue_mode=None)
    assert allow_dec is True
    assert allow_pub is True


def test_book_eligibility_soft_discontinue_blocks_publisher_order():
    """SOFT_DISCONTINUE → 재분배·권역이동 OK · 신규 발주 차단 (재고 소진 모드)"""
    allow_dec, allow_pub = _check_book_decision_eligibility(active=True, discontinue_mode="SOFT_DISCONTINUE")
    assert allow_dec is True
    assert allow_pub is False


def test_book_eligibility_inactive_mode_blocks_all():
    """discontinue_mode='INACTIVE' → 모든 의사결정 차단"""
    allow_dec, allow_pub = _check_book_decision_eligibility(active=True, discontinue_mode="INACTIVE")
    assert allow_dec is False
    assert allow_pub is False


def test_book_eligibility_active_false_blocks_all():
    """active=FALSE → 어떤 mode 이든 모든 의사결정 차단 (master 비활성)"""
    allow_dec, allow_pub = _check_book_decision_eligibility(active=False, discontinue_mode="NONE")
    assert allow_dec is False
    assert allow_pub is False


def test_book_eligibility_active_false_with_inactive_mode_blocks_all():
    """active=FALSE + INACTIVE 둘 다 → 차단 (양 조건 OR)"""
    allow_dec, allow_pub = _check_book_decision_eligibility(active=False, discontinue_mode="INACTIVE")
    assert allow_dec is False
    assert allow_pub is False


# ─── _auto_execute_eligible (FR-A4.7) ───────────────────────────────────────
# FR-A4.7: 외부 발주 (Stage 3 PUBLISHER_ORDER) + 긴급 (URGENT/CRITICAL) 만 자동 승인 후보.
# 권역 내 재분배 (Stage 1) / 권역 이동 (Stage 2) 는 항상 사람 승인 필요 (담당자 책임).
# CronJob 07:00 KST 가 auto_execute_eligible=TRUE row 를 일괄 승인 + 발주 (사용자 결정).
def test_auto_execute_stage3_urgent_eligible():
    """Stage 3 + URGENT → True (외부 발주 자동 트리거)"""
    assert _auto_execute_eligible(stage_num=3, urgency_level="URGENT") is True


def test_auto_execute_stage3_critical_eligible():
    """Stage 3 + CRITICAL → True"""
    assert _auto_execute_eligible(stage_num=3, urgency_level="CRITICAL") is True


def test_auto_execute_stage3_normal_not_eligible():
    """Stage 3 + NORMAL → False (긴급 아니면 사람 승인 받기)"""
    assert _auto_execute_eligible(stage_num=3, urgency_level="NORMAL") is False


def test_auto_execute_stage1_urgent_not_eligible():
    """Stage 1 + URGENT → False (재분배는 항상 사람 승인 · 기존 True 정정)"""
    assert _auto_execute_eligible(stage_num=1, urgency_level="URGENT") is False


def test_auto_execute_stage1_critical_not_eligible():
    """Stage 1 + CRITICAL → False (기존 True 정정)"""
    assert _auto_execute_eligible(stage_num=1, urgency_level="CRITICAL") is False


def test_auto_execute_stage2_critical_not_eligible():
    """Stage 2 + CRITICAL → False (권역 이동은 SOURCE/TARGET 양측 사람 승인 필요)"""
    assert _auto_execute_eligible(stage_num=2, urgency_level="CRITICAL") is False


def test_auto_execute_stage1_normal_not_eligible():
    """Stage 1 + NORMAL → False"""
    assert _auto_execute_eligible(stage_num=1, urgency_level="NORMAL") is False


# ─── _calc_eoq (FR-A4.1 경제적 발주량 sqrt(2DS/H)) ───────────────────────────
# D: annual_demand · S: order_cost (발주 1건 비용) · H: holding_cost (단위당 연간 보관비)
# 음수/0 입력 → MIN_EOQ 반환 (출판사 정책 최소 발주량 안전망)
def test_eoq_basic_formula():
    """D=1000, S=50000, H=500 → EOQ = sqrt(2 * 1000 * 50000 / 500) = sqrt(200000) ≈ 447"""
    expected = math.sqrt(200000)
    result = _calc_eoq(annual_demand=1000, order_cost=50000, holding_cost=500)
    assert abs(result - expected) < 1.0  # rounding tolerance


def test_eoq_zero_demand_returns_min():
    """수요 0 → MIN_EOQ (10) · 발주 안 하는 게 정답이지만 호출되면 최소량"""
    assert _calc_eoq(annual_demand=0, order_cost=50000, holding_cost=500) == 10


def test_eoq_negative_demand_returns_min():
    """수요 음수 (이상치) → MIN_EOQ"""
    assert _calc_eoq(annual_demand=-100, order_cost=50000, holding_cost=500) == 10


def test_eoq_zero_order_cost_returns_min():
    """order_cost=0 → division 안전 · MIN_EOQ"""
    assert _calc_eoq(annual_demand=1000, order_cost=0, holding_cost=500) == 10


def test_eoq_zero_holding_cost_returns_min():
    """holding_cost=0 → division by zero 회피 · MIN_EOQ"""
    assert _calc_eoq(annual_demand=1000, order_cost=50000, holding_cost=0) == 10


def test_eoq_high_demand_low_holding_returns_large_qty():
    """베스트셀러 시나리오 D=10000, S=50000, H=200 → EOQ = sqrt(5,000,000) ≈ 2236"""
    expected = math.sqrt(5_000_000)
    result = _calc_eoq(annual_demand=10000, order_cost=50000, holding_cost=200)
    assert abs(result - expected) < 1.0


def test_eoq_below_min_clamps_to_min():
    """계산된 EOQ 가 MIN 보다 작으면 MIN 으로 끌어올림 (D=10, S=100, H=10000 → EOQ ≈ 0.45 → MIN)"""
    assert _calc_eoq(annual_demand=10, order_cost=100, holding_cost=10000) == 10


def test_eoq_returns_int():
    """반환은 정수 (수량 단위) — 소수점 반올림"""
    result = _calc_eoq(annual_demand=1000, order_cost=50000, holding_cost=500)
    assert isinstance(result, int)
