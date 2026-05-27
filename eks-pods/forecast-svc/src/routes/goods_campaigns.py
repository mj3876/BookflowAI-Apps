"""Event goods display campaigns.

HQ creates a short-lived campaign, asks Gemini for recommendations on demand,
reviews the result, and sends branch mail through notification-svc. This route
never mutates inventory.
"""
import json
from datetime import date, datetime, timezone
from typing import Any
from uuid import UUID, uuid4

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, status
from psycopg.types.json import Json
from pydantic import BaseModel, Field, field_validator

from ..auth import AuthContext, require_auth
from ..db import db_conn
from ..settings import settings

router = APIRouter(prefix="/forecast/goods-campaigns", tags=["goods-campaigns"])


class CampaignCreateReq(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    campaign_type: str = Field(default="EVENT", max_length=40)
    start_date: date
    end_date: date
    isbn13s: list[str] = Field(min_length=1, max_length=20)
    target_branch_ids: list[int] = Field(min_length=1, max_length=50)
    objective: str | None = Field(default=None, max_length=500)

    @field_validator("isbn13s")
    @classmethod
    def _isbn13s(cls, values: list[str]) -> list[str]:
        cleaned = [str(v).strip() for v in values if str(v).strip()]
        if not cleaned or any(len(v) != 13 for v in cleaned):
            raise ValueError("isbn13s must contain 13-digit ISBN values")
        return list(dict.fromkeys(cleaned))

    @field_validator("target_branch_ids")
    @classmethod
    def _branch_ids(cls, values: list[int]) -> list[int]:
        return list(dict.fromkeys(int(v) for v in values))


class RecommendationPatchReq(BaseModel):
    recommendation_id: UUID
    recommended_goods: list[dict[str, Any]] | None = None
    display_position: str | None = Field(default=None, max_length=120)
    reason: str | None = Field(default=None, max_length=1000)
    priority: str | None = Field(default=None, max_length=20)
    email_subject: str | None = Field(default=None, max_length=200)
    email_body: str | None = None


def _require_hq(ctx: AuthContext) -> None:
    if ctx.role != "hq-admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="hq-admin only")


def _ensure_tables(cur) -> None:
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS goods_campaigns (
            campaign_id UUID PRIMARY KEY,
            title VARCHAR(200) NOT NULL,
            campaign_type VARCHAR(40) NOT NULL DEFAULT 'EVENT',
            start_date DATE NOT NULL,
            end_date DATE NOT NULL,
            isbn13s JSONB NOT NULL DEFAULT '[]'::jsonb,
            target_branch_ids INTEGER[] NOT NULL DEFAULT '{}',
            objective TEXT,
            status VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
            created_by VARCHAR(100),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS goods_recommendations (
            recommendation_id UUID PRIMARY KEY,
            campaign_id UUID NOT NULL REFERENCES goods_campaigns(campaign_id) ON DELETE CASCADE,
            isbn13 CHAR(13) NOT NULL,
            branch_id INTEGER NOT NULL,
            recommended_goods JSONB NOT NULL DEFAULT '[]'::jsonb,
            display_position VARCHAR(120),
            reason TEXT,
            priority VARCHAR(20) NOT NULL DEFAULT 'MEDIUM',
            email_subject VARCHAR(200),
            email_body TEXT,
            ai_model VARCHAR(80),
            source VARCHAR(20) NOT NULL DEFAULT 'gemini',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (campaign_id, isbn13, branch_id)
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS goods_campaign_send_history (
            send_id UUID PRIMARY KEY,
            campaign_id UUID NOT NULL REFERENCES goods_campaigns(campaign_id) ON DELETE CASCADE,
            branch_id INTEGER NOT NULL,
            recipient_email VARCHAR(200),
            send_status VARCHAR(20) NOT NULL,
            notification_id UUID,
            sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )


def _campaign_dict(row) -> dict[str, Any]:
    return {
        "campaign_id": str(row[0]),
        "title": row[1],
        "campaign_type": row[2],
        "start_date": row[3].isoformat(),
        "end_date": row[4].isoformat(),
        "isbn13s": row[5] or [],
        "target_branch_ids": list(row[6] or []),
        "objective": row[7],
        "status": row[8],
        "created_by": row[9],
        "created_at": row[10].isoformat() if row[10] else None,
        "updated_at": row[11].isoformat() if row[11] else None,
    }


def _recommendation_dict(row) -> dict[str, Any]:
    return {
        "recommendation_id": str(row[0]),
        "campaign_id": str(row[1]),
        "isbn13": row[2],
        "branch_id": row[3],
        "recommended_goods": row[4] or [],
        "display_position": row[5],
        "reason": row[6],
        "priority": row[7],
        "email_subject": row[8],
        "email_body": row[9],
        "ai_model": row[10],
        "source": row[11],
        "created_at": row[12].isoformat() if row[12] else None,
        "updated_at": row[13].isoformat() if row[13] else None,
    }


def _load_campaign(cur, campaign_id: UUID) -> dict[str, Any]:
    cur.execute(
        """
        SELECT campaign_id, title, campaign_type, start_date, end_date, isbn13s,
               target_branch_ids, objective, status, created_by, created_at, updated_at
          FROM goods_campaigns
         WHERE campaign_id = %s
        """,
        (str(campaign_id),),
    )
    row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="campaign not found")
    return _campaign_dict(row)


def _load_recommendations(cur, campaign_id: UUID) -> list[dict[str, Any]]:
    cur.execute(
        """
        SELECT recommendation_id, campaign_id, isbn13, branch_id, recommended_goods,
               display_position, reason, priority, email_subject, email_body,
               ai_model, source, created_at, updated_at
          FROM goods_recommendations
         WHERE campaign_id = %s
         ORDER BY branch_id, isbn13
        """,
        (str(campaign_id),),
    )
    return [_recommendation_dict(r) for r in cur.fetchall()]


def _book_rows(cur, isbn13s: list[str]) -> list[dict[str, Any]]:
    cur.execute(
        """
        SELECT isbn13, title, author, publisher, category_name, price_sales, pub_date
          FROM books
         WHERE isbn13 = ANY(%s)
         ORDER BY isbn13
        """,
        (isbn13s,),
    )
    return [
        {
            "isbn13": r[0],
            "title": r[1],
            "author": r[2],
            "publisher": r[3],
            "category": r[4],
            "price_sales": int(r[5]) if r[5] is not None else None,
            "pub_date": r[6].isoformat() if r[6] else None,
        }
        for r in cur.fetchall()
    ]


def _branch_rows(cur, branch_ids: list[int]) -> list[dict[str, Any]]:
    cur.execute(
        """
        SELECT location_id, name, location_type, wh_id, region
          FROM locations
         WHERE location_id = ANY(%s)
         ORDER BY location_id
        """,
        (branch_ids,),
    )
    return [
        {"branch_id": r[0], "name": r[1], "location_type": r[2], "wh_id": r[3], "region": r[4]}
        for r in cur.fetchall()
    ]


def _forecast_summary(cur, isbn13s: list[str], branch_ids: list[int]) -> list[dict[str, Any]]:
    cur.execute(
        """
        WITH target AS (
            SELECT COALESCE(
                MIN(snapshot_date) FILTER (WHERE snapshot_date >= CURRENT_DATE),
                MAX(snapshot_date)
            ) AS d
            FROM forecast_cache
        )
        SELECT f.isbn13, f.store_id, f.predicted_demand
          FROM forecast_cache f
          JOIN target ON target.d = f.snapshot_date
         WHERE f.isbn13 = ANY(%s) AND f.store_id = ANY(%s)
         ORDER BY f.isbn13, f.store_id
        """,
        (isbn13s, branch_ids),
    )
    return [
        {"isbn13": r[0], "branch_id": int(r[1]), "predicted_demand": float(r[2] or 0)}
        for r in cur.fetchall()
    ]


def _fallback_recommendations(
    campaign: dict[str, Any], books: list[dict], branches: list[dict], forecasts: list[dict]
) -> dict[str, list[dict[str, Any]]]:
    forecast_map = {(f["isbn13"], f["branch_id"]): f["predicted_demand"] for f in forecasts}
    items: list[dict[str, Any]] = []
    for book in books:
        category = (book.get("category") or "").lower()
        if "child" in category or "kids" in category:
            goods = [{"name": "Character bookmark set", "display_position": "Kids section endcap"}]
        elif "travel" in category:
            goods = [{"name": "Travel note and sticker pack", "display_position": "New release table"}]
        else:
            goods = [{"name": "Premium bookmark and postcard set", "display_position": "Checkout counter"}]
        for branch in branches:
            demand = forecast_map.get((book["isbn13"], branch["branch_id"]), 0.0)
            priority = "HIGH" if demand >= 20 else "MEDIUM"
            title = book.get("title") or book["isbn13"]
            branch_name = branch.get("name") or f"Branch {branch['branch_id']}"
            body = (
                f"Campaign: {campaign['title']}\n"
                f"Period: {campaign['start_date']} ~ {campaign['end_date']}\n"
                f"Branch: {branch_name}\n"
                f"Book: {title} ({book['isbn13']})\n"
                f"Recommended goods: {goods[0]['name']}\n"
                f"Display position: {goods[0]['display_position']}\n"
                "Please display this as an event campaign after HQ approval."
            )
            items.append({
                "isbn13": book["isbn13"],
                "branch_id": branch["branch_id"],
                "recommended_goods": goods,
                "display_position": goods[0]["display_position"],
                "reason": "Generated from category, campaign period, branch, and latest forecast summary.",
                "priority": priority,
                "email_subject": f"[BOOKFLOW] Goods display campaign: {campaign['title']}",
                "email_body": body,
            })
    return {"items": items}


def _gemini_prompt(campaign: dict, books: list[dict], branches: list[dict], forecasts: list[dict]) -> str:
    payload = {
        "task": "Create event-only goods display recommendations for bookstore branches.",
        "rules": [
            "Do not recommend inventory quantity changes.",
            "Return JSON only.",
            "One item per isbn13 and branch_id pair.",
            "Keep goods low-cost and practical for short event display.",
        ],
        "campaign": campaign,
        "books": books,
        "branches": branches,
        "forecast_summary": forecasts,
    }
    return json.dumps(payload, ensure_ascii=False)


def _extract_json(text: str) -> dict:
    text = text.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:].strip()
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end >= start:
        text = text[start:end + 1]
    return json.loads(text)


def _call_gemini(campaign: dict, books: list[dict], branches: list[dict], forecasts: list[dict]) -> dict:
    if not settings.gcp_gemini_generate_url or settings.gcp_gemini_generate_url.startswith("${"):
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Gemini URL is not configured")
    headers = {"Content-Type": "application/json"}
    if settings.gcp_function_bearer_token:
        headers["Authorization"] = f"Bearer {settings.gcp_function_bearer_token}"
    body = {
        "contents": [{"role": "user", "parts": [{"text": _gemini_prompt(campaign, books, branches, forecasts)}]}],
        "generationConfig": {
            "temperature": settings.gcp_gemini_temperature,
            "responseMimeType": "application/json",
        },
    }
    try:
        with httpx.Client(timeout=settings.gcp_http_timeout_seconds) as client:
            url = settings.gcp_gemini_generate_url.replace("{model}", settings.gcp_gemini_model)
            resp = client.post(url, json=body, headers=headers)
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPStatusError as exc:
        detail = exc.response.text[:500] if exc.response is not None else str(exc)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"Gemini call failed: {detail}") from exc
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"Gemini call failed: {exc}") from exc

    text = data.get("candidates", [{}])[0].get("content", {}).get("parts", [{}])[0].get("text", "")
    if not text:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Gemini returned empty content")
    parsed = _extract_json(text)
    if not isinstance(parsed.get("items"), list):
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Gemini JSON missing items")
    return parsed


