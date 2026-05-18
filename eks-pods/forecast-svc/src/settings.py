"""env-driven config (FORECAST_ prefix)."""
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="FORECAST_", case_sensitive=False)

    rds_host: str
    rds_port: int = 5432
    rds_db: str = "bookflow"
    rds_user: str
    rds_password: str

    redis_host: str
    redis_port: int = 6379

    auth_mode: str = "mock"
    log_level: str = "INFO"

    # GCP integration. These are intentionally optional so local/unit tests can
    # boot without GCP credentials, but production endpoints fail closed when
    # the required values are absent.
    bq_project_id: str | None = None
    bq_dataset_id: str = "bookflow_dw"
    bq_forecast_table: str = "forecast_results"
    bq_location: str = "asia-northeast1"
    bq_refresh_days: int = 7

    gcp_vertex_invoke_url: str | None = None
    gcp_new_book_inference_url: str | None = None
    gcp_function_bearer_token: str | None = None
    gcp_http_timeout_seconds: float = 30.0
    allow_mock_fallback: bool = False


settings = Settings()
