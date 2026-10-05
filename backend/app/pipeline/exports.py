"""Export job execution: turn a clip plus render settings into an MP4.

Kept separate from the HTTP layer so it can be driven from a worker, a CLI, or a
test without going through a request.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from ..config import Settings, get_settings
from ..db import Clip, ExportJob, Project, utcnow
from ..jobs import CancelledError, JobContext
from ..storage import safe_join, sanitize_name
from ..utils import ensure_utc, new_id
from .render import RenderError, RenderRequest, render_clip

logger = logging.getLogger(__name__)


class ExportError(RuntimeError):
    """Raised when an export cannot run. Message goes on the job."""


def queue_export(
    session: Session,
    clip: Clip,
    settings_from_request: dict[str, Any],
) -> ExportJob:
    """Create the export job row. Rendering happens separately."""
    project = session.query(Project).filter(Project.id == clip.project_id).first()
    if project is None:
        raise ExportError("clip has no project")

    stored_export = json.loads(clip.export_json or "{}")

    # Resolution from the request wins; otherwise the clip's saved setting.
    # Aspect ratio likewise, so the render matches the preview the user approved.
    resolution = settings_from_request.get("resolution") or stored_export.get("resolution", "1080x1920")
    fmt = settings_from_request.get("format") or stored_export.get("format", "mp4")
    aspect = settings_from_request.get("aspectRatio") or clip.aspect_ratio
    burn = settings_from_request.get("burnCaptions")
    if burn is None:
        burn = stored_export.get("burnCaptions", True)

    # The caption preset and text can be overridden per-export without touching
    # the clip, which is what makes "try another style" cheap.
    caption = json.loads(clip.caption_json or "{}")
    preset_id = settings_from_request.get("captionPresetId") or caption.get("presetId") or "clean"
    caption_text = settings_from_request.get("captionText")
    caption_position = settings_from_request.get("captionPosition")

    job = ExportJob(
        id=new_id("exp"),
        clip_id=clip.id,
        project_id=clip.project_id,
        title=clip.title,
        kind="video",
        status="queued",
        progress=0.0,
        format=fmt,
        resolution=resolution,
        aspect_ratio=aspect,
        burn_captions=bool(burn),
        settings_json=json.dumps(
            {
                "captionPresetId": preset_id,
                "captionText": caption_text,
                "captionPosition": caption_position,
            }
        ),
    )
    session.add(job)

    # Stamp the clip so the Exports page can show that a render happened.
    stored_export["lastExportedAt"] = utcnow().isoformat().replace("+00:00", "Z")
    clip.export_json = json.dumps(stored_export)
    clip.edited_at = clip.edited_at or utcnow()

    session.commit()
    return job


def run_export(
    session: Session,
    job_id: str,
    context: JobContext,
) -> dict[str, Any]:
    """Render the clip for ``job_id`` and update the job row as it goes."""
    settings: Settings = context.settings or get_settings()

    job = session.query(ExportJob).filter(ExportJob.id == job_id).first()
    if job is None:
        raise ExportError("export job not found")

    clip = session.query(Clip).filter(Clip.id == job.clip_id).first()
    if clip is None:
        raise ExportError("clip no longer exists")

    project = session.query(Project).filter(Project.id == job.project_id).first()
    if project is None:
        raise ExportError("project no longer exists")

    if not project.asset_path:
        raise ExportError("source media is missing. Re-upload the video.")

    try:
        source = safe_join(settings.data_dir, project.asset_path)
    except Exception:
        raise ExportError("source media path is invalid") from None

    if not source.exists():
        raise ExportError("source media is missing. Re-upload the video.")

    if job.status == "cancelled" or context.cancelled():
        raise CancelledError("export cancelled")

    job.status = "rendering"
    job.updated_at = utcnow()
    session.commit()

    options = json.loads(job.settings_json or "{}")
    duration = max(0.1, clip.end_sec - clip.start_sec)

    # ffmpeg reports out_time in microseconds since the start of the output,
    # which for a trimmed render is clip-relative.
    def on_progress(out_time_us: float) -> None:
        fraction = min(1.0, max(0.0, (out_time_us / 1_000_000) / duration))
        job.progress = round(fraction * 100, 1)
        job.updated_at = utcnow()
        # Committing per frame would thrash the database; once a second is plenty.
        if int(job.progress) % 5 == 0:
            session.commit()
        context.report(None, job.progress)

    output = _output_path(job, settings)

    request = RenderRequest(
        source=source,
        output=output,
        start_sec=clip.start_sec,
        end_sec=clip.end_sec,
        aspect_ratio=job.aspect_ratio,
        resolution=job.resolution,
        fmt=job.format,
        burn_captions=bool(job.burn_captions),
        caption_preset_id=options.get("captionPresetId"),
        caption_position=options.get("captionPosition"),
        caption_text=options.get("captionText"),
        transcript=json.loads(clip.transcript_json or "[]"),
    )

    try:
        render_clip(request, on_progress=on_progress, cancel=context.should_cancel)
    except CancelledError:
        job.status = "cancelled"
        job.updated_at = utcnow()
        session.commit()
        output.unlink(missing_ok=True)
        raise
    except RenderError as exc:
        job.status = "failed"
        job.error = str(exc)
        job.updated_at = utcnow()
        session.commit()
        output.unlink(missing_ok=True)
        raise

    job.status = "complete"
    job.progress = 100.0
    job.render_path = str(output.relative_to(settings.data_dir).as_posix())
    job.size_bytes = output.stat().st_size
    job.updated_at = utcnow()

    # An export supersedes the clip's edited state.
    clip.status = "exported"
    clip.edited_at = utcnow()

    # Clear any previous download token so the new file needs a fresh one.
    job.download_token = None
    job.download_expires_at = None

    session.commit()

    return {
        "jobId": job.id,
        "status": "complete",
        "sizeBytes": job.size_bytes,
        "format": job.format,
    }


def _output_path(job: ExportJob, settings: Settings) -> Path:
    """Where the rendered file lands, with a name the browser will download cleanly."""
    stem = sanitize_name(job.title, fallback=job.clip_id).rsplit(".", 1)[0] or job.clip_id
    filename = f"{stem}-{job.id}.{job.format}"
    return safe_join(settings.render_dir, filename)


def is_download_ready(job: ExportJob) -> bool:
    """True when the file exists and a token can be issued."""
    return job.status == "complete" and bool(job.render_path)


def token_is_valid(job: ExportJob) -> bool:
    """Whether the stored download token is present and unexpired."""
    if not job.download_token:
        return False
    expires = ensure_utc(job.download_expires_at)
    return expires is not None and expires > utcnow()


def download_filename(job: ExportJob) -> str:
    """A friendly filename that drops the internal job suffix."""
    stem = sanitize_name(job.title, fallback=job.clip_id).rsplit(".", 1)[0] or job.clip_id
    return f"{stem}.{job.format}"