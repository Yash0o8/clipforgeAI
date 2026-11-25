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
import time
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
from .score import Candidate, signal_only_candidates, top_candidates
from .transcribe import TranscriptionError, transcribe
from .analysis import (
    detect_audio_spikes,
    detect_dead_air_intervals,
    detect_face_tracks,
    detect_scene_cuts,
    suggest_facecam_box,
)

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


def _persist_progress(
    session: Session,
    project: Project,
    job: Job | None,
    tracker: StageTracker,
    stage: str | None,
    processing_meta: dict[str, Any] | None,
) -> None:
    """Persist a frequent progress tick to the row the UI actually polls.

    ``_apply_stage`` handles stage boundaries. This handles the long middle of
    transcription, where the old code only updated an in-memory job record and
    left the project frozen at 32% for the entire 100-minute job.
    """
    # A final context.report(100) fires after the job has already been marked
    # ready. Never rewrite a terminal row — doing so used to flip finished
    # projects back to "processing" with the last stage still selected.
    if project.status in ("ready", "failed", "cancelled"):
        if job is not None:
            job.stage = stage
            job.progress = tracker.progress
            job.updated_at = utcnow()
            session.commit()
        return

    project.status = "processing"
    project.current_stage = stage or tracker.current_stage()
    project.progress = tracker.progress
    project.stages_json = _stage_payload(tracker)
    project.updated_at = utcnow()

    if processing_meta is not None:
        current = json.loads(project.settings_json or "{}")
        current["_processing"] = processing_meta
        project.settings_json = json.dumps(current)

    if job is not None:
        job.stage = project.current_stage
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
    *,
    project_preset: str | None = None,
    project_settings: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Turn ranked candidates into clip rows."""
    project_settings = project_settings or {}
    preset = (project_preset or "podcast").strip().lower()
    render_mode = project_settings.get("renderMode") or (
        "split_screen" if preset == "split_screen" else "gaming" if preset == "gaming" else "default"
    )
    default_caption = project_settings.get("captionPreset")
    if not default_caption:
        default_caption = "split_center" if preset == "split_screen" else "hormozi" if preset == "podcast" else "bold"

    preset_cycle = {
        "podcast": ("hormozi", "bold", "clean", "creator", "minimal"),
        "split_screen": ("split_center", "hormozi", "bold", "clean", "creator"),
        "gaming": ("bold", "hormozi", "clean", "creator", "minimal"),
    }.get(preset, ("hormozi", "bold", "karaoke", "split_center", "creator"))

    results: list[dict[str, Any]] = []
    for index, candidate in enumerate(candidates):
        window = segments_for_window(transcript, candidate.start_sec, candidate.end_sec)
        end_sec = candidate.end_sec
        duration = round(end_sec - candidate.start_sec, 2)
        seed = stable_hash(f"{project_id}:{candidate.start_sec:.1f}:{candidate.end_sec:.1f}", 360)
        viral = int(getattr(candidate, "viral_score", 0) or round(candidate.score))
        caption_preset = preset_cycle[index % len(preset_cycle)] if index else default_caption

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
                "viral_score": max(0, min(100, viral)),
                "aspect_ratio": "9:16",
                "status": "suggested",
                "poster_seed": seed,
                "transcript_json": json.dumps([segment.to_dict() for segment in window]),
                "caption_json": json.dumps(
                    {
                        "text": candidate.caption,
                        "presetId": caption_preset,
                        "position": "divider" if caption_preset == "split_center" or render_mode == "split_screen" else None,
                        "keywordHighlight": True,
                    }
                ),
                "export_json": json.dumps(
                    {
                        "format": "mp4",
                        "resolution": "1080x1920",
                        "burnCaptions": True,
                        "renderMode": render_mode,
                        "backgroundAssetId": project_settings.get("backgroundAssetId"),
                        "preview": False,
                        "watermark": False,
                        "lastExportedAt": None,
                    }
                ),
                "meta_json": json.dumps(
                    {
                        "viralScore": max(0, min(100, viral)),
                        "hookBanner": getattr(candidate, "hook_banner", "") or candidate.hook,
                        "keywords": getattr(candidate, "keywords", []) or [],
                        "hashtags": getattr(candidate, "hashtags", []) or [],
                        "description": getattr(candidate, "description", "") or candidate.hook,
                        "reason": candidate.components.get("reason", "") if isinstance(candidate.components, dict) else "",
                        "projectPreset": preset,
                        "renderMode": render_mode,
                    }
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

    # The Processing page polls the project row, not the in-memory job record.
    # Register a throttled listener so every meaningful transcript tick reaches
    # that row without turning a 100-minute job into 100-minute DB write storm.
    processing_meta: dict[str, Any] = {
        "startedAt": utcnow().isoformat(),
        "transcriptProgress": 0.0,
        "processedSec": 0.0,
        "wordCount": 0,
        "provider": "local",
        "model": settings.whisper_model,
        "fastMode": False,
    }
    last_persist_value = [-1.0]
    last_persist_time = [0.0]

    def persist_progress(stage: str | None, progress: float, force: bool = False) -> None:
        # The terminal report is emitted after finalization; applying it here
        # would resurrect the "processing" state we just cleared above.
        if stage is None or progress >= 100:
            return
        now = time.monotonic()
        if (
            not force
            and abs(progress - last_persist_value[0]) < 1.0
            and now - last_persist_time[0] < 1.5
        ):
            return
        last_persist_value[0] = progress
        last_persist_time[0] = now
        try:
            _persist_progress(session, project, job, tracker, stage, processing_meta)
        except Exception:  # pragma: no cover - progress must never kill a job
            logger.exception("could not persist progress for project %s", project_id)

    context.on_update(persist_progress)
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

        run_settings = settings
        project_settings = json.loads(project.settings_json or "{}")
        transcription_hint = project_settings.get("transcriptionHint") or project_settings.get("transcription_hint")
        if transcription_hint:
            try:
                run_settings = settings.model_copy(update={"transcription_hint": str(transcription_hint)})
            except Exception:
                run_settings = settings

        quality = (
            project_settings.get("transcriptionQuality")
            or project_settings.get("transcription_quality")
        )
        plan = settings.transcription_plan(project.duration_sec, quality)
        processing_meta.update(
            {
                "provider": plan["provider"],
                "model": plan["model"],
                "fastMode": plan["fastMode"],
                "quality": plan["quality"],
            }
        )
        logger.info(
            "project %s transcription plan: model=%s beam=%s provider=%s fast=%s",
            project_id,
            plan["model"],
            plan["beamSize"],
            plan["provider"],
            plan["fastMode"],
        )

        # Map transcript completion onto 0..1 of the stage.
        reported = [0.0]

        def on_transcribed(fraction: float) -> None:
            frac = fraction
            if frac <= 0.0:
                frac = min(0.05, reported[0] + 0.002)
            if frac < reported[0]:
                frac = reported[0]
            if frac > 0.98:
                frac = 0.98
            reported[0] = frac
            processing_meta["transcriptProgress"] = round(frac * 100, 1)
            processing_meta["processedSec"] = round(
                frac * max(0.0, project.duration_sec or 0.0), 1
            )
            tracker.advance("transcript", frac)
            context.report("transcript", tracker.progress)

        # Initial heartbeat to show activity during model load.
        try:
            on_transcribed(0.02)
        except Exception:
            pass

        segments, meta = transcribe(
            temp_audio,
            run_settings,
            on_progress=on_transcribed,
            cancel=context.should_cancel,
            plan=plan,
        )
        context.check_cancelled()

        if not segments:
            # Silent gameplay/screen recordings are valid source material. Keep
            # going and pick moments from audio spikes/scene cuts instead of
            # failing the whole project at 32%.
            logger.info("project %s has no speech; using signal-only highlights", project_id)
            processing_meta["noSpeech"] = True

        project.word_count = meta["wordCount"]
        processing_meta.update(
            {
                "transcriptProgress": 100.0,
                "processedSec": round(float(project.duration_sec or 0.0), 1),
                "wordCount": int(meta["wordCount"]),
                "provider": meta.get("provider") or plan["provider"],
            }
        )
        tracker.advance("transcript", 1.0)
        _apply_stage(session, project, job, tracker, "transcript")
        persist_progress("transcript", tracker.progress, force=True)
        logger.info(
            "project %s transcript: %d segments, %d words, lang=%s",
            project_id,
            len(segments),
            meta["wordCount"],
            meta["language"],
        )

        # Optional mode analysis (best-effort, dependency-gated).
        preset = (project.preset_id or "podcast").lower()
        analysis: dict[str, Any] = {}
        try:
            if preset in ("podcast", "gaming") and settings.enable_face_tracking:
                analysis["faceTracks"] = detect_face_tracks(source, sample_fps=settings.face_tracking_sample_fps)
                if preset == "gaming":
                    facecam_box = suggest_facecam_box(analysis.get("faceTracks") or [])
                    if facecam_box:
                        analysis["facecamBoxSuggestion"] = facecam_box
            # Audio spikes are cheap and useful for all modes.
            if settings.enable_audio_spike_detection:
                analysis["audioSpikes"] = detect_audio_spikes(source)
            # Scene cuts help podcast punch-ins and gaming/split action selection.
            if settings.enable_scene_cut_detection and preset in ("podcast", "gaming", "split_screen"):
                analysis["sceneCuts"] = detect_scene_cuts(source)
            # Dead-air removal is most useful for podcast/gaming pacing.
            if settings.enable_dead_air_removal and preset in ("podcast", "gaming"):
                analysis["deadAirIntervals"] = detect_dead_air_intervals(source)
        except Exception:
            logger.exception("optional analysis failed for project %s", project_id)
        if analysis:
            project_settings.update(analysis)
            project.settings_json = json.dumps(project_settings)
            session.commit()

        # --- Stage 4: highlights -------------------------------------------
        tracker.start("highlights")
        _apply_stage(session, project, job, tracker, "highlights")

        signal_kwargs = {
            "audio_spikes": project_settings.get("audioSpikes"),
            "scene_cuts": project_settings.get("sceneCuts"),
            "face_tracks": project_settings.get("faceTracks"),
        }
        candidates = top_candidates(
            segments,
            settings,
            count=settings.shortlist_size,
            min_duration=min_duration,
            max_duration=max_duration,
            **signal_kwargs,
        )
        if not candidates:
            # No usable transcript windows: fall back to action/audio signals.
            candidates = signal_only_candidates(
                project.duration_sec or float(meta.get("duration") or 0.0),
                settings,
                count=settings.shortlist_size,
                min_duration=min_duration,
                max_duration=max_duration,
                **signal_kwargs,
            )
        context.check_cancelled()

        if not candidates:
            raise PipelineError(
                "could not find a clip-worthy moment. The transcript may be too "
                "short, or try a wider duration range."
            )

        # Only the shortlist goes to the LLM. Without a key this is a no-op that
        # returns the same list, so the heuristic result is what gets used.
        # Silent clips have no text to judge, so skip the text-only ranker.
        ranked = (
            rank_candidates(candidates, settings, max_clips=target_count or settings.default_clip_count)
            if segments
            else candidates
        )
        ranked = ranked[: (target_count or settings.default_clip_count)]
        context.check_cancelled()

        tracker.advance("highlights", 1.0)
        _apply_stage(session, project, job, tracker, "highlights")
        context.report("highlights", tracker.progress)

        # --- Stage 5: prepare ----------------------------------------------
        tracker.start("prepare")
        _apply_stage(session, project, job, tracker, "prepare")

        payloads = build_clips(
            ranked,
            segments,
            project_id,
            project_preset=project.preset_id,
            project_settings=project_settings,
        )
        for payload in payloads:
            meta_json = json.loads(payload.get("meta_json") or "{}")
            for k in ("faceTracks", "audioSpikes", "sceneCuts", "deadAirIntervals", "facecamBoxSuggestion"):
                if k in project_settings:
                    meta_json[k] = project_settings[k]
            # Best-effort SFX hooks from spikes/keywords for downstream editors.
            spikes = meta_json.get("audioSpikes") or []
            if isinstance(spikes, list) and spikes:
                meta_json.setdefault("sfxMarkers", [{"t": s.get("t"), "type": "impact"} for s in spikes[:12] if isinstance(s, dict)])
            if preset == "gaming":
                export_json = json.loads(payload.get("export_json") or "{}")
                suggested = meta_json.get("facecamBoxSuggestion")
                if isinstance(suggested, dict) and not export_json.get("facecamBox"):
                    export_json["facecamBox"] = suggested
                    export_json["facecamEnabled"] = bool(export_json.get("facecamEnabled") or False)
                    payload["export_json"] = json.dumps(export_json)
            payload["meta_json"] = json.dumps(meta_json)
        _persist_clips(session, project, payloads)

    except CancelledError:
        project.status = "cancelled"
        project.error = None
        project.current_stage = None
        if job is not None:
            job.status = "cancelled"
        session.commit()
        raise
    except PipelineError as exc:
        # A handled pipeline failure (missing media, no highlight window, ...) is
        # still a terminal state for the UI. Committing without setting it left
        # the project "processing" forever while only the in-memory job knew it
        # had failed.
        session.rollback()
        project = session.query(Project).filter(Project.id == project_id).first()
        if project is not None:
            project.status = "failed"
            project.error = str(exc)
            project.updated_at = utcnow()
        job = session.query(Job).filter(Job.id == context.job_id).first()
        if job is not None:
            job.status = "failed"
            job.error = str(exc)
            job.updated_at = utcnow()
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
    processing_meta["status"] = "complete"
    project = session.query(Project).filter(Project.id == project_id).first()
    if project is not None:
        project.status = "ready"
        project.progress = 100.0
        project.current_stage = None
        project.stages_json = _stage_payload(tracker)
        project.error = None
        project.updated_at = utcnow()
        current = json.loads(project.settings_json or "{}")
        current["_processing"] = processing_meta
        project.settings_json = json.dumps(current)
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