"""Application configuration settings."""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    api_title: str = "Deepfake Detection Backend"
    debug: bool = False
    database_url: str = "postgresql+asyncpg://user:password@localhost:5432/deepfake"
    redis_url: str = "redis://localhost:6379/0"
    agent_base_url: str = "http://localhost:8002"
    gemini_api_key: str = ""

    # Vector search tuning
    vector_similarity_threshold: float = 0.85
    deepfake_frame_threshold: int = 3

    # Chunk queue management
    chunk_temp_dir: str = "/tmp/true-ledger/chunks"
    chunk_queue_ttl_seconds: int = 3600
    chunk_inactivity_timeout_seconds: int = 6


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
