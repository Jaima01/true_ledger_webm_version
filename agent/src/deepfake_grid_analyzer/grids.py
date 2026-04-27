from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps

FRAMES_PER_GRID = 20
GRID_COLUMNS = 5
GRID_ROWS = 4
TARGET_CELL_LONG_SIDE = 320


class GridGenerationError(Exception):
    pass


def _draw_frame_index_label(draw: ImageDraw.ImageDraw, x: int, y: int, frame_index: int) -> None:
    font = ImageFont.load_default()
    label = str(frame_index)
    left, top, right, bottom = draw.textbbox((0, 0), label, font=font)
    text_width = right - left
    text_height = bottom - top

    pad_x = 4
    pad_y = 2
    box_left = x + 6
    box_top = y + 6
    box_right = box_left + text_width + (pad_x * 2)
    box_bottom = box_top + text_height + (pad_y * 2)

    draw.rectangle((box_left, box_top, box_right, box_bottom), fill=(0, 0, 0))
    draw.text((box_left + pad_x, box_top + pad_y), label, fill=(255, 255, 255), font=font)


def _dynamic_cell_size(first_frame_path: Path) -> tuple[int, int]:
    with Image.open(first_frame_path) as im:
        width, height = im.size

    if width <= 0 or height <= 0:
        raise GridGenerationError(f"Invalid frame dimensions for {first_frame_path}")

    if width >= height:
        cell_width = TARGET_CELL_LONG_SIDE
        cell_height = max(1, round(TARGET_CELL_LONG_SIDE * (height / width)))
    else:
        cell_height = TARGET_CELL_LONG_SIDE
        cell_width = max(1, round(TARGET_CELL_LONG_SIDE * (width / height)))

    return cell_width, cell_height


def build_contact_sheets(frame_paths: list[Path], output_dir: Path) -> tuple[list[Path], Path]:
    output_dir.mkdir(parents=True, exist_ok=True)

    if not frame_paths:
        raise GridGenerationError("No frame paths provided")

    grids: list[Path] = []
    manifest: list[dict[str, int | str]] = []
    cell_width, cell_height = _dynamic_cell_size(frame_paths[0])

    for batch_start in range(0, len(frame_paths), FRAMES_PER_GRID):
        batch = frame_paths[batch_start : batch_start + FRAMES_PER_GRID]
        grid_index = len(grids) + 1
        grid_path = output_dir / f"grid_{grid_index:03d}.jpg"

        sheet = Image.new(
            "RGB",
            (GRID_COLUMNS * cell_width, GRID_ROWS * cell_height),
            color=(0, 0, 0),
        )
        draw = ImageDraw.Draw(sheet)

        for i, frame_path in enumerate(batch):
            row = i // GRID_COLUMNS
            col = i % GRID_COLUMNS
            x = col * cell_width
            y = row * cell_height
            frame_index = batch_start + i + 1

            with Image.open(frame_path) as im:
                rgb = im.convert("RGB")
                fitted = ImageOps.contain(
                    rgb,
                    (cell_width, cell_height),
                    method=Image.Resampling.LANCZOS,
                )

                paste_x = x + (cell_width - fitted.width) // 2
                paste_y = y + (cell_height - fitted.height) // 2
                sheet.paste(fitted, (paste_x, paste_y))

            _draw_frame_index_label(draw, x, y, frame_index)

            manifest.append(
                {
                    "frame_file": frame_path.name,
                    "frame_sequence_index": frame_index,
                    "grid_index": grid_index,
                    "grid_row": row,
                    "grid_col": col,
                    "cell_width": cell_width,
                    "cell_height": cell_height,
                }
            )

        sheet.save(grid_path, format="JPEG", quality=92)
        grids.append(grid_path)

    manifest_path = output_dir / "grid_manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return grids, manifest_path
