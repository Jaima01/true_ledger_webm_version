from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
import tempfile


@contextmanager
def temporary_image_workspace(prefix: str = "deepfake-agent-"):
    with tempfile.TemporaryDirectory(prefix=prefix) as workspace_root:
        yield Path(workspace_root)
