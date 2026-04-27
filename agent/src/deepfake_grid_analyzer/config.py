from __future__ import annotations

import os
from dataclasses import dataclass

from dotenv import load_dotenv


load_dotenv()


@dataclass(frozen=True, slots=True)
class Settings:
    gemini_api_key: str
    gemini_model: str
    request_timeout_seconds: int


def get_settings() -> Settings:
    timeout_value = os.getenv("REQUEST_TIMEOUT_SECONDS", "90")
    try:
        request_timeout_seconds = int(timeout_value)
    except ValueError as exc:
        raise ValueError("REQUEST_TIMEOUT_SECONDS must be an integer") from exc

    return Settings(
        gemini_api_key=os.getenv("GEMINI_API_KEY", "").strip(),
        gemini_model=os.getenv("GEMINI_MODEL", "gemini-2.0-flash").strip(),
        request_timeout_seconds=request_timeout_seconds,
    )
