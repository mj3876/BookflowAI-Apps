"""pydantic models matching V3 forecast_cache table.

V3 columns: snapshot_date · isbn13 · store_id · predicted_demand
            confidence_low · confidence_high · model_version · synced_at
PK: (snapshot_date, isbn13, store_id)
"""
from datetime import date, datetime
from pydantic import BaseModel, Field


class ForecastRow(BaseModel):
    snapshot_date: date
    isbn13: str = Field(min_length=13, max_length=13)
    store_id: int
    predicted_demand: float
    confidence_low: float | None = None
    confidence_high: float | None = None
    model_version: str | None = None
    synced_at: datetime | None = None


class ForecastResponse(BaseModel):
    snapshot_date: date
    store_id: int
    items: list[ForecastRow]


class RefreshRequest(BaseModel):
    snapshot_date: date
    store_id: int
    items: list[ForecastRow]


class RefreshResponse(BaseModel):
    snapshot_date: date
    store_id: int
    inserted: int
