"""Option B 인벤토리 변동 + queue 검색 단위 테스트.

approve/reject/inbound 흐름이 _adjust_source_inventory 를 정확히 호출하는지 검증
(2026-05-14: REBALANCE 도 양측 협의 (SOURCE+TARGET) 로 변경):

  REBALANCE        한쪽만 APPROVED      → 변동 없음 (PENDING 유지)
  REBALANCE        양쪽 APPROVED        → source -qty (한 번만)
  REBALANCE        APPROVED → /reject   → source +qty (복원)
  WH_TRANSFER      한쪽만 APPROVED      → 변동 없음
  WH_TRANSFER      양쪽 APPROVED        → source -qty (한 번만)
  WH_TRANSFER      APPROVED → /inbound/reject → source +qty
  PUBLISHER_ORDER  FINAL APPROVED       → 변동 없음 (source NULL)
  /intervene/batch REBALANCE × N        → 양측 모두 → source -qty

또 /queue?q= 검색 (isbn13 ILIKE) 동작 확인.
"""
import json
from datetime import datetime
from uuid import uuid4

import pytest

from src.auth import AuthContext
from src.models import ApproveRequest, RejectRequest
from src.routes import intervention as iv
from src.routes.intervention import (
    approve,
    intervene_batch,
    queue,
    reject,
    reject_inbound,
)


# ─── Stateful fake DB ─────────────────────────────────────────────────────
class FakeDB:
    """In-memory rows for the tables the inventory flow touches.

    pending_orders[oid] = {order_type, source_location_id, target_location_id,
                           isbn13, qty, status, reject_reason, reject_count}
    order_approvals[(oid, side)] = {decision, approval_id}
    inventory[(isbn, loc)] = on_hand
    locations[loc_id] = wh_id
    audit_log = list[dict]  (inventory.adjust 만 추적)
    """

    def __init__(self):
        self.pending: dict[str, dict] = {}
        self.approvals: dict[tuple[str, str], dict] = {}
        self.inventory: dict[tuple[str, int], int] = {}
        self.locations: dict[int, int] = {}
        self.books: dict[str, str] = {}
        self.audit_inventory: list[dict] = []

    def seed_pending(self, order_type, source_loc, target_loc, isbn, qty,
                     status="PENDING", oid=None) -> str:
        oid = oid or str(uuid4())
        self.pending[oid] = {
            "order_type": order_type, "source_location_id": source_loc,
            "target_location_id": target_loc, "isbn13": isbn, "qty": qty,
            "status": status, "reject_reason": None, "reject_count": 0,
            "approved_at": None, "executed_at": None,
        }
        return oid

    def seed_location(self, loc_id, wh_id):
        self.locations[loc_id] = wh_id

    def seed_inventory(self, isbn, loc, on_hand):
        self.inventory[(isbn, loc)] = on_hand


