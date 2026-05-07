"""GCP Vertex AI Endpoint mock.

Schema source: V6.2 slide 12 + Vertex AI predict API contract.

Real endpoint:
  POST https://{region}-aiplatform.googleapis.com/v1/projects/{p}/locations/{r}/endpoints/{e}:predict
Request:
  {"instances": [{"isbn13": "...", "store_id": 1, "features": {...}}]}
Response:
  {"predictions": [{"value": 12.3, "lower_bound": 9.1, "upper_bound": 15.6}],
   "deployedModelId": "1234", "model": "...", "modelVersionId": "1.0.0"}

Mock returns deterministic predictions seeded by isbn13 + store_id so unit tests
match RDS forecast_cache seed values when the same input is sent.
"""
from __future__ import annotations

import hashlib
from typing import Any

from fastapi import FastAPI
from pydantic import BaseModel, Field

app = FastAPI(title="gcp-vertex-mock", version="0.1.0")


class PredictRequest(BaseModel):
    instances: list[dict[str, Any]] = Field(default_factory=list)
    parameters: dict[str, Any] | None = None


def _seed_value(isbn13: str, store_id: int) -> float:
    """Stable pseudo-random demand for (isbn13, store_id) - between 1.0 and 60.0"""
    h = int(hashlib.sha256(f"{isbn13}:{store_id}".encode()).hexdigest()[:12], 16)
    return round(1.0 + (h % 5900) / 100.0, 2)


@app.post("/v1/projects/{project}/locations/{location}/endpoints/{endpoint}:predict")
def predict(project: str, location: str, endpoint: str, payload: PredictRequest) -> dict[str, Any]:
    predictions: list[dict[str, Any]] = []
    for inst in payload.instances:
        isbn13 = inst.get("isbn13") or inst.get("ISBN13") or "0000000000000"
        store_id = int(inst.get("store_id") or inst.get("STORE_ID") or 1)
        v = _seed_value(isbn13, store_id)
        predictions.append(
            {
                "value": v,
                "lower_bound": round(v * 0.7, 2),
                "upper_bound": round(v * 1.3, 2),
                "isbn13": isbn13,
                "store_id": store_id,
            }
        )
    return {
        "predictions": predictions,
        "deployedModelId": "mock-deployed-1234",
        "model": f"projects/{project}/locations/{location}/models/bookflow-automl-v1",
        "modelVersionId": "1.0.0",
    }


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
