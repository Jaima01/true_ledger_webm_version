"""Database service for video and frame operations using pgvector."""

import logging
import uuid
from dataclasses import dataclass

from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import Video, VideoFrame

logger = logging.getLogger(__name__)


@dataclass
class DBFrameMatch:
    frame_id: uuid.UUID
    distance: float
    status: str
    video_id: uuid.UUID


class DatabaseService:
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

    async def search_similar_frames(
        self, embedding: list[float], threshold: float = 0.85, limit: int = 10
    ) -> list[DBFrameMatch]:
        """Find frames with cosine similarity above the threshold via pgvector."""
        embedding_str = "[" + ",".join(str(v) for v in embedding) + "]"
        query = text("""
            SELECT id, video_id, status,
                   (embedding <=> :emb::vector) AS distance
            FROM video_frames
            WHERE embedding IS NOT NULL
            ORDER BY embedding <=> :emb::vector
            LIMIT :lim
        """)
        result = await self.db.execute(query, {"emb": embedding_str, "lim": limit})
        rows = result.fetchall()

        matches: list[DBFrameMatch] = []
        for row in rows:
            similarity = 1.0 - float(row.distance)
            if similarity < threshold:
                continue
            matches.append(DBFrameMatch(
                frame_id=row.id,
                distance=float(row.distance),
                status=row.status,
                video_id=row.video_id,
            ))
        return matches

    async def store_frames(
        self,
        video_id: uuid.UUID,
        frames_data: list[dict],
    ) -> list[VideoFrame]:
        """Bulk-insert frame records for a video."""
        frame_objs: list[VideoFrame] = []
        for fd in frames_data:
            frame = VideoFrame(
                video_id=video_id,
                frame_timestamp=fd["timestamp"],
                embedding=fd["embedding"],
                status=fd["status"],
                confidence_score=fd.get("confidence_score"),
            )
            self.db.add(frame)
            frame_objs.append(frame)

        await self.db.commit()
        for f in frame_objs:
            await self.db.refresh(f)
        return frame_objs

    async def update_video_status(
        self, video_id: uuid.UUID, status: str, scanned_until: float | None = None
    ) -> None:
        values: dict = {"status": status}
        if scanned_until is not None:
            values["scanned_until"] = scanned_until

        await self.db.execute(
            update(Video).where(Video.id == video_id).values(**values)
        )
        await self.db.commit()
