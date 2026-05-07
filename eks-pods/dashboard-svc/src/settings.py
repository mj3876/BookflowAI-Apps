"""env-driven config (DASHBOARD_ prefix).

5-pod fan-in via HTTP + WebSocket broker (Redis pub/sub) + direct RDS read for master tables.
"""
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="DASHBOARD_", case_sensitive=False)

    inventory_svc_url:    str = "http://inventory-svc.bookflow.svc.cluster.local"
    forecast_svc_url:     str = "http://forecast-svc.bookflow.svc.cluster.local"
    decision_svc_url:     str = "http://decision-svc.bookflow.svc.cluster.local"
    notification_svc_url: str = "http://notification-svc.bookflow.svc.cluster.local"
    intervention_svc_url: str = "http://intervention-svc.bookflow.svc.cluster.local"

    redis_host: str
    redis_port: int = 6379

    # Direct RDS read for master tables (sales_realtime · books · kpi_daily)
    # per .pen Service Mesh - dashboard_svc role has SELECT only.
    rds_host: str = ""
    rds_port: int = 5432
    rds_db: str = "bookflow"
    rds_user: str = "dashboard_svc"
    rds_password: str = ""

    auth_mode: str = "mock"
    log_level: str = "INFO"

    fan_in_timeout_seconds: float = 3.0


settings = Settings()
