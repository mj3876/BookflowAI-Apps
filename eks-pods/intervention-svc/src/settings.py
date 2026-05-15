"""env-driven config (INTERVENTION_ prefix)."""
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="INTERVENTION_", case_sensitive=False)

    rds_host: str
    rds_port: int = 5432
    rds_db: str = "bookflow"
    rds_user: str
    rds_password: str

    redis_host: str
    redis_port: int = 6379

    # 4-step state machine v2 (PR-B): inventory writer 단일화 + notification publish 통일
    # env var: INTERVENTION_INVENTORY_SVC_URL · INTERVENTION_NOTIFICATION_SVC_URL
    inventory_svc_url: str = "http://inventory-svc.bookflow.svc.cluster.local"
    notification_svc_url: str = "http://notification-svc.bookflow.svc.cluster.local"

    auth_mode: str = "mock"
    log_level: str = "INFO"


settings = Settings()
