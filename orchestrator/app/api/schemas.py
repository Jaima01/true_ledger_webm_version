"""Pydantic request and response models for orchestrator endpoints."""

from pydantic import BaseModel, Field


class ContentMetadataRequest(BaseModel):
    platform: str = Field(..., description="Platform name, e.g. youtube or twitter")
    platform_video_id: str = Field(..., description="Platform-specific content ID")
    title: str | None = None
    channel: str | None = None
    total_duration: float | None = None
    source_url: str | None = None


class ContentStatusResponse(BaseModel):
    platform: str
    platform_video_id: str
    status: str
    send_frames: bool = Field(
        False, description="True when the extension should start sending frames"
    )
    source: str = Field(..., description="cache, database, or workflow")
    message: str | None = None
