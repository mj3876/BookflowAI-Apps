"""/decision/plan-daily/{snapshot_date}/summary + /items role-scope 필터링 검증.

role/scope 매트릭스:
  - hq-admin                       → 필터 없음 (전체)
  - wh-manager + scope_wh_id       → source 또는 target wh = scope_wh_id
  - branch-clerk + scope_store_id  → target_location_id = scope_store_id

또 /items?q=... 의 ILIKE 매칭 동작 확인.
"""
import pytest

from src.auth import AuthContext
from src.routes import decision as dc
from src.routes.decision import plan_daily_items, plan_daily_summary


# ─── Stateful in-memory rows ──────────────────────────────────────────────
class FakeDB:
    """plan_daily summary/items 가 접근하는 row 집합.

    pending_orders rows: list[dict(order_id, isbn13, title, order_type, status,
                                   source_location_id, target_location_id, qty,
                                   wh_source, wh_target, snapshot_date,
                                   source_name, target_name,
                                   urgency_level, approved_at, executed_at,
                                   reject_reason, created_at)]
    """

    def __init__(self):
        self.rows: list[dict] = []

    def add(self, **kw):
        defaults = {
            "order_id": "00000000-0000-0000-0000-000000000000",
            "isbn13": "9788956746425",
            "title": "데미안",
            "order_type": "REBALANCE",
            "status": "PENDING",
            "source_location_id": 11,
            "target_location_id": 12,
            "qty": 10,
            "wh_source": 1,
            "wh_target": 1,
            "snapshot_date": "2026-05-14",
            "source_name": "광화문점",
            "target_name": "강남점",
            "urgency_level": "MEDIUM",
            "approved_at": None,
            "executed_at": None,
            "reject_reason": None,
            "created_at": None,
        }
        defaults.update(kw)
        self.rows.append(defaults)


class FakeCur:
    """SQL substring 기반 dispatcher · summary/items 두 경로만 처리."""

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

    def _filter_rows(self, params, has_q: bool):
        """params consumed in order:
        [snapshot_date, ?(wh, wh) OR ?store, ?status, ?order_type, ?(like × 4)]
        """
        snapshot = params[0]
        idx = 1
        wh = store = status = order_type = like = None

        # scope: detect by next params shape — wh comes in pair, store in single
        # 우리는 caller 가 어느 ctx 인지 알므로 hint 없이 추론. 단순화: 호출 측 별도 헬퍼 사용.
        # 여기선 'who cares' 식 brute filter. 그러나 정확히 처리 위해 SQL 본문 길이로 분기 → 별 함수에서 처리.
        return snapshot, list(params[1:])

    def execute(self, sql, params=()):
        s = " ".join(sql.split())
        self._result = []

        # summary GROUP BY order_type, status
        if "GROUP BY po.order_type, po.status" in s:
            snapshot, rest = self._filter_rows(params, "ILIKE" in s)
            scoped = list(self.db.rows)
            scoped = [r for r in scoped if r["snapshot_date"] == snapshot]
            scoped = _apply_scope(scoped, sql, rest)
            from collections import Counter
            c: Counter = Counter()
            for r in scoped:
                c[(r["order_type"], r["status"])] += 1
            q: dict = {}
            for r in scoped:
                key = (r["order_type"], r["status"])
                q[key] = q.get(key, 0) + r["qty"]
            self._result = [(ot, st, c[(ot, st)], q[(ot, st)]) for (ot, st) in c]
            return

        # items count
        if s.startswith("SELECT COUNT(*)"):
            snapshot, rest = self._filter_rows(params, "ILIKE" in sql)
            scoped = [r for r in self.db.rows if r["snapshot_date"] == snapshot]
            scoped = _apply_scope(scoped, sql, rest)
            scoped = _apply_q(scoped, sql, rest)
            self._result = [(len(scoped),)]
            return

        # items list
        if "SELECT po.order_id, po.isbn13" in s:
            # last 2 params 은 LIMIT/OFFSET
            params_no_pag = list(params[:-2])
            snapshot = params_no_pag[0]
            rest = params_no_pag[1:]
            scoped = [r for r in self.db.rows if r["snapshot_date"] == snapshot]
            scoped = _apply_scope(scoped, sql, rest)
            scoped = _apply_q(scoped, sql, rest)
            self._result = [
                (
                    r["order_id"], r["isbn13"], r["title"],
                    r["order_type"], r["status"],
                    r["source_location_id"], r["source_name"],
                    r["target_location_id"], r["target_name"],
                    r["qty"], r["urgency_level"],
                    r["approved_at"], r["executed_at"], r["reject_reason"],
                    r["created_at"],
                    r.get("expected_arrival_date"),  # LEAD_DAYS 적용 결과 (fixture default None)
                )
                for r in scoped
            ]
            return

    def close(self):
        pass


