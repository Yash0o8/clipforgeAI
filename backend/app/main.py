"""ClipForge AI backend.

Run with::

    uvicorn app.main:app --reload --port 8000

from the ``backend/`` directory. Or via the shortcut in ``backend/run.ps1``,
which also checks that ffmpeg is present before starting.

Full setup, the verified dependency matrix and GPU notes are in
``backend/README.md``.

The API is mounted at ``/api/v1`` to match ``VITE_API_BASE_URL`` in the
frontend's ``.env.example``. ``/media`` is deliberately *outside* that prefix:
it is a static file endpoint, and a ``<video src>`` cannot carry auth headers
or a version prefix cleanly.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .db import init_engine, new_session
from .jobs import get_queue
from .pipeline.runner import recover_interrupted
from .routes import api_router
from .routes.media import router as media_router
from .schemas import HealthResponse

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
  
) 
logger = logging.getLogger("clipforge")

VERSION = "1.0.0"


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Startup and shutdown.

    Startup creates the database and fails any job left ``running`` by a dead
    process, so a restart does not leave a project pinned at "processing".
    Shutdown cancels in-flight work and waits briefly for renders to finish
    writing their output, so a restart does not truncate a file mid-encode.
    """
    settings = get_settings()
    settings.ensure_dirs()
    init_engine()

    session = new_session()
    try:
        recovered = recover_interrupted(session)
        if recovered:
            logger.warning("marked %d interrupted job(s) as failed", recovered)
    finally:
        session.close()

    logger.info(
        "ClipForge AI %s ready | data=%s | whisper=%s | llm=%s",
        VERSION,
        settings.data_dir,
        settings.whisper_model,
        settings.llm_provider() or "heuristic-only",
    )
    yield

    logger.info("shutting down, draining job queue")
    get_queue().shutdown(wait=True)


app = FastAPI(
    title="ClipForge AI",
    version=VERSION,
    description=(
        "Transcribe, auto-edit and render short-form clips from long-form video. "
        "Field names are camelCase to match the React frontend's service layer."
    ),
    lifespan=lifespan,
)

_settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=_settings.cors_origin_list,
    allow_credentials=True,
    # Media and file downloads are range-requested, which browsers preflight.
    expose_headers=["Content-Range", "Accept-Ranges", "Content-Length", "ETag"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router, prefix=_settings.api_prefix)
app.include_router(media_router)


@app.get("/api/v1/health", response_model=HealthResponse, tags=["meta"])
@app.get("/health", response_model=HealthResponse, include_in_schema=False)
def health() -> HealthResponse:
    """Liveness plus the capabilities a client needs to know about.

    The frontend uses this to tell the user *why* something will not work —
    missing ffmpeg or no LLM key are both silently degrading conditions worth
    surfacing rather than failing at render time.
    """
    from .pipeline.transcribe import resolve_device
    from .storage import ffmpeg_available

    settings = get_settings()
    return HealthResponse(
        status="ok",
        version=VERSION,
        ffmpeg=ffmpeg_available(),
        whisperModel=settings.whisper_model,
        llmProvider=settings.llm_provider(),
        device=resolve_device(settings.whisper_device),
    )


@app.get("/api/v1/meta", tags=["meta"])
def meta() -> dict:
    """Vocabulary the frontend's constants mirror.

    Served from the backend so the two lists can be diffed rather than assumed to
    agree. ``src/utils/constants.js`` is the source of truth for the UI; this
    exists to make a divergence obvious instead of invisible.
    """
    return {
        "version": VERSION,
        "stages": [
            {"key": "upload", "weight": 18},
            {"key": "audio", "weight": 14},
            {"key": "transcript", "weight": 34},
            {"key": "highlights", "weight": 22},
            {"key": "prepare", "weight": 12},
        ],
        "projectStatus": ["draft", "uploading", "processing", "ready", "failed", "cancelled"],
        "clipStatus": ["suggested", "selected", "edited", "exported"],
        "exportStatus": ["queued", "rendering", "complete", "pending_backend", "failed"],
        "aspectRatios": [
            {"id": "9:16", "width": 1080, "height": 1920},
            {"id": "1:1", "width": 1080, "height": 1080},
            {"id": "16:9", "width": 1920, "height": 1080},
        ],
        "resolutions": ["1080x1920", "1080x1080", "1920x1080"],
        "captionPresets": ["clean", "bold", "karaoke", "minimal", "creator"],
        "clipLimits": {"minDuration": 5, "maxDuration": 90, "defaultDuration": 38},
    }