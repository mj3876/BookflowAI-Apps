"""
S3 첨부파일 업로드 모듈

출판사가 신간 요청서와 함께 제출하는 마케팅 자료, 원고 샘플 등을 S3 에 저장.

S3 키 규칙: {s3_prefix}/{isbn13}/{원본파일명}
  예: attachments/9791234567890/marketing_plan.pdf

인프라 연동:
  - 버킷: settings.s3_bucket (인프라 미비: s3.yaml 에 publisher-uploads 버킷 추가 필요)
  - IAM:  publisher EC2 Role 에 s3:PutObject 권한 필요
          (인프라 미비: publisher-asg.yaml PublisherRole 에 정책 추가 필요)
  - EC2 → S3: NAT Gateway 경유 인터넷 또는 S3 VPC Endpoint 경유
"""
import logging

import boto3
from botocore.exceptions import BotoCoreError, ClientError

from .settings import settings

log = logging.getLogger(__name__)
_s3_client = None

# 허용 MIME 타입 (악성 파일 차단)
ALLOWED_CONTENT_TYPES = {
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "image/jpeg",
    "image/png",
}

MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024  # 10 MB


def _get_s3():
    global _s3_client
    if _s3_client is None:
        # EC2 IAM Role 로 자동 인증 (명시적 키 불필요)
        _s3_client = boto3.client("s3", region_name=settings.aws_region)
    return _s3_client


def upload_attachment(isbn13: str, filename: str, data: bytes, content_type: str) -> str | None:
    """첨부파일을 S3 에 업로드하고 S3 키를 반환. 실패 시 None (요청 자체는 계속 처리).

    Args:
        isbn13: 도서 ISBN-13 (S3 경로 구분자로 사용)
        filename: 원본 파일명
        data: 파일 바이트
        content_type: MIME 타입

    Returns:
        S3 키 문자열 (예: "attachments/9791234567890/marketing.pdf"), 실패 시 None
    """
    if content_type not in ALLOWED_CONTENT_TYPES:
        log.warning("attachment upload rejected: unsupported content_type=%s isbn13=%s", content_type, isbn13)
        return None

    if len(data) > MAX_FILE_SIZE_BYTES:
        log.warning("attachment upload rejected: file too large (%d bytes) isbn13=%s", len(data), isbn13)
        return None

    # 파일명에서 디렉토리 경로 제거 (경로 순회 공격 방지)
    safe_name = filename.replace("\\", "/").split("/")[-1]
    key = f"{settings.s3_prefix.rstrip('/')}/{isbn13}/{safe_name}"

    try:
        _get_s3().put_object(
            Bucket=settings.s3_bucket,
            Key=key,
            Body=data,
            ContentType=content_type,
            # 서버 측 암호화 (s3.yaml 버킷 기본 SSE-KMS 와 정합)
            ServerSideEncryption="aws:kms",
        )
        log.info("attachment uploaded: s3://%s/%s", settings.s3_bucket, key)
        return key
    except (BotoCoreError, ClientError) as e:
        # S3 업로드 실패 시 요청 처리는 계속 (첨부파일은 선택사항)
        log.error("attachment S3 upload failed for isbn13=%s: %s", isbn13, e)
        return None
