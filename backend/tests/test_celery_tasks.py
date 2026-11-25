"""Celery worker wiring: task names and cross-process cancellation."""

from __future__ import annotations

import threading

import pytest

pytest.importorskip("celery")

from app.celery_tasks import WorkerContext, app as celery_app  # noqa: E402
from app.db import Job, Project  # noqa: E402
from app.jobs import CeleryQueueAdapter, CancelledError, JobRecord  # noqa: E402

EXPECTED_TASKS = {
    "clipforge.process_project",
    "clipforge.generate_project",
    "clipforge.run_export",
    "clipforge.ingest_youtube",
}


def test_worker_registers_every_queue_task_name():
    """CeleryQueueAdapter.send_task uses these exact names."""
    registered = set(celery_app.tasks)
    assert EXPECTED_TASKS <= registered


def test_worker_context_observes_persisted_cancellation(db_session):
    """The API sets a DB flag; the worker polls it between pipeline steps."""
    project = Project(id="prj_worker", title="Worker test", status="processing")
    job = Job(id="job_worker", project_id=project.id, kind="process", status="running")
    db_session.add_all([project, job])
    db_session.commit()

    context = WorkerContext(job.id, project.id, "process")
    assert context.cancelled() is False
    assert context.should_cancel() is False

    job.cancel_requested = True
    db_session.commit()

    assert context.cancelled() is True
    with pytest.raises(CancelledError):
        context.check_cancelled()


def test_adapter_stops_reporting_finished_worker_jobs_as_active(db_session):
    """The web process mirrors worker-written SQLite state before answering."""
    project = Project(id="prj_worker_sync", title="Sync test", status="ready")
    job = Job(
        id="job_worker_sync",
        project_id=project.id,
        kind="process",
        status="complete",
        progress=100.0,
    )
    db_session.add_all([project, job])
    db_session.commit()

    adapter = CeleryQueueAdapter.__new__(CeleryQueueAdapter)
    adapter._records = {}
    adapter._lock = threading.Lock()
    adapter._shutting_down = False
    record = JobRecord(
        id=job.id,
        project_id=project.id,
        kind="process",
        fn=lambda _ctx: None,
        status="queued",
    )
    adapter._records[record.id] = record

    assert record.status == "queued"
    assert adapter.active_for_project(project.id, kind="process") is None

    # The refresh happened inside active_for_project above.
    assert record.status == "complete"
    assert record.progress == 100.0
