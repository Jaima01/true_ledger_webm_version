"""Redis cache helpers for content status lookups."""

from redis.asyncio import Redis


class CacheService:
    PREFIX = "content:status"

    def __init__(self, redis_client: Redis):
        self.redis_client = redis_client

    def _key(self, platform: str, platform_video_id: str) -> str:
        return f"{self.PREFIX}:{platform}:{platform_video_id}"

    async def get_content_status(self, platform: str, platform_video_id: str) -> str | None:
        return await self.redis_client.get(self._key(platform, platform_video_id))

    async def set_content_status(
        self, platform: str, platform_video_id: str, status: str, ttl_seconds: int = 3600
    ) -> None:
        await self.redis_client.setex(
            self._key(platform, platform_video_id), ttl_seconds, status
        )

    async def delete_content_status(self, platform: str, platform_video_id: str) -> None:
        await self.redis_client.delete(self._key(platform, platform_video_id))