class FakeCur:
    """SQL fragment 기반 dispatcher. 정합한 row 만 추적해 흐름 검증.

    실제 SQL 파서가 아니라 substring 매칭이므로 운영 SQL 이 바뀌면 갱신 필요.
    """

    def __init__(self, db: FakeDB):
        self.db = db
        self._result: list[tuple] = []
        self.rowcount = 0

    # ─── stub control flow ────────────────────────────────────────────
    def fetchone(self):
        return self._result[0] if self._result else None

    def fetchall(self):
        return list(self._result)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    # ─── dispatcher ───────────────────────────────────────────────────
    def executemany(self, sql, seq):
        for row in seq:
            self.execute(sql, row)

    def execute(self, sql, params=(), prepare=None):  # noqa: D401
        s = " ".join(sql.split())  # collapse whitespace
        self._result = []
        self.rowcount = 0

        # locations lookup
        if "SELECT wh_id FROM locations WHERE location_id" in s:
            loc = params[0]
            if loc in self.db.locations:
                self._result = [(self.db.locations[loc],)]
            return

        # pending_orders metadata (authority validate · 2 cols + 3 cols 분기)
        if s.startswith("SELECT order_type, source_location_id, target_location_id FROM pending_orders"):
            oid = params[0]
            po = self.db.pending.get(oid)
            if po:
                self._result = [(po["order_type"], po["source_location_id"], po["target_location_id"])]
            return

        # adjust helper SELECT
        if s.startswith("SELECT order_type, source_location_id, isbn13, qty FROM pending_orders"):
            oid = params[0]
            po = self.db.pending.get(oid)
            if po:
                self._result = [(po["order_type"], po["source_location_id"], po["isbn13"], po["qty"])]
            return

        # inbound receive/reject metadata
        if "SELECT order_type, target_location_id, qty, isbn13, status FROM pending_orders" in s:
            oid = params[0]
            po = self.db.pending.get(oid)
            if po:
                self._result = [(po["order_type"], po["target_location_id"], po["qty"],
                                 po["isbn13"], po["status"])]
            return

        # current status query (reject 전 prev_status)
        if s.startswith("SELECT status FROM pending_orders"):
            oid = params[0]
            po = self.db.pending.get(oid)
            if po:
                self._result = [(po["status"],)]
            return

        # _record_approval REJECTED 분기 — prev_status + order_type + qty
        if s.startswith("SELECT status, order_type, qty FROM pending_orders"):
            oid = params[0]
            po = self.db.pending.get(oid)
            if po:
                self._result = [(po["status"], po["order_type"], po["qty"])]
            return

        # _record_approval APPROVED 양측 완료 후 final notification 용 (order_type, qty)
        if s.startswith("SELECT order_type, qty FROM pending_orders"):
            oid = params[0]
            po = self.db.pending.get(oid)
            if po:
                self._result = [(po["order_type"], po["qty"])]
            return

        # order_approvals existence check (단건 _record_approval)
        if "SELECT approval_id FROM order_approvals WHERE order_id" in s:
            oid, side = params[0], params[1]
            ap = self.db.approvals.get((oid, side))
            if ap:
                self._result = [(ap["approval_id"],)]
            return

        # INSERT order_approvals (단건) RETURNING approval_id, decided_at
        if "INSERT INTO order_approvals" in s:
            approval_id, oid, _aid, _role, _wh, side, decision, rej = params[:8]
            self.db.approvals[(oid, side)] = {"approval_id": approval_id, "decision": decision}
            self._result = [(approval_id, datetime(2026, 5, 14, 9, 0, 0))]
            self.rowcount = 1
            return

        # UPDATE order_approvals (단건) RETURNING approval_id, decided_at
        if "UPDATE order_approvals" in s and "WHERE approval_id" in s and "RETURNING" in s:
            decision = params[3]
            approval_id = params[5]
            # find pair by approval_id
            for key, ap in self.db.approvals.items():
                if ap["approval_id"] == approval_id:
                    ap["decision"] = decision
                    break
            self._result = [(approval_id, datetime(2026, 5, 14, 9, 0, 0))]
            self.rowcount = 1
            return

        # pending_orders → APPROVED (REBALANCE/PUBLISHER FINAL · 단건 _record_approval)
        if "UPDATE pending_orders SET status = 'APPROVED'" in s and "ANY" not in s and "(SELECT COUNT(*)" not in s:
            oid = params[0]
            po = self.db.pending.get(oid)
            if po:
                po["status"] = "APPROVED"
                po["approved_at"] = datetime.now()
                self.rowcount = 1
            return

        # pending_orders → APPROVED (단건 WH_TRANSFER · 양측 confirm 후)
        if "UPDATE pending_orders SET status = 'APPROVED'" in s and "ANY" not in s and "(SELECT COUNT(*)" in s:
            oid = params[0]
            po = self.db.pending.get(oid)
            if not po:
                return
            cnt = sum(
                1 for (o, side), ap in self.db.approvals.items()
                if o == oid and side in ("SOURCE", "TARGET") and ap["decision"] == "APPROVED"
            )
            if cnt >= 2:
                po["status"] = "APPROVED"
                po["approved_at"] = datetime.now()
                self.rowcount = 1
            return

        # pending_orders → EXECUTED (inbound receive 단건)
        if "UPDATE pending_orders SET status='EXECUTED'" in s and "WHERE order_id = %s" in s:
            oid = params[0]
            po = self.db.pending.get(oid)
            if po:
                po["status"] = "EXECUTED"
                po["executed_at"] = datetime.now()
                self.rowcount = 1
            return

        # pending_orders → REJECTED (단건 _record_approval)
        if "UPDATE pending_orders SET status = 'REJECTED'" in s and "WHERE order_id = %s" in s and "ANY" not in s:
            reason, oid = params[0], params[1]
            po = self.db.pending.get(oid)
            if po:
                po["status"] = "REJECTED"
                po["reject_reason"] = reason
                po["reject_count"] += 1
                self.rowcount = 1
            return

        # pending_orders → REJECTED (inbound reject · reject_reason + status)
        if "UPDATE pending_orders SET status='REJECTED', reject_reason" in s:
            reason, oid = params[0], params[1]
            po = self.db.pending.get(oid)
            if po:
                po["status"] = "REJECTED"
                po["reject_reason"] = reason
                self.rowcount = 1
            return

        # inventory UPDATE  (delta, user_id, isbn, src)
        if "UPDATE inventory SET on_hand = on_hand + %s" in s and "isbn13=%s AND location_id=%s" in s:
            delta, _user, isbn, loc = params
            key = (isbn, loc)
            self.db.inventory[key] = self.db.inventory.get(key, 0) + delta
            self.rowcount = 1
            return

        # audit_log INSERT (inventory.adjust 만 추적)
        # inventory.adjust 는 SQL 리터럴 action='inventory.adjust' · params=(user, entity_id, json_after)
        # 다른 INSERT (pending_orders intervention.* 등) 는 params[1]=action_str
        if "INSERT INTO audit_log" in s:
            if "'inventory.adjust'" in s:
                self.db.audit_inventory.append({
                    "actor_id": params[0],
                    "entity_id": params[1],
                    "after_state": json.loads(params[2]),
                })
            return

        # ── bulk paths (intervene/batch) — source_location_id + target_location_id 포함 ──
        if "SELECT po.order_id::text, po.order_type," in s and "po.source_location_id, po.target_location_id" in s and "= ANY" in s:
            oids = params[0]
            rows = []
            for oid in oids:
                po = self.db.pending.get(oid)
                if not po:
                    continue
                swh = self.db.locations.get(po["source_location_id"]) if po["source_location_id"] else None
                twh = self.db.locations.get(po["target_location_id"]) if po["target_location_id"] else None
                rows.append((oid, po["order_type"], po["source_location_id"],
                             po["target_location_id"], swh, twh))
            self._result = rows
            return

        if "SELECT order_id::text, approval_side, approval_id::text FROM order_approvals" in s:
            oids, sides = params[0], params[1]
            pairs = list(zip(oids, sides))
            rows = []
            for (oid, side) in pairs:
                ap = self.db.approvals.get((oid, side))
                if ap:
                    rows.append((oid, side, ap["approval_id"]))
            self._result = rows
            return

        # bulk UPDATE → APPROVED (FINAL or WH_TRANSFER 양측) RETURNING order_id::text
        if "UPDATE pending_orders" in s and "= ANY" in s and "RETURNING po.order_id::text" in s:
            oids = params[0]
            ret = []
            for oid in oids:
                po = self.db.pending.get(oid)
                if not po or po["status"] in ("APPROVED", "EXECUTED", "AUTO_EXECUTED"):
                    continue
                # WH_TRANSFER 양측 검사
                cnt = sum(
                    1 for (o, side), ap in self.db.approvals.items()
                    if o == oid and side in ("SOURCE", "TARGET") and ap["decision"] == "APPROVED"
                )
                if cnt >= 2:
                    po["status"] = "APPROVED"
                    ret.append((oid,))
            self._result = ret
            return

        if "UPDATE pending_orders" in s and "= ANY" in s and "RETURNING order_id::text" in s:
            oids = params[0]
            ret = []
            for oid in oids:
                po = self.db.pending.get(oid)
                if not po or po["status"] in ("APPROVED", "EXECUTED", "AUTO_EXECUTED"):
                    continue
                po["status"] = "APPROVED"
                ret.append((oid,))
            self._result = ret
            return

        # queue list (간단한 isbn ILIKE 매칭)
        if "FROM pending_orders po" in s and "ILIKE" in s and "LIMIT %s OFFSET" in s:
            # params 끝의 limit/offset 앞 3 개 가 LIKE 패턴
            like_terms = [p for p in params if isinstance(p, str) and p.startswith("%") and p.endswith("%")]
            term = like_terms[0].strip("%") if like_terms else ""
            rows = []
            for oid, po in self.db.pending.items():
                if term and term not in po["isbn13"]:
                    continue
                rows.append((
                    oid, po["order_type"], po["isbn13"],
                    po["source_location_id"], po["target_location_id"], po["qty"],
                    "MEDIUM", False, po["status"], datetime(2026, 5, 14),
                    None, self.db.books.get(po["isbn13"]),
                    None, None,
                ))
            self._result = rows
            return

        # queue stage_counts (GROUP BY order_type · COUNT)
        if "FROM pending_orders po" in s and "GROUP BY po.order_type" in s and "COUNT" in s:
            from collections import Counter
            like_terms = [p for p in params if isinstance(p, str) and p.startswith("%") and p.endswith("%")]
            term = like_terms[0].strip("%") if like_terms else ""
            c: Counter = Counter()
            for po in self.db.pending.values():
                if term and term not in po["isbn13"]:
                    continue
                if po["status"] != "PENDING":
                    continue
                c[po["order_type"]] += 1
            self._result = [(k, v) for k, v in c.items()]
            return

        # 그 외는 no-op
        return

    # cursor manager
    def close(self):
        pass


