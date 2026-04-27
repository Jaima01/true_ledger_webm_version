from __future__ import annotations

import base64
import shutil
from contextlib import contextmanager
from io import BytesIO
from pathlib import Path

from PIL import Image

from deepfake_grid_analyzer.analyzer import BatchAnalyzer
from deepfake_grid_analyzer.config import Settings
from deepfake_grid_analyzer.contracts import parse_batch_request


def _encode_image(color: str) -> str:
    buffer = BytesIO()
    Image.new("RGB", (32, 32), color=color).save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def _make_payload(colors: list[str]) -> dict[str, object]:
    return {
        "request_id": "req_test_002",
        "uid": "uid_456",
        "video_total_seconds": 60,
        "batch_index": 2,
        "batch_start_frame": 1,
        "batch_end_frame": len(colors),
        "is_final_batch": True,
        "frame_count": len(colors),
        "frames": [
            {
                "frame_number": index + 1,
                "timestamp_ms": index * 1000,
                "content_type": "image/png",
                "image_base64": _encode_image(color),
            }
            for index, color in enumerate(colors)
        ],
    }


class _FakeResponse:
    def __init__(self, text: str) -> None:
        self.text = text


class _FakeModels:
    def generate_content(self, **kwargs):
        return _FakeResponse("No - Confidence: 12%\nFrames: none")


class _FakeClient:
    def __init__(self) -> None:
        self.models = _FakeModels()


def test_analyzer_returns_authentic_and_cleans_workspace(tmp_path: Path, monkeypatch) -> None:
    workspace = tmp_path / "workspace"

    @contextmanager
    def workspace_factory():
        workspace.mkdir(parents=True, exist_ok=False)
        try:
            yield workspace
        finally:
            shutil.rmtree(workspace, ignore_errors=True)

    monkeypatch.setattr("deepfake_grid_analyzer.gemini_client.genai.Client", lambda api_key: _FakeClient())

    analyzer = BatchAnalyzer(
        settings=Settings(gemini_api_key="test-key", gemini_model="gemini-2.0-flash", request_timeout_seconds=90),
        workspace_factory=workspace_factory,
    )
    request = parse_batch_request(_make_payload(["white", "white", "white"]))

    response = analyzer.analyze(request)

    assert response.batch_verdict == "authentic"
    assert response.suspicious_frame_numbers == tuple()
    assert not workspace.exists()


def test_analyzer_optionally_saves_grids(tmp_path: Path, monkeypatch) -> None:
    workspace = tmp_path / "workspace"
    save_grid_dir = tmp_path / "saved_grids"

    @contextmanager
    def workspace_factory():
        workspace.mkdir(parents=True, exist_ok=False)
        try:
            yield workspace
        finally:
            shutil.rmtree(workspace, ignore_errors=True)

    monkeypatch.setattr("deepfake_grid_analyzer.gemini_client.genai.Client", lambda api_key: _FakeClient())

    analyzer = BatchAnalyzer(
        settings=Settings(gemini_api_key="test-key", gemini_model="gemini-2.0-flash", request_timeout_seconds=90),
        workspace_factory=workspace_factory,
        save_grid_dir=save_grid_dir,
    )
    request = parse_batch_request(_make_payload(["white", "white", "white"]))

    response = analyzer.analyze(request)

    assert response.batch_verdict == "authentic"
    assert (save_grid_dir / "grid_001.jpg").exists()
    assert (save_grid_dir / "grid_manifest.json").exists()
