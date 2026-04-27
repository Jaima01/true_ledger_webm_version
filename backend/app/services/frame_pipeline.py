"""Frame processing pipeline: embed -> redis search -> db search -> agent -> store."""

import logging
from collections import Counter

from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.services.agent_client import analyze_batch
from app.services.database_service import DatabaseService
from app.services.embedding_service import generate_embeddings
from app.services.vector_search_service import VectorSearchService

logger = logging.getLogger(__name__)

DEEPFAKE_THRESHOLD = settings.deepfake_frame_threshold
SIMILARITY_THRESHOLD = settings.vector_similarity_threshold


class FramePipeline:
    def __init__(self, db: AsyncSession, redis_client: Redis):
        self.db_service = DatabaseService(db)
        self.vector_service = VectorSearchService(redis_client)

    async def process_frames(
        self,
        platform: str,
        platform_video_id: str,
        image_bytes_list: list[bytes],
        timestamps: list[float],
    ) -> dict:
        video = await self.db_service.get_video(platform, platform_video_id)
        if not video:
            return {"status": "error", "message": "Video not registered. Send metadata first."}

        if video.status in ("deepfake", "authentic"):
            return {
                "status": video.status,
                "platform_video_id": platform_video_id,
                "message": f"Video already classified as {video.status}",
            }

        # Step 1: generate CLIP embeddings for all incoming frames
        embeddings = await generate_embeddings(image_bytes_list)

        # Step 2: check Redis vector cache for similar frames
        redis_result = await self._check_vector_cache(embeddings)
        if redis_result:
            return await self._handle_cache_hit(video, redis_result, timestamps)

        # Step 3: check Postgres via pgvector
        db_result = await self._check_database(embeddings)
        if db_result:
            return await self._handle_cache_hit(video, db_result, timestamps)

        # Step 4: no matches found – send to agent for Gemini analysis
        return await self._run_agent_analysis(
            video, image_bytes_list, embeddings, timestamps
        )

    # ------------------------------------------------------------------
    # Cache / DB lookup helpers
    # ------------------------------------------------------------------

    async def _check_vector_cache(
        self, embeddings: list[list[float]]
    ) -> dict | None:
        """Search Redis Stack for similar frames. Return aggregated status if enough matches."""
        status_counts: Counter[str] = Counter()
        for emb in embeddings:
            matches = await self.vector_service.search_similar_frames(
                emb, threshold=SIMILARITY_THRESHOLD
            )
            for m in matches:
                status_counts[m.status] += 1

        if status_counts.get("deepfake", 0) >= DEEPFAKE_THRESHOLD:
            return {"verdict": "deepfake", "source": "redis_cache"}
        if sum(status_counts.values()) > 0:
            return {"verdict": "authentic", "source": "redis_cache", "counts": dict(status_counts)}
        return None

    async def _check_database(
        self, embeddings: list[list[float]]
    ) -> dict | None:
        """Search Postgres pgvector for similar frames."""
        status_counts: Counter[str] = Counter()
        for emb in embeddings:
            matches = await self.db_service.search_similar_frames(
                emb, threshold=SIMILARITY_THRESHOLD
            )
            for m in matches:
                status_counts[m.status] += 1

        if status_counts.get("deepfake", 0) >= DEEPFAKE_THRESHOLD:
            return {"verdict": "deepfake", "source": "database"}
        if sum(status_counts.values()) > 0:
            return {"verdict": "authentic", "source": "database", "counts": dict(status_counts)}
        return None

    async def _handle_cache_hit(self, video, result: dict, timestamps: list[float]) -> dict:
        verdict = result["verdict"]
        scanned = max(timestamps) if timestamps else 0.0

        if verdict == "deepfake":
            await self.db_service.update_video_status(video.id, "deepfake", scanned)
            return {
                "status": "deepfake",
                "platform_video_id": video.platform_video_id,
                "source": result["source"],
                "message": "Deepfake detected from cached frame analysis",
            }

        # Authentic cache hit – update scan progress, wait for more frames
        await self.db_service.update_video_status(video.id, "processing", scanned)
        return {
            "status": "processing",
            "platform_video_id": video.platform_video_id,
            "source": result["source"],
            "message": "Similar authentic frames found; continue sending frames",
        }

    # ------------------------------------------------------------------
    # Agent / Gemini analysis
    # ------------------------------------------------------------------

    async def _run_agent_analysis(
        self, video, image_bytes_list, embeddings, timestamps
    ) -> dict:
        try:
            verdict = await analyze_batch(
                video_id=str(video.id),
                image_bytes_list=image_bytes_list,
                timestamps=timestamps,
                video_total_seconds=int(video.total_duration or 0),
            )
        except Exception:
            logger.exception("Agent analysis failed for video %s", video.id)
            return {
                "status": "processing",
                "platform_video_id": video.platform_video_id,
                "message": "Agent analysis unavailable; continue sending frames",
            }

        frame_status = verdict.batch_verdict
        scanned = max(timestamps) if timestamps else 0.0

        # Store frames in DB
        frames_data = [
            {
                "timestamp": ts,
                "embedding": emb,
                "status": frame_status,
                "confidence_score": verdict.confidence / 100.0 if verdict.confidence else None,
            }
            for ts, emb in zip(timestamps, embeddings)
        ]
        stored_frames = await self.db_service.store_frames(video.id, frames_data)

        # Cache embeddings in Redis for future lookups
        for frame_obj, emb in zip(stored_frames, embeddings):
            await self.vector_service.store_frame_embedding(
                frame_id=str(frame_obj.id),
                embedding=emb,
                status=frame_status,
                video_id=str(video.id),
            )

        if frame_status == "deepfake":
            await self.db_service.update_video_status(video.id, "deepfake", scanned)
            return {
                "status": "deepfake",
                "platform_video_id": video.platform_video_id,
                "source": "agent",
                "message": "Deepfake detected by AI analysis",
                "confidence": verdict.confidence,
            }

        # Authentic – update scanned progress, keep processing
        new_status = "processing"
        if video.total_duration and scanned >= video.total_duration:
            new_status = "authentic"

        await self.db_service.update_video_status(video.id, new_status, scanned)

        return {
            "status": new_status,
            "platform_video_id": video.platform_video_id,
            "source": "agent",
            "message": "Frames analysed as authentic" + (
                "; video fully scanned" if new_status == "authentic" else "; continue sending frames"
            ),
            "confidence": verdict.confidence,
        }
