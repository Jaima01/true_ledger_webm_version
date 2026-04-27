from __future__ import annotations

from pathlib import Path

from google import genai
from google.genai import types
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from .config import Settings
from .gemini_prompt import DEEPFAKE_PROMPT
from .parser import AnalysisResult, parse_gemini_response


class GeminiAnalysisError(Exception):
    pass


class GeminiResponseFormatError(Exception):
    pass


def _build_bounds_hint(total_frames: int | None) -> str:
    if total_frames is None:
        return ""
    return (
        f"\n\nFrame index bounds (critical):\n"
        f"- The sequence contains exactly {total_frames} frames.\n"
        f"- Valid frame indices are 1 to {total_frames} only.\n"
        f"- Never reference any frame outside this range."
    )


def _repair_response_with_gemini(
    client: genai.Client,
    *,
    model: str,
    invalid_response: str,
    total_frames: int | None,
) -> str:
    upper = str(total_frames) if total_frames is not None else "N"
    repair_prompt = (
        "Your previous output violated the required format or frame bounds. "
        "Rewrite it to comply exactly.\n\n"
        "Output must be exactly two lines:\n"
        "Line 1: Yes - Confidence: X% OR No - Confidence: X%\n"
        "Line 2: Frames: none OR Frames: <comma-separated ranges>\n"
        "Rules: use comma+space separators, sorted non-overlapping ranges, no extra text.\n"
        f"Frame bounds: valid indices are 1..{upper}.\n"
        "If verdict is No, line 2 must be Frames: none.\n\n"
        f"Previous invalid output:\n{invalid_response.strip()}"
    )
    repair_response = client.models.generate_content(
        model=model,
        contents=[repair_prompt],
        config=types.GenerateContentConfig(
            temperature=0.0,
            max_output_tokens=64,
        ),
    )
    return (repair_response.text or "").strip()


@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=1, max=8),
    retry=retry_if_exception_type((TimeoutError, ConnectionError, GeminiAnalysisError)),
    reraise=True,
)
def analyze_grids_with_gemini(
    grid_paths: list[Path],
    settings: Settings,
    *,
    total_frames: int | None = None,
) -> AnalysisResult:
    if not settings.gemini_api_key:
        raise GeminiAnalysisError("GEMINI_API_KEY is empty")
    if not grid_paths:
        raise GeminiAnalysisError("No grids to analyze")

    client = genai.Client(api_key=settings.gemini_api_key)

    parts: list[types.Part | str] = [DEEPFAKE_PROMPT + _build_bounds_hint(total_frames)]
    for grid_path in sorted(grid_paths):
        with grid_path.open("rb") as fd:
            parts.append(types.Part.from_bytes(data=fd.read(), mime_type="image/jpeg"))

    response = client.models.generate_content(
        model=settings.gemini_model,
        contents=parts,
        config=types.GenerateContentConfig(
            temperature=0.0,
            max_output_tokens=64,
        ),
    )

    text = (response.text or "").strip()
    if not text:
        raise GeminiAnalysisError("Gemini returned empty response")

    try:
        return parse_gemini_response(text, total_frames=total_frames)
    except ValueError:
        repaired_text = _repair_response_with_gemini(
            client,
            model=settings.gemini_model,
            invalid_response=text,
            total_frames=total_frames,
        )
        if not repaired_text:
            raise GeminiResponseFormatError("Gemini returned empty repaired response")

        try:
            return parse_gemini_response(repaired_text, total_frames=total_frames)
        except ValueError as exc:
            raise GeminiResponseFormatError(f"Unrecoverable Gemini response format error: {exc}") from exc
