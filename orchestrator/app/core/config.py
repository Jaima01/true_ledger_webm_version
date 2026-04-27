"""Application settings for the orchestrator service."""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    api_title: str = "Deepfake Orchestrator"
    debug: bool = False
    database_url: str = "postgresql+asyncpg://user:password@localhost:5432/deepfake"
    redis_url: str = "redis://localhost:6379/0"
    backend_base_url: str = "http://localhost:8001"


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