class FakeConn:
    def __init__(self, db: FakeDB):
        self.db = db
        self._cur = FakeCur(db)
        self.committed = False

    def cursor(self):
        return self._cur

    def commit(self):
        self.committed = True

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


# ─── helpers ──────────────────────────────────────────────────────────────
def _ctx(role: str, wh_id=None, store_id=None) -> AuthContext:
    user_map = {"hq-admin": "u-hq", "wh-manager": f"u-wh{wh_id}",
                "branch-clerk": f"u-store{store_id}"}
    return AuthContext(user_map.get(role, f"u-{role}"), role, wh_id, store_id,
                       token="Bearer mock-token-x")


@pytest.fixture
def db_and_conn(monkeypatch):
    db = FakeDB()
    conn = FakeConn(db)
    monkeypatch.setattr(iv, "db_conn", lambda: conn)
    # notify / inventory-svc HTTP 호출 silently noop
    monkeypatch.setattr(iv, "_notify", lambda *a, **kw: None)
    return db, conn


# ─── 1. REBALANCE 양측 (SOURCE+TARGET) approve → source -qty ──────────────
def test_rebalance_approve_source_minus(db_and_conn):
    db, _ = db_and_conn
    db.seed_location(11, 1)  # store1 (wh1)
    db.seed_location(12, 1)  # store2 (wh1)
    db.seed_inventory("9788956746425", 11, 100)
    db.seed_inventory("9788956746425", 12, 50)
    oid = db.seed_pending("REBALANCE", 11, 12, "9788956746425", 10)

    # SOURCE 측 (source 매장 직원) 승인
    approve(ApproveRequest(order_id=oid, approval_side="SOURCE"),
            _ctx("branch-clerk", store_id=11))
    assert db.pending[oid]["status"] == "PENDING"  # TARGET 미승인
    assert db.inventory[("9788956746425", 11)] == 100  # 미차감
    # TARGET 측 (target 매장 직원) 승인
    approve(ApproveRequest(order_id=oid, approval_side="TARGET"),
            _ctx("branch-clerk", store_id=12))

    assert db.pending[oid]["status"] == "APPROVED"
    assert db.inventory[("9788956746425", 11)] == 90  # source -10
    assert db.inventory[("9788956746425", 12)] == 50  # target 변동 없음
    # audit_log inventory.adjust delta = -10 (TARGET 시점에 한 번만)
    adj = [a for a in db.audit_inventory if a["entity_id"] == "9788956746425:11"]
    assert len(adj) == 1 and adj[0]["after_state"]["delta"] == -10


