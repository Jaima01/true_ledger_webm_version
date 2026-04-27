"""Cache-first content lookup workflow."""

from app.api.schemas import ContentMetadataRequest, ContentStatusResponse
from app.services.cache_service import CacheService
from app.services.content_service import ContentService

TERMINAL_STATUSES = {"deepfake", "authentic", "partial_authentic"}


async def check_content_workflow(
    payload: ContentMetadataRequest,
    cache_service: CacheService,
    content_service: ContentService,
) -> ContentStatusResponse:
    platform = payload.platform
    vid = payload.platform_video_id

    cached_status = await cache_service.get_content_status(platform, vid)
    if cached_status:
        return ContentStatusResponse(
            platform=platform,
            platform_video_id=vid,
            status=cached_status,
            send_frames=cached_status == "processing",
            source="cache",
            message="Status returned from cache",
        )

    video = await content_service.get_video(platform, vid)
    if video:
        await cache_service.set_content_status(platform, vid, video.status)
        return ContentStatusResponse(
            platform=platform,
            platform_video_id=vid,
            status=video.status,
            send_frames=video.status == "processing",
            source="database",
            message="Status returned from database",
        )

    video = await content_service.create_video(
        platform=platform,
        platform_video_id=vid,
        title=payload.title,
        channel=payload.channel,
        total_duration=payload.total_duration,
        status="processing",
    )
    await cache_service.set_content_status(platform, vid, "processing")

    return ContentStatusResponse(
        platform=platform,
        platform_video_id=vid,
        status="processing",
        send_frames=True,
        source="workflow",
        message="New content registered; send frames for analysis",
    )
