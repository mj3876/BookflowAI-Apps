"""pydantic models matching V3 notifications_log table.

V3 columns: notification_id UUID PK, event_type, correlation_id UUID,
            severity, recipients jsonb, channels, payload_summary jsonb,
            sent_at (NOT NULL DEFAULT NOW), status (default 'SENT')
"""
from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field


# V3 시트 06 Logic Apps 12 이벤트
EventType = Literal[
    "OrderPending", "OrderApproved", "OrderRejected",
    "AutoExecutedUrgent", "AutoRejectedBatch",
    "SpikeUrgent",
    "StockDepartPending", "StockArrivalPending",
    "NewBookRequest",
    "ReturnPending",
    "DailyPlanFinalized", "ApprovalDelayed", "InboundRejected",
    "LambdaAlarm", "DeploymentRollback",
    # D5-8 Notion 3.5 · 매장 → 본사/물류 의견 제출 (운영 확장)
    "BranchFeedback",
]

Severity = Literal["INFO", "WARNING", "CRITICAL"]


class SendRequest(BaseModel):
    event_type: EventType
    severity: Severity = "INFO"
    recipients: list[str] = Field(default_factory=list)  # user_ids or emails
    channels: str | None = None  # "email,sms" 같이 콤마 구분 또는 단일
    payload_summary: dict
    correlation_id: UUID | None = None


class SendResponse(BaseModel):
    notification_id: UUID
    event_type: str
    status: str
    sent_at: datetime


class NotificationRow(BaseModel):
    notification_id: UUID
    event_type: str
    correlation_id: UUID | None
    severity: str | None
    channels: str | None
    payload_summary: dict | None
    sent_at: datetime
    status: str


class RecentResponse(BaseModel):
    items: list[NotificationRow]


# D5-8 Notion 3.5 · Branch → 본사/물류 의견 제출 채널
FeedbackType = Literal["SLOW_SELLER", "STOCK_REQUEST", "OTHER"]


class BranchFeedbackRequest(BaseModel):
    """매장 (branch-clerk) 이 본사/물류센터로 제출하는 의견."""
    feedback_type: FeedbackType
    isbn13: str | None = Field(default=None, min_length=13, max_length=13)
    message: str = Field(min_length=1, max_length=500)


class BranchFeedbackResponse(BaseModel):
    notification_id: UUID
    feedback_type: str
    submitted_at: datetime
