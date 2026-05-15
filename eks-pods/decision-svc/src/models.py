"""pydantic models matching V3 pending_orders.

V3 columns: order_id · order_type · isbn13 · source_location_id · target_location_id
            qty · est_lead_time_hours · est_cost · forecast_rationale (jsonb)
            urgency_level · auto_execute_eligible · stock_days_remaining
            demand_confidence_ratio · demand_cv · status · execution_reason
            reject_reason · reject_count · created_at · approved_at · executed_at
"""
from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field


OrderType = Literal["WH_TO_STORE", "REBALANCE", "WH_TRANSFER", "PUBLISHER_ORDER"]
Urgency = Literal["NORMAL", "URGENT", "CRITICAL"]
OrderStatus = Literal["PENDING", "APPROVED", "REJECTED", "EXECUTED", "CANCELLED"]


class DecideRequest(BaseModel):
    """V6.2 3-stage cascade 입력 (단순화).

    isbn13 + target_location_id + qty 만 받음 → 백엔드가 자동으로 Stage 1/2/3 결정.
    `urgency_level`/`auto_execute_eligible` 등 도 자동 계산 (forecast_cache + inventory 기준).
    """
    isbn13: str = Field(min_length=13, max_length=13)
    target_location_id: int = Field(gt=0)
    qty: int = Field(gt=0)
    note: str | None = None  # 사용자 메모 (audit_log)


class BatchDecideRequest(BaseModel):
    """일괄 cascade 결정 (시연 일괄 발의 · 매일 03:30 batch).

    N items 받아 backend 가 parallel (asyncio.gather) 처리.
    """
    items: list[DecideRequest] = Field(min_length=1, max_length=2000)


class BatchDecideResponse(BaseModel):
    total: int
    s0: int = 0  # WH_TO_STORE (2026-05-14 신규)
    s1: int = 0
    s2: int = 0
    s3: int = 0
    failed: int = 0
    errors: list[str] = []


class DecideResponse(BaseModel):
    order_id: UUID
    order_type: OrderType
    stage: Literal[0, 1, 2, 3]
    source_location_id: int | None
    target_location_id: int
    qty: int
    urgency_level: Urgency
    auto_execute_eligible: bool
    status: OrderStatus
    rationale: dict
    created_at: datetime


class PendingOrder(BaseModel):
    """Response model - order_type kept as str so seed data with legacy types ('MANUAL') passes."""
    order_id: UUID
    order_type: str
    isbn13: str
    source_location_id: int | None
    target_location_id: int | None
    qty: int
    urgency_level: str
    status: str
    created_at: datetime


class PendingOrdersResponse(BaseModel):
    items: list[PendingOrder]
