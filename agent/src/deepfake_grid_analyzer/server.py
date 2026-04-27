from __future__ import annotations

import json
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import ClassVar

from .analyzer import BatchAnalyzer
from .contracts import ValidationError, parse_batch_request


class DeepfakeAgentHTTPServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, server_address: tuple[str, int], analyzer: BatchAnalyzer) -> None:
        self.analyzer = analyzer
        super().__init__(server_address, DeepfakeAgentRequestHandler)


class DeepfakeAgentRequestHandler(BaseHTTPRequestHandler):
    server: DeepfakeAgentHTTPServer
    protocol_version: ClassVar[str] = "HTTP/1.1"

    def do_GET(self) -> None:
        if self.path == "/healthz":
            self._send_json(HTTPStatus.OK, {"status": "ok"})
            return
        self._send_json(HTTPStatus.NOT_FOUND, {"status": "error", "error_code": "not_found"})

    def do_POST(self) -> None:
        if self.path != "/v1/analyze/batch":
            self._send_json(HTTPStatus.NOT_FOUND, {"status": "error", "error_code": "not_found"})
            return

        content_length = self.headers.get("Content-Length")
        if content_length is None:
            self._send_json(HTTPStatus.LENGTH_REQUIRED, {"status": "error", "error_code": "missing_content_length"})
            return

        try:
            raw_body = self.rfile.read(int(content_length))
        except ValueError:
            self._send_json(HTTPStatus.BAD_REQUEST, {"status": "error", "error_code": "invalid_content_length"})
            return

        try:
            payload = json.loads(raw_body.decode("utf-8"))
            request = parse_batch_request(payload)
            response = self.server.analyzer.analyze(request)
        except json.JSONDecodeError:
            self._send_json(HTTPStatus.BAD_REQUEST, {"status": "error", "error_code": "invalid_json"})
            return
        except ValidationError as exc:
            self._send_json(
                HTTPStatus.UNPROCESSABLE_ENTITY,
                {"status": "error", "error_code": "invalid_request", "message": str(exc)},
            )
            return
        except Exception as exc:  # pragma: no cover - defensive catch-all for server errors
            self._send_json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"status": "error", "error_code": "internal_error", "message": str(exc)},
            )
            return

        self._send_json(HTTPStatus.OK, response.to_dict())

    def log_message(self, format: str, *args) -> None:
        return

    def _send_json(self, status: HTTPStatus, payload: dict[str, object]) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def run_server(host: str, port: int, *, model_version: str = "gemini-v1") -> None:
    analyzer = BatchAnalyzer(model_version=model_version)
    with DeepfakeAgentHTTPServer((host, port), analyzer) as server:
        host_name, bound_port = server.server_address
        print(f"Deepfake agent listening on http://{host_name}:{bound_port}")
        server.serve_forever()
