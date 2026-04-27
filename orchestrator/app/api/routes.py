"""HTTP routes for orchestrator content checks."""

from fastapi import APIRouter, Depends

from app.api.schemas import ContentMetadataRequest, ContentStatusResponse
from app.core.database import get_db
from app.core.redis_client import get_redis
from app.services.cache_service import CacheService
from app.services.content_service import ContentService
from app.workflows.content_check import check_content_workflow

router = APIRouter()


@router.post("/check-content", response_model=ContentStatusResponse)
async def check_content(
    payload: ContentMetadataRequest,
    db=Depends(get_db),
    redis_client=Depends(get_redis),
) -> ContentStatusResponse:
    cache_service = CacheService(redis_client)
    content_service = ContentService(db)
    return await check_content_workflow(payload, cache_service, content_service)
