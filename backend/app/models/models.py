"""SQLAlchemy models matching the Supabase videos / video_frames schema."""

import uuid
from datetime import datetime

from pgvector.sqlalchemy import Vector
from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class Video(Base):
    __tablename__ = "videos"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    platform: Mapped[str] = mapped_column(String(50), nullable=False)
    platform_video_id: Mapped[str] = mapped_column(String(255), nullable=False)
    title: Mapped[str | None] = mapped_column(String, nullable=True)
    channel: Mapped[str | None] = mapped_column(String, nullable=True)
    total_duration: Mapped[float | None] = mapped_column(Float, nullable=True)
    scanned_until: Mapped[float] = mapped_column(Float, default=0.0)
    status: Mapped[str] = mapped_column(String(64), nullable=False, default="pending")
    created_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), server_default=text("timezone('utc', now())")
    )
    updated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), server_default=text("timezone('utc', now())")
    )

    frames: Mapped[list["VideoFrame"]] = relationship(back_populates="video", cascade="all, delete-orphan")


class VideoFrame(Base):
    __tablename__ = "video_frames"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    video_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("videos.id", ondelete="CASCADE"), nullable=False
    )
    frame_timestamp: Mapped[float] = mapped_column(Float, nullable=False)
    embedding = mapped_column(Vector(512), nullable=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    match_count: Mapped[int] = mapped_column(Integer, default=0)
    confidence_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), server_default=text("timezone('utc', now())")
    )

    video: Mapped["Video"] = relationship(back_populates="frames")
