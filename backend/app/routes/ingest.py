"""YouTube/URL ingestion.

Uses yt-dlp when available. Downloads into uploads dir and creates a project.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import Job, Project, get_session, utcnow
from ..jobs import JobContext, get_queue
from ..schemas import YouTubeIngestRequest
from ..storage import probe, safe_join, sanitize_name
from ..utils import new_id
from .projects import INITIAL_STAGES, session_factory

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/ingest", tags=["ingest"])


def _download_youtube(url: str, dest_dir: Path) -> tuple[Path, dict]:
    try:
        import yt_dlp  # type: ignore
    except Exception as exc:
        raise HTTPException(
            status_code=501,
            detail="yt-dlp is not installed. Install backend requirements to enable YouTube ingest.",
        ) from exc

    dest_dir.mkdir(parents=True, exist_ok=True)
    outtmpl = str(dest_dir / "%(id)s.%(ext)s")
    ydl_opts = {
        "outtmpl": outtmpl,
        "format": "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b",
        "merge_output_format": "mp4",
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=True)
        filename = ydl.prepare_filename(info)
        path = Path(filename)
        if path.suffix.lower() != ".mp4":
            mp4 = path.with_suffix(".mp4")
            if mp4.exists():
                path = mp4
    return path, info or {}


@router.post("/youtube", status_code=status.HTTP_202_ACCEPTED)
def ingest_youtube(payload: YouTubeIngestRequest, session: Session = Depends(get_session)) -> dict:
    settings = get_settings()
    if not settings.enable_youtube_ingest:
        raise HTTPException(status_code=403, detail="YouTube ingest is disabled")

    url = payload.url.strip()
    if not (url.startswith("http://") or url.startswith("https://")):
        raise HTTPException(status_code=422, detail="Invalid URL")

    title = (payload.title or "YouTube import").strip() or "YouTube import"
    project = Project(
        id=new_id("prj"),
        title=title,
        source="youtube",
        source_url=url,
        status="processing",
        progress=0.0,
        current_stage="upload",
        stages_json=json.dumps(INITIAL_STAGES),
        preset_id=payload.presetId or "podcast",
        settings_json=json.dumps(payload.settings or {}),
    )
    db_job = Job(
        id=new_id("job"),
        project_id=project.id,
        kind="ingest",
        status="queued",
        stage="upload",
        progress=0.0,
    )
    session.add(project)
    session.add(db_job)
    session.commit()

    queue = get_queue()

    def body(ctx: JobContext):
        db = session_factory()
        try:
            prj = db.query(Project).filter(Project.id == project.id).first()
            job = db.query(Job).filter(Job.id == db_job.id).first()
            if not prj:
                return
            try:
                if job:
                    job.status = "running"
                    job.stage = "upload"
                    job.progress = 1.0
                ctx.report("upload", 1.0)
                path, info = _download_youtube(url, settings.upload_dir / "youtube")
                safe_name = sanitize_name(info.get("title") or path.name, fallback=path.name)
                final = path
                rel = str(final.relative_to(settings.data_dir)).replace("\\", "/")
                media = probe(final)
                prj.asset_path = rel
                prj.file_name = safe_name
                prj.file_size = final.stat().st_size if final.exists() else None
                prj.mime_type = "video/mp4"
                prj.duration_sec = media.duration_sec or 0.0
                prj.width = media.width
                prj.height = media.height
                prj.asset_kind = "audio" if not media.has_video else "video"
                prj.title = prj.title or sanitize_name(info.get("title") or "YouTube import")
                prj.status = "draft"
                prj.progress = 0.0
                prj.current_stage = "upload"
                prj.error = None
                prj.updated_at = utcnow()
                if job:
                    job.status = "complete"
                    job.progress = 100.0
                    job.stage = "upload"
                    job.updated_at = utcnow()
                db.commit()
            except Exception as exc:
                prj.status = "failed"
                prj.error = str(exc)
                prj.updated_at = utcnow()
                if job:
                    job.status = "failed"
                    job.error = str(exc)
                    job.updated_at = utcnow()
                db.commit()
                raise
        finally:
            db.close()

    queue.submit("ingest", project.id, body, settings, job_id=db_job.id, payload={"projectId": project.id, "url": payload.url})
    return {"jobId": db_job.id, "projectId": project.id, "status": "queued"}