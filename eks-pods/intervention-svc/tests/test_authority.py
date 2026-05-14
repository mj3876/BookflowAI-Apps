"""권한 매트릭스 단위 테스트 · _validate_authority.

3-stage approval 매트릭스 (2026-05-14 REBALANCE 양측 협의 정정):
| Stage | order_type        | approval_side    | 권한                                |
|-------|-------------------|------------------|-----------------------------------|
| 1     | REBALANCE         | SOURCE / TARGET  | 해당 측 wh-manager / branch-clerk / hq-admin |
| 2     | WH_TRANSFER       | SOURCE / TARGET  | 해당 side wh 의 wh-manager / hq-admin |
| 3     | PUBLISHER_ORDER   | FINAL only       | hq-admin / 자기 권역 wh-manager      |
"""
import pytest
from fastapi import HTTPException

from src.auth import AuthContext
from src.routes.intervention import _validate_authority


class FakeCur:
    """단순 cursor stub. execute → row 저장, fetchone → 마지막 row 반환."""

    def __init__(self, order_row, location_rows):
        self.order_row = order_row
        self.location_rows = location_rows
        self._next = None

    def execute(self, sql, params=()):
        if "FROM pending_orders" in sql:
            self._next = self.order_row
        elif "FROM locations" in sql:
            loc_id = params[0]
            self._next = self.location_rows.get(loc_id)
        else:
            self._next = None

    def fetchone(self):
        return self._next


def _ctx(role: str, scope_wh_id: int | None = None, scope_store_id: int | None = None) -> AuthContext:
    user_id = {"hq-admin": "u1", "wh-manager": f"u-wh{scope_wh_id}"}.get(role, f"u-{role}")
    return AuthContext(user_id, role, scope_wh_id, scope_store_id, token="Bearer mock-token-x")


def _cur(order_type: str, source_loc: int | None, target_loc: int | None,
         loc_to_wh: dict[int, int] | None = None) -> FakeCur:
    """pending_orders + locations 두 SELECT 흐름 stub."""
    loc_rows = {k: (v,) for k, v in (loc_to_wh or {}).items()}
    return FakeCur(order_row=(order_type, source_loc, target_loc), location_rows=loc_rows)


# ─── REBALANCE (SOURCE/TARGET · 양측 협의 · 2026-05-14 정정) ───────────────
def test_rebalance_wh_manager_source_side_ok():
    cur = _cur("REBALANCE", 1, 3, {1: 1, 3: 1})
    ot, sw, tw = _validate_authority(cur, _ctx("wh-manager", 1), "x", "SOURCE")
    assert ot == "REBALANCE" and sw == 1 and tw == 1


def test_rebalance_wh_manager_target_side_ok():
    cur = _cur("REBALANCE", 1, 3, {1: 1, 3: 1})
    ot, *_ = _validate_authority(cur, _ctx("wh-manager", 1), "x", "TARGET")
    assert ot == "REBALANCE"


def test_rebalance_wh_manager_other_wh_403():
    # wh-manager-2 가 wh1 의 REBALANCE SOURCE 측 승인 시도 → 403
    cur = _cur("REBALANCE", 1, 3, {1: 1, 3: 1})
    with pytest.raises(HTTPException) as e:
        _validate_authority(cur, _ctx("wh-manager", 2), "x", "SOURCE")
    assert e.value.status_code == 403


def test_rebalance_side_final_rejected_400():
    # 양측 협의 변경 후: REBALANCE 에 FINAL 사이드 사용 시 400
    cur = _cur("REBALANCE", 1, 3, {1: 1, 3: 1})
    with pytest.raises(HTTPException) as e:
        _validate_authority(cur, _ctx("wh-manager", 1), "x", "FINAL")
    assert e.value.status_code == 400


def test_rebalance_branch_clerk_no_scope_match_403():
    # branch-clerk 자기 매장 아닌 REBALANCE → 403
    cur = _cur("REBALANCE", 1, 3, {1: 1, 3: 1})
    with pytest.raises(HTTPException) as e:
        _validate_authority(cur, _ctx("branch-clerk"), "x", "TARGET")
    assert e.value.status_code == 403


