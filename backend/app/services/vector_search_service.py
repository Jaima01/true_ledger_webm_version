"""Redis Stack vector similarity search for frame embeddings."""

import logging
import struct
from dataclasses import dataclass

import numpy as np
from redis.asyncio import Redis

logger = logging.getLogger(__name__)

INDEX_NAME = "idx:frame_embeddings"
KEY_PREFIX = "frame:"
EMBEDDING_DIM = 512


@dataclass
class FrameMatch:
    frame_id: str
    score: float
    status: str
    video_id: str


def _float_list_to_bytes(vec: list[float]) -> bytes:
    return struct.pack(f"{len(vec)}f", *vec)


class VectorSearchService:
    def __init__(self, redis_client: Redis):
        self.redis = redis_client

    async def search_similar_frames(
        self, embedding: list[float], threshold: float = 0.85, top_k: int = 10
    ) -> list[FrameMatch]:
        """Search Redis for frames with cosine similarity above threshold."""
        query_blob = _float_list_to_bytes(embedding)

        try:
            results = await self.redis.execute_command(
                "FT.SEARCH",
                INDEX_NAME,
                f"(*)=>[KNN {top_k} @embedding $query_vec AS score]",
                "PARAMS", "2", "query_vec", query_blob,
                "SORTBY", "score",
                "RETURN", "3", "score", "status", "video_id",
                "DIALECT", "2",
            )
        except Exception:
            logger.warning("Vector search failed (index may not exist yet)", exc_info=True)
            return []

        matches: list[FrameMatch] = []
        if not results or results[0] == 0:
            return matches

        count = results[0]
        idx = 1
        for _ in range(count):
            key = results[idx]
            fields = results[idx + 1]
            idx += 2

            field_dict: dict[str, str] = {}
            for i in range(0, len(fields), 2):
                field_dict[fields[i]] = fields[i + 1]

            # FT.SEARCH returns cosine *distance* (0 = identical); convert to similarity
            distance = float(field_dict.get("score", "1.0"))
            similarity = 1.0 - distance

            if similarity < threshold:
                continue

            frame_id = key.replace(KEY_PREFIX, "") if isinstance(key, str) else key.decode().replace(KEY_PREFIX, "")
            matches.append(FrameMatch(
                frame_id=frame_id,
                score=similarity,
                status=field_dict.get("status", ""),
                video_id=field_dict.get("video_id", ""),
            ))

        return matches

    async def store_frame_embedding(
        self, frame_id: str, embedding: list[float], status: str, video_id: str, ttl_seconds: int = 86400
    ) -> None:
        """Store a single frame embedding in Redis for future similarity lookups."""
        key = f"{KEY_PREFIX}{frame_id}"
        blob = _float_list_to_bytes(embedding)

        await self.redis.hset(key, mapping={
            "embedding": blob,
            "status": status,
            "video_id": video_id,
        })
        if ttl_seconds > 0:
            await self.redis.expire(key, ttl_seconds)
