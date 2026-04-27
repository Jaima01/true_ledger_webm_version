"""Redis connection pool, client, and vector index bootstrap."""

import logging

import redis.asyncio as aioredis

from app.core.config import settings

logger = logging.getLogger(__name__)

_redis_client: aioredis.Redis | None = None

INDEX_NAME = "idx:frame_embeddings"
KEY_PREFIX = "frame:"
EMBEDDING_DIM = 512


async def get_redis() -> aioredis.Redis:
    global _redis_client
    if _redis_client is None:
        _redis_client = aioredis.from_url(
            settings.redis_url, decode_responses=False
        )
    return _redis_client


async def close_redis() -> None:
    global _redis_client
    if _redis_client is not None:
        await _redis_client.aclose()
        _redis_client = None


async def ensure_vector_index() -> None:
    """Create the RediSearch vector index if it doesn't already exist."""
    client = await get_redis()
    try:
        await client.execute_command("FT.INFO", INDEX_NAME)
        logger.info("Vector index '%s' already exists", INDEX_NAME)
        return
    except Exception:
        pass

    try:
        await client.execute_command(
            "FT.CREATE", INDEX_NAME,
            "ON", "HASH",
            "PREFIX", "1", KEY_PREFIX,
            "SCHEMA",
            "embedding", "VECTOR", "HNSW", "6",
                "TYPE", "FLOAT32",
                "DIM", str(EMBEDDING_DIM),
                "DISTANCE_METRIC", "COSINE",
            "status", "TAG",
            "video_id", "TAG",
        )
        logger.info("Created vector index '%s'", INDEX_NAME)
    except Exception:
        logger.exception("Failed to create vector index '%s'", INDEX_NAME)
