"""pydantic request/response models matching V3 schema (inventory + reservations tables)."""
from datetime import date, datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field


class InventoryItem(BaseModel):
    isbn13: str = Field(min_length=13, max_length=13)
    location_id: int
    on_hand: int
    reserved_qty: int
    safety_stock: int
    available: int  # derived: on_hand - reserved_qty
    updated_at: datetime
    # FR-A7.4 enrichment
    title: str | None = None                  # books.title (LEFT JOIN · NULL 가능)
    expected_soldout_at: date | None = None   # books.expected_soldout_at
    incoming_qty: int = 0                     # pending_orders APPROVED · target=self · in-transit
    outgoing_qty: int = 0                     # pending_orders APPROVED · source=self · in-transit


class WarehouseInventoryResponse(BaseModel):
    wh_id: int
    items: list[InventoryItem]


class AdjustRequest(BaseModel):
    isbn13: str = Field(min_length=13, max_length=13)
    location_id: int
    delta: int  # positive = inbound, negative = outbound
    reason: str = Field(min_length=1, max_length=50)


class AdjustResponse(BaseModel):
    isbn13: str
    location_id: int
    on_hand_before: int
    on_hand_after: int


class ReserveRequest(BaseModel):
    isbn13: str = Field(min_length=13, max_length=13)
    location_id: int
    qty: int = Field(gt=0)
    reason: Literal["NORMAL", "SPIKE", "SOLD"] = "NORMAL"
    ttl_seconds: int = Field(default=300, ge=10, le=86400)


class ReserveResponse(BaseModel):
    reservation_id: UUID
    isbn13: str
    location_id: int
    qty: int
    expires_at: datetime