def test_rebalance_hq_admin_source_ok_anywhere():
    cur = _cur("REBALANCE", 9, 11, {9: 2, 11: 2})
    ot, *_ = _validate_authority(cur, _ctx("hq-admin"), "x", "SOURCE")
    assert ot == "REBALANCE"


def test_rebalance_hq_admin_target_ok_anywhere():
    cur = _cur("REBALANCE", 9, 11, {9: 2, 11: 2})
    ot, *_ = _validate_authority(cur, _ctx("hq-admin"), "x", "TARGET")
    assert ot == "REBALANCE"


# ─── WH_TRANSFER (SOURCE/TARGET · 해당 side wh) ───────────────────────────
def test_wh_transfer_source_side_own_wh_ok():
    # source_loc=1 (wh1) target_loc=9 (wh2). wh-manager-1 이 SOURCE 승인 → OK
    cur = _cur("WH_TRANSFER", 1, 9, {1: 1, 9: 2})
    ot, sw, tw = _validate_authority(cur, _ctx("wh-manager", 1), "x", "SOURCE")
    assert ot == "WH_TRANSFER" and sw == 1 and tw == 2


def test_wh_transfer_target_side_own_wh_ok():
    cur = _cur("WH_TRANSFER", 1, 9, {1: 1, 9: 2})
    _validate_authority(cur, _ctx("wh-manager", 2), "x", "TARGET")


def test_wh_transfer_source_side_other_wh_403():
    cur = _cur("WH_TRANSFER", 1, 9, {1: 1, 9: 2})
    with pytest.raises(HTTPException) as e:
        _validate_authority(cur, _ctx("wh-manager", 2), "x", "SOURCE")
    assert e.value.status_code == 403


def test_wh_transfer_with_final_side_400():
    cur = _cur("WH_TRANSFER", 1, 9, {1: 1, 9: 2})
    with pytest.raises(HTTPException) as e:
        _validate_authority(cur, _ctx("wh-manager", 1), "x", "FINAL")
    assert e.value.status_code == 400


# ─── PUBLISHER_ORDER (FINAL only · hq-admin OR wh-manager 자기 권역) ──────
# 사용자 결정 2026-05-03: 물류센터가 발주 주체. wh-manager 자기 권역 PUBLISHER_ORDER 승인 가능.
# (메모리: project_authority_clarifications_2026_05_03.md)
def test_publisher_order_hq_admin_ok():
    cur = _cur("PUBLISHER_ORDER", None, 3, {3: 1})
    ot, *_ = _validate_authority(cur, _ctx("hq-admin"), "x", "FINAL")
    assert ot == "PUBLISHER_ORDER"


def test_publisher_order_wh_manager_own_wh_ok():
    """wh-manager-1 이 target_wh=1 인 PUBLISHER_ORDER 승인 가능."""
    cur = _cur("PUBLISHER_ORDER", None, 3, {3: 1})
    ot, *_ = _validate_authority(cur, _ctx("wh-manager", 1), "x", "FINAL")
    assert ot == "PUBLISHER_ORDER"


def test_publisher_order_wh_manager_other_wh_403():
    """wh-manager-2 가 target_wh=1 인 PUBLISHER_ORDER 거절."""
    cur = _cur("PUBLISHER_ORDER", None, 3, {3: 1})
    with pytest.raises(HTTPException) as e:
        _validate_authority(cur, _ctx("wh-manager", 2), "x", "FINAL")
    assert e.value.status_code == 403


def test_publisher_order_branch_clerk_403():
    """branch-clerk 는 PUBLISHER_ORDER 절대 승인 불가."""
    cur = _cur("PUBLISHER_ORDER", None, 3, {3: 1})
    with pytest.raises(HTTPException) as e:
        _validate_authority(cur, _ctx("branch-clerk"), "x", "FINAL")
    assert e.value.status_code == 403


def test_publisher_order_with_source_side_400():
    cur = _cur("PUBLISHER_ORDER", None, 3, {3: 1})
    with pytest.raises(HTTPException) as e:
        _validate_authority(cur, _ctx("hq-admin"), "x", "SOURCE")
    assert e.value.status_code == 400


