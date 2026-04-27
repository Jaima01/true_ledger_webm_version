"""HTTP client for the deepfake-agent batch analysis service."""

import base64
import logging
import uuid
from dataclasses import dataclass

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)


@dataclass
class AgentVerdict:
    batch_verdict: str          # "deepfake" or "authentic"
    confidence: int             # 0-100
    suspicious_frame_indices: list[int]


async def analyze_batch(
    video_id: str,
    image_bytes_list: list[bytes],
    timestamps: list[float],
    batch_index: int = 1,
    video_total_seconds: int = 0,
) -> AgentVerdict:
    """Send a batch of frames to the agent service for Gemini analysis."""
    frames_payload = []
    for i, (img_bytes, ts) in enumerate(zip(image_bytes_list, timestamps), start=1):
        frames_payload.append({
            "frame_number": i,
            "timestamp_ms": int(ts * 1000),
            "content_type": "image/jpeg",
            "image_base64": base64.b64encode(img_bytes).decode("ascii"),
        })

    request_body = {
        "request_id": str(uuid.uuid4()),
        "uid": video_id,
        "video_total_seconds": max(int(video_total_seconds), 1),
        "batch_index": batch_index,
        "batch_start_frame": 1,
        "batch_end_frame": len(frames_payload),
        "is_final_batch": False,
        "frame_count": len(frames_payload),
        "frames": frames_payload,
    }

    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.post(
            f"{settings.agent_base_url}/v1/analyze/batch",
            json=request_body,
        )
        response.raise_for_status()
        data = response.json()

    return AgentVerdict(
        batch_verdict=data.get("batch_verdict", "authentic"),
        confidence=data.get("confidence", 0),
        suspicious_frame_indices=data.get("suspicious_frame_numbers", []),
    )
