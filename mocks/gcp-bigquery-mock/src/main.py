"""GCP BigQuery Jobs API mock.

Schema source: BQ REST API jobs.query +  V6.2 BQ tables (sheet 04).

Real endpoint:
  POST https://bigquery.googleapis.com/bigquery/v2/projects/{p}/queries
Request:
  {"query": "SELECT ...", "useLegacySql": false, "maxResults": 1000}
Response:
  {"kind": "bigquery#queryResponse", "schema": {...}, "rows": [...], "totalRows": "..."}

Mock detects queries against `bookflow_dw.forecast_results` and returns
deterministic synthetic rows for the requested (target_date, isbn13, store_id).
Other tables -> empty result.
"""
from __future__ import annotations

import hashlib
import re
from datetime import date, timedelta
from typing import Any

from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title="gcp-bigquery-mock", version="0.1.0")


class QueryRequest(BaseModel):
    query: str
    useLegacySql: bool = False
    maxResults: int | None = None
    timeoutMs: int | None = None


def _seed(isbn13: str, store_id: int, day_offset: int) -> float:
    h = int(
        hashlib.sha256(f"{isbn13}:{store_id}:{day_offset}".encode()).hexdigest()[:12], 16
    )
    return round(1.0 + (h % 5900) / 100.0, 2)


def _forecast_results_schema() -> dict[str, Any]:
    return {
        "fields": [
            {"name": "prediction_date", "type": "DATE"},
            {"name": "target_date",     "type": "DATE"},
            {"name": "isbn13",          "type": "STRING"},
            {"name": "store_id",        "type": "INT64"},
            {"name": "predicted_demand","type": "NUMERIC"},
            {"name": "confidence_low",  "type": "NUMERIC"},
            {"name": "confidence_high", "type": "NUMERIC"},
            {"name": "model_version",   "type": "STRING"},
            {"name": "inference_ms",    "type": "INT64"},
        ]
    }


def _build_forecast_rows(query: str) -> list[dict[str, Any]]:
    """Return small synthetic forecast_results table for D+2~5 (3 days, 5 isbns x 2 stores = 30 rows)."""
    today = date.today()
    rows: list[dict[str, Any]] = []
    isbn_match = re.findall(r"['\"]([0-9]{13})['\"]", query)
    isbns = isbn_match if isbn_match else [
        "9788937417320", "9788972756538", "9788937834226", "9788956051924", "9788970127194",
    ]
    for day_offset in (2, 3, 4, 5):
        for isbn in isbns:
            for store_id in (1, 2):
                v = _seed(isbn, store_id, day_offset)
                rows.append(
                    {
                        "f": [
                            {"v": today.isoformat()},
                            {"v": (today + timedelta(days=day_offset)).isoformat()},
                            {"v": isbn},
                            {"v": str(store_id)},
                            {"v": str(v)},
                            {"v": str(round(v * 0.7, 2))},
                            {"v": str(round(v * 1.3, 2))},
                            {"v": "automl-v1.0.0"},
                            {"v": "42"},
                        ]
                    }
                )
    return rows


@app.post("/bigquery/v2/projects/{project}/queries")
def query(project: str, payload: QueryRequest) -> dict[str, Any]:
    q = payload.query.lower()
    if "forecast_results" in q:
        rows = _build_forecast_rows(payload.query)
        return {
            "kind": "bigquery#queryResponse",
            "schema": _forecast_results_schema(),
            "jobReference": {"projectId": project, "jobId": f"job-{abs(hash(payload.query))}"},
            "totalRows": str(len(rows)),
            "rows": rows,
            "jobComplete": True,
            "cacheHit": False,
        }
    return {
        "kind": "bigquery#queryResponse",
        "schema": {"fields": []},
        "jobReference": {"projectId": project, "jobId": f"job-empty-{abs(hash(payload.query))}"},
        "totalRows": "0",
        "rows": [],
        "jobComplete": True,
        "cacheHit": False,
    }


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