# ─── 잘못된 order_type · 404 ──────────────────────────────────────────────
def test_unknown_order_type_400():
    cur = _cur("UNKNOWN_TYPE", 1, 3, {1: 1, 3: 1})
    with pytest.raises(HTTPException) as e:
        _validate_authority(cur, _ctx("hq-admin"), "x", "FINAL")
    assert e.value.status_code == 400


def test_order_not_found_404():
    cur = FakeCur(order_row=None, location_rows={})
    with pytest.raises(HTTPException) as e:
        _validate_authority(cur, _ctx("hq-admin"), "x", "FINAL")
    assert e.value.status_code == 404


# ─── branch-clerk REBALANCE 양측 협의 권한 (FR-A6.6 정합) ─────────────────
# 2026-05-14: REBALANCE 양측 협의 → branch-clerk 가 SOURCE/TARGET 양쪽 모두 자기 측 승인.
#   - 자기 매장이 source 면 SOURCE 측 (출고 동의)
#   - 자기 매장이 target 면 TARGET 측 (입고 동의)
def test_rebalance_branch_clerk_target_match_ok():
    """branch-clerk scope_store_id == target → TARGET 승인 OK"""
    cur = _cur("REBALANCE", 4, 3, {4: 1, 3: 1})
    ot, *_ = _validate_authority(cur, _ctx("branch-clerk", scope_store_id=3), "x", "TARGET")
    assert ot == "REBALANCE"


def test_rebalance_branch_clerk_source_match_ok():
    """branch-clerk scope_store_id == source → SOURCE 승인 OK"""
    cur = _cur("REBALANCE", 4, 3, {4: 1, 3: 1})
    ot, *_ = _validate_authority(cur, _ctx("branch-clerk", scope_store_id=4), "x", "SOURCE")
    assert ot == "REBALANCE"


def test_rebalance_branch_clerk_target_mismatch_403():
    """branch-clerk 가 자기 매장 외 TARGET 측 승인 → 403"""
    cur = _cur("REBALANCE", 4, 3, {4: 1, 3: 1})
    with pytest.raises(HTTPException) as e:
        _validate_authority(cur, _ctx("branch-clerk", scope_store_id=5), "x", "TARGET")
    assert e.value.status_code == 403


def test_rebalance_branch_clerk_source_mismatch_403():
    """branch-clerk 가 자기 매장 외 SOURCE 측 승인 → 403"""
    cur = _cur("REBALANCE", 4, 3, {4: 1, 3: 1})
    with pytest.raises(HTTPException) as e:
        _validate_authority(cur, _ctx("branch-clerk", scope_store_id=5), "x", "SOURCE")
    assert e.value.status_code == 403


def test_rebalance_branch_clerk_target_user_source_side_403():
    """branch-clerk scope=target_loc 이 SOURCE 측 승인 시도 → 403 (my_side_loc mismatch)"""
    cur = _cur("REBALANCE", 4, 3, {4: 1, 3: 1})
    with pytest.raises(HTTPException) as e:
        _validate_authority(cur, _ctx("branch-clerk", scope_store_id=3), "x", "SOURCE")
    assert e.value.status_code == 403


def test_rebalance_branch_clerk_no_scope_403():
    """branch-clerk scope_store_id 부재 (인증 손상) → 403"""
    cur = _cur("REBALANCE", 4, 3, {4: 1, 3: 1})
    with pytest.raises(HTTPException) as e:
        _validate_authority(cur, _ctx("branch-clerk", scope_store_id=None), "x", "TARGET")
    assert e.value.status_code == 403


def test_wh_transfer_branch_clerk_403():
    """WH_TRANSFER target 은 WH 라서 branch-clerk 와 무관 → 403"""
    cur = _cur("WH_TRANSFER", 1, 2, {1: 1, 2: 2})
    with pytest.raises(HTTPException) as e:
        _validate_authority(cur, _ctx("branch-clerk", scope_store_id=3), "x", "TARGET")
    assert e.value.status_code == 403
