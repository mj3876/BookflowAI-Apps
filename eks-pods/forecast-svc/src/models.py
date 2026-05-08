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


# P1-4b 시연 trigger: 예측 수요 > 가용 재고 인 도서 list (cascade 자동 발의용)
class InsufficientStockItem(BaseModel):
    isbn13: str
    title: str | None = None
    store_id: int
    predicted_demand: float
    available: int
    gap: int                 # predicted_demand - available
    suggested_qty: int       # 권장 보충 수량 (gap + safety_buffer)


class InsufficientStockResponse(BaseModel):
    snapshot_date: date
    items: list[InsufficientStockItem]
