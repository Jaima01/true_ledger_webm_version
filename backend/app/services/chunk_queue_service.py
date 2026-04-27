"""Redis-backed queue and tracking for video chunks."""

import json
import time

from redis.asyncio import Redis


class ChunkQueueService:
    QUEUE_PREFIX = "chunks:queue"
    RECEIVED_PREFIX = "chunks:received"
    STATE_PREFIX = "chunks:state"

    def __init__(
        self,
        redis_client: Redis,
        ttl_seconds: int,
        inactivity_timeout_seconds: int,
    ):
        self.redis = redis_client
        self.ttl_seconds = ttl_seconds
        self.inactivity_timeout_seconds = inactivity_timeout_seconds

    def _queue_key(self, video_id: str) -> str:
        return f"{self.QUEUE_PREFIX}:{video_id}"

    def _received_key(self, video_id: str) -> str:
        return f"{self.RECEIVED_PREFIX}:{video_id}"

    def _state_key(self, video_id: str) -> str:
        return f"{self.STATE_PREFIX}:{video_id}"

    async def register_chunk(self, video_id: str, chunk_index: int) -> bool:
        """Return True when chunk index is first-seen, False when duplicate."""
        added = await self.redis.sadd(self._received_key(video_id), str(chunk_index))
        return bool(added)

    async def unregister_chunk(self, video_id: str, chunk_index: int) -> None:
        await self.redis.srem(self._received_key(video_id), str(chunk_index))

    async def enqueue_chunk(
        self,
        *,
        video_id: str,
        chunk_index: int,
        chunk_path: str,
        size_bytes: int,
        captured_at: str,
        page_url: str,
    ) -> dict:
        now = time.time()
        queue_key = self._queue_key(video_id)
        state_key = self._state_key(video_id)
        received_key = self._received_key(video_id)

        item = {
            "video_id": video_id,
            "chunk_index": chunk_index,
            "chunk_path": chunk_path,
            "size_bytes": size_bytes,
            "captured_at": captured_at,
            "page_url": page_url,
            "received_at": now,
        }

        pipe = self.redis.pipeline()
        pipe.rpush(queue_key, json.dumps(item))
        pipe.hset(
            state_key,
            mapping={
                "video_id": video_id,
                "last_chunk_index": str(chunk_index),
                "last_chunk_at": str(now),
            },
        )
        pipe.hincrby(state_key, "received_count", 1)
        pipe.expire(queue_key, self.ttl_seconds)
        pipe.expire(state_key, self.ttl_seconds)
        pipe.expire(received_key, self.ttl_seconds)
        pipe.llen(queue_key)
        results = await pipe.execute()

        queue_length = int(results[-1])
        received_count_raw = await self.redis.hget(state_key, "received_count")
        received_count = int(received_count_raw) if received_count_raw else 0

        return {
            "queue_length": queue_length,
            "received_count": received_count,
            "last_chunk_at": now,
        }

    async def get_video_status(self, video_id: str) -> dict:
        state_key = self._state_key(video_id)
        queue_key = self._queue_key(video_id)

        state = await self.redis.hgetall(state_key)
        queue_length = await self.redis.llen(queue_key)

        if not state:
            return {
                "video_id": video_id,
                "queue_length": int(queue_length),
                "received_count": 0,
                "is_ready_for_analysis": False,
                "seconds_since_last_chunk": None,
            }

        last_chunk_at_raw = state.get(b"last_chunk_at") or state.get("last_chunk_at")
        last_chunk_at = float(last_chunk_at_raw) if last_chunk_at_raw else 0.0
        received_count_raw = state.get(b"received_count") or state.get("received_count")
        received_count = int(received_count_raw) if received_count_raw else 0
        last_chunk_index_raw = state.get(b"last_chunk_index") or state.get("last_chunk_index")
        last_chunk_index = int(last_chunk_index_raw) if last_chunk_index_raw else None

        seconds_since_last_chunk = max(0.0, time.time() - last_chunk_at)
        is_ready_for_analysis = seconds_since_last_chunk >= self.inactivity_timeout_seconds

        return {
            "video_id": video_id,
            "queue_length": int(queue_length),
            "received_count": received_count,
            "last_chunk_index": last_chunk_index,
            "seconds_since_last_chunk": round(seconds_since_last_chunk, 3),
            "is_ready_for_analysis": is_ready_for_analysis,
            "inactivity_timeout_seconds": self.inactivity_timeout_seconds,
        }
