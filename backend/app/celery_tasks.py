"""Optional Celery worker entry points for heavy pipeline/export jobs.

The app keeps its inline thread pool as the default so a fresh install needs
only Python + ffmpeg. Deployments that set ``JOB_QUEUE=celery`` run this module
as a worker::

    celery -A app.celery_tasks worker --loglevel=info --concurrency=2

Task names deliberately match those sent by
:class:`~app.jobs.CeleryQueueAdapter`. Each task reopens its own database
session — a worker process must never share the API's request-scoped session —
and derives progress from the same pipeline functions the inline queue uses.
"""

from __future__ import annotations

import logging
from typing import Any

from .config import get_settings
from .db import Job, new_session
from .jobs import CancelledError, JobContext, JobRecord

logger = logging.getLogger(__name__)

try:
    from celery import Celery  # type: ignore
except ImportError as exc:  # pragma: no cover - optional dependency
    raise RuntimeError(
        "Celery queue selected but celery is not installed. "
        "Install celery + redis, or set JOB_QUEUE=inline."
    ) from exc

_settings = get_settings()
app = Celery("clipforge", broker=_settings.redis_url, backend=_settings.redis_url)
app.conf.update(
    task_acks_late=True,
    task_track_started=True,
    worker_prefetch_multiplier=1,
)


class WorkerContext(JobContext):
    """JobContext whose cancellation flag comes from the persisted Job row.

    The web process sets ``Job.cancel_requested``; the worker process cannot see
    its in-memory event. Polling the row on every cancellation check keeps
    ``POST /projects/{id}/cancel`` and ``POST /exports/{id}/cancel`` working
    across processes without any extra IPC.
    """

    def __init__(self, job_id: str, project_id: str, kind: str) -> None:
        record = JobRecord(id=job_id, project_id=project_id, kind=kind, fn=lambda _ctx: None)
        super().__init__(record, _settings)

    def _sync_cancel(self) -> None:
        session = new_session()
        try:
            row = session.query(Job).filter(Job.id == self.job_id).first()
            if row is not None and row.cancel_requested:
                self._record._cancel.set()
        finally:
            session.close()

    def cancelled(self) -> bool:
        self._sync_cancel()
        return super().cancelled()

    def should_cancel(self) -> bool:
        self._sync_cancel()
        return super().should_cancel()

    def check_cancelled(self) -> None:
        self._sync_cancel()
        super().check_cancelled()


def _task_result(job_id: str, **extra: Any) -> dict[str, Any]:
    return {"jobId": job_id, "status": "complete", **extra}


@app.task(name="clipforge.process_project")
def process_project(job_id: str, project_id: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    """Run ingestion → transcript → highlight → clip preparation."""
    from .routes.projects import _run_process

    context = WorkerContext(job_id, project_id, "process")
    try:
        result = _run_process(new_session(), job_id, context)
        return _task_result(job_id, projectId=project_id, result=result)
    except CancelledError:
        return {"jobId": job_id, "status": "cancelled", "projectId": project_id}


@app.task(name="clipforge.generate_project")
def generate_project(job_id: str, project_id: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    """Re-score an existing project with edited clip constraints."""
    from .routes.projects import _run_process

    options = payload or {}
    context = WorkerContext(job_id, project_id, "generate")

    def number(key: str) -> float | None:
        try:
            value = float(options.get(key))
        except (TypeError, ValueError):
            return None
        return value if value > 0 else None

    try:
        result = _run_process(
            new_session(),
            job_id,
            context,
            min_duration=number("minDuration"),
            max_duration=number("maxDuration"),
            target_count=number("targetCount"),
        )
        return _task_result(job_id, projectId=project_id, result=result)
    except CancelledError:
        return {"jobId": job_id, "status": "cancelled", "projectId": project_id}


@app.task(name="clipforge.run_export")
def run_export(job_id: str, project_id: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    """Render one ExportJob, including 480p previews and caption-only reruns."""
    from .routes.exports import _run_export

    context = WorkerContext(job_id, project_id, "export")
    try:
        result = _run_export(job_id, context)
        return _task_result(job_id, projectId=project_id, result=result)
    except CancelledError:
        return {"jobId": job_id, "status": "cancelled", "projectId": project_id}


@app.task(name="clipforge.ingest_youtube")
def ingest_youtube(job_id: str, project_id: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    """Download a YouTube URL for a project already created by the API."""
    from .routes.ingest import run_youtube_ingest

    options = payload or {}
    url = str(options.get("url") or "").strip()
    if not url:
        raise ValueError("ingest task is missing its URL")
    context = WorkerContext(job_id, project_id, "ingest")
    try:
        result = run_youtube_ingest(url, project_id, job_id, context)
        return _task_result(job_id, projectId=project_id, result=result)
    except CancelledError:
        return {"jobId": job_id, "status": "cancelled", "projectId": project_id}
