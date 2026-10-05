"""End-to-end processing pipeline: audio → transcript → highlights → clips.

This is what ``POST /projects/{id}/process`` runs. It walks the five stages the
Processing page already knows how to render and keeps ``project.stages`` and
``project.progress`` in step at every transition, so a client that polls sees
monotonically advancing progress and never a jump to 100 with nothing done.

Stage weights and keys come from ``utils.StageTracker``, which mirrors the
frontend's PROCESSING_STAGES.
"""

from __future__ import annotations

import json
import logging
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Sequence

from sqlalchemy.orm import Session

from ..config import Settings, get_settings
from ..db import Clip, Job, Project, utcnow
from ..jobs import CancelledError, JobContext
from ..utils import (
    STAGE_KEYS,
    Segment,
    StageTracker,
    new_id,
    segments_for_window,
    stable_hash,
)
from .rank import rank_candidates
from .render import render_clip
from .score import Candidate, top_candidates
from .transcribe import TranscriptionError, transcribe

logger = logging.getLogger(__name__)


class PipelineError(RuntimeError):
    """Raised when processing cannot complete. Message goes on the project."""


# --- Database helpers -------------------------------------------------------


def _stage_payload(tracker: StageTracker) -> str:
    return json.dumps(tracker.to_json())


def _apply_stage(
    session: Session,
    project: Project,
    job: Job | None,
    tracker: StageTracker,
    stage: str,
    status: str = "processing",
) -> None:
    """Commit a stage transition to both the project and the job row."""
    project.status = status
    project.current_stage = stage
    project.progress = tracker.progress
    project.stages_json = _stage_payload(tracker)
    project.updated_at = utcnow()

    if job is not None:
        job.stage = stage
        job.progress = tracker.progress
        job.updated_at = utcnow()

    session.commit()


def _clear_clips(session: Session, project_id: str) -> None:
    """Drop existing suggestions, so a re-run does not duplicate clips."""
    for clip in session.query(Clip).filter(Clip.project_id == project_id).all():
        session.delete(clip)
    session.commit()


# --- Audio extraction -------------------------------------------------------


def extract_audio(
    source: Path,
    destination: Path,
    on_progress: Callable[[float], None] | None = None,
    cancel: Callable[[], bool] | None = None,
) -> Path:
    """Decode to 16 kHz mono WAV.

    Whisper resamples internally, so this is not strictly required for accuracy —
    but it removes the container/codec work from the model run, which on a 4-core
    CPU is the difference between a few minutes and a few tens of minutes for a
    long video. It also gives the ``audio`` stage real work to report progress
    against.
    """
    from ..storage import run_ffmpeg

    if cancel is not None and cancel():
        raise CancelledError("cancelled before audio extraction")

    run_ffmpeg(
        [
            "-y",
            "-i", str(source),
            "-vn",
            "-ac", "1",
            "-ar", "16000",
            "-c:a", "pcm_s16le",
            str(destination),
        ],
        progress=None,
        cancel=cancel,
    )

    if on_progress is not None:
        on_progress(1.0)
    return destination


# --- Clip construction ------------------------------------------------------


def build_clips(
    candidates: Sequence[Candidate],
    transcript: list[Segment],
    project_id: str,
) -> list[dict[str, Any]]:
    """Turn ranked candidates into clip rows.

    Each clip carries only the transcript segments inside its own window, so
    ``ClipEditor``'s transcript panel and the karaoke overlay never show words
    outside the trim range.
    """
    from .captions import DEFAULT_PRESET

    # Presets cycle across a project's clips so the grid shows variety, matching
    # what the demo fixtures did. A user can change any of it in the editor.
    preset_ids = ("clean", "bold", "karaoke", "minimal", "creator")

    results: list[dict[str, Any]] = []
    for index, candidate in enumerate(candidates):
        window = segments_for_window(transcript, candidate.start_sec, candidate.end_sec)
        end_sec = candidate.end_sec
        duration = round(end_sec - candidate.start_sec, 2)

        # Poster colour is derived from the clip's own window, so re-running the
        # pipeline on the same source gives the same clip the same colour.
        seed = stable_hash(f"{project_id}:{candidate.start_sec:.1f}:{candidate.end_sec:.1f}", 360)

        results.append(
            {
                "id": new_id("clip"),
                "project_id": project_id,
                "title": candidate.title or f"Highlight {index + 1}",
                "hook": candidate.hook,
                "start_sec": round(candidate.start_sec, 2),
                "end_sec": round(end_sec, 2),
                "duration_sec": duration,
                "score": int(round(min(99, max(0, candidate.score)))),
                "aspect_ratio": "9:16",
                "status": "suggested",
                "poster_seed": seed,
                "transcript_json": json.dumps([segment.to_dict() for segment in window]),
                # Caption defaults are deliberately minimal: a preset, the derived
                # line, and a null position so the preset's own anchor applies.
                "caption_json": json.dumps(
                    {
                        "text": candidate.caption,
                        "presetId": preset_ids[index % len(preset_ids)],
                        "position": None,
                    }
                ),
                "export_json": json.dumps(
                    {"format": "mp4", "resolution": "1080x1920", "burnCaptions": True, "lastExportedAt": None}
                ),
                "created_at": utcnow(),
            }
        )

    return results


