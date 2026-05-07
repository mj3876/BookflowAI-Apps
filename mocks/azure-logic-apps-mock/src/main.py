"""Azure Logic Apps webhook mock.

Schema source: BOOKFLOW_Data_Schema_v3.xlsx sheet 04_Master_BQ_Redis_알림 (12 events).

Real Logic Apps URL pattern:
  POST https://prod-XX.koreacentral.logic.azure.com/workflows/{wf_id}/triggers/manual/paths/invoke?api-version=2016-10-01&sv=1.0&sig={sig}
Response: 202 Accepted (no body or run id).

Mock keeps last 100 invocations in memory for inspection (/workflows/{wf_id}/runs).
"""
from __future__ import annotations

import time
import uuid
from collections import deque
from typing import Any

from fastapi import FastAPI, HTTPException, Query, Request, Response

app = FastAPI(title="azure-logic-apps-mock", version="0.1.0")

# Maps event_type -> deterministic workflow id (mirrors V6.2 sheet 04 12 events)
WORKFLOW_IDS: dict[str, str] = {
    "OrderPending":        "wf-order-pending-0001",
    "OrderApproved":       "wf-order-approved-0002",
    "OrderRejected":       "wf-order-rejected-0003",
    "AutoExecutedUrgent":  "wf-auto-exec-urgent-0004",
    "AutoRejectedBatch":   "wf-auto-rejected-0005",
    "SpikeUrgent":         "wf-spike-urgent-0006",
    "StockDepartPending":  "wf-stock-depart-0007",
    "StockArrivalPending": "wf-stock-arrival-0008",
    "NewBookRequest":      "wf-newbook-request-0009",
    "ReturnPending":       "wf-return-pending-0010",
    "LambdaAlarm":         "wf-lambda-alarm-0011",
    "DeploymentRollback":  "wf-deploy-rollback-0012",
}

_RUNS: dict[str, deque[dict[str, Any]]] = {}


@app.post("/workflows/{workflow_id}/triggers/manual/paths/invoke")
async def invoke_workflow(
    workflow_id: str,
    request: Request,
    api_version: str = Query("2016-10-01", alias="api-version"),
    sv: str | None = Query(default="1.0"),
    sig: str | None = Query(default=None),
):
    if sig is None:
        raise HTTPException(status_code=401, detail={"error": "Authentication failed (missing sig)."})
    try:
        body = await request.json()
    except Exception:
        body = {}

    run_id = uuid.uuid4().hex
    record = {
        "run_id": run_id,
        "workflow_id": workflow_id,
        "received_at": time.time(),
        "body": body,
    }
    _RUNS.setdefault(workflow_id, deque(maxlen=100)).append(record)
    return Response(
        status_code=202,
        headers={
            "x-ms-workflow-run-id": run_id,
            "Location": f"http://azure-logic-apps-mock.stubs.svc.cluster.local/workflows/{workflow_id}/runs/{run_id}",
        },
    )


@app.get("/workflows/{workflow_id}/runs")
def list_runs(workflow_id: str) -> dict[str, Any]:
    runs = list(_RUNS.get(workflow_id, []))
    return {"value": runs, "count": len(runs)}


@app.get("/workflows")
def list_workflows() -> dict[str, Any]:
    return {"workflows": [{"event_type": k, "workflow_id": v} for k, v in WORKFLOW_IDS.items()]}


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
