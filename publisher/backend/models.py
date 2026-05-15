"""
신간 요청서 Pydantic 모델

DB 스키마 (new_book_requests 테이블) 와 1:1 대응.
publisher-watcher/src/poll.py 의 _normalize_request() 와 필드명 정합 유지.
migration.sql 적용 후 attachment_s3_key 컬럼이 추가된다.
"""
from datetime import date
from typing import Optional
from pydantic import BaseModel, Field


class NewBookRequestIn(BaseModel):
    """출판사가 제출하는 신간 요청서 입력 모델 (JSON body용).
    Form 제출은 main.py 에서 Form() 파라미터로 직접 받음.
    """
    isbn13: str = Field(..., pattern=r"^\d{13}$", description="ISBN-13 (13자리 숫자)")
    publisher_id: str = Field(..., min_length=1, max_length=50)
    title: str = Field(..., min_length=1, max_length=500)
    author: str = Field(..., min_length=1, max_length=500)
    genre: Optional[str] = Field(None, max_length=100)
    expected_pub_date: Optional[date] = None          # YYYY-MM-DD
    estimated_initial_sales: int = Field(0, ge=0)
    marketing_plan: Optional[str] = Field("", max_length=5000)
    # ISBN13 목록 (유사 기존 도서, publisher-watcher 가 수요예측에 활용)
    similar_books: list[str] = Field(default_factory=list)
    # 독자 타겟 세그먼트 태그 예: ["10대", "판타지 독자", "직장인"]
    target_segments: list[str] = Field(default_factory=list)


class SubmitResponse(BaseModel):
    """POST /api/v1/new-book-requests 응답."""
    id: int
    isbn13: str
    status: str                       # NEW 고정 (초기 상태)
    attachment_s3_key: Optional[str]  # S3 업로드 경로 (첨부파일 있을 때만)
    created_at: str


class StatusResponse(BaseModel):
    """GET /api/v1/new-book-requests/{isbn13}/status 응답."""
    id: int
    isbn13: str
    publisher_id: str
    title: str
    status: str    # NEW | REVIEWING | ACCEPTED | REJECTED
    created_at: str
    attachment_s3_key: Optional[str] = None
