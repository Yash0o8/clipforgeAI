"""Celery task wiring for ClipForge.

Used only when `JOB_QUEUE=celery`. Routes enqueue tasks by name; workers import this
module and execute the real pipeline/export/ingest functions.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from celery import Celery

from .config import get_settings
from .db import Job, new_session
from .jobs import JobContext

logger = logging.getLogger(__name__)

_settings = get_settings()
celery_app = Celery("clipforge", broker=_settings.redis_url, backend=_settings.redis_url)


class _TaskContext(JobContext):
    def __init__(self, job_id: str, project_id: str, kind: str):
        super().__init__(job_id=job_id, project_id=project_id, kind=kind)
        self.settings = get_settings()

    def report(self, stage: str | None, progress: float) -> None:
        # Persist coarse progress in DB for polling clients.
        try:
            with new_session() as db:
                job = db.query(Job).filter(Job.id == self.job_id).first()
                if not job:
                    return
                if stage:
                    job.stage = stage
                job.progress = float(progress)
                db.commit()
        except Exception:
            logger.exception("failed to persist celery task progress")


@celery_app.task(name="clipforge.process_project")
def process_project_task(job_id: str, project_id: str) -> dict[str, Any]:
    from .pipeline.runner import run_processing

    ctx = _TaskContext(job_id=job_id, project_id=project_id, kind="process")
    with new_session() as db:
        return run_processing(db, project_id, ctx)


@celery_app.task(name="clipforge.generate_project")
def generate_project_task(job_id: str, project_id: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    from .pipeline.runner import run_processing

    ctx = _TaskContext(job_id=job_id, project_id=project_id, kind="generate")
    payload = payload or {}
    with new_session() as db:
        return run_processing(
            db,
            project_id,
            ctx,
            min_duration=payload.get("minDuration"),
            max_duration=payload.get("maxDuration"),
            target_count=payload.get("targetCount"),
        )


@celery_app.task(name="clipforge.run_export")
def run_export_task(job_id: str, project_id: str) -> dict[str, Any]:
    from .pipeline.exports import run_export

    ctx = _TaskContext(job_id=job_id, project_id=project_id, kind="export")
    with new_session() as db:
        return run_export(db, job_id, ctx)


@celery_app.task(name="clipforge.ingest_youtube")
def ingest_youtube_task(job_id: str, project_id: str) -> dict[str, Any]:
    from .routes.ingest import _download_youtube
    from .storage import probe
    from .db import Project, utcnow

    ctx = _TaskContext(job_id=job_id, project_id=project_id, kind="ingest")
    settings = get_settings()
    with new_session() as db:
        prj = db.query(Project).filter(Project.id == project_id).first()
        job = db.query(Job).filter(Job.id == job_id).first()
        if prj is None or not prj.source_url:
            raise RuntimeError("Ingest project/source URL missing")
        try:
            if job:
                job.status = "running"
                db.commit()
            path, info = _download_youtube(prj.source_url, settings.upload_dir)
            media = probe(path)
            prj.asset_path = str(path.relative_to(settings.data_dir)).replace("\\", "/")
            prj.file_name = path.name
            prj.file_size = path.stat().st_size
            prj.duration_sec = float(media.duration_sec or 0.0)
            prj.width = media.width
            prj.height = media.height
            prj.asset_kind = "audio" if not media.has_video else "video"
            prj.title = prj.title or str(info.get("title") or "YouTube import")
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
            return {"projectId": project_id, "status": "complete"}
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