@router.post("")
def create_campaign(req: CampaignCreateReq, ctx: AuthContext = Depends(require_auth)):
    _require_hq(ctx)
    if req.end_date < req.start_date:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="end_date must be >= start_date")
    campaign_id = uuid4()
    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO goods_campaigns
                    (campaign_id, title, campaign_type, start_date, end_date, isbn13s,
                     target_branch_ids, objective, created_by)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    str(campaign_id), req.title, req.campaign_type, req.start_date, req.end_date,
                    Json(req.isbn13s), req.target_branch_ids, req.objective, ctx.user_id,
                ),
            )
            cur.execute(
                """
                INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, after_state)
                VALUES ('user', %s, 'goods_campaign.create', 'goods_campaigns', %s, %s)
                """,
                (ctx.user_id, str(campaign_id), Json(req.model_dump(mode="json"))),
            )
        conn.commit()
    return {"campaign_id": str(campaign_id), "status": "DRAFT"}


@router.get("")
def list_campaigns(ctx: AuthContext = Depends(require_auth), limit: int = Query(default=30, ge=1, le=100)):
    _require_hq(ctx)
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT campaign_id, title, campaign_type, start_date, end_date, isbn13s,
                   target_branch_ids, objective, status, created_by, created_at, updated_at
              FROM goods_campaigns
             ORDER BY created_at DESC
             LIMIT %s
            """,
            (limit,),
        )
        items = [_campaign_dict(r) for r in cur.fetchall()]
    return {"items": items}


@router.get("/{campaign_id}")
def get_campaign(campaign_id: UUID, ctx: AuthContext = Depends(require_auth)):
    _require_hq(ctx)
    with db_conn() as conn, conn.cursor() as cur:
        campaign = _load_campaign(cur, campaign_id)
        recs = _load_recommendations(cur, campaign_id)
    return {**campaign, "recommendations": recs}


@router.delete("/{campaign_id}")
def delete_campaign(campaign_id: UUID, ctx: AuthContext = Depends(require_auth)):
    _require_hq(ctx)
    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM goods_campaigns WHERE campaign_id = %s RETURNING campaign_id",
                (str(campaign_id),),
            )
            if not cur.fetchone():
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="campaign not found")
        conn.commit()
    return {"campaign_id": str(campaign_id), "deleted": True}


@router.post("/{campaign_id}/recommend")
def recommend_campaign(campaign_id: UUID, mode: str = "auto", ctx: AuthContext = Depends(require_auth)):
    _require_hq(ctx)
    mode = (mode or "auto").lower()
    if mode not in ("auto", "real", "mock"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="mode must be auto, real, or mock")
    with db_conn() as conn:
        with conn.cursor() as cur:
            campaign = _load_campaign(cur, campaign_id)
            books = _book_rows(cur, campaign["isbn13s"])
            branches = _branch_rows(cur, campaign["target_branch_ids"])
            forecasts = _forecast_summary(cur, campaign["isbn13s"], campaign["target_branch_ids"])
            if not books:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="no matching books")
            if not branches:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="no matching branches")
            source = "gemini"
            gemini_configured = bool(settings.gcp_gemini_generate_url) and not settings.gcp_gemini_generate_url.startswith("${")
            if mode == "mock" or (mode == "auto" and not gemini_configured):
                generated = _fallback_recommendations(campaign, books, branches, forecasts)
                source = "mock"
            else:
                generated = _call_gemini(campaign, books, branches, forecasts)
            saved: list[dict[str, Any]] = []
            for item in generated["items"]:
                cur.execute(
                    """
                    INSERT INTO goods_recommendations
                        (recommendation_id, campaign_id, isbn13, branch_id, recommended_goods,
                         display_position, reason, priority, email_subject, email_body, ai_model, source)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (campaign_id, isbn13, branch_id) DO UPDATE
                    SET recommended_goods = EXCLUDED.recommended_goods,
                        display_position = EXCLUDED.display_position,
                        reason = EXCLUDED.reason,
                        priority = EXCLUDED.priority,
                        email_subject = EXCLUDED.email_subject,
                        email_body = EXCLUDED.email_body,
                        ai_model = EXCLUDED.ai_model,
                        source = EXCLUDED.source,
                        updated_at = NOW()
                    RETURNING recommendation_id, campaign_id, isbn13, branch_id, recommended_goods,
                              display_position, reason, priority, email_subject, email_body,
                              ai_model, source, created_at, updated_at
                    """,
                    (
                        str(uuid4()), str(campaign_id), str(item.get("isbn13", ""))[:13],
                        int(item.get("branch_id")), Json(item.get("recommended_goods") or []),
                        item.get("display_position"), item.get("reason"),
                        str(item.get("priority") or "MEDIUM")[:20],
                        item.get("email_subject"), item.get("email_body"),
                        settings.gcp_gemini_model, source,
                    ),
                )
                saved.append(_recommendation_dict(cur.fetchone()))
            cur.execute(
                "UPDATE goods_campaigns SET status = 'RECOMMENDED', updated_at = NOW() WHERE campaign_id = %s",
                (str(campaign_id),),
            )
        conn.commit()
    return {"campaign_id": str(campaign_id), "source": source, "items": saved}


@router.patch("/{campaign_id}/recommendation")
def patch_recommendation(campaign_id: UUID, req: RecommendationPatchReq, ctx: AuthContext = Depends(require_auth)):
    _require_hq(ctx)
    sets = ["updated_at = NOW()"]
    params: list[Any] = []
    for col, value in [
        ("recommended_goods", Json(req.recommended_goods) if req.recommended_goods is not None else None),
        ("display_position", req.display_position),
        ("reason", req.reason),
        ("priority", req.priority),
        ("email_subject", req.email_subject),
        ("email_body", req.email_body),
    ]:
        if value is not None:
            sets.append(f"{col} = %s")
            params.append(value)
    if len(sets) == 1:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="no fields to update")
    params.extend([str(campaign_id), str(req.recommendation_id)])
    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                UPDATE goods_recommendations
                   SET {', '.join(sets)}
                 WHERE campaign_id = %s AND recommendation_id = %s
                RETURNING recommendation_id, campaign_id, isbn13, branch_id, recommended_goods,
                          display_position, reason, priority, email_subject, email_body,
                          ai_model, source, created_at, updated_at
                """,
                params,
            )
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="recommendation not found")
        conn.commit()
    return _recommendation_dict(row)


