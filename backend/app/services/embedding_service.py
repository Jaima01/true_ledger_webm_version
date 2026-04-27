"""CLIP embedding generation service.

# TODO: Replace the stub with a real CLIP model (e.g. openai/clip-vit-base-patch32).
#       Install `transformers` and `torch`, load the model once at module level,
#       and replace generate_embeddings with actual inference.
"""

import logging

import numpy as np

logger = logging.getLogger(__name__)

EMBEDDING_DIM = 512


async def generate_embeddings(images: list[bytes]) -> list[list[float]]:
    """Convert raw image bytes into 512-dimensional embedding vectors.

    Currently returns normalised random vectors as a placeholder so the
    full pipeline can be exercised end-to-end before the real CLIP model
    is integrated.
    """
    embeddings: list[list[float]] = []
    for _ in images:
        vec = np.random.randn(EMBEDDING_DIM).astype(np.float32)
        vec = vec / np.linalg.norm(vec)
        embeddings.append(vec.tolist())

    logger.info("Generated %d stub embeddings (dim=%d)", len(embeddings), EMBEDDING_DIM)
    return embeddings
