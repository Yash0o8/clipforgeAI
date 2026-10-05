"""Export jobs and downloads.

Maps onto ``src/services/clipService.js``:

    POST /clips/{id}/export        -> queue a render
    GET  /exports/{jobId}          -> poll progress
    POST /exports/{jobId}/cancel   -> stop a render
    POST /exports/{jobId}/download -> time-limited download URL

Unlike the demo build, a completed job points at a real file on disk.
"""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import Clip, ExportJob, get_session, new_session, utcnow
from ..jobs import JobContext, get_queue
from ..pipeline.exports import (
    ExportError,
    download_filename,
    is_download_ready,
    queue_export,
    run_export,
    token_is_valid,
)
from ..schemas import DownloadResponse, ExportRequest
from ..storage import safe_join
from ..utils import random_token

logger = logging.getLogger(__name__)

router = APIRouter(tags=["exports"])

DOWNLOAD_TTL_MINUTES = 30


def get_job_or_404(session: Session, job_id: str) -> ExportJob:
    job = session.query(ExportJob).filter(ExportJob.id == job_id).first()
    if job is None:
        raise HTTPException(status_code=404, detail="Export job not found")
    return job


@router.post("/clips/{clip_id}/export", status_code=status.HTTP_202_ACCEPTED)
def start_export(
    clip_id: str,
    payload: ExportRequest,
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    """Queue a render. Returns the job descriptor the client polls."""
    clip = session.query(Clip).filter(Clip.id == clip_id).first()
    if clip is None:
        raise HTTPException(status_code=404, detail="Clip not found")

    project = clip.project
    if project is None:
        raise HTTPException(status_code=404, detail="Clip has no project")
    if project.status != "ready":
        raise HTTPException(
            status_code=409,
            detail="This project is still processing. Exports unlock once highlights are ready.",
        )
    if project.asset_kind == "audio":
        # Renders trim, refit and burn captions onto a video track. An audio-only
        # upload has nothing to do that to, and ffmpeg's failure for it is an
        # opaque "matches no streams" filtergraph error.
        raise HTTPException(
            status_code=422,
            detail="This project has no video track, so there is nothing to render a clip from.",
        )

    queue = get_queue_or_503()

    # One live render per clip. Re-queuing while one is running would race two
    # ffmpeg processes onto the same output filename.
    for existing in (
        session.query(ExportJob)
        .filter(ExportJob.clip_id == clip_id, ExportJob.status.in_(["queued", "rendering"]))
        .all()
    ):
        return {
            "jobId": existing.id,
            "status": existing.status,
            "progress": existing.progress,
            "clipId": clip_id,
            "format": existing.format,
            "resolution": existing.resolution,
        }

    try:
        job = queue_export(session, clip, payload.model_dump(exclude_none=True))
    except ExportError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    settings = get_settings()

    # Registered under the ExportJob's own ID so a cancel can target exactly
    # this render. With an unrelated queue ID the only way to stop a job was to
    # cancel every export in the project, which killed unrelated renders.
    queue.submit(
        "export",
        clip.project_id,
        lambda ctx: _run_export(job.id, ctx),
        settings,
        job_id=job.id,
    )

    logger.info("queued export %s for clip %s (%s %s)", job.id, clip_id, payload.format, payload.resolution)

    return {
        "jobId": job.id,
        "status": job.status,
        "progress": 0,
        "clipId": clip_id,
        "projectId": job.project_id,
        "format": job.format,
        "resolution": job.resolution,
        "aspectRatio": job.aspect_ratio,
        "burnCaptions": job.burn_captions,
    }


@router.get("/exports")
def list_exports(
    project_id: str | None = None,
    session: Session = Depends(get_session),
) -> list[dict[str, Any]]:
    """Export history, newest first. Optionally scoped to one project.

    Backs the Exports page, which needs finished renders even after a reload.
    """
    query = session.query(ExportJob)
    if project_id:
        query = query.filter(ExportJob.project_id == project_id)
    jobs = query.order_by(ExportJob.created_at.desc()).all()
    return [job.to_dict() for job in jobs]


@router.get("/exports/{job_id}")
def read_export(job_id: str, session: Session = Depends(get_session)) -> dict[str, Any]:
    """Poll a render job.

    The returned ``status`` values match ``EXPORT_STATUS`` in the frontend:
    ``queued``, ``rendering``, ``complete``, ``failed``.
    """
    job = get_job_or_404(session, job_id)
    payload = job.to_dict()
    payload["jobId"] = job.id
    payload["canDownload"] = is_download_ready(job)
    return payload


@router.post("/exports/{job_id}/cancel")
def cancel_export(job_id: str, session: Session = Depends(get_session)) -> dict[str, Any]:
    """Cancel a queued or running render."""
    job = get_job_or_404(session, job_id)

    # The queue registers each render under its ExportJob ID, so this cancels
    # exactly the requested job and leaves the project's other renders running.
    get_queue().cancel(job.id)

    if job.status in ("queued", "rendering"):
        job.status = "cancelled"
        job.updated_at = utcnow()
        session.commit()

    return {"jobId": job.id, "status": job.status, "cancelled": job.status == "cancelled"}


@router.post("/exports/{job_id}/download", response_model=DownloadResponse)
def create_download(job_id: str, session: Session = Depends(get_session)) -> DownloadResponse:
    """Exchange a completed job for a time-limited download URL.

    The token is stored on the row rather than signed into a URL, so it can be
    revoked and so a leaked URL stops working without any secret rotation.
    """
    job = get_job_or_404(session, job_id)

    if not is_download_ready(job):
        raise HTTPException(
            status_code=409,
            detail=f"Export is {job.status}, not ready to download.",
        )

    settings = get_settings()
    try:
        path = safe_join(settings.data_dir, job.render_path)
    except ValueError as exc:
        raise HTTPException(status_code=500, detail="Render path is invalid") from exc

    if not path.exists():
        raise HTTPException(status_code=410, detail="Rendered file is no longer on disk")

    expires = utcnow() + timedelta(minutes=DOWNLOAD_TTL_MINUTES)
    job.download_token = random_token()
    job.download_expires_at = expires
    session.commit()

    return DownloadResponse(
        url=f"{get_settings().api_prefix}/exports/{job.id}/file?token={job.download_token}",
        expiresAt=expires.isoformat().replace("+00:00", "Z"),
        fileName=download_filename(job),
        sizeBytes=job.size_bytes,
    )


@router.get("/exports/{job_id}/file")
def download_file(
    job_id: str, token: str | None = None, session: Session = Depends(get_session)
) -> FileResponse:
    """Serve the rendered file. Requires a valid, unexpired token.

    A FileResponse with an explicit content type and filename, so the browser
    downloads rather than trying to play it inline.

    ``token`` is optional in the signature so a request that omits it entirely
    gets a 403 like any other bad token, rather than FastAPI's 422 validation
    error, which reads as "malformed request" instead of "link expired".
    """
    job = get_job_or_404(session, job_id)

    if not token or not token_is_valid(job) or job.download_token != token:
        raise HTTPException(status_code=403, detail="Download link is invalid or has expired")

    settings = get_settings()
    try:
        path = safe_join(settings.data_dir, job.render_path)
    except ValueError as exc:
        raise HTTPException(status_code=500, detail="Render path is invalid") from exc

    if not path.exists():
        raise HTTPException(status_code=410, detail="Rendered file is no longer on disk")

    media_types = {"mp4": "video/mp4", "webm": "video/webm"}
    return FileResponse(
        path,
        media_type=media_types.get(job.format, "application/octet-stream"),
        filename=download_filename(job),
    )


# --- Helpers ----------------------------------------------------------------


def get_queue_or_503():
    """Fetch the queue, turning a shutdown race into a 503 rather than a 500."""
    from ..jobs import get_queue  # noqa: PLC0415

    try:
        queue = get_queue()
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail="Server is shutting down") from exc
    return queue


def _run_export(job_id: str, context: JobContext):
    """Worker entry point. Uses its own session, never the request's."""
    session = new_session()
    try:
        return run_export(session, job_id, context)
    finally:
        session.close()