# ─── 1b. REBALANCE 한쪽만 APPROVED → inventory 무변경 ─────────────────────
def test_rebalance_one_side_no_inventory_change(db_and_conn):
    db, _ = db_and_conn
    db.seed_location(11, 1)
    db.seed_location(12, 1)
    db.seed_inventory("9788956746425", 11, 100)
    oid = db.seed_pending("REBALANCE", 11, 12, "9788956746425", 10)

    approve(ApproveRequest(order_id=oid, approval_side="SOURCE"),
            _ctx("wh-manager", wh_id=1))

    assert db.pending[oid]["status"] == "PENDING"
    assert db.inventory[("9788956746425", 11)] == 100  # 차감 없음
    adj = [a for a in db.audit_inventory if a["entity_id"] == "9788956746425:11"]
    assert len(adj) == 0


# ─── 1c. REBALANCE branch-clerk SOURCE side ───────────────────────────────
def test_rebalance_branch_clerk_source_side(db_and_conn):
    """branch-clerk scope==source_loc → SOURCE 측 승인만 가능 · TARGET 측은 403."""
    db, _ = db_and_conn
    db.seed_location(11, 1)
    db.seed_location(12, 1)
    db.seed_inventory("9788956746425", 11, 100)
    oid = db.seed_pending("REBALANCE", 11, 12, "9788956746425", 10)

    # SOURCE 매장 직원 (store_id=11) → SOURCE 측 OK
    approve(ApproveRequest(order_id=oid, approval_side="SOURCE"),
            _ctx("branch-clerk", store_id=11))
    assert (oid, "SOURCE") in db.approvals

    # SOURCE 매장 직원이 TARGET 측 시도 → 403
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as e:
        approve(ApproveRequest(order_id=oid, approval_side="TARGET"),
                _ctx("branch-clerk", store_id=11))
    assert e.value.status_code == 403