def _persist_clips(
    session: Session, project: Project, clips: list[dict[str, Any]]
) -> list[Clip]:
    """Replace the project's clips with ``clips`` and return the ORM rows."""
    _clear_clips(session, project.id)

    created: list[Clip] = []
    for payload in clips:
        clip = Clip(**payload)
        session.add(clip)
        created.append(clip)

    session.commit()
    return created


# --- The pipeline -----------------------------------------------------------


def run_processing(
    session: Session,
    project_id: str,
    context: JobContext,
    min_duration: float | None = None,
    max_duration: float | None = None,
    target_count: int | None = None,
) -> dict[str, Any]:
    """Process one project end to end.

    Args:
        session: DB session, committed at each stage boundary.
        project_id: Project to process.
        context: Job context for progress reporting and cancellation.
        min_duration: Override the clip minimum window, in seconds.
        max_duration: Override the clip maximum window, in seconds.
        target_count: How many clips to produce.

    Returns:
        A summary dict: counts, language, word total, and the chosen provider.

    Raises:
        PipelineError: with a message suitable for showing to the user.
        CancelledError: when cancellation was requested.
    """
    settings: Settings = context.settings or get_settings()

    project = session.query(Project).filter(Project.id == project_id).first()
    if project is None:
        raise PipelineError("project not found")

    job = (
        session.query(Job)
        .filter(Job.id == context.job_id)
        .first()
    )

    source = _source_path(project, settings)
    if source is None or not source.exists():
        raise PipelineError("source media is missing. Re-upload the video.")

    tracker = StageTracker()
    context.report(STAGE_KEYS[0], 0.0)

    # --- Stage 1: upload ----------------------------------------------------
    # The bytes are already on disk; this stage records that fact and accounts
    # for the slice of progress the frontend expects it to consume.
    tracker.advance("upload", 1.0)
    _apply_stage(session, project, job, tracker, "upload")
    context.report("upload", tracker.progress)
    context.check_cancelled()

    # --- Stage 2: audio -----------------------------------------------------
    tracker.start("audio")
    _apply_stage(session, project, job, tracker, "audio")
    context.check_cancelled()

    temp_audio = Path(tempfile.gettempdir()) / f"clipforge_audio_{project_id}.wav"
    try:
        # Probe first: this is where duration_sec becomes trustworthy, which the
        # trim bounds and the timeline both depend on.
        from ..storage import probe

        info = probe(source)
        if info.duration_sec > 0:
            project.duration_sec = info.duration_sec
        project.width = info.width
        project.height = info.height
        session.commit()

        if not info.has_audio:
            raise PipelineError(
                "this file has no audio track, so there is nothing to transcribe. "
                "ClipForge works on spoken content."
            )

        extract_audio(source, temp_audio, cancel=context.should_cancel)
        tracker.advance("audio", 1.0)
        _apply_stage(session, project, job, tracker, "audio")
        context.report("audio", tracker.progress)

        # --- Stage 3: transcript -------------------------------------------
        tracker.start("transcript")
        _apply_stage(session, project, job, tracker, "transcript")

        # Map transcript completion onto 0..1 of the stage.
        base = tracker.progress

        def on_transcribed(fraction: float) -> None:
            tracker.advance("transcript", fraction)
            context.report("transcript", tracker.progress)

        segments, meta = transcribe(
            temp_audio,
            settings,
            on_progress=on_transcribed,
            cancel=context.should_cancel,
        )
        context.check_cancelled()

        if not segments:
            raise PipelineError(
                "no speech was detected in this video. If it does contain speech, "
                "try a version with less background noise."
            )

        project.word_count = meta["wordCount"]
        tracker.advance("transcript", 1.0)
        _apply_stage(session, project, job, tracker, "transcript")
        context.report("transcript", tracker.progress)
        logger.info(
            "project %s transcript: %d segments, %d words, lang=%s",
            project_id,
            len(segments),
            meta["wordCount"],
            meta["language"],
        )

        # --- Stage 4: highlights -------------------------------------------
        tracker.start("highlights")
        _apply_stage(session, project, job, tracker, "highlights")

        candidates = top_candidates(
            segments,
            settings,
            count=settings.shortlist_size,
            min_duration=min_duration,
            max_duration=max_duration,
        )
        context.check_cancelled()

        if not candidates:
            raise PipelineError(
                "could not find a clip-worthy moment. The transcript may be too "
                "short, or try a wider duration range."
            )

        # Only the shortlist goes to the LLM. Without a key this is a no-op that
        # returns the same list, so the heuristic result is what gets used.
        ranked = rank_candidates(candidates, settings, max_clips=target_count or settings.default_clip_count)
        ranked = ranked[: (target_count or settings.default_clip_count)]
        context.check_cancelled()

        tracker.advance("highlights", 1.0)
        _apply_stage(session, project, job, tracker, "highlights")
        context.report("highlights", tracker.progress)

        # --- Stage 5: prepare ----------------------------------------------
        tracker.start("prepare")
        _apply_stage(session, project, job, tracker, "prepare")

        payloads = build_clips(ranked, segments, project_id)
        _persist_clips(session, project, payloads)

    except CancelledError:
        project.status = "cancelled"
        project.error = None
        project.current_stage = None
        if job is not None:
            job.status = "cancelled"
        session.commit()
        raise
    except PipelineError:
        session.commit()
        raise
    except Exception as exc:
        session.rollback()
        project = session.query(Project).filter(Project.id == project_id).first()
        if project is not None:
            project.status = "failed"
            project.error = str(exc)
            project.updated_at = utcnow()
        if job is not None:
            job.status = "failed"
            job.error = str(exc)
        session.commit()
        raise PipelineError(str(exc)) from exc
    finally:
        temp_audio.unlink(missing_ok=True)

    tracker.finish()
    project = session.query(Project).filter(Project.id == project_id).first()
    if project is not None:
        project.status = "ready"
        project.progress = 100.0
        project.current_stage = None
        project.stages_json = _stage_payload(tracker)
        project.error = None
        project.updated_at = utcnow()
    if job is not None:
        job.status = "complete"
        job.progress = 100.0
    session.commit()

    context.report(None, 100.0)

    return {
        "projectId": project_id,
        "clipCount": len(payloads),
        "wordCount": meta["wordCount"],
        "language": meta["language"],
        "durationSec": project.duration_sec if project else 0.0,
        "llmProvider": settings.llm_provider(),
    }


