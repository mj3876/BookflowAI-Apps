"""decision-svc GET /decision/pending-orders role/scope 자동 필터링.

매트릭스 (2026-05-14 정정):
- hq-admin: 전체
- wh-manager + scope_wh_id: source 또는 target wh = scope_wh_id
- branch-clerk + scope_store_id: target_location_id = scope_store_id

_plan_scope_clause 헬퍼 재사용 (plan_daily summary/items 와 동일 규약).
"""
from datetime import datetime, timezone

import pytest

from src.auth import AuthContext
from src.routes import decision as dc
from src.routes.decision import list_pending


CREATED_AT = datetime(2026, 5, 14, 10, 0, tzinfo=timezone.utc)


class FakeDB:
    def __init__(self):
        self.rows: list[dict] = []

    def add(self, **kw):
        defaults = {
            "order_id": "00000000-0000-0000-0000-000000000000",
            "order_type": "REBALANCE",
            "isbn13": "9788956746425",
            "source_location_id": 11,
            "target_location_id": 12,
            "qty": 10,
            "urgency_level": "NORMAL",
            "status": "PENDING",
            "created_at": CREATED_AT,
            "wh_source": 1,
            "wh_target": 1,
        }
        defaults.update(kw)
        self.rows.append(defaults)


class FakeCur:
    def __init__(self, db: FakeDB):
        self.db = db
        self._result: list = []

    def fetchone(self):
        return self._result[0] if self._result else None

    def fetchall(self):
        return list(self._result)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def execute(self, sql, params=()):
        # list_pending SQL 만 처리. status PENDING + 옵션 scope clause + LIMIT.
        rows = [r for r in self.db.rows if r["status"] == "PENDING"]

        # SQL 본문 기반 scope filter
        if "po.source_location_id AND sl.wh_id = %s" in sql and "po.target_location_id AND tl.wh_id = %s" in sql:
            wh = params[0]
            rows = [r for r in rows if wh in (r["wh_source"], r["wh_target"])]
        elif "po.target_location_id = %s" in sql:
            store = params[0]
            rows = [r for r in rows if r["target_location_id"] == store]

        self._result = [
            (
                r["order_id"], r["order_type"], r["isbn13"],
                r["source_location_id"], r["target_location_id"],
                r["qty"], r["urgency_level"], r["status"], r["created_at"],
            )
            for r in rows
        ]

    def close(self):
        pass


class FakeConn:
    def __init__(self, db: FakeDB):
        self.db = db
        self._cur = FakeCur(db)

    def cursor(self):
        return self._cur

    def commit(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def _ctx(role: str, wh_id=None, store_id=None) -> AuthContext:
    return AuthContext(f"u-{role}", role, wh_id, store_id, token="Bearer mock-token-x")


@pytest.fixture
def db(monkeypatch):
    d = FakeDB()
    monkeypatch.setattr(dc, "db_conn", lambda: FakeConn(d))
    return d


# ─── hq-admin: 전체 ────────────────────────────────────────────────────────
def test_pending_orders_hq_admin_all(db):
    db.add(target_location_id=3, wh_target=1)
    db.add(target_location_id=99, wh_target=2)
    res = list_pending(ctx=_ctx("hq-admin"), limit=50)
    assert len(res.items) == 2


# ─── branch-clerk: 자기 매장만 ─────────────────────────────────────────────
def test_pending_orders_branch_clerk_own_only(db):
    db.add(target_location_id=3, wh_target=1)
    db.add(target_location_id=3, wh_target=1, order_type="REBALANCE")
    db.add(target_location_id=4, wh_target=1)  # 다른 매장
    res = list_pending(ctx=_ctx("branch-clerk", store_id=3), limit=50)
    assert len(res.items) == 2
    assert all(it.target_location_id == 3 for it in res.items)


# ─── wh-manager: 자기 wh source 또는 target 만 ────────────────────────────
def test_pending_orders_wh_manager_source_or_target(db):
    # wh1 → wh2 (source wh=1 매칭)
    db.add(order_type="WH_TRANSFER", wh_source=1, wh_target=2)
    # wh2 → wh1 (target wh=1 매칭)
    db.add(order_type="WH_TRANSFER", wh_source=2, wh_target=1)
    # wh2 내부 — 봐선 안 됨
    db.add(order_type="REBALANCE", wh_source=2, wh_target=2)
    res = list_pending(ctx=_ctx("wh-manager", wh_id=1), limit=50)
    assert len(res.items) == 2


# ─── EXECUTED row 는 PENDING 큐 미포함 ─────────────────────────────────────
def test_pending_orders_status_filter(db):
    db.add(target_location_id=3, wh_target=1, status="PENDING")
    db.add(target_location_id=3, wh_target=1, status="EXECUTED")
    res = list_pending(ctx=_ctx("hq-admin"), limit=50)
    assert len(res.items) == 1
    assert res.items[0].status == "PENDING"
