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

    # Azure Logic Apps SAS URL (워크플로 별 분리).
    # notification/        → SpikeUrgent, NegotiationDelay, DailyPlanFinalized
    # approval-request/    → ForecastCompleted, OrderPending (승인요청)
    # stock-depart/        → StockDepartPending (운송시작)
    # stock-arrival/       → StockArrivalPending (운송완료)
    logic_apps_url: str = ""                        # la-bookflowmj-notification SAS URL
    logic_apps_approval_request_url: str = ""       # la-bookflowmj-approval-request SAS URL
    logic_apps_stock_depart_url: str = ""           # la-bookflowmj-stock-depart SAS URL
    logic_apps_stock_arrival_url: str = ""          # la-bookflowmj-stock-arrival SAS URL
    logic_apps_timeout_seconds: float = 5.0

    auth_mode: str = "mock"
    log_level: str = "INFO"

    # ── 수신자 연락처 ─────────────────────────────────────────────────
    # K8s ConfigMap NOTIFICATION_CONTACT_* 으로 주입 (학습환경: 3개 주소로 통합)
    contact_hq_emails: str = ""      # 본사+경영진 → woohek00@gmail.com
    contact_wh_emails: str = ""      # 물류센터(수도권+영남) → rladudgjs0427@gmail.com
    contact_branch_emails: str = ""  # 지점 전체 → ms8405493@gmail.com

    # ── 지점·물류센터 개별 담당자 연락처 ─────────────────────────────
    # JSON 문자열: {"location_id": "email", ...} (location_id = locations 테이블 PK)
    # K8s ConfigMap NOTIFICATION_CONTACT_LOCATION_CONTACTS_JSON 으로 주입
    contact_location_contacts_json: str = ""


settings = Settings()
