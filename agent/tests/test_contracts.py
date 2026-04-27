from __future__ import annotations

import base64
from io import BytesIO

import pytest
from PIL import Image

from deepfake_grid_analyzer.contracts import BatchAnalysisResponse, ValidationError, parse_batch_request


def _encode_image(color: str) -> str:
    buffer = BytesIO()
    Image.new("RGB", (32, 32), color=color).save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def _make_request(*, frame_numbers: list[int] | None = None) -> dict[str, object]:
    numbers = frame_numbers or [1, 2]
    return {
        "request_id": "req_test_001",
        "uid": "uid_123",
        "video_total_seconds": 180,
        "batch_index": 1,
        "batch_start_frame": numbers[0],
        "batch_end_frame": numbers[-1],
        "is_final_batch": False,
        "frame_count": len(numbers),
        "frames": [
            {
                "frame_number": number,
                "timestamp_ms": (number - 1) * 1000,
                "content_type": "image/png",
                "image_base64": _encode_image("white"),
            }
            for number in numbers
        ],
    }


def test_parse_batch_request_accepts_valid_payload() -> None:
    request = parse_batch_request(_make_request())

    assert request.uid == "uid_123"
    assert request.frame_count == 2
    assert request.frames[0].frame_number == 1


def test_parse_batch_request_rejects_non_contiguous_frame_numbers() -> None:
    payload = _make_request(frame_numbers=[1, 3])

    with pytest.raises(ValidationError, match="continuous global frame numbers"):
        parse_batch_request(payload)


def test_response_serializes_to_compact_json() -> None:
    response = BatchAnalysisResponse(
        request_id="req_test_001",
        uid="uid_123",
        batch_index=1,
        batch_verdict="authentic",
        confidence=92,
        suspicious_frame_numbers=tuple(),
    )

    assert response.to_json() == (
        '{"request_id":"req_test_001","uid":"uid_123","batch_index":1,'
        '"batch_verdict":"authentic","confidence":92,"suspicious_frame_numbers":[],"status":"ok"}'
    )