# ─── 2. REBALANCE APPROVED → /inbound/receive → target +qty ───────────────
def test_rebalance_executed_target_plus(db_and_conn, monkeypatch):
    db, _ = db_and_conn
    db.seed_location(11, 1)
    db.seed_location(12, 1)
    db.seed_inventory("9788956746425", 11, 100)
    db.seed_inventory("9788956746425", 12, 50)
    oid = db.seed_pending("REBALANCE", 11, 12, "9788956746425", 10, status="APPROVED")

    # receive_inbound 의 inventory-svc HTTP 콜 stub
    class _Resp:
        status_code = 200
        text = ""
    class _Client:
        def __init__(self, *a, **kw): pass
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def post(self, *a, **kw):
            db.inventory[("9788956746425", 12)] = db.inventory.get(("9788956746425", 12), 0) + 10
            return _Resp()
    monkeypatch.setattr(iv.httpx, "Client", _Client)

    from src.routes.intervention import receive_inbound
    receive_inbound(oid, _ctx("wh-manager", wh_id=1))

    assert db.pending[oid]["status"] == "EXECUTED"
    assert db.inventory[("9788956746425", 12)] == 60  # target +10


# ─── 3. PENDING reject → inventory 무변경 ──────────────────────────────────
def test_rebalance_pending_reject_no_change(db_and_conn):
    db, _ = db_and_conn
    db.seed_location(11, 1)
    db.seed_location(12, 1)
    db.seed_inventory("9788956746425", 11, 100)
    db.seed_inventory("9788956746425", 12, 50)
    oid = db.seed_pending("REBALANCE", 11, 12, "9788956746425", 10)

    # 양측 협의 변경: 어느 측이든 한쪽이 거절하면 전체 REJECTED
    reject(RejectRequest(order_id=oid, approval_side="SOURCE", reject_reason="중복 발의"),
           _ctx("wh-manager", wh_id=1))

    assert db.pending[oid]["status"] == "REJECTED"
    assert db.inventory[("9788956746425", 11)] == 100  # 무변경
    assert db.inventory[("9788956746425", 12)] == 50
    # inventory.adjust audit 없음
    adj = [a for a in db.audit_inventory if a["entity_id"] == "9788956746425:11"]
    assert len(adj) == 0


