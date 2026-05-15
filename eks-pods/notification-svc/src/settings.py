"""env-driven config (NOTIFICATION_ prefix)."""
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="NOTIFICATION_", case_sensitive=False)

    rds_host: str
    rds_port: int = 5432
    rds_db: str = "bookflow"
    rds_user: str
    rds_password: str

    redis_host: str
    redis_port: int = 6379

    # Azure Logic Apps webhook (ACS Email 발신 담당).
    logic_apps_url: str = "http://azure-logic-apps-mock.stubs.svc.cluster.local"
    logic_apps_timeout_seconds: float = 5.0

    auth_mode: str = "mock"
    log_level: str = "INFO"

    # ── 수신자 연락처 ─────────────────────────────────────────────────
    # K8s ConfigMap NOTIFICATION_CONTACT_* 으로 주입 (학습환경: 3개 주소로 통합)
    contact_hq_emails: str = ""      # 본사+경영진 → ms8405493@gmail.com
    contact_wh_emails: str = ""      # 물류센터(수도권+영남) → rladudgjs0427@gmail.com
    contact_branch_emails: str = ""  # 지점 전체 → admin@bleach10905gmail.onmicrosoft.com


settings = Settings()
