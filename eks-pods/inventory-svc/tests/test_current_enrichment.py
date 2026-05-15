"""inventory-svc /current 응답 enrichment 단위 테스트 (FR-A7.4).

응답에 포함되어야 할 필드:
- 기존: isbn13 · location_id · on_hand · reserved_qty · safety_stock · available · updated_at
- 신규 (FR-A7.4):
  - title (도서명 표시 — UI 편의)
  - expected_soldout_at (예상 소진일)
  - incoming_qty (입고 예정 수량 — pending_orders APPROVED 합)
  - outgoing_qty (출고 예정 수량 — pending_orders APPROVED 합)

DB row → pydantic 모델 매핑은 `_inventory_item_from_row` pure helper 가 담당.
"""
from datetime import date, datetime, timezone

from src.routes.inventory import _inventory_item_from_row


def test_row_basic_full_fields():
    """모든 필드 채워진 row → 모든 필드 포함 모델"""
    updated = datetime(2026, 5, 5, 12, 0, tzinfo=timezone.utc)
    soldout = date(2026, 5, 20)
    row = ("9788912345678", 1, 100, 20, 30, updated, "베스트셀러 도서명", soldout, 50, 10)
    item = _inventory_item_from_row(row)
    assert item.isbn13 == "9788912345678"
    assert item.location_id == 1
    assert item.on_hand == 100
    assert item.reserved_qty == 20
    assert item.safety_stock == 30
    assert item.available == 80  # on_hand - reserved
    assert item.updated_at == updated
    assert item.title == "베스트셀러 도서명"
    assert item.expected_soldout_at == soldout
    assert item.incoming_qty == 50
    assert item.outgoing_qty == 10


def test_row_no_title_no_soldout():
    """books LEFT JOIN 결과 NULL → title/expected_soldout_at None 허용"""
    updated = datetime(2026, 5, 5, 12, 0, tzinfo=timezone.utc)
    row = ("9788900000000", 2, 50, 0, 0, updated, None, None, 0, 0)
    item = _inventory_item_from_row(row)
    assert item.title is None
    assert item.expected_soldout_at is None
    assert item.incoming_qty == 0
    assert item.outgoing_qty == 0


def test_row_zero_pending_orders():
    """pending_orders 없음 → incoming/outgoing 0"""
    updated = datetime(2026, 5, 5, 12, 0, tzinfo=timezone.utc)
    row = ("9788911111111", 5, 200, 50, 20, updated, "신간", date(2026, 6, 1), 0, 0)
    item = _inventory_item_from_row(row)
    assert item.incoming_qty == 0
    assert item.outgoing_qty == 0
    assert item.available == 150


def test_row_high_outgoing_marks_low_available():
    """outgoing 많아도 available = on_hand - reserved (별도 표시) — outgoing 은 정보용"""
    updated = datetime(2026, 5, 5, 12, 0, tzinfo=timezone.utc)
    row = ("9788922222222", 7, 100, 10, 30, updated, "재고소진중", date(2026, 5, 10), 0, 80)
    item = _inventory_item_from_row(row)
    assert item.available == 90  # 기존 정의 유지 (UI 측에서 outgoing 보고 판단)
    assert item.outgoing_qty == 80


def test_row_safety_stock_null_clamped_to_zero():
    """inventory.safety_stock NULL → 0 (DB COALESCE 기대 + 모델 측에서도 안전)"""
    updated = datetime(2026, 5, 5, 12, 0, tzinfo=timezone.utc)
    row = ("9788933333333", 3, 50, 5, 0, updated, None, None, 0, 0)
    item = _inventory_item_from_row(row)
    assert item.safety_stock == 0
