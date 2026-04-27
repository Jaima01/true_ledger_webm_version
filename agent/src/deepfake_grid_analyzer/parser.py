from __future__ import annotations

import re
from dataclasses import dataclass

VERDICT_PATTERN = re.compile(r"^(Yes|No) - Confidence: (100|[0-9]{1,2})%$")
FRAMES_PATTERN = re.compile(r"^Frames: (none|[0-9]+(?:-[0-9]+)?(?:, [0-9]+(?:-[0-9]+)?)*)$")


@dataclass(frozen=True, slots=True)
class AnalysisResult:
    is_deepfake: bool
    confidence: int
    frame_indices: tuple[int, ...]
    frames_text: str
    raw: str


def _collapse_frame_indices(indices: list[int]) -> str:
    if not indices:
        return "none"

    chunks: list[str] = []
    start = indices[0]
    end = start

    for value in indices[1:]:
        if value == end + 1:
            end = value
            continue
        chunks.append(str(start) if start == end else f"{start}-{end}")
        start = value
        end = value

    chunks.append(str(start) if start == end else f"{start}-{end}")
    return ", ".join(chunks)


def _expand_frame_token(token: str) -> list[int]:
    if "-" not in token:
        value = int(token)
        if value <= 0:
            raise ValueError("Frame indices must be positive integers")
        return [value]

    start_str, end_str = token.split("-", maxsplit=1)
    start = int(start_str)
    end = int(end_str)
    if start <= 0 or end <= 0:
        raise ValueError("Frame indices must be positive integers")
    if start >= end:
        raise ValueError("Frame ranges must use ascending bounds like A-B where A < B")
    return list(range(start, end + 1))


def parse_frames_line(frames_line: str, total_frames: int | None = None) -> tuple[tuple[int, ...], str]:
    match = FRAMES_PATTERN.match(frames_line)
    if not match:
        raise ValueError(
            "Invalid frames line. Expected 'Frames: none' or 'Frames: <ranges>' with comma+space separators."
        )

    payload = match.group(1)
    if payload == "none":
        return tuple(), "none"

    raw_tokens = payload.split(", ")
    expanded: list[int] = []
    for token in raw_tokens:
        expanded.extend(_expand_frame_token(token))

    unique_sorted = sorted(set(expanded))
    if len(unique_sorted) != len(expanded):
        raise ValueError("Frame list contains duplicate or overlapping indices")

    if total_frames is not None:
        if total_frames <= 0:
            raise ValueError("total_frames must be positive when provided")
        if unique_sorted and (unique_sorted[0] < 1 or unique_sorted[-1] > total_frames):
            raise ValueError(f"Frame index out of bounds. Valid range is 1-{total_frames}")

    canonical = _collapse_frame_indices(unique_sorted)
    return tuple(unique_sorted), canonical


def parse_gemini_response(text: str, total_frames: int | None = None) -> AnalysisResult:
    stripped = text.strip()
    lines = stripped.splitlines()
    if len(lines) != 2:
        raise ValueError("Gemini response must be exactly two lines")

    verdict_line = lines[0].strip()
    frames_line = lines[1].strip()

    verdict_match = VERDICT_PATTERN.match(verdict_line)
    if not verdict_match:
        raise ValueError(
            "Invalid Gemini response first line. Expected 'Yes - Confidence: X%' or 'No - Confidence: X%'."
        )

    verdict = verdict_match.group(1)
    confidence = int(verdict_match.group(2))
    frame_indices, canonical_frames = parse_frames_line(frames_line, total_frames=total_frames)

    if verdict == "No" and canonical_frames != "none":
        raise ValueError("Invalid Gemini response: 'No' verdict must use 'Frames: none'")

    canonical_raw = f"{verdict_line}\nFrames: {canonical_frames}"
    return AnalysisResult(
        is_deepfake=(verdict == "Yes"),
        confidence=confidence,
        frame_indices=frame_indices,
        frames_text=canonical_frames,
        raw=canonical_raw,
    )
