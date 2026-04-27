"""Redis cache helpers for content status lookups (backend side)."""

import json
import logging
from typing import Any

from redis.asyncio import Redis

logger = logging.getLogger(__name__)


class CacheService:
    PREFIX = "content:status"

    def __init__(self, redis_client: Redis):
        self.redis = redis_client

    def _key(self, platform: str, platform_video_id: str) -> str:
        return f"{self.PREFIX}:{platform}:{platform_video_id}"

    async def get_content_status(self, platform: str, platform_video_id: str) -> str | None:
        val = await self.redis.get(self._key(platform, platform_video_id))
        if val is None:
            return None
        return val.decode() if isinstance(val, bytes) else val

    async def set_content_status(
        self, platform: str, platform_video_id: str, status: str, ttl: int = 3600
    ) -> None:
        await self.redis.setex(self._key(platform, platform_video_id), ttl, status)
