from __future__ import annotations

import json

from PIL import Image

from deepfake_grid_analyzer.grids import build_contact_sheets


def test_grid_overlay_draws_frame_index(tmp_path) -> None:
    frames_dir = tmp_path / "frames"
    grids_dir = tmp_path / "grids"
    frames_dir.mkdir()

    frame_path = frames_dir / "frame_0001.jpg"
    Image.new("RGB", (32, 32), color=(0, 0, 0)).save(frame_path)

    grid_paths, manifest_path = build_contact_sheets([frame_path], grids_dir)

    assert len(grid_paths) == 1
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert manifest[0]["frame_sequence_index"] == 1

    with Image.open(grid_paths[0]) as im:
        region = im.crop((8, 8, 60, 30))
        pixels = list(region.getdata())

    assert any((r > 0 or g > 0 or b > 0) for (r, g, b) in pixels)
import json

from PIL import Image

from deepfake_grid_analyzer.grids import build_contact_sheets


def test_grid_overlay_draws_frame_index(tmp_path):
    frames_dir = tmp_path / "frames"
    grids_dir = tmp_path / "grids"
    frames_dir.mkdir()

    frame_path = frames_dir / "frame_0001.jpg"
    Image.new("RGB", (32, 32), color=(0, 0, 0)).save(frame_path)

    grid_paths, manifest_path = build_contact_sheets([frame_path], grids_dir)

    assert len(grid_paths) == 1
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert manifest[0]["frame_sequence_index"] == 1

    with Image.open(grid_paths[0]) as im:
        region = im.crop((8, 8, 60, 30))
        pixels = list(region.getdata())

    assert any((r > 0 or g > 0 or b > 0) for (r, g, b) in pixels)
