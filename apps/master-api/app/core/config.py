from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "FilinControl Master API"
    app_version: str = "dev"
    debug: bool = False
    cors_origins: list[str] = Field(default_factory=lambda: ["*"])

    database_url: str = "postgresql+asyncpg://filin:filin@postgres:5432/filin"
    redis_url: str = "redis://redis:6379/0"

    jwt_secret: str = "change_me_in_production"
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 60 * 24 * 7  # 7 days

    enroll_token_expire_minutes: int = 15

    node_offline_threshold_seconds: int = 30

    agent_auto_update_enabled: bool = False
    agent_auto_update_check_seconds: int = 300
    agent_auto_update_batch_size: int = 1
    sse_ping_seconds: int = 20
    alert_notification_timeout_seconds: int = 10


settings = Settings()