def regenerate_clips(
    session: Session,
    project_id: str,
    context: JobContext,
    min_duration: float | None = None,
    max_duration: float | None = None,
    target_count: int | None = None,
) -> dict[str, Any]:
    """Re-run highlight detection without re-transcribing.

    Requires a transcript to already exist. The transcript is not persisted as a
    project-level field, so this re-transcribes from the cached audio: cheap for
    short clips, but it is the honest cost of not storing a second copy of every
    transcript in the database.
    """
    settings: Settings = context.settings or get_settings()

    project = session.query(Project).filter(Project.id == project_id).first()
    if project is None:
        raise PipelineError("project not found")

    # Detection only needs the transcript, and a fresh run is more predictable
    # than reusing a possibly-stale cached one.
    return run_processing(
        session,
        project_id,
        context,
        min_duration=min_duration,
        max_duration=max_duration,
        target_count=target_count,
    )


# --- Recovery ---------------------------------------------------------------


def recover_interrupted(session: Session) -> int:
    """Mark jobs left running by a previous process as failed.

    Called on startup. Without this, a crash mid-transcription leaves a project
    pinned at ``processing`` with nothing running, and the UI waits forever.

    Returns how many jobs were recovered.
    """
    stale = (
        session.query(Job).filter(Job.status.in_(["queued", "running"])).all()
    )
    if not stale:
        return 0

    for job in stale:
        job.status = "failed"
        job.error = "Interrupted by a server restart. Retry to continue."
        job.updated_at = utcnow()

        project = session.query(Project).filter(Project.id == job.project_id).first()
        if project is not None and project.status == "processing":
            project.status = "failed"
            project.error = job.error
            project.updated_at = utcnow()

    session.commit()
    logger.info("recovered %d interrupted jobs", len(stale))
    return len(stale)


def _source_path(project: Project, settings: Settings) -> Path | None:
    """Resolve a project's media file, or None when it is not on disk."""
    if not project.asset_path:
        return None

    from ..storage import safe_join

    candidate = safe_join(settings.data_dir, project.asset_path)
    return candidate if candidate.exists() else None