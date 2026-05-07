"""pydantic models matching V3 order_approvals + returns."""
from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field


ApprovalSide = Literal["SOURCE", "TARGET", "FINAL"]
Decision = Literal["APPROVED", "REJECTED"]


class QueueItem(BaseModel):
    """A pending_orders row that needs approval (queue view for HQ Approval / WH Approve pages).

    forecast_rationale: decision-svc 가 채운 의사결정 근거 (Stage 1 effective_available 또는
    Stage 2 partner_surplus 등). UI 가 승인 판단 시 참고 자료로 표시 (UX-4 / FR-A5.6).
    """
    order_id: UUID
    order_type: str
    isbn13: str
    source_location_id: int | None
    target_location_id: int | None
    qty: int
    urgency_level: str
    auto_execute_eligible: bool
    status: str
    created_at: datetime
    forecast_rationale: dict | None = None


class QueueResponse(BaseModel):
    items: list[QueueItem]


class ApproveRequest(BaseModel):
    order_id: UUID
    approval_side: ApprovalSide = "FINAL"  # FINAL = single-stage HQ approval; SOURCE/TARGET = 2-stage WH transfer
    note: str | None = None


class RejectRequest(BaseModel):
    order_id: UUID
    approval_side: ApprovalSide = "FINAL"
    reject_reason: str = Field(min_length=1, max_length=50)


class ApprovalResponse(BaseModel):
    approval_id: UUID
    order_id: UUID
    decision: Decision
    decided_at: datetime


class ReturnApproveRequest(BaseModel):
    return_id: UUID
    note: str | None = None


class ReturnApproveResponse(BaseModel):
    return_id: UUID
    status: str
    hq_approved_at: datetime


class ReturnRejectRequest(BaseModel):
    """A4 반품 거부 (FR-A6.8 본사 마스터 기각). reject_reason 필수."""
    return_id: UUID
    reject_reason: str = Field(min_length=1, max_length=200)


class ReturnRejectResponse(BaseModel):
    return_id: UUID
    status: str
    rejected_at: datetime
    reject_reason: str


# ─── A5 ErrorResponse 표준 (intervention-svc pilot) ──────────────────────────
class ErrorResponse(BaseModel):
    """전 endpoint 공통 에러 응답 스키마.

    HTTPException 자동 변환 (main.py custom handler) · 클라이언트가 일관된 형식으로 파싱.
    `error_code` 는 도메인별 상수 (FORBIDDEN / NOT_FOUND / VALIDATION / CONFLICT / INTERNAL).
    `request_id` 는 요청 추적용 (X-Request-ID header).
    """
    error_code: str
    message: str
    details: dict | None = None
    request_id: str | None = None