# ─── 4. 양측 APPROVED 후 reject → source +qty 복원 ────────────────────────
def test_rebalance_approved_reject_restores(db_and_conn):
    db, _ = db_and_conn
    db.seed_location(11, 1)
    db.seed_location(12, 1)
    db.seed_inventory("9788956746425", 11, 90)  # already debited by 10
    oid = db.seed_pending("REBALANCE", 11, 12, "9788956746425", 10, status="APPROVED")
    # 기존 양측 APPROVED row
    db.approvals[(oid, "SOURCE")] = {"approval_id": str(uuid4()), "decision": "APPROVED"}
    db.approvals[(oid, "TARGET")] = {"approval_id": str(uuid4()), "decision": "APPROVED"}

    # 한쪽 (예: TARGET) 사후 거절 → 전체 REJECTED + source 복원
    reject(RejectRequest(order_id=oid, approval_side="TARGET", reject_reason="취소"),
           _ctx("wh-manager", wh_id=1))

    assert db.pending[oid]["status"] == "REJECTED"
    assert db.inventory[("9788956746425", 11)] == 100  # 복원
    adj = [a for a in db.audit_inventory if a["entity_id"] == "9788956746425:11"]
    assert any(a["after_state"]["delta"] == 10 and "거부복원" in a["after_state"]["reason"] for a in adj)


# ─── 5. WH_TRANSFER SOURCE 단독 승인 → inventory 무변경 ────────────────────
def test_wh_transfer_one_side_no_inventory_change(db_and_conn):
    db, _ = db_and_conn
    db.seed_location(101, 1)  # wh1 holding
    db.seed_location(102, 2)  # wh2 holding
    db.seed_inventory("9788956746425", 101, 500)
    db.seed_inventory("9788956746425", 102, 100)
    oid = db.seed_pending("WH_TRANSFER", 101, 102, "9788956746425", 50)

    approve(ApproveRequest(order_id=oid, approval_side="SOURCE"),
            _ctx("wh-manager", wh_id=1))

    assert db.pending[oid]["status"] == "PENDING"  # TARGET 미승인
    assert db.inventory[("9788956746425", 101)] == 500


# ─── 6. WH_TRANSFER 양측 → source -qty (한 번만) ──────────────────────────
def test_wh_transfer_both_sides_source_minus(db_and_conn):
    db, _ = db_and_conn
    db.seed_location(101, 1)
    db.seed_location(102, 2)
    db.seed_inventory("9788956746425", 101, 500)
    oid = db.seed_pending("WH_TRANSFER", 101, 102, "9788956746425", 50)

    approve(ApproveRequest(order_id=oid, approval_side="SOURCE"),
            _ctx("wh-manager", wh_id=1))
    approve(ApproveRequest(order_id=oid, approval_side="TARGET"),
            _ctx("wh-manager", wh_id=2))

    assert db.pending[oid]["status"] == "APPROVED"
    assert db.inventory[("9788956746425", 101)] == 450  # source -50
    adj = [a for a in db.audit_inventory if a["entity_id"] == "9788956746425:101"]
    assert len(adj) == 1  # 한 번만 (TARGET 승인 시점)


