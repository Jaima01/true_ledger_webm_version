from __future__ import annotations

import base64
import http.client
import json
import threading
from io import BytesIO

from PIL import Image

from deepfake_grid_analyzer.analyzer import BatchAnalyzer
from deepfake_grid_analyzer.config import Settings
from deepfake_grid_analyzer.server import DeepfakeAgentHTTPServer


def _encode_image(color: str) -> str:
    buffer = BytesIO()
    Image.new("RGB", (32, 32), color=color).save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def _payload() -> dict[str, object]:
    return {
        "request_id": "req_test_003",
        "uid": "uid_789",
        "video_total_seconds": 30,
        "batch_index": 1,
        "batch_start_frame": 1,
        "batch_end_frame": 2,
        "is_final_batch": True,
        "frame_count": 2,
        "frames": [
            {
                "frame_number": 1,
                "timestamp_ms": 0,
                "content_type": "image/png",
                "image_base64": _encode_image("white"),
            },
            {
                "frame_number": 2,
                "timestamp_ms": 1000,
                "content_type": "image/png",
                "image_base64": _encode_image("white"),
            },
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


def test_http_server_returns_json_response(monkeypatch) -> None:
    monkeypatch.setattr("deepfake_grid_analyzer.gemini_client.genai.Client", lambda api_key: _FakeClient())

    server = DeepfakeAgentHTTPServer(
        ("127.0.0.1", 0),
        BatchAnalyzer(settings=Settings(gemini_api_key="test-key", gemini_model="gemini-2.0-flash", request_timeout_seconds=90)),
    )
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    try:
        host, port = server.server_address
        connection = http.client.HTTPConnection(host, port, timeout=5)
        connection.request(
            "POST",
            "/v1/analyze/batch",
            body=json.dumps(_payload()),
            headers={"Content-Type": "application/json", "Accept": "application/json"},
        )
        response = connection.getresponse()
        body = json.loads(response.read().decode("utf-8"))

        assert response.status == 200
        assert body["status"] == "ok"
        assert body["request_id"] == "req_test_003"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
