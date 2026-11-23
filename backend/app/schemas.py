"""Pydantic request/response models.

Field names are camelCase on the wire and are declared with explicit aliases so
the serialised payload is exactly what ``src/services/*.js`` expects. Aliases
also mean these models validate incoming frontend payloads without any
snake_case translation step.

These models exist mainly to *validate*; responses are assembled by
``Model.to_dict()`` in ``db.py``, which already emits the right names. Both
paths are kept in sync deliberately: this file documents and enforces the
contract, ``db.py`` produces it.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

# --- Vocabulary, mirrored from src/utils/constants.js -----------------------

ProjectStatus = Literal["draft", "uploading", "processing", "ready", "failed", "cancelled"]
ClipStatus = Literal["suggested", "selected", "edited", "exported"]
AspectRatio = Literal["9:16", "1:1", "16:9"]
ExportFormat = Literal["mp4", "webm"]
ExportStatus = Literal["queued", "rendering", "complete", "pending_backend", "failed", "cancelled"]
StageKey = Literal["upload", "audio", "transcript", "highlights", "prepare"]
CaptionPresetId = Literal[
    "clean",
    "bold",
    "karaoke",
    "minimal",
    "creator",
    "hormozi",
    "split_center",
]
CaptionPosition = Literal["top", "center", "lower", "divider"]
RenderMode = Literal["default", "podcast", "split_screen", "gaming"]
ProjectPresetId = Literal["podcast", "split_screen", "gaming", "custom"]

VALID_RESOLUTIONS = ("1080x1920", "1080x1080", "1920x1080", "720x1280", "854x480", "480x854")


class CamelModel(BaseModel):
    """Base that accepts camelCase keys and rejects unknown ones.

    ``extra="forbid"`` matters here: a typo'd field name from the frontend
    should be a 422, not a silently ignored setting.
    """

    model_config = ConfigDict(populate_by_name=True, extra="forbid")


# --- Transcript -------------------------------------------------------------


class Word(CamelModel):
    """One timed word. ``startSec``/``endSec`` are source-absolute."""

    startSec: float = Field(ge=0)
    endSec: float = Field(ge=0)
    text: str = Field(min_length=1)


class TranscriptSegment(CamelModel):
    startSec: float = Field(ge=0)
    endSec: float = Field(ge=0)
    speaker: str | None = None
    text: str
    words: list[Word] = Field(default_factory=list)


# --- Caption / export settings ---------------------------------------------


class CaptionSettings(CamelModel):
    """``position`` is intentionally nullable: ``None`` means "inherit the
    preset's own anchor", which is how the frontend renders it."""

    text: str = ""
    presetId: CaptionPresetId = "clean"
    position: CaptionPosition | None = None
    keywordHighlight: bool = False
    highlightColor: str | None = Field(default=None, max_length=32)
    # Optional timed caption segments for quick editor. When present, renderer may
    # use them instead of transcript-derived cues.
    segments: list[dict[str, Any]] | None = None


class RenderSettings(CamelModel):
    format: ExportFormat = "mp4"
    resolution: str = "1080x1920"
    burnCaptions: bool = True
    lastExportedAt: str | None = None
    renderMode: RenderMode = "default"
    presetId: ProjectPresetId | None = None
    backgroundAssetId: str | None = None
    preview: bool = False
    autoZoom: bool = False
    deadAirRemoval: bool = False
    sfxEnabled: bool = False
    facecamEnabled: bool = False
    facecamAssetId: str | None = None
    facecamBox: dict[str, float] | None = None
    watermark: bool = False
    captionOnly: bool = False
    frameRate: int | None = Field(default=None, ge=24, le=60)

    @field_validator("resolution")
    @classmethod
    def check_resolution(cls, value: str) -> str:
        if value not in VALID_RESOLUTIONS:
            raise ValueError(f"resolution must be one of {VALID_RESOLUTIONS}")
        return value


# --- Requests ---------------------------------------------------------------


