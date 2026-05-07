"""env-driven config. ConfigMap (CLIENT_ID/TENANT_ID/PUBLIC_BASE_URL) + Secret (CLIENT_SECRET/JWT_KEY)."""
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="AUTH_", case_sensitive=False)

    # OIDC (Entra ID)
    entra_tenant_id: str
    entra_client_id: str
    entra_client_secret: str
    public_base_url: str = "https://bookflow.duckdns.org"
    redirect_path: str = "/auth/callback"

    # JWT (BookFlow internal · HS256)
    jwt_signing_key: str
    jwt_issuer: str = "bookflow-auth-pod"
    jwt_audience: str = "bookflow-services"
    jwt_ttl_seconds: int = 8 * 3600  # 8h

    # RDS (users upsert)
    rds_host: str
    rds_port: int = 5432
    rds_db: str = "bookflow"
    rds_user: str
    rds_password: str

    # default role mapping when Entra group not yet assigned
    default_role: str = "branch-clerk"
    default_store_id: int = 1

    log_level: str = "INFO"


settings = Settings()
