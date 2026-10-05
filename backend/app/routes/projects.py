"""Project resources.

Maps onto the calls in ``src/services/projectService.js``. Note that project
serialisation happens in ``db.Project.to_dict`` — these routes are thin on
purpose, so the wire shape has exactly one definition.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import Clip, ExportJob, Job, Project, get_session, new_session, utcnow
from ..jobs import JobContext, get_queue
from ..pipeline.runner import PipelineError, recover_interrupted, run_processing
from ..schemas import ProjectCreate, ProjectPatch
from ..storage import probe
from ..utils import new_id, stable_hash
from .upload_store import get_session as get_upload_session

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/projects", tags=["projects"])

# The five stage keys and weights, matching src/utils/constants.js. Kept as a
# literal here so a fresh project renders a complete stepper before any work runs.
INITIAL_STAGES: list[dict[str, Any]] = [
    {"key": "upload", "progress": 0, "status": "idle"},
    {"key": "audio", "progress": 0, "status": "idle"},
    {"key": "transcript", "progress": 0, "status": "idle"},
    {"key": "highlights", "progress": 0, "status": "idle"},
    {"key": "prepare", "progress": 0, "status": "idle"},
]


def get_project_or_404(session: Session, project_id: str) -> Project:
    project = session.query(Project).filter(Project.id == project_id).first()
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


@router.get("")
def list_projects(
    session: Session = Depends(get_session),
    status_filter: str | None = Query(default=None, alias="status"),
) -> list[dict[str, Any]]:
    """All projects, newest first. Optional ``?status=ready`` filter."""
    query = session.query(Project)
    if status_filter:
        query = query.filter(Project.status == status_filter)
    return [project.to_dict() for project in query.order_by(Project.created_at.desc()).all()]


@router.post("", status_code=status.HTTP_201_CREATED)
def create_project(payload: ProjectCreate, session: Session = Depends(get_session)) -> dict[str, Any]:
    """Create a project, linking it to an uploaded asset when given an uploadId.

    ffprobe runs here rather than at processing time so the project has a real
    duration immediately — the upload page shows it, and the editor's trim bounds
    depend on it.
    """
    settings = get_settings()

    asset_path: str | None = None
    file_name = payload.fileName
    file_size = payload.fileSize
    duration = payload.durationSec
    width: int | None = None
    height: int | None = None
    mime = payload.mimeType

    if payload.uploadId:
        upload = get_upload_session(payload.uploadId)
        if upload is None:
            raise HTTPException(status_code=404, detail="Upload session not found")
        if upload.status != "complete":
            raise HTTPException(
                status_code=409, detail="Upload has not been finalised yet"
            )
        # Reconstruct the path the same way assemble() derived it.
        asset_path = f"uploads/{upload.id}-{upload.file_name}"
        # The upload session is the authority on what actually arrived, so trust
        # it over what the client claims about its own file. The frontend only
        # sends title/durationSec/uploadId, so inheriting here is what makes
        # fileName and fileSize populated at all.
        file_name = upload.file_name
        file_size = upload.file_size
        mime = upload.mime_type
    else:
        mime = payload.mimeType

    if asset_path:
        from ..storage import StorageError, safe_join

        try:
            source = safe_join(settings.data_dir, asset_path)
            info = probe(source)
        except StorageError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

        duration = info.duration_sec or duration
        width, height = info.width, info.height
        asset_kind = "audio" if not info.has_video else "video"
    else:
        asset_kind = "video"

    project = Project(
        id=new_id("prj"),
        title=payload.title,
        source="upload",
        file_name=file_name,
        file_size=file_size,
        mime_type=mime,
        duration_sec=duration,
        width=width,
        height=height,
        status="draft",
        progress=0.0,
        current_stage="upload",
        stages_json=json.dumps(INITIAL_STAGES),
        asset_path=asset_path,
        asset_kind=asset_kind,
    )
    session.add(project)
    session.commit()

    logger.info("created project %s (%s)", project.id, project.title)
    return project.to_dict()


@router.get("/{project_id}")
def get_project(project_id: str, session: Session = Depends(get_session)) -> dict[str, Any]:
    return get_project_or_404(session, project_id).to_dict()


@router.patch("/{project_id}")
def update_project(
    project_id: str,
    payload: ProjectPatch,
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    project = get_project_or_404(session, project_id)

    if payload.title is not None:
        project.title = payload.title.strip() or project.title
    if payload.status is not None:
        project.status = payload.status
    project.updated_at = utcnow()

    session.commit()
    return project.to_dict()


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project(project_id: str, session: Session = Depends(get_session)) -> Response:
    """Delete a project, its clips, its jobs, and every derived file."""
    project = get_project_or_404(session, project_id)

    # Cancel anything still running so it does not write into deleted rows.
    get_queue().cancel_for_project(project_id)

    settings = get_settings()

    for clip in session.query(Clip).filter(Clip.project_id == project_id).all():
        session.delete(clip)
    for job in session.query(Job).filter(Job.project_id == project_id).all():
        session.delete(job)
    for export in session.query(ExportJob).filter(ExportJob.project_id == project_id).all():
        _delete_file(settings.data_dir, export.render_path)
        session.delete(export)

    _delete_file(settings.data_dir, project.asset_path)

    session.delete(project)
    session.commit()

    logger.info("deleted project %s", project_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{project_id}/clips")
def list_clips(project_id: str, session: Session = Depends(get_session)) -> list[dict[str, Any]]:
    """Clip suggestions, best score first. Matches ``clipService.listClips``."""
    get_project_or_404(session, project_id)
    clips = (
        session.query(Clip)
        .filter(Clip.project_id == project_id)
        .order_by(Clip.score.desc(), Clip.created_at.asc())
        .all()
    )
    return [clip.to_dict() for clip in clips]


@router.post("/{project_id}/process", status_code=status.HTTP_202_ACCEPTED)
def process_project(project_id: str, session: Session = Depends(get_session)) -> dict[str, Any]:
    """Queue the transcription + highlight pipeline.

    Returns a job descriptor. The client polls ``GET /projects/{id}`` for
    ``stages``/``progress``, which is what ``Processing.jsx`` renders.
    """
    project = get_project_or_404(session, project_id)

    if not project.asset_path:
        raise HTTPException(status_code=422, detail="This project has no uploaded video")

    queue = get_queue()
    settings = get_settings()

    existing = queue.active_for_project(project_id, kind="process")
    if existing is not None:
        # Idempotent: a double-click on "Process" should not queue two runs.
        return {
            "jobId": existing.id,
            "status": existing.status,
            "projectId": project_id,
            "progress": existing.progress,
            "stage": existing.stage,
        }

    project.status = "processing"
    project.error = None
    project.progress = 0.0
    project.current_stage = "upload"
    project.stages_json = json.dumps(INITIAL_STAGES)
    project.updated_at = utcnow()

    db_job = Job(
        id=new_id("job"),
        project_id=project_id,
        kind="process",
        status="queued",
        stage="upload",
        progress=0.0,
    )
    session.add(db_job)
    session.commit()

    # The queue reuses ``db_job.id`` so the in-memory record and the persisted
    # row are one job. The pipeline runner finds its row through
    # ``context.job_id``; with two independent IDs it would never find it, and
    # every progress update and error would be dropped.
    queue.submit(
        "process",
        project_id,
        lambda ctx: _run_process(session_factory(), db_job.id, ctx),
        settings,
        job_id=db_job.id,
    )

    return {
        "jobId": db_job.id,
        "status": "queued",
        "projectId": project_id,
        "progress": 0,
        "stage": "upload",
    }


@router.post("/{project_id}/cancel")
def cancel_project(project_id: str, session: Session = Depends(get_session)) -> dict[str, Any]:
    """Request cancellation of a running pipeline job."""
    project = get_project_or_404(session, project_id)

    cancelled = get_queue().cancel_for_project(project_id, kind="process")

    # Also flip the persisted flag, so a job that starts after this still stops.
    for job in session.query(Job).filter(Job.project_id == project_id, Job.status.in_(["queued", "running"])):
        job.cancel_requested = True
        job.status = "cancelled"
        job.updated_at = utcnow()

    if project.status == "processing":
        project.status = "cancelled"
        project.error = None
        project.updated_at = utcnow()

    session.commit()

    return {
        "jobId": None,
        "status": "cancelled" if cancelled or project.status == "cancelled" else "idle",
        "projectId": project_id,
        "cancelled": bool(cancelled),
    }


@router.post("/{project_id}/clips/generate", status_code=status.HTTP_202_ACCEPTED)
def generate_clips(
    project_id: str,
    payload: dict[str, Any],
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    """Re-run highlight detection with different parameters.

    Matches ``clipService.generateClips(projectId, { minDuration, maxDuration,
    targetCount })``.
    """
    project = get_project_or_404(session, project_id)

    if not project.asset_path:
        raise HTTPException(status_code=422, detail="This project has no uploaded video")

    queue = get_queue()
    settings = get_settings()

    min_duration = _positive(payload.get("minDuration"))
    max_duration = _positive(payload.get("maxDuration"))
    target_count = _positive(payload.get("targetCount"))

    existing = queue.active_for_project(project_id, kind="generate")
    if existing is not None:
        return {"jobId": existing.id, "status": existing.status, "projectId": project_id}

    db_job = Job(
        id=new_id("job"),
        project_id=project_id,
        kind="generate",
        status="queued",
        stage="highlights",
        progress=0.0,
    )
    session.add(db_job)

    project.status = "processing"
    project.error = None
    project.current_stage = "highlights"
    project.updated_at = utcnow()

    session.commit()

    def body(ctx: JobContext):
        return _run_process(
            session_factory(),
            db_job.id,
            ctx,
            min_duration=min_duration,
            max_duration=max_duration,
            target_count=target_count,
        )

    queue.submit("generate", project_id, body, settings)

    return {
        "jobId": db_job.id,
        "status": "queued",
        "projectId": project_id,
        "minDuration": min_duration,
        "maxDuration": max_duration,
        "targetCount": target_count,
    }


@router.get("/{project_id}/jobs")
def list_jobs(project_id: str, session: Session = Depends(get_session)) -> list[dict[str, Any]]:
    """Job history for a project, newest first."""
    get_project_or_404(session, project_id)
    jobs = (
        session.query(Job)
        .filter(Job.project_id == project_id)
        .order_by(Job.created_at.desc())
        .all()
    )
    return [job.to_dict() for job in jobs]


# --- Helpers ----------------------------------------------------------------


def _run_process(
    db_session: Session,
    job_id: str,
    context: JobContext,
    min_duration: float | None = None,
    max_duration: float | None = None,
    target_count: int | None = None,
):
    """Adapter between the job body signature and the pipeline function.

    The pipeline takes its own session because the job runs on a worker thread;
    reusing the request-scoped one would be a cross-thread violation.
    """
    try:
        return run_processing(
            db_session,
            context.project_id,
            context,
            min_duration=min_duration,
            max_duration=max_duration,
            target_count=target_count,
        )
    except PipelineError as exc:
        # Already recorded on the project; the queue records it on the job.
        logger.info("pipeline %s reported: %s", job_id, exc)
        raise
    finally:
        db_session.close()


def session_factory() -> Session:
    """A fresh session for worker-thread use."""
    return new_session()


def _positive(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def _delete_file(data_dir, relative: str | None) -> None:
    """Remove a file under the data dir, ignoring anything already gone."""
    if not relative:
        return
    from ..storage import safe_join  # noqa: PLC0415

    try:
        safe_join(data_dir, relative).unlink(missing_ok=True)
    except (OSError, ValueError):
        logger.debug("could not delete %s", relative, exc_info=True)


def recover_jobs(session: Session) -> int:
    """Startup hook: fail anything left running by a dead process."""
    return recover_interrupted(session)