class ProjectCreate(CamelModel):
    title: str = Field(min_length=1, max_length=200)
    durationSec: float = Field(default=0.0, ge=0)
    fileSize: int | None = Field(default=None, ge=0)
    fileName: str | None = Field(default=None, max_length=400)
    mimeType: str | None = Field(default=None, max_length=200)
    # Set by the upload flow so the file on disk is linked to this project.
    uploadId: str | None = None
    sourceUrl: str | None = Field(default=None, max_length=2000)
    presetId: ProjectPresetId = "podcast"
    settings: dict[str, Any] | None = None

    @field_validator("title")
    @classmethod
    def strip_title(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("title must not be blank")
        return cleaned


class ProjectPatch(CamelModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    status: ProjectStatus | None = None
    presetId: ProjectPresetId | None = None
    settings: dict[str, Any] | None = None


class GenerateClipsRequest(CamelModel):
    minDuration: float | None = Field(default=None, ge=1)
    maxDuration: float | None = Field(default=None, ge=1)
    targetCount: int | None = Field(default=None, ge=1, le=50)


class ClipPatch(CamelModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    hook: str | None = Field(default=None, max_length=2000)
    startSec: float | None = Field(default=None, ge=0)
    endSec: float | None = Field(default=None, ge=0)
    aspectRatio: AspectRatio | None = None
    caption: CaptionSettings | None = None
    export: RenderSettings | None = None
    status: ClipStatus | None = None
    viralScore: int | None = Field(default=None, ge=0, le=100)
    keywords: list[str] | None = None
    hashtags: list[str] | None = None
    description: str | None = Field(default=None, max_length=4000)
    hookBanner: str | None = Field(default=None, max_length=300)


class ExportRequest(CamelModel):
    format: ExportFormat = "mp4"
    resolution: str = "1080x1920"
    aspectRatio: AspectRatio | None = None
    captionPresetId: CaptionPresetId | None = None
    captionText: str | None = Field(default=None, max_length=500)
    captionPosition: CaptionPosition | None = None
    captionSegments: list[dict[str, Any]] | None = None
    burnCaptions: bool = True
    renderMode: RenderMode | None = None
    presetId: ProjectPresetId | None = None
    backgroundAssetId: str | None = None
    preview: bool = False
    autoZoom: bool = False
    deadAirRemoval: bool = False
    sfxEnabled: bool = False
    facecamEnabled: bool = False
    facecamAssetId: str | None = None
    facecamBox: dict[str, float] | None = None
    watermark: bool = False
    keywordHighlight: bool | None = None
    highlightColor: str | None = Field(default=None, max_length=32)
    captionOnly: bool = False
    frameRate: int | None = Field(default=None, ge=24, le=60)

    @field_validator("resolution")
    @classmethod
    def check_resolution(cls, value: str) -> str:
        if value not in VALID_RESOLUTIONS:
            raise ValueError(f"resolution must be one of {VALID_RESOLUTIONS}")
        return value


# --- Uploads ----------------------------------------------------------------


class UploadSessionCreate(CamelModel):
    fileName: str = Field(min_length=1, max_length=400)
    fileSize: int = Field(ge=1)
    mimeType: str | None = Field(default=None, max_length=200)
    checksum: str | None = Field(default=None, max_length=200)


class RefreshPartsRequest(CamelModel):
    partNumbers: list[int] = Field(min_length=1)


# --- Responses --------------------------------------------------------------


class ErrorResponse(BaseModel):
    detail: str


class HealthResponse(BaseModel):
    status: Literal["ok"]
    version: str
    ffmpeg: bool
    whisperModel: str
    llmProvider: str | None
    llmProviders: list[str] = Field(default_factory=list)
    device: str
    youtubeIngest: bool = True


class DownloadResponse(BaseModel):
    """Returned by ``POST /exports/{jobId}/download``."""

    url: str
    expiresAt: str
    fileName: str
    sizeBytes: int | None = None


class YouTubeIngestRequest(CamelModel):
    url: str = Field(min_length=8, max_length=2000)
    title: str | None = Field(default=None, max_length=200)
    presetId: ProjectPresetId = "podcast"
    settings: dict[str, Any] | None = None