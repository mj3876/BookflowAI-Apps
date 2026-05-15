"""publisher-watcher CronJob entry point.

Schedule: */1 * * * * (every 1 minute · k8s CronJob).
1. GET publisher API stub → list of NewBookRequest objects (FR-A1.4 풀 필드)
2. UPSERT books master (FR-A11.1 · ISBN13 PK · source='PUBLISHER_REQUEST')
3. INSERT new_book_requests (ON CONFLICT DO NOTHING — idempotent on isbn13)
4. Redis pub `newbook.request` for each new row → notification-svc subscriber

Real publisher API: 출판사 신간 신청 endpoint (Phase 4 + ALB external entry).
Phase 2-3: synthesized stub via env (or no-op if URL unset).
"""
import json
import logging
import os
import sys
from datetime import date

import httpx
import psycopg
import redis
from pydantic_settings import BaseSettings, SettingsConfigDict

logging.basicConfig(level=os.environ.get("PUBWATCH_LOG_LEVEL", "INFO"))
log = logging.getLogger("publisher-watcher")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="PUBWATCH_", case_sensitive=False)

    rds_host: str
    rds_port: int = 5432
    rds_db: str = "bookflow"
    rds_user: str
    rds_password: str

    redis_host: str
    redis_port: int = 6379

    publisher_api_url: str = ""  # empty = skip polling (no-op cron)
    publisher_api_timeout_seconds: float = 10.0

    log_level: str = "INFO"


def _parse_date(s: str | None) -> date | None:
    """ISO YYYY-MM-DD → date · 그 외 / None / "" → None (parse 실패 swallow)."""
    if not s:
        return None
    try:
        return date.fromisoformat(s)
    except (ValueError, TypeError):
        return None


def _normalize_request(item: dict) -> dict:
    """Publisher API row → DB INSERT 정규화 (FR-A1.4 풀 필드).

    누락 필드 default + 타입 coerce + 안전 처리.
    """
    try:
        sales = int(item.get("estimated_initial_sales") or 0)
    except (ValueError, TypeError):
        sales = 0
    return {
        "isbn13":                  item.get("isbn13"),
        "publisher_id":            item.get("publisher_id"),
        "title":                   item.get("title"),
        "author":                  item.get("author"),
        "genre":                   item.get("genre") or item.get("category_name"),
        "expected_pub_date":       _parse_date(item.get("expected_pub_date")),
        "estimated_initial_sales": sales,
        "marketing_plan":          item.get("marketing_plan") or "",
        "similar_books":           item.get("similar_books") or [],
        "target_segments":         item.get("target_segments") or [],
    }


def fetch_pending(api_url: str, timeout: float) -> list[dict]:
    if not api_url:
        log.info("PUBWATCH_PUBLISHER_API_URL empty — skip (no-op cron)")
        return []
    try:
        r = httpx.get(f"{api_url}/new-book-requests", timeout=timeout)
        r.raise_for_status()
        body = r.json()
        return body.get("items", body if isinstance(body, list) else [])
    except Exception as e:
        log.warning("publisher API GET failed: %s", e)
        return []


# FR-A11.1 books master upsert — 출판사가 새로 신청한 ISBN13 은 books 에 등록되어야
# forecast/decision/inventory pod 가 참조 가능. ON CONFLICT DO NOTHING 으로 idempotent.
BOOKS_UPSERT_SQL = """
    INSERT INTO books (isbn13, title, author, category_name, source, active, discontinue_mode)
    VALUES (%s, %s, %s, %s, 'PUBLISHER_REQUEST', TRUE, 'NONE')
    ON CONFLICT (isbn13) DO NOTHING
"""

# FR-A1.4 new_book_requests 풀 필드 INSERT (created_at = DEFAULT NOW · 시드 / DDL 정합)
NEWREQ_INSERT_SQL = """
    INSERT INTO new_book_requests
        (isbn13, publisher_id, title, author, genre,
         expected_pub_date, estimated_initial_sales, marketing_plan,
         similar_books, target_segments, status)
    VALUES (%s, %s, %s, %s, %s,
            %s, %s, %s,
            %s::jsonb, %s::jsonb, 'NEW')
    ON CONFLICT (isbn13) DO NOTHING
    RETURNING id
"""


def main() -> int:
    s = Settings()
    items = fetch_pending(s.publisher_api_url, s.publisher_api_timeout_seconds)
    if not items:
        log.info("no new requests")
        return 0

    conninfo = (
        f"host={s.rds_host} port={s.rds_port} dbname={s.rds_db} "
        f"user={s.rds_user} password={s.rds_password}"
    )
    rds = redis.Redis(host=s.redis_host, port=s.redis_port, decode_responses=True)
    inserted = 0
    with psycopg.connect(conninfo) as conn:
        for it in items:
            n = _normalize_request(it)
            if not n["isbn13"] or not n["publisher_id"]:
                continue  # 필수 필드 누락 row 는 스킵
            with conn.cursor() as cur:
                # 1) books master upsert (신간이 아직 카탈로그에 없을 수 있음)
                cur.execute(
                    BOOKS_UPSERT_SQL,
                    (n["isbn13"], n["title"], n["author"], n["genre"]),
                )
                # 2) new_book_requests INSERT
                cur.execute(
                    NEWREQ_INSERT_SQL,
                    (
                        n["isbn13"], n["publisher_id"], n["title"], n["author"], n["genre"],
                        n["expected_pub_date"], n["estimated_initial_sales"], n["marketing_plan"],
                        json.dumps(n["similar_books"]), json.dumps(n["target_segments"]),
                    ),
                )
                row = cur.fetchone()
                if row is None:
                    continue  # duplicate isbn13, already in queue
                request_id = row[0]
                cur.execute(
                    """
                    INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, after_state)
                    VALUES ('cronjob', 'publisher-watcher', 'newbook.discovered', 'new_book_requests', %s, %s)
                    """,
                    (str(request_id), json.dumps({
                        "isbn13": n["isbn13"], "publisher_id": n["publisher_id"], "title": n["title"],
                    })),
                )
                inserted += 1
                try:
                    rds.publish("newbook.request", json.dumps({
                        "request_id": request_id,
                        "publisher_id": n["publisher_id"],
                        "isbn13": n["isbn13"],
                    }))
                except Exception as e:
                    log.warning("redis publish failed: %s", e)
        conn.commit()

    log.info("inserted %d new_book_requests", inserted)
    return 0


if __name__ == "__main__":
    sys.exit(main())
