"""inventory-svc reservation TTL cleanup 단위 테스트 (Phase A2 / FR · 시트04).

만료 reservations 정리:
  - ttl < NOW() AND status='ACTIVE' row → status='EXPIRED'
  - 각 (isbn13, location_id) 묶음별 inventory.reserved_qty -= sum(qty)
  - 실패 row 차단 (FOR UPDATE SKIP LOCKED · BATCH_SIZE 제한)
  - audit_log 'reservation.expire' 1건 (대표 + 통계)
"""
from src.cron.reservation_cleanup import (
    _aggregate_by_inventory,
    _summarize_rows,
)


# ─── _aggregate_by_inventory ────────────────────────────────────────────
def test_aggregate_basic():
    """동일 (isbn, loc) 의 qty 합산"""
    rows = [
        ("res-1", "9788912345678", 1, 5),
        ("res-2", "9788912345678", 1, 3),
        ("res-3", "9788900000000", 2, 7),
    ]
    agg = _aggregate_by_inventory(rows)
    assert agg == {("9788912345678", 1): 8, ("9788900000000", 2): 7}


def test_aggregate_empty():
    """빈 입력 → 빈 dict"""
    assert _aggregate_by_inventory([]) == {}


def test_aggregate_single_row():
    rows = [("res-x", "9788900000001", 5, 10)]
    assert _aggregate_by_inventory(rows) == {("9788900000001", 5): 10}


def test_aggregate_distinct_isbn_same_location():
    """같은 location_id 라도 isbn 다르면 별도 키"""
    rows = [
        ("a", "9780000000001", 1, 4),
        ("b", "9780000000002", 1, 6),
    ]
    agg = _aggregate_by_inventory(rows)
    assert agg == {("9780000000001", 1): 4, ("9780000000002", 1): 6}


# ─── _summarize_rows ────────────────────────────────────────────────────
def test_summarize_basic():
    """통계: expired_count + qty_released + 영향받은 inventory 셀 수"""
    rows = [
        ("a", "9780000000001", 1, 4),
        ("b", "9780000000001", 1, 6),
        ("c", "9780000000002", 2, 5),
    ]
    s = _summarize_rows(rows)
    assert s["expired_count"] == 3
    assert s["qty_released"] == 15
    assert s["inventory_cells_affected"] == 2


def test_summarize_empty():
    s = _summarize_rows([])
    assert s["expired_count"] == 0
    assert s["qty_released"] == 0
    assert s["inventory_cells_affected"] == 0
