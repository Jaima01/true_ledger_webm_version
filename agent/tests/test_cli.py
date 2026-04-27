from __future__ import annotations

from io import BytesIO
from pathlib import Path

from PIL import Image

from deepfake_grid_analyzer.cli import _build_manual_request, _resolve_input_images


def _write_image(path: Path, color: str = "white") -> None:
    buffer = BytesIO()
    Image.new("RGB", (16, 16), color=color).save(buffer, format="PNG")
    path.write_bytes(buffer.getvalue())


def test_resolve_input_images_supports_files_and_directories(tmp_path: Path) -> None:
    image_a = tmp_path / "a.png"
    image_b = tmp_path / "b.jpg"
    text_file = tmp_path / "note.txt"

    _write_image(image_a, "red")
    _write_image(image_b, "blue")
    text_file.write_text("ignore me", encoding="utf-8")

    resolved = _resolve_input_images([image_a, tmp_path])

    assert resolved == [image_a, image_b]


def test_build_manual_request_builds_contiguous_batch(tmp_path: Path) -> None:
    image_1 = tmp_path / "01.png"
    image_2 = tmp_path / "02.png"
    _write_image(image_1, "white")
    _write_image(image_2, "black")

    request = _build_manual_request([image_1, image_2], uid="manual_uid", request_id="req_manual_fixed")

    assert request.request_id == "req_manual_fixed"
    assert request.uid == "manual_uid"
    assert request.frame_count == 2
    assert request.batch_start_frame == 1
    assert request.batch_end_frame == 2
    assert request.frames[0].frame_number == 1
    assert request.frames[1].frame_number == 2
    assert request.frames[0].content_type == "image/png"
    assert request.frames[1].content_type == "image/png"
