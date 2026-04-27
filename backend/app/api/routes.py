"""API routes for frame submission and processing."""

import json
import logging
from typing import Optional

from fastapi import HTTPException
from fastapi import APIRouter, Depends, File, Form, UploadFile

from app.core.config import settings
from app.core.database import get_db
from app.core.redis_client import get_redis
from app.services.chunk_queue_service import ChunkQueueService
from app.services.chunk_storage_service import ChunkStorageService
from app.services.frame_pipeline import FramePipeline

logger = logging.getLogger(__name__)
terminal_logger = logging.getLogger("uvicorn.error")

router = APIRouter(prefix="/api")


@router.post("/frames")
async def submit_frames(
    platform: str = Form(...),
    platform_video_id: str = Form(...),
    frame_timestamps: str = Form(..., description="JSON array of float timestamps"),
    frames: list[UploadFile] = File(...),
    db=Depends(get_db),
    redis_client=Depends(get_redis),
):
    """Receive frame images from the extension for deepfake analysis.

    Accepts multipart/form-data with metadata fields and image blobs.
    """
    timestamps: list[float] = json.loads(frame_timestamps)

    image_bytes_list: list[bytes] = []
    for frame_file in frames:
        data = await frame_file.read()
        image_bytes_list.append(data)

    pipeline = FramePipeline(db=db, redis_client=redis_client)
    result = await pipeline.process_frames(
        platform=platform,
        platform_video_id=platform_video_id,
        image_bytes_list=image_bytes_list,
        timestamps=timestamps,
    )

    return result


# ──────────────────────────────────────────────────────────────────────────────
# /api/analyze-chunk
# Receives one independently-decodable WebM chunk per call from the extension.
# ──────────────────────────────────────────────────────────────────────────────

@router.post("/analyze-chunk")
async def analyze_chunk(
    chunk: UploadFile = File(..., description="WebM video chunk"),
    video_id: str = Form(...),
    chunk_index: int = Form(...),
    page_url: str = Form(...),
    captured_at: str = Form(...),
    channel_name: Optional[str] = Form(None),
    content_title: Optional[str] = Form(None),
    redis_client=Depends(get_redis),
):
    """Receive a WebM video chunk from the VERI-Real extension.

    The extension sends one independently-decodable 5-second WebM file per
    call, produced by the cyclic MediaRecorder pipeline in chunkedCapture.ts.

    For now this endpoint just reads the bytes and confirms receipt.
    """
    queue_service = ChunkQueueService(
        redis_client=redis_client,
        ttl_seconds=settings.chunk_queue_ttl_seconds,
        inactivity_timeout_seconds=settings.chunk_inactivity_timeout_seconds,
    )
    storage_service = ChunkStorageService(base_dir=settings.chunk_temp_dir)

    is_new_chunk = await queue_service.register_chunk(video_id=video_id, chunk_index=chunk_index)
    if not is_new_chunk:
        current_status = await queue_service.get_video_status(video_id=video_id)
        duplicate_line = (
            "CHUNK_DUPLICATE "
            f"video_id={video_id} "
            f"chunk_index={chunk_index}"
        )
        print(duplicate_line, flush=True)
        terminal_logger.info(duplicate_line)

        return {
            "status": "duplicate_ignored",
            "video_id": video_id,
            "chunk_index": chunk_index,
            "queue": current_status,
        }

    chunk_bytes = await chunk.read()
    size_bytes = len(chunk_bytes)
    size_kb = size_bytes / 1024

    try:
        chunk_path = await storage_service.store_chunk(
            video_id=video_id,
            chunk_index=chunk_index,
            chunk_bytes=chunk_bytes,
        )

        enqueue_state = await queue_service.enqueue_chunk(
            video_id=video_id,
            chunk_index=chunk_index,
            chunk_path=chunk_path,
            size_bytes=size_bytes,
            captured_at=captured_at,
            page_url=page_url,
        )
        queue_status = await queue_service.get_video_status(video_id=video_id)
    except Exception as exc:
        await queue_service.unregister_chunk(video_id=video_id, chunk_index=chunk_index)
        logger.exception(
            "Failed to persist/enqueue chunk | video_id=%s chunk_index=%s",
            video_id,
            chunk_index,
        )
        raise HTTPException(status_code=500, detail="Failed to store chunk") from exc

    terminal_line = (
        "CHUNK_RECEIVED "
        f"video_id={video_id} "
        f"chunk_index={chunk_index} "
        f"size_bytes={size_bytes} "
        f"size_kb={size_kb:.1f} "
        f"mime={chunk.content_type or 'unknown'}"
    )

    # ── Confirmation print ──────────────────────────────────────────────────
    print(
        f"\n{'='*60}\n"
        f"  ✅  VIDEO CHUNK RECEIVED\n"
        f"{'='*60}\n"
        f"  video_id    : {video_id}\n"
        f"  chunk_index : #{chunk_index}\n"
        f"  size        : {size_kb:.1f} KB  ({size_bytes} bytes)\n"
        f"  mime        : {chunk.content_type}\n"
        f"  captured_at : {captured_at}\n"
        f"  page_url    : {page_url}\n"
        f"  channel     : {channel_name or '(not provided)'}\n"
        f"  title       : {content_title or '(not provided)'}\n"
        f"  chunk_path  : {chunk_path}\n"
        f"  queue_len   : {enqueue_state['queue_length']}\n"
        f"  total_recv  : {enqueue_state['received_count']}\n"
        f"{'='*60}\n",
        flush=True,
    )
    print(terminal_line, flush=True)
    terminal_logger.info(terminal_line)

    logger.info(
        "Chunk received | video_id=%s chunk=#%s size_bytes=%d",
        video_id,
        chunk_index,
        size_bytes,
    )

    return {
        "status": "received",
        "video_id": video_id,
        "chunk_index": chunk_index,
        "size_bytes": size_bytes,
        "chunk_path": chunk_path,
        "queue": queue_status,
    }


@router.get("/health")
async def health():
    return {"status": "ok"}


@router.get("/chunk-queue/{video_id}")
async def get_chunk_queue_status(
    video_id: str,
    redis_client=Depends(get_redis),
):
    queue_service = ChunkQueueService(
        redis_client=redis_client,
        ttl_seconds=settings.chunk_queue_ttl_seconds,
        inactivity_timeout_seconds=settings.chunk_inactivity_timeout_seconds,
    )
    return await queue_service.get_video_status(video_id=video_id)
