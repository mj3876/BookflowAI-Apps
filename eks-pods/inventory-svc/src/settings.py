"""env-driven config. ConfigMap/Secret -> env vars; pydantic-settings parses + validates."""
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="INVENTORY_", case_sensitive=False)

    rds_host: str
    rds_port: int = 5432
    rds_db: str = "bookflow"
    rds_user: str
    rds_password: str

    redis_host: str
    redis_port: int = 6379

    auth_mode: str = "mock"

    log_level: str = "INFO"


settings = Settings()
