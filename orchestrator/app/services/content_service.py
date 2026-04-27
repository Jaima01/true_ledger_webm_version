"""Database access helpers for the videos table."""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.content import Video


class ContentService:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def get_video(self, platform: str, platform_video_id: str) -> Video | None:
        result = await self.db.execute(
            select(Video).where(
                Video.platform == platform,
                Video.platform_video_id == platform_video_id,
            )
        )
        return result.scalar_one_or_none()

    async def create_video(
        self,
        platform: str,
        platform_video_id: str,
        title: str | None = None,
        channel: str | None = None,
        total_duration: float | None = None,
        status: str = "processing",
    ) -> Video:
        video = Video(
            platform=platform,
            platform_video_id=platform_video_id,
            title=title,
            channel=channel,
            total_duration=total_duration,
            status=status,
        )
        self.db.add(video)
        await self.db.commit()
        await self.db.refresh(video)
        return video
