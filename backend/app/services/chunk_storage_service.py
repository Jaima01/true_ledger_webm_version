"""Temporary filesystem storage for received video chunks."""

import asyncio
import re
from pathlib import Path


class ChunkStorageService:
    def __init__(self, base_dir: str):
        self.base_dir = Path(base_dir)
        self.fallback_base_dir = Path("/tmp/true-ledger-local/chunks")

    @staticmethod
    def _safe_video_id(video_id: str) -> str:
        # Keep paths safe and deterministic for per-video chunk storage.
        return re.sub(r"[^a-zA-Z0-9_.-]", "_", video_id)

    def _video_dir(self, video_id: str) -> Path:
        return self.base_dir / self._safe_video_id(video_id)

    async def store_chunk(self, video_id: str, chunk_index: int, chunk_bytes: bytes) -> str:
        chunk_path = await self._store_under_base(
            base_dir=self.base_dir,
            video_id=video_id,
            chunk_index=chunk_index,
            chunk_bytes=chunk_bytes,
        )
        if chunk_path is not None:
            return chunk_path

        fallback_path = await self._store_under_base(
            base_dir=self.fallback_base_dir,
            video_id=video_id,
            chunk_index=chunk_index,
            chunk_bytes=chunk_bytes,
        )
        if fallback_path is None:
            raise PermissionError("Unable to write chunk in configured and fallback temp dirs")
        return fallback_path

    async def _store_under_base(
        self,
        *,
        base_dir: Path,
        video_id: str,
        chunk_index: int,
        chunk_bytes: bytes,
    ) -> str | None:
        video_dir = base_dir / self._safe_video_id(video_id)
        try:
            await asyncio.to_thread(video_dir.mkdir, parents=True, exist_ok=True)
            chunk_path = video_dir / f"chunk-{chunk_index:06d}.webm"
            await asyncio.to_thread(chunk_path.write_bytes, chunk_bytes)
            return str(chunk_path)
        except PermissionError:
            return None
