"""
API 키 인증 모듈

출판사는 요청마다 HTTP 헤더 X-Api-Key 에 발급받은 키를 포함.
서버는 키의 SHA-256 해시를 settings.api_key_hash 와 비교 (평문 저장 방지).
secrets.compare_digest 로 타이밍 공격 방지.

키 발급 절차:
  1. 임의 문자열 생성: python3 -c "import secrets; print(secrets.token_hex(32))"
  2. 해시 생성:       echo -n "<위 값>" | sha256sum
  3. 해시를 Secrets Manager bookflow/publisher-api 의 api_key_hash 항목에 저장
  4. 원본 키를 출판사에 안전하게 전달 (이메일 금지 → 별도 채널)

settings.api_key_hash 가 빈 문자열이면 개발 모드로 간주해 인증을 건너뜀.
"""
import hashlib
import logging
import secrets
from typing import Optional

from fastapi import HTTPException, Header

from .settings import settings

log = logging.getLogger(__name__)


def verify_api_key(x_api_key: Optional[str] = Header(None)) -> None:
    """FastAPI Depends 로 사용하는 API 키 검증 함수.

    POST 엔드포인트에 Depends(verify_api_key) 로 주입.
    개발 환경(api_key_hash 미설정) 에서는 경고만 로그하고 통과.
    """
    if not settings.api_key_hash:
        # 개발 모드: 인증 우회 (프로덕션 배포 전 반드시 api_key_hash 설정)
        log.warning("API key auth DISABLED (api_key_hash not configured) — dev mode only")
        return

    if not x_api_key:
        raise HTTPException(status_code=401, detail="X-Api-Key header required")

    # SHA-256 해시 비교 (타이밍 공격 방지: compare_digest 사용)
    submitted_hash = hashlib.sha256(x_api_key.encode()).hexdigest()
    if not secrets.compare_digest(submitted_hash, settings.api_key_hash):
        log.warning("invalid API key attempt (hash mismatch)")
        raise HTTPException(status_code=401, detail="Invalid API key")
