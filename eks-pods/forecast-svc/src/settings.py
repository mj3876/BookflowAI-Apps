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

    # New-book inference via BigQuery ML.PREDICT executed directly from forecast-svc
    # (BigQuery reached privately over PSC: bigquery.googleapis.com -> 10.50.0.10).
    # Mirrors the bookflow-new-book-inference Cloud Function logic but keeps the
    # call path AWS->BQ private, since the Cloud Function is ingress=internal-only
    # and not reachable from the EKS VPC.
    gcp_new_book_use_bq_direct: bool = False
    gcp_new_book_model: str = "bookflow_new_books_forecast"
    gcp_new_book_forecast_table: str = "new_book_forecast"
    gcp_new_book_lead_days: int = 30

    # Direct Vertex AI SDK call — bypasses Cloud Function, uses VPN private endpoint
    gcp_vertex_endpoint_name: str | None = None   # full resource name or display name
    gcp_vertex_location: str = "asia-northeast1"
    gcp_vertex_project_id: str | None = None      # falls back to bq_project_id
    gcp_vertex_private_api_endpoint: str | None = None  # e.g. "ENDPOINT_ID.asia-northeast1-aiplatform.googleapis.com"

    # forecast → decision service trigger (post BQ refresh)
    decision_svc_url: str = "http://decision-svc.bookflow.svc.cluster.local"
    decision_svc_timeout: float = 5.0


settings = Settings()
