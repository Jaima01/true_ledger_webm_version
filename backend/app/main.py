"""FastAPI application entry point for the backend service."""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import router as api_router
from app.core.config import settings
from app.core.redis_client import close_redis, ensure_vector_index

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await ensure_vector_index()
    logger.info("Backend started – Redis vector index ready")
    yield
    await close_redis()
    logger.info("Backend shutdown – connections closed")


app = FastAPI(
    title=settings.api_title,
    version="1.0.0",
    debug=settings.debug,
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router)
