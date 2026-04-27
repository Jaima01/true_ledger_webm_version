from __future__ import annotations

import shutil
from io import BytesIO
from pathlib import Path
from typing import Callable, ContextManager

from PIL import Image

from .config import Settings, get_settings
from .contracts import BatchAnalysisRequest, BatchAnalysisResponse, FramePayload
from .gemini_client import analyze_grids_with_gemini
from .grids import build_contact_sheets
from .storage import temporary_image_workspace


WorkspaceFactory = Callable[[], ContextManager[Path]]


class BatchAnalyzer:
    def __init__(
        self,
        *,
        settings: Settings | None = None,
        model_version: str = "gemini-v1",
        workspace_factory: WorkspaceFactory | None = None,
        save_grid_dir: Path | None = None,
    ) -> None:
        self._settings = settings or get_settings()
        self._model_version = model_version
        self._workspace_factory = workspace_factory or temporary_image_workspace
        self._save_grid_dir = save_grid_dir

    def analyze(self, request: BatchAnalysisRequest) -> BatchAnalysisResponse:
        with self._workspace_factory() as workspace_root:
            workspace = Path(workspace_root)
            frames_dir = workspace / "frames"
            grids_dir = workspace / "grids"
            frames_dir.mkdir(parents=True, exist_ok=True)
            grids_dir.mkdir(parents=True, exist_ok=True)

            frame_paths = [self._write_frame_image(frame, frames_dir) for frame in request.frames]
            grid_paths, manifest_path = build_contact_sheets(frame_paths, grids_dir)
            self._export_debug_grids(grid_paths, manifest_path)
            result = analyze_grids_with_gemini(grid_paths, self._settings, total_frames=len(request.frames))

        return BatchAnalysisResponse(
            request_id=request.request_id,
            uid=request.uid,
            batch_index=request.batch_index,
            batch_verdict="deepfake" if result.is_deepfake else "authentic",
            confidence=result.confidence,
            suspicious_frame_numbers=result.frame_indices if result.is_deepfake else tuple(),
            status="ok",
            model_version=self._model_version,
            notes=result.raw,
        )

    @staticmethod
    def _write_frame_image(frame: FramePayload, frames_dir: Path) -> Path:
        raw_bytes = BytesIO(_decode_image_bytes(frame.image_base64))
        with Image.open(raw_bytes) as image:
            rgb = image.convert("RGB")
            frame_path = frames_dir / f"frame_{frame.frame_number:04d}.jpg"
            rgb.save(frame_path, format="JPEG", quality=95)
            return frame_path

    def _export_debug_grids(self, grid_paths: list[Path], manifest_path: Path) -> None:
        if self._save_grid_dir is None:
            return

        self._save_grid_dir.mkdir(parents=True, exist_ok=True)
        for grid_path in grid_paths:
            shutil.copy2(grid_path, self._save_grid_dir / grid_path.name)
        shutil.copy2(manifest_path, self._save_grid_dir / manifest_path.name)


def _decode_image_bytes(value: str) -> bytes:
    import base64

    return base64.b64decode(value.encode("ascii"), validate=True)