def _apply_scope(rows, sql, rest_params):
    """SQL 본문 기반으로 wh/store filter 적용."""
    # wh-manager scope: source 또는 target wh = scope_wh_id (2-param)
    if "po.source_location_id AND sl.wh_id = %s" in sql and "po.target_location_id AND tl.wh_id = %s" in sql:
        wh = rest_params[0]
        return [r for r in rows if wh in (r["wh_source"], r["wh_target"])]
    # branch-clerk scope
    if "po.target_location_id = %s" in sql and "ILIKE" not in sql:
        store = rest_params[0]
        return [r for r in rows if r["target_location_id"] == store]
    if "po.target_location_id = %s" in sql:
        # ILIKE 와 공존 가능: target_location_id = %s 가 첫 scope param 일 때만 store filter
        # 단순화: 먼저 = %s 패턴이 ILIKE 보다 앞에 등장 → 첫 rest_param 이 store
        store = rest_params[0]
        return [r for r in rows if r["target_location_id"] == store]
    return rows


def _apply_q(rows, sql, rest_params):
    if "ILIKE" not in sql:
        return rows
    likes = [p for p in rest_params if isinstance(p, str) and p.startswith("%") and p.endswith("%")]
    if not likes:
        return rows
    term = likes[0].strip("%")
    out = []
    for r in rows:
        hay = " ".join([
            r["isbn13"] or "",
            r["title"] or "",
            r["source_name"] or "",
            r["target_name"] or "",
        ])
        if term in hay:
            out.append(r)
    return out


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


# ─── 1. branch-clerk → target_location_id = scope 만 ──────────────────────
def test_plan_summary_role_scope_branch(db):
    db.add(target_location_id=3, status="PENDING", order_type="REBALANCE", qty=5)
    db.add(target_location_id=3, status="APPROVED", order_type="REBALANCE", qty=7)
    db.add(target_location_id=4, status="PENDING", order_type="REBALANCE", qty=99)  # 다른 매장

    res = plan_daily_summary("2026-05-14", _ctx("branch-clerk", store_id=3))

    assert res["totals"]["total_orders"] == 2  # store_id=3 만
    assert res["totals"]["total_qty"] == 12
    assert res["totals"]["statuses"]["PENDING"] == 1
    assert res["totals"]["statuses"]["APPROVED"] == 1


# ─── 2. wh-manager → wh 매칭만 (source OR target) ─────────────────────────
def test_plan_summary_role_scope_wh(db):
    # wh1 → wh2 transfer · wh-manager-1 (source wh=1) 가 봐야 함
    db.add(order_type="WH_TRANSFER", wh_source=1, wh_target=2, qty=50, status="PENDING")
    # wh2 → wh1 transfer · wh-manager-1 (target wh=1) 도 봐야 함
    db.add(order_type="WH_TRANSFER", wh_source=2, wh_target=1, qty=30, status="APPROVED")
    # wh2 내부 REBALANCE · wh-manager-1 보면 안 됨
    db.add(order_type="REBALANCE", wh_source=2, wh_target=2, qty=99, status="PENDING")

    res = plan_daily_summary("2026-05-14", _ctx("wh-manager", wh_id=1))

    assert res["totals"]["total_orders"] == 2
    assert res["totals"]["total_qty"] == 80


# ─── 3. /items?q= ILIKE 매칭 ──────────────────────────────────────────────
def test_plan_items_search_q(db):
    db.add(isbn13="9788956746425", title="데미안", target_location_id=3)
    db.add(isbn13="9788932917245", title="토지", target_location_id=3)
    db.add(isbn13="9788936434120", title="소년이 온다", target_location_id=3)

    res = plan_daily_items("2026-05-14", q="데미안",
                           ctx=_ctx("branch-clerk", store_id=3))

    assert res["total"] == 1
    assert res["items"][0]["title"] == "데미안"
