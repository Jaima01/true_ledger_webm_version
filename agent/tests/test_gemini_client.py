from __future__ import annotations

from pathlib import Path

from PIL import Image

from deepfake_grid_analyzer.config import Settings
from deepfake_grid_analyzer.gemini_client import analyze_grids_with_gemini


def _make_grid(path: Path) -> None:
    Image.new("RGB", (64, 64), color=(255, 255, 255)).save(path, format="JPEG")


class _FakeResponse:
    def __init__(self, text: str) -> None:
        self.text = text


class _FakeModels:
    def __init__(self, responses: list[str]) -> None:
        self._responses = responses
        self.calls = 0

    def generate_content(self, **kwargs):
        response = _FakeResponse(self._responses[self.calls])
        self.calls += 1
        return response


class _FakeClient:
    def __init__(self, responses: list[str]) -> None:
        self.models = _FakeModels(responses)


def test_analyze_grids_with_gemini_repairs_invalid_response(monkeypatch, tmp_path: Path) -> None:
    grid_path = tmp_path / "grid_001.jpg"
    _make_grid(grid_path)

    fake_client = _FakeClient(["not valid", "Yes - Confidence: 91%\nFrames: 1"])
    monkeypatch.setattr("deepfake_grid_analyzer.gemini_client.genai.Client", lambda api_key: fake_client)

    result = analyze_grids_with_gemini(
        [grid_path],
        Settings(gemini_api_key="test-key", gemini_model="gemini-2.0-flash", request_timeout_seconds=90),
        total_frames=1,
    )

    assert result.is_deepfake is True
    assert result.confidence == 91
    assert result.frame_indices == (1,)
