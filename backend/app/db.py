"""SQLAlchemy models backing the projects / clips / exports / jobs tables.

Deliberately plain SQLite: no server to run, no migrations to babysit. The
columns mirror the frontend's data contracts one-to-one so serialising a row
produces an object the React app can consume without a translation layer.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    create_engine,
)
from sqlalchemy.orm import DeclarativeBase, relationship, sessionmaker
from sqlalchemy.orm import Session as OrmSession

Session = OrmSession

from .config import get_settings


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso(value: datetime | None) -> str | None:
    """ISO-8601 with a trailing Z, matching what the frontend parses."""
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


class Base(DeclarativeBase):
    pass


class Project(Base):
    __tablename__ = "projects"

    id = Column(String, primary_key=True)
    title = Column(String, nullable=False)
    source = Column(String, nullable=False, default="upload")

    file_name = Column(String)
    file_size = Column(Integer)
    mime_type = Column(String)

    duration_sec = Column(Float, default=0.0)
    width = Column(Integer)
    height = Column(Integer)

    status = Column(String, nullable=False, default="draft")
    progress = Column(Float, default=0.0)
    current_stage = Column(String)
    error = Column(Text)
    word_count = Column(Integer, default=0)

    created_at = Column(DateTime, default=utcnow)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow)

    # Server-side relative path under DATA_DIR. Never exposed directly: the
    # frontend must go through GET /media/{project_id} so access stays checkable.
    asset_path = Column(String)
    # "video" | "audio" | "unknown"
    asset_kind = Column(String, default="video")

    # JSON-encoded stages[] so the Processing page stepper has something to
    # render on the very first poll, before any work starts.
    stages_json = Column(Text, default="[]")

    clips = relationship(
        "Clip",
        back_populates="project",
        cascade="all, delete-orphan",
        order_by="Clip.created_at",
    )

    def to_dict(self) -> dict:
        """Serialise for the API, using the exact field names the UI reads."""
        # objectUrl is derived from whether media actually exists. Handing the
        # frontend a URL for a project with no upload makes <video> request a
        # 404 and sit on a broken player with no explanation.
        has_media = bool(self.asset_path)
        return {
            "id": self.id,
            "title": self.title,
            "source": self.source,
            "fileName": self.file_name,
            "fileSize": self.file_size,
            "mimeType": self.mime_type,
            "durationSec": self.duration_sec or 0.0,
            "width": self.width,
            "height": self.height,
            "status": self.status,
            "progress": self.progress or 0.0,
            "currentStage": self.current_stage,
            "stages": json.loads(self.stages_json or "[]"),
            "error": self.error,
            "wordCount": self.word_count or 0,
            "createdAt": iso(self.created_at),
            "updatedAt": iso(self.updated_at),
            # Path the <video> element loads directly. The media route sits
            # outside the API prefix because it is a plain GET with range
            # support, not a JSON resource.
            "objectUrl": f"/media/{self.id}" if has_media else None,
            "hasLocalSource": has_media,
        }


class Clip(Base):
    __tablename__ = "clips"

    id = Column(String, primary_key=True)
    project_id = Column(String, ForeignKey("projects.id"), nullable=False, index=True)

    title = Column(String, nullable=False)
    hook = Column(Text)

    start_sec = Column(Float, nullable=False)
    end_sec = Column(Float, nullable=False)
    duration_sec = Column(Float, default=0.0)

    score = Column(Integer, default=0)
    aspect_ratio = Column(String, nullable=False, default="9:16")
    status = Column(String, nullable=False, default="suggested")
    poster_seed = Column(Integer, default=0)

    created_at = Column(DateTime, default=utcnow)
    edited_at = Column(DateTime)

    # JSON blobs. Kept as TEXT rather than child tables because they are always
    # read and written whole, never queried into.
    transcript_json = Column(Text, default="[]")
    caption_json = Column(Text, default="{}")
    export_json = Column(Text, default="{}")

    project = relationship("Project", back_populates="clips")

    def to_dict(self) -> dict:
        caption = json.loads(self.caption_json or "{}")
        export = json.loads(self.export_json or "{}")
        return {
            "id": self.id,
            "projectId": self.project_id,
            "title": self.title,
            "hook": self.hook,
            "startSec": self.start_sec,
            "endSec": self.end_sec,
            "durationSec": self.duration_sec,
            "score": self.score,
            "aspectRatio": self.aspect_ratio,
            "status": self.status,
            "posterSeed": self.poster_seed,
            "createdAt": iso(self.created_at),
            "editedAt": iso(self.edited_at),
            "transcript": json.loads(self.transcript_json or "[]"),
            # position may legitimately be null, meaning "inherit the preset".
            "caption": caption,
            "export": export,
        }


class ExportJob(Base):
    __tablename__ = "exports"

    id = Column(String, primary_key=True)
    clip_id = Column(String, ForeignKey("clips.id"), nullable=False, index=True)
    project_id = Column(String, ForeignKey("projects.id"), nullable=False, index=True)

    title = Column(String, nullable=False)
    kind = Column(String, nullable=False, default="video")
    status = Column(String, nullable=False, default="queued")
    progress = Column(Float, default=0.0)
    error = Column(Text)

    format = Column(String, default="mp4")
    resolution = Column(String, default="1080x1920")
    aspect_ratio = Column(String, default="9:16")
    burn_captions = Column(Boolean, default=True)

    settings_json = Column(Text, default="{}")

    # Rendered file path relative to DATA_DIR, set once status is "complete".
    render_path = Column(String)
    size_bytes = Column(Integer)
    download_token = Column(String)
    download_expires_at = Column(DateTime)

    created_at = Column(DateTime, default=utcnow)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "clipId": self.clip_id,
            "projectId": self.project_id,
            "title": self.title,
            "kind": self.kind,
            "status": self.status,
            "progress": self.progress or 0.0,
            "error": self.error,
            "format": self.format,
            "resolution": self.resolution,
            "aspectRatio": self.aspect_ratio,
            "burnCaptions": self.burn_captions,
            "createdAt": iso(self.created_at),
            "updatedAt": iso(self.updated_at),
            "settings": json.loads(self.settings_json or "{}"),
            "sizeBytes": self.size_bytes,
            "hasDownload": self.render_path is not None,
        }


class Job(Base):
    """Generic background-work record for the processing pipeline.

    Kept separate from ``projects.status`` so a crash mid-run leaves evidence
    that lets the runner resume or mark the project failed on restart, rather
    than leaving it stuck at "processing" forever.
    """

    __tablename__ = "jobs"

    id = Column(String, primary_key=True)
    project_id = Column(String, ForeignKey("projects.id"), nullable=False, index=True)
    kind = Column(String, nullable=False, default="process")
    status = Column(String, nullable=False, default="queued")
    stage = Column(String)
    progress = Column(Float, default=0.0)
    error = Column(Text)
    cancel_requested = Column(Boolean, default=False)

    created_at = Column(DateTime, default=utcnow)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "projectId": self.project_id,
            "kind": self.kind,
            "status": self.status,
            "stage": self.stage,
            "progress": self.progress or 0.0,
            "error": self.error,
            "cancelRequested": self.cancel_requested,
            "createdAt": iso(self.created_at),
            "updatedAt": iso(self.updated_at),
        }


_engine = None
_SessionLocal = None


def init_engine():
    """Create the engine and tables once per process."""
    global _engine, _SessionLocal
    if _engine is not None:
        return _engine
    settings = get_settings()
    _engine = create_engine(
        settings.database_url,
        connect_args={"check_same_thread": False},
        future=True,
    )
    Base.metadata.create_all(_engine)
    _SessionLocal = sessionmaker(bind=_engine, autoflush=False, expire_on_commit=False)
    return _engine


def new_session() -> Session:
    """A session for a specific thread.

    Worker threads must not borrow the request-scoped session: SQLAlchemy
    sessions are not thread-safe, and sharing one across the request boundary is
    how you get "SQLite objects created in a thread can only be used in that
    thread" errors.
    """
    global _SessionLocal
    if _SessionLocal is None:
        init_engine()
    return _SessionLocal()


def get_session():
    """FastAPI dependency yielding a scoped session."""
    session = new_session()
    try:
        yield session
    finally:
        session.close()
