"""Phase A2 reservation TTL cleanup CronJob.

매 5분 (k8s schedule `*/5 * * * *`) 실행:
1. ttl < NOW() AND status='ACTIVE' 인 reservations 를 BATCH_SIZE 만큼 SELECT FOR UPDATE SKIP LOCKED
2. 그 row 들 status='EXPIRED' 로 UPDATE
3. (isbn13, location_id) 별 qty 합산해서 inventory.reserved_qty 차감
4. audit_log 통계 1건 INSERT

reservations 테이블 (Schema v3):
  ttl TIMESTAMPTZ · status VARCHAR(20) DEFAULT 'ACTIVE'
"""
import json
import logging
import os
import sys
from collections import defaultdict
from typing import Iterable

import psycopg
from pydantic_settings import BaseSettings, SettingsConfigDict

logging.basicConfig(level=os.environ.get("INVENTORY_LOG_LEVEL", "INFO"))
log = logging.getLogger("reservation-cleanup")

BATCH_SIZE = 1000  # 한 번에 만료 처리할 최대 row 수 (메모리 안정 + transaction 짧게)


class _Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="INVENTORY_", case_sensitive=False)
    rds_host: str
    rds_port: int = 5432
    rds_db: str = "bookflow"
    rds_user: str
    rds_password: str


def _aggregate_by_inventory(rows: Iterable[tuple]) -> dict[tuple[str, int], int]:
    """rows = [(reservation_id, isbn13, location_id, qty), ...]
    → {(isbn13, location_id): sum(qty)} 차감해야 할 reserved_qty 묶음.
    """
    agg: dict[tuple[str, int], int] = defaultdict(int)
    for row in rows:
        _, isbn13, loc, qty = row
        agg[(isbn13, loc)] += qty
    return dict(agg)


def _summarize_rows(rows: list[tuple]) -> dict:
    """audit_log 에 적을 통계 요약."""
    if not rows:
        return {"expired_count": 0, "qty_released": 0, "inventory_cells_affected": 0}
    return {
        "expired_count": len(rows),
        "qty_released": sum(r[3] for r in rows),
        "inventory_cells_affected": len({(r[1], r[2]) for r in rows}),
    }


def expire_reservations(conn) -> dict:
    """단일 사이클 실행. Transaction 1개로 SELECT-LOCK + UPDATE + audit.

    Returns: {expired_count, qty_released, inventory_cells_affected}
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT reservation_id::text, isbn13, location_id, qty
              FROM reservations
             WHERE ttl < NOW() AND status = 'ACTIVE'
             FOR UPDATE SKIP LOCKED
             LIMIT %s
            """,
            (BATCH_SIZE,),
        )
        rows = cur.fetchall()
        if not rows:
            return _summarize_rows([])

        ids = [r[0] for r in rows]
        cur.execute(
            "UPDATE reservations SET status='EXPIRED' WHERE reservation_id = ANY(%s::uuid[])",
            (ids,),
        )

        for (isbn, loc), qty_total in _aggregate_by_inventory(rows).items():
            cur.execute(
                """
                UPDATE inventory
                   SET reserved_qty = GREATEST(0, reserved_qty - %s),
                       updated_at = NOW(),
                       updated_by = 'cron:reservation-cleanup'
                 WHERE isbn13 = %s AND location_id = %s
                """,
                (qty_total, isbn, loc),
            )

        summary = _summarize_rows(rows)
        cur.execute(
            """
            INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, after_state)
            VALUES ('cronjob', 'reservation-cleanup', 'reservation.expire', 'reservations', %s, %s::jsonb)
            """,
            ("batch", json.dumps(summary)),
        )
    conn.commit()
    return summary


def main() -> int:
    s = _Settings()
    conninfo = (
        f"host={s.rds_host} port={s.rds_port} dbname={s.rds_db} "
        f"user={s.rds_user} password={s.rds_password}"
    )
    with psycopg.connect(conninfo) as conn:
        result = expire_reservations(conn)
    log.info(
        "reservation cleanup: expired=%d qty_released=%d cells=%d",
        result["expired_count"],
        result["qty_released"],
        result["inventory_cells_affected"],
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
