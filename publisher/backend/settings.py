"""
publisher-api 환경 설정 모듈

설정값 로드 우선순위:
  1. /etc/publisher-api.env  (EC2 배포 시 after-install.sh 가 Secrets Manager 에서 생성)
  2. 환경변수 (로컬 개발 시 .env 파일 또는 직접 export)

EC2 → RDS 연결 경로:
  Egress VPC (10.2.0.0/16) → Transit Gateway → Data VPC (10.3.0.0/16) → RDS 5432
  (인프라 코드: 60-network-cross-cloud/tgw-vpc-routes.yaml RtEgressToData 참조)
"""
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        # EC2 배포 환경: after-install.sh 가 Secrets Manager 값으로 생성
        env_file="/etc/publisher-api.env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ── RDS (PostgreSQL 16 · Data VPC DB subnet) ──────────────────────────────
    rds_host: str = "localhost"
    rds_port: int = 5432
    rds_db: str = "bookflow"
    rds_user: str = "publisher_api"   # DB 전용 role (최소 권한)
    rds_password: str = "changeme"

    # ── S3 (첨부파일 버킷 · 인프라 미비: s3.yaml 에 publisher-uploads 버킷 추가 필요) ──
    s3_bucket: str = "bookflow-publisher-uploads"
    s3_prefix: str = "attachments/"        # S3 키 접두사: attachments/{isbn13}/{파일명}
    aws_region: str = "ap-northeast-1"

    # ── API 인증 ──────────────────────────────────────────────────────────────
    # 출판사에게 발급한 API 키의 SHA-256 해시값 (평문 노출 방지)
    # 생성: echo -n "발급할키" | sha256sum
    # 인프라 미비: Secrets Manager bookflow/publisher-api 에 api_key_hash 항목 추가 필요
    api_key_hash: str = ""   # 빈 값이면 POST 인증 우회 (개발 전용)

    log_level: str = "INFO"
    port: int = 8000


settings = Settings()
