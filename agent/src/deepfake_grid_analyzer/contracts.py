from __future__ import annotations

import base64
import json
from dataclasses import dataclass
from typing import Any, Mapping


class ValidationError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class FramePayload:
    frame_number: int
    timestamp_ms: int
    content_type: str
    image_base64: str


@dataclass(frozen=True, slots=True)
class VectorMatchInfo:
    enabled: bool
    match_found: bool
    matched_verdict: str | None
    matched_uid: str | None


@dataclass(frozen=True, slots=True)
class BatchAnalysisRequest:
    request_id: str
    uid: str
    video_total_seconds: int
    batch_index: int
    batch_start_frame: int
    batch_end_frame: int
    is_final_batch: bool
    frame_count: int
    frames: tuple[FramePayload, ...]
    vector_match: VectorMatchInfo | None = None


@dataclass(frozen=True, slots=True)
class BatchAnalysisResponse:
    request_id: str
    uid: str
    batch_index: int
    batch_verdict: str
    confidence: int
    suspicious_frame_numbers: tuple[int, ...]
    status: str = "ok"
    model_version: str | None = None
    notes: str | None = None

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "request_id": self.request_id,
            "uid": self.uid,
            "batch_index": self.batch_index,
            "batch_verdict": self.batch_verdict,
            "confidence": self.confidence,
            "suspicious_frame_numbers": list(self.suspicious_frame_numbers),
            "status": self.status,
        }
        if self.model_version is not None:
            payload["model_version"] = self.model_version
        if self.notes is not None:
            payload["notes"] = self.notes
        return payload

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), ensure_ascii=False, separators=(",", ":"))


def _require_mapping(data: Any, field: str) -> Mapping[str, Any]:
    if not isinstance(data, Mapping):
        raise ValidationError(f"{field} must be an object")
    return data


def _require_str(data: Mapping[str, Any], field: str) -> str:
    value = data.get(field)
    if not isinstance(value, str) or not value.strip():
        raise ValidationError(f"{field} must be a non-empty string")
    return value.strip()


def _require_int(data: Mapping[str, Any], field: str, *, min_value: int | None = None) -> int:
    value = data.get(field)
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValidationError(f"{field} must be an integer")
    if min_value is not None and value < min_value:
        raise ValidationError(f"{field} must be >= {min_value}")
    return value


def _require_bool(data: Mapping[str, Any], field: str) -> bool:
    value = data.get(field)
    if not isinstance(value, bool):
        raise ValidationError(f"{field} must be a boolean")
    return value


def _decode_base64_image(value: str) -> bytes:
    try:
        return base64.b64decode(value.encode("ascii"), validate=True)
    except Exception as exc:  # pragma: no cover - base64 decoder error text varies
        raise ValidationError("image_base64 must be valid base64") from exc


def parse_batch_request(payload: Any) -> BatchAnalysisRequest:
    data = _require_mapping(payload, "request payload")

    request_id = _require_str(data, "request_id")
    uid = _require_str(data, "uid")
    video_total_seconds = _require_int(data, "video_total_seconds", min_value=1)
    batch_index = _require_int(data, "batch_index", min_value=1)
    batch_start_frame = _require_int(data, "batch_start_frame", min_value=1)
    batch_end_frame = _require_int(data, "batch_end_frame", min_value=batch_start_frame)
    is_final_batch = _require_bool(data, "is_final_batch")
    frame_count = _require_int(data, "frame_count", min_value=1)

    raw_frames = data.get("frames")
    if not isinstance(raw_frames, list) or not raw_frames:
        raise ValidationError("frames must be a non-empty array")

    frames: list[FramePayload] = []
    expected_frame_number = batch_start_frame
    for index, raw_frame in enumerate(raw_frames):
        frame_data = _require_mapping(raw_frame, f"frames[{index}]")
        frame_number = _require_int(frame_data, "frame_number", min_value=1)
        timestamp_ms = _require_int(frame_data, "timestamp_ms", min_value=0)
        content_type = _require_str(frame_data, "content_type")
        image_base64 = _require_str(frame_data, "image_base64")
        _decode_base64_image(image_base64)

        if frame_number != expected_frame_number:
            raise ValidationError("frames must use continuous global frame numbers")

        frames.append(
            FramePayload(
                frame_number=frame_number,
                timestamp_ms=timestamp_ms,
                content_type=content_type,
                image_base64=image_base64,
            )
        )
        expected_frame_number += 1

    if len(frames) != frame_count:
        raise ValidationError("frame_count must match the number of frames")
    if frames[0].frame_number != batch_start_frame:
        raise ValidationError("batch_start_frame must match the first frame number")
    if frames[-1].frame_number != batch_end_frame:
        raise ValidationError("batch_end_frame must match the last frame number")

    vector_match_value = data.get("vector_match")
    vector_match: VectorMatchInfo | None = None
    if vector_match_value is not None:
        vector_match_data = _require_mapping(vector_match_value, "vector_match")
        enabled = _require_bool(vector_match_data, "enabled")
        match_found = _require_bool(vector_match_data, "match_found")
        matched_verdict = vector_match_data.get("matched_verdict")
        if matched_verdict is not None and matched_verdict not in {"deepfake", "authentic"}:
            raise ValidationError("matched_verdict must be deepfake, authentic, or null")
        matched_uid = vector_match_data.get("matched_uid")
        if matched_uid is not None and (not isinstance(matched_uid, str) or not matched_uid.strip()):
            raise ValidationError("matched_uid must be a non-empty string or null")
        vector_match = VectorMatchInfo(
            enabled=enabled,
            match_found=match_found,
            matched_verdict=matched_verdict,
            matched_uid=matched_uid.strip() if isinstance(matched_uid, str) else None,
        )

    return BatchAnalysisRequest(
        request_id=request_id,
        uid=uid,
        video_total_seconds=video_total_seconds,
        batch_index=batch_index,
        batch_start_frame=batch_start_frame,
        batch_end_frame=batch_end_frame,
        is_final_batch=is_final_batch,
        frame_count=frame_count,
        frames=tuple(frames),
        vector_match=vector_match,
    )