# ─── 7. WH_TRANSFER APPROVED → /inbound/reject → source 복원 ──────────────
def test_wh_transfer_inbound_reject_restores(db_and_conn):
    db, _ = db_and_conn
    db.seed_location(101, 1)
    db.seed_location(102, 2)
    db.seed_inventory("9788956746425", 101, 450)
    oid = db.seed_pending("WH_TRANSFER", 101, 102, "9788956746425", 50, status="APPROVED")

    reject_inbound(oid, {"reject_reason": "수량 부족"},
                   _ctx("wh-manager", wh_id=2))

    assert db.pending[oid]["status"] == "REJECTED"
    assert db.inventory[("9788956746425", 101)] == 500  # 복원
    adj = [a for a in db.audit_inventory if a["entity_id"] == "9788956746425:101"]
    assert any("입고거부 복원" in a["after_state"]["reason"] for a in adj)


# ─── 8. PUBLISHER_ORDER → inventory 변동 없음 (source NULL) ───────────────
def test_publisher_order_no_source_inventory(db_and_conn):
    db, _ = db_and_conn
    db.seed_location(101, 1)
    db.seed_inventory("9788956746425", 101, 10)
    oid = db.seed_pending("PUBLISHER_ORDER", None, 101, "9788956746425", 100)

    approve(ApproveRequest(order_id=oid, approval_side="FINAL"),
            _ctx("hq-admin"))

    assert db.pending[oid]["status"] == "APPROVED"
    assert db.inventory[("9788956746425", 101)] == 10  # 변동 없음 (입고 수령 전)


# ─── 9. /intervene/batch REBALANCE 5건 양측 → 모두 source -qty ───────────
def test_bulk_rebalance_all_minus(db_and_conn):
    """REBALANCE 양측 협의: SOURCE+TARGET 두 측 모두 batch 에 넣어야 APPROVED 전환."""
    db, _ = db_and_conn
    db.seed_location(11, 1)
    db.seed_location(12, 1)
    db.seed_inventory("9788956746425", 11, 1000)
    db.seed_inventory("9788956746425", 12, 200)
    oids = [db.seed_pending("REBALANCE", 11, 12, "9788956746425", 10) for _ in range(5)]

    # SOURCE + TARGET 둘 다 포함 → 10 items
    items = [{"order_id": oid, "approval_side": side}
             for oid in oids for side in ("SOURCE", "TARGET")]
    res = intervene_batch({"action": "approve", "items": items},
                          _ctx("wh-manager", wh_id=1))

    assert res["ok"] == 10  # 5 orders × 2 sides
    assert db.inventory[("9788956746425", 11)] == 950  # -50
    for oid in oids:
        assert db.pending[oid]["status"] == "APPROVED"
    # inventory.adjust audit 5 건 (order 당 한 번)
    adj = [a for a in db.audit_inventory if a["entity_id"] == "9788956746425:11"]
    assert len(adj) == 5


# ─── 10. /queue?q=isbn → 해당 isbn 만 ─────────────────────────────────────
def test_queue_search_by_isbn(db_and_conn):
    db, _ = db_and_conn
    db.seed_location(11, 1)
    db.seed_location(12, 1)
    db.books["9788956746425"] = "데미안"
    db.books["9788932917245"] = "토지"
    db.seed_pending("REBALANCE", 11, 12, "9788956746425", 5)
    db.seed_pending("REBALANCE", 11, 12, "9788932917245", 7)

    resp = queue(ctx=_ctx("hq-admin"), q="9788956")
    isbns = {it.isbn13 for it in resp.items}
    assert isbns == {"9788956746425"}
