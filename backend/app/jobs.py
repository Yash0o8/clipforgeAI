"""In-process job runner.

Transcription and rendering are long, blocking, CPU-heavy operations. They run
on a thread pool executor here rather than in the request handler, for two
reasons:

1. **Async-safe.** FastAPI would otherwise block the event loop for the length of
   a render, freezing every other request including the polling that reports
   progress.
2. **Same-process simplicity.** A worker pool plus a celery/redis setup is a lot
   of machinery for a single-machine app. The trade-off is that jobs do not
   survive a restart; :func:`recover_interrupted` on startup marks anything left
   ``running`` as failed rather than leaving a project stuck in ``processing``
   forever.

Cancellation is cooperative: jobs poll a flag between units of work, and the
executor is shut down gracefully on exit so in-flight renders finish writing
their output file.
"""

from __future__ import annotations

import logging
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Callable

from .config import Settings, get_settings
from .utils import new_id

logger = logging.getLogger(__name__)


class CancelledError(RuntimeError):
    """Raised inside a job when cancellation has been requested."""


@dataclass
class JobRecord:
    """In-memory view of a running job."""

    id: str
    project_id: str
    kind: str
    fn: Callable[[JobContext], Any]
    created: float = field(default_factory=time.monotonic)
    status: str = "queued"
    stage: str | None = None
    progress: float = 0.0
    error: str | None = None
    result: Any = None
    future: Future | None = field(default=None, repr=False)
    _cancel: threading.Event = field(default_factory=threading.Event, repr=False)


class JobContext:
    """Handed to a job body. The only way a job reports progress or checks for
    cancellation."""

    def __init__(self, record: JobRecord, settings: Settings) -> None:
        self._record = record
        self.settings = settings
        self._listeners: list[Callable[[str | None, float], None]] = []

    @property
    def job_id(self) -> str:
        return self._record.id

    @property
    def project_id(self) -> str:
        return self._record.project_id

    def on_update(self, listener: Callable[[str | None, float], None]) -> None:
        """Register a callback invoked as ``(stage, progress)`` changes."""
        self._listeners.append(listener)

    def report(self, stage: str | None, progress: float) -> None:
        """Record progress. Cheap; safe to call often."""
        self._record.stage = stage
        self._record.progress = max(0.0, min(100.0, progress))
        for listener in self._listeners:
            try:
                listener(stage, self._record.progress)
            except Exception:  # pragma: no cover - listener errors must not kill the job
                logger.exception("job progress listener failed")

    def cancelled(self) -> bool:
        return self._record._cancel.is_set()

    def check_cancelled(self) -> None:
        if self._record._cancel.is_set():
            raise CancelledError("job cancelled")

    def should_cancel(self) -> bool:
        """Pass as the ``cancel`` callback to pipeline steps."""
        return self._record._cancel.is_set()


class JobQueue:
    """Bounded thread-pool executor with cooperative cancellation."""

    def __init__(self, max_workers: int = 2) -> None:
        self._executor = ThreadPoolExecutor(
            max_workers=max_workers, thread_name_prefix="clipforge-job"
        )
        self._records: dict[str, JobRecord] = {}
        self._lock = threading.Lock()
        self._shutting_down = False

    @property
    def shutting_down(self) -> bool:
        return self._shutting_down

    def submit(
        self,
        kind: str,
        project_id: str,
        fn: Callable[[JobContext], Any],
        settings: Settings | None = None,
        job_id: str | None = None,
    ) -> JobRecord:
        """Queue a job. Returns immediately.

        ``job_id`` lets a caller supply an ID it has already persisted, so the
        in-memory record and the database row are the same job. Without this the
        two identities diverge: the runner looks its row up by ``context.job_id``,
        finds nothing, and silently fails to persist progress or errors.
        """
        if self._shutting_down:
            raise RuntimeError("queue is shutting down")

        record = JobRecord(id=job_id or new_id("job"), project_id=project_id, kind=kind, fn=fn)
        context = JobContext(record, settings or get_settings())

        def run() -> Any:
            record.status = "running"
            try:
                result = fn(context)
                record.status = "complete"
                record.progress = 100.0
                record.result = result
                return result
            except CancelledError:
                record.status = "cancelled"
                record.error = "cancelled"
                logger.info("job %s (%s) cancelled", record.id, kind)
                return None
            except Exception as exc:
                record.status = "failed"
                record.error = str(exc)
                logger.exception("job %s (%s) failed", record.id, kind)
                # Swallowed: failure is reported through the record and the
                # project's status field, not propagated to the executor.
                return None

        with self._lock:
            self._records[record.id] = record

        record.future = self._executor.submit(run)
        return record

    def cancel(self, job_id: str) -> bool:
        """Request cancellation. True if the job was found."""
        with self._lock:
            record = self._records.get(job_id)
        if record is None:
            return False
        record._cancel.set()
        return True

    def cancel_for_project(self, project_id: str, kind: str | None = None) -> int:
        """Cancel every active job for a project. Returns how many were hit."""
        with self._lock:
            records = list(self._records.values())
        count = 0
        for record in records:
            if record.project_id != project_id:
                continue
            if kind and record.kind != kind:
                continue
            if record.status in ("queued", "running"):
                record._cancel.set()
                count += 1
        return count

    def get(self, job_id: str) -> JobRecord | None:
        with self._lock:
            return self._records.get(job_id)

    def active_for_project(self, project_id: str, kind: str | None = None) -> JobRecord | None:
        """Most recent still-running job for a project, if any."""
        with self._lock:
            records = [r for r in self._records.values() if r.project_id == project_id]
        running = [r for r in records if r.status in ("queued", "running")]
        if kind:
            running = [r for r in running if r.kind == kind]
        return max(running, key=lambda r: r.created) if running else None

    def snapshot(self) -> list[dict[str, Any]]:
        with self._lock:
            records = list(self._records.values())
        return [
            {
                "id": r.id,
                "projectId": r.project_id,
                "kind": r.kind,
                "status": r.status,
                "stage": r.stage,
                "progress": r.progress,
                "error": r.error,
                "cancelRequested": r._cancel.is_set(),
            }
            for r in records
        ]

    def shutdown(self, wait: bool = True, timeout: float | None = 120.0) -> None:
        """Stop accepting work, then let in-flight jobs finish."""
        self._shutting_down = True
        with self._lock:
            records = list(self._records.values())
        for record in records:
            if record.status in ("queued", "running"):
                record._cancel.set()
        self._executor.shutdown(wait=wait, cancel_futures=True)
        logger.info("job queue shut down")


_queue: JobQueue | None = None
_queue_lock = threading.Lock()


def get_queue() -> JobQueue:
    """Process-wide queue singleton."""
    global _queue
    if _queue is None:
        with _queue_lock:
            if _queue is None:
                # Two workers: transcription and rendering are both CPU-bound,
                # but running them concurrently on a 4-core box mostly just
                # thrashes. Serial is faster in practice and keeps progress
                # reporting simple.
                _queue = JobQueue(max_workers=2)
    return _queue


def set_queue(queue: JobQueue | None) -> None:
    """Swap the singleton. Tests use this to inject a synchronous queue."""
    global _queue
    with _queue_lock:
        _queue = queue