@router.post("/{campaign_id}/send")
def send_campaign(campaign_id: UUID, ctx: AuthContext = Depends(require_auth)):
    _require_hq(ctx)
    with db_conn() as conn:
        with conn.cursor() as cur:
            campaign = _load_campaign(cur, campaign_id)
            recs = _load_recommendations(cur, campaign_id)
            if not recs:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="recommendations are required before send")
        by_branch: dict[int, list[dict[str, Any]]] = {}
        for rec in recs:
            by_branch.setdefault(int(rec["branch_id"]), []).append(rec)
        sent: list[dict[str, Any]] = []
        for branch_id, branch_recs in by_branch.items():
            payload = {
                "campaign_id": str(campaign_id),
                "campaign_title": campaign["title"],
                "campaign_period": f"{campaign['start_date']} ~ {campaign['end_date']}",
                "branch_id": branch_id,
                "email_subject": branch_recs[0].get("email_subject") or f"[BOOKFLOW] Goods campaign: {campaign['title']}",
                "email_body": "\n\n".join(r.get("email_body") or "" for r in branch_recs),
                "recommendations": branch_recs,
            }
            req = {
                "event_type": "GoodsDisplayCampaign",
                "severity": "INFO",
                "recipients": [],
                "channels": "email",
                "payload_summary": payload,
            }
            status_code = 503
            data: dict[str, Any] | None = None
            try:
                with httpx.Client(timeout=settings.gcp_http_timeout_seconds) as client:
                    resp = client.post(
                        f"{settings.notification_svc_url}/notification/send",
                        json=req,
                        headers={"Authorization": ctx.token},
                    )
                    status_code = resp.status_code
                    data = resp.json() if resp.content else None
            except Exception as exc:
                data = {"detail": str(exc)[:200]}
            send_status = "SENT" if 200 <= status_code < 300 else "FAILED"
            notification_id = (data or {}).get("notification_id")
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO goods_campaign_send_history
                        (send_id, campaign_id, branch_id, recipient_email, send_status, notification_id)
                    VALUES (%s, %s, %s, NULL, %s, %s)
                    """,
                    (str(uuid4()), str(campaign_id), branch_id, send_status, notification_id),
                )
            sent.append({"branch_id": branch_id, "status": send_status, "notification": data})
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE goods_campaigns SET status = 'SENT', updated_at = NOW() WHERE campaign_id = %s",
                (str(campaign_id),),
            )
        conn.commit()
    return {"campaign_id": str(campaign_id), "sent": sent, "sent_at": datetime.now(timezone.utc).isoformat()}
