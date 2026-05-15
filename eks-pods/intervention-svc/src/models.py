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
    title: str | None = None  # P3-1 ISBN → 제목 우선 표시 (LEFT JOIN books · 일부 ISBN 은 books 에 없을 수도)
    approved_at: datetime | None = None
    executed_at: datetime | None = None
    # 2026-05-15 v3: frontend whichSide 의 wh_id 매핑 정합 + 4-step state machine 표시
    source_wh_id: int | None = None
    target_wh_id: int | None = None
    expected_arrival_at: str | None = None  # DATE 컬럼
    dispatched_at: datetime | None = None
    rejection_stage: str | None = None
    # v4 2026-05-15 selfDone 영구화 — 새로고침 시에도 한쪽 ✓ 표시 유지
    source_approved: bool = False
    target_approved: bool = False


class QueueResponse(BaseModel):
    items: list[QueueItem]
    # 페이지네이션: total = 필터 적용된 전체 row 수 (limit/offset 무관), stage_counts = order_type 별 count
    total: int = 0
    stage_counts: dict[str, int] = {}


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
    # 2026-05-14: 양측 협의 (REBALANCE/WH_TRANSFER) 진행 단계 UI 명확화용.
    # 자기측만 처리된 경우 'PENDING' · 양측 모두 완료된 경우 'APPROVED' (또는 'REJECTED').
    final_status: str | None = None


class PendingOrderEditRequest(BaseModel):
    """D5-7 Notion 2.6 · WH AI 추천 수정 (수량/대상 매장/사유).

    wh-manager 가 PENDING pending_order 의 qty/target_location_id/note 를 수정.
    audit_log 에 before/after 기록.
    """
    qty: int | None = Field(default=None, gt=0, description="새 수량 (양수)")
    target_location_id: int | None = Field(default=None, description="대상 매장 변경")
    note: str | None = Field(default=None, max_length=200, description="수정 사유")


class PendingOrderEditResponse(BaseModel):
    order_id: UUID
    qty: int
    target_location_id: int
    edited_at: datetime
    edited_by: str


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


class ReturnRequestRequest(BaseModel):
    """P1-3 Branch 반품 신청 (R&R 3.2 line 143).

    branch-clerk 전용 — scope_store_id == location_id 검증.
    returns INSERT status='PENDING' (default) → HQ Returns 큐 진입 + ⑩ReturnPending 알림.
    """
    isbn13: str = Field(min_length=13, max_length=13)
    location_id: int
    qty: int = Field(gt=0)
    reason: str = Field(min_length=1, max_length=50)


class ReturnRequestResponse(BaseModel):
    return_id: UUID
    isbn13: str
    location_id: int
    qty: int
    reason: str
    status: str
    requested_at: datetime


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
