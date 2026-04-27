from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import sys
import uuid
from pathlib import Path

from .analyzer import BatchAnalyzer
from .contracts import BatchAnalysisRequest, FramePayload, ValidationError, parse_batch_request
from .server import run_server


SUPPORTED_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}


def _read_request_payload(path: Path | None) -> dict[str, object]:
    if path is None:
        raw_text = sys.stdin.read()
    else:
        raw_text = path.read_text(encoding="utf-8")
    return json.loads(raw_text)


def _read_image_as_frame(path: Path, frame_number: int) -> FramePayload:
    image_bytes = path.read_bytes()
    encoded = base64.b64encode(image_bytes).decode("ascii")
    guessed_content_type, _ = mimetypes.guess_type(path.name)
    content_type = guessed_content_type or "image/jpeg"
    return FramePayload(
        frame_number=frame_number,
        timestamp_ms=(frame_number - 1) * 1000,
        content_type=content_type,
        image_base64=encoded,
    )


def _resolve_input_images(raw_paths: list[Path]) -> list[Path]:
    resolved: list[Path] = []
    seen: set[Path] = set()

    def append_unique(candidate: Path) -> None:
        absolute = candidate.resolve()
        if absolute in seen:
            return
        seen.add(absolute)
        resolved.append(candidate)

    for raw_path in raw_paths:
        path = raw_path.expanduser()
        if not path.exists():
            raise ValidationError(f"Input path does not exist: {path}")

        if path.is_dir():
            for candidate in sorted(path.iterdir()):
                if candidate.is_file() and candidate.suffix.lower() in SUPPORTED_IMAGE_EXTENSIONS:
                    append_unique(candidate)
            continue

        if path.is_file() and path.suffix.lower() in SUPPORTED_IMAGE_EXTENSIONS:
            append_unique(path)
            continue

        raise ValidationError(
            f"Unsupported image input: {path}. Supported extensions: {', '.join(sorted(SUPPORTED_IMAGE_EXTENSIONS))}"
        )

    if not resolved:
        raise ValidationError("No images found in the provided input paths")
    return resolved


def _build_manual_request(raw_paths: list[Path], uid: str, request_id: str | None) -> BatchAnalysisRequest:
    image_paths = _resolve_input_images(raw_paths)
    frames = tuple(_read_image_as_frame(path, index + 1) for index, path in enumerate(image_paths))
    generated_request_id = request_id or f"req_manual_{uuid.uuid4().hex[:12]}"
    frame_count = len(frames)
    return BatchAnalysisRequest(
        request_id=generated_request_id,
        uid=uid,
        video_total_seconds=max(1, frame_count),
        batch_index=1,
        batch_start_frame=1,
        batch_end_frame=frame_count,
        is_final_batch=True,
        frame_count=frame_count,
        frames=frames,
        vector_match=None,
    )


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="deepfake-agent", description="Run the deepfake batch agent service")
    subparsers = parser.add_subparsers(dest="command")

    serve_parser = subparsers.add_parser("serve", help="Start the HTTP agent service")
    serve_parser.add_argument("--host", default=os.getenv("AGENT_HOST", "127.0.0.1"))
    serve_parser.add_argument("--port", type=int, default=int(os.getenv("AGENT_PORT", "8080")))
    serve_parser.add_argument("--model-version", default=os.getenv("AGENT_MODEL_VERSION", "gemini-v1"))

    analyze_parser = subparsers.add_parser("analyze", help="Analyze one batch request from a JSON file or stdin")
    analyze_parser.add_argument("--input", type=Path, default=None, help="Path to a JSON batch request; defaults to stdin")
    analyze_parser.add_argument("--model-version", default=os.getenv("AGENT_MODEL_VERSION", "gemini-v1"))

    image_parser = subparsers.add_parser(
        "analyze-images",
        help="Analyze local image files/folders directly and print the batch JSON response",
    )
    image_parser.add_argument(
        "paths",
        nargs="+",
        type=Path,
        help="One or more image files and/or directories containing images",
    )
    image_parser.add_argument("--uid", default="manual_local", help="UID to include in the synthetic batch request")
    image_parser.add_argument(
        "--request-id",
        default=None,
        help="Optional request_id for the synthetic batch request (auto-generated when omitted)",
    )
    image_parser.add_argument(
        "--save-grid-dir",
        type=Path,
        default=None,
        help="Optional output directory to save generated contact sheets and grid manifest",
    )
    image_parser.add_argument("--model-version", default=os.getenv("AGENT_MODEL_VERSION", "gemini-v1"))

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)
    command = args.command or "serve"

    if command == "serve":
        run_server(args.host, args.port, model_version=args.model_version)
        return 0

    if command == "analyze":
        analyzer = BatchAnalyzer(model_version=args.model_version)
        try:
            request_payload = _read_request_payload(args.input)
            request = parse_batch_request(request_payload)
            response = analyzer.analyze(request)
        except json.JSONDecodeError as exc:
            print(json.dumps({"status": "error", "error_code": "invalid_json", "message": str(exc)}), file=sys.stderr)
            return 2
        except ValidationError as exc:
            print(json.dumps({"status": "error", "error_code": "invalid_request", "message": str(exc)}), file=sys.stderr)
            return 2

        print(response.to_json())
        return 0

    if command == "analyze-images":
        analyzer = BatchAnalyzer(model_version=args.model_version, save_grid_dir=args.save_grid_dir)
        try:
            request = _build_manual_request(args.paths, uid=args.uid, request_id=args.request_id)
            response = analyzer.analyze(request)
        except ValidationError as exc:
            print(json.dumps({"status": "error", "error_code": "invalid_input", "message": str(exc)}), file=sys.stderr)
            return 2
        except OSError as exc:
            print(json.dumps({"status": "error", "error_code": "file_read_error", "message": str(exc)}), file=sys.stderr)
            return 2

        print(response.to_json())
        return 0

    parser.error(f"Unknown command: {command}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())

