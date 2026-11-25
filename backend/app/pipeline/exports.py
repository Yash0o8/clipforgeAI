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
from sqlalchemy.orm.exc import StaleDataError

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

    caption = json.loads(clip.caption_json or "{}")
    clip_meta = json.loads(clip.meta_json or "{}")
    preset_id = settings_from_request.get("captionPresetId") or caption.get("presetId") or "clean"
    caption_text = settings_from_request.get("captionText")
    caption_position = settings_from_request.get("captionPosition")
    caption_segments = settings_from_request.get("captionSegments") or caption.get("segments")
    render_mode = settings_from_request.get("renderMode") or stored_export.get("renderMode") or "default"
    background_asset_id = settings_from_request.get("backgroundAssetId") or stored_export.get("backgroundAssetId")
    preview = bool(settings_from_request.get("preview"))
    watermark = bool(settings_from_request.get("watermark") or stored_export.get("watermark"))
    auto_zoom = bool(settings_from_request.get("autoZoom") or stored_export.get("autoZoom"))
    dead_air = bool(settings_from_request.get("deadAirRemoval") or stored_export.get("deadAirRemoval"))
    sfx = bool(settings_from_request.get("sfxEnabled") or stored_export.get("sfxEnabled"))
    facecam_enabled = bool(settings_from_request.get("facecamEnabled") or stored_export.get("facecamEnabled"))
    facecam_asset_id = settings_from_request.get("facecamAssetId") or stored_export.get("facecamAssetId")
    facecam_box = settings_from_request.get("facecamBox") or stored_export.get("facecamBox")
    caption_only = bool(settings_from_request.get("captionOnly"))
    frame_rate = settings_from_request.get("frameRate") or stored_export.get("frameRate")
    hook_banner = (
        settings_from_request.get("hookBanner")
        or stored_export.get("hookBanner")
        or (clip_meta.get("hookBanner") if isinstance(clip_meta, dict) else None)
        or (clip_meta.get("hook") if isinstance(clip_meta, dict) else None)
    )
    keyword_highlight = settings_from_request.get("keywordHighlight")
    if keyword_highlight is None:
        keyword_highlight = caption.get("keywordHighlight", False)
    highlight_color = settings_from_request.get("highlightColor") or caption.get("highlightColor")
    if preview:
        # Fast preview defaults (480p for speed/cost).
        resolution = settings_from_request.get("resolution") or "480x854"
        watermark = True if settings_from_request.get("watermark") is None else watermark

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
                "captionSegments": caption_segments,
                "renderMode": render_mode,
                "backgroundAssetId": background_asset_id,
                "preview": preview,
                "watermark": watermark,
                "autoZoom": auto_zoom,
                "deadAirRemoval": dead_air,
                "sfxEnabled": sfx,
                "facecamEnabled": facecam_enabled,
                "facecamAssetId": facecam_asset_id,
                "facecamBox": facecam_box,
                "keywordHighlight": bool(keyword_highlight),
                "highlightColor": highlight_color,
                "captionOnly": caption_only,
                "frameRate": frame_rate,
                "hookBanner": hook_banner,
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

    caption_only = bool(options.get("captionOnly"))
    prior_complete = None
    if caption_only:
        prior_complete = (
            session.query(ExportJob)
            .filter(
                ExportJob.clip_id == clip.id,
                ExportJob.status == "complete",
                ExportJob.id != job.id,
            )
            .order_by(ExportJob.created_at.desc())
            .first()
        )
        if prior_complete and prior_complete.render_path:
            try:
                prior_path = safe_join(settings.data_dir, prior_complete.render_path)
            except Exception:
                prior_path = None
            if prior_path and prior_path.exists():
                # Caption-only rerender: reuse prior rendered video as source; no reanalysis.
                source = prior_path
                prior_settings = json.loads(prior_complete.settings_json or "{}")
                clip_dur = max(0.1, clip.end_sec - clip.start_sec)
                clip_meta = json.loads(clip.meta_json or "{}")
                project_settings = json.loads(project.settings_json or "{}")

                # If prior render baked dead-air removal, captions must be remapped to the baked timeline.
                prior_dead_air = bool(prior_settings.get("deadAirRemoval"))
                dead_air_intervals = (
                    clip_meta.get("deadAirIntervals")
                    if isinstance(clip_meta.get("deadAirIntervals"), list)
                    else project_settings.get("deadAirIntervals", [])
                )
                keeps = [(0.0, clip_dur)]
                if prior_dead_air and isinstance(dead_air_intervals, list) and dead_air_intervals:
                    from .render import _keep_intervals

                    keeps = _keep_intervals(clip_dur, dead_air_intervals)

                def _remap_to_prior(t: float) -> float | None:
                    # Map clip-relative source time to prior rendered timeline.
                    if len(keeps) <= 1:
                        return max(0.0, min(clip_dur, t))
                    from .render import _remap_time_for_keep

                    return _remap_time_for_keep(t, keeps)

                raw_transcript = json.loads(clip.transcript_json or "[]")
                rebased_transcript = []
                rendered_dur = sum(max(0.0, e - s) for s, e in keeps) if keeps else clip_dur
                for seg in raw_transcript if isinstance(raw_transcript, list) else []:
                    if not isinstance(seg, dict):
                        continue
                    try:
                        ss = float(seg.get("startSec", 0.0)) - clip.start_sec
                        ee = float(seg.get("endSec", 0.0)) - clip.start_sec
                    except Exception:
                        continue
                    if ee < -0.1 or ss > clip_dur + 0.1:
                        continue
                    ss = max(0.0, min(clip_dur, ss))
                    ee = max(0.0, min(clip_dur, ee))
                    rss = _remap_to_prior(ss)
                    ree = _remap_to_prior(ee)
                    if rss is None or ree is None:
                        # fallback to midpoint remap for segments crossing cut boundaries
                        mid = _remap_to_prior((ss + ee) / 2)
                        if mid is None:
                            continue
                        rss = max(0.0, mid - ((ee - ss) / 2))
                        ree = min(rendered_dur, rss + (ee - ss))
                    if ree - rss < 0.05:
                        continue
                    seg2 = dict(seg)
                    seg2["startSec"] = max(0.0, rss)
                    seg2["endSec"] = max(0.0, min(rendered_dur, ree))
                    words = []
                    for w in seg.get("words") or []:
                        if not isinstance(w, dict):
                            continue
                        try:
                            ws = float(w.get("startSec", 0.0)) - clip.start_sec
                            we = float(w.get("endSec", 0.0)) - clip.start_sec
                        except Exception:
                            continue
                        if we < -0.1 or ws > clip_dur + 0.1:
                            continue
                        ws = max(0.0, min(clip_dur, ws))
                        we = max(0.0, min(clip_dur, we))
                        rws = _remap_to_prior(ws)
                        rwe = _remap_to_prior(we)
                        if rws is None or rwe is None:
                            continue
                        if rwe - rws < 0.02:
                            continue
                        w2 = dict(w)
                        w2["startSec"] = max(0.0, rws)
                        w2["endSec"] = max(0.0, min(rendered_dur, rwe))
                        words.append(w2)
                    seg2["words"] = words
                    rebased_transcript.append(seg2)

                # Remap explicit caption segments if provided, relative to original clip timeline.
                caption_segments = options.get("captionSegments")
                remapped_caption_segments = None
                if isinstance(caption_segments, list):
                    remapped_caption_segments = []
                    for cs in caption_segments:
                        if not isinstance(cs, dict):
                            continue
                        try:
                            css = float(cs.get("startSec", 0.0))
                            cee = float(cs.get("endSec", 0.0))
                        except Exception:
                            continue
                        # captionSegments from editor are clip-relative (0..clip_dur)
                        rss = _remap_to_prior(max(0.0, min(clip_dur, css)))
                        ree = _remap_to_prior(max(0.0, min(clip_dur, cee)))
                        if rss is None or ree is None or ree - rss < 0.05:
                            continue
                        c2 = dict(cs)
                        c2["startSec"] = round(rss, 3)
                        c2["endSec"] = round(ree, 3)
                        remapped_caption_segments.append(c2)

                request = RenderRequest(
                    source=source,
                    output=output,
                    start_sec=0.0,
                    end_sec=rendered_dur,
                    aspect_ratio=job.aspect_ratio,
                    resolution=job.resolution,
                    fmt=job.format,
                    burn_captions=bool(job.burn_captions),
                    caption_preset_id=options.get("captionPresetId"),
                    caption_position=options.get("captionPosition"),
                    caption_text=options.get("captionText"),
                    caption_segments=remapped_caption_segments if remapped_caption_segments is not None else options.get("captionSegments"),
                    transcript=rebased_transcript,
                    render_mode="default",
                    background_source=None,
                    # Avoid double-overlaying watermark/hook banner on top of an already-rendered video.
                    watermark_text=None if prior_settings.get("watermark") else (get_settings().free_watermark_text if options.get("watermark") else None),
                    hook_banner=None if prior_settings.get("hookBanner") else (str(options.get("hookBanner") or "").strip() or None),
                    preview=bool(options.get("preview")),
                    keyword_highlight=bool(options.get("keywordHighlight")),
                    highlight_color=options.get("highlightColor"),
                    keywords=(clip_meta.get("keywords") or []),
                    auto_zoom=False,
                    dead_air_removal=False,
                    sfx_enabled=False,  # baked in prior render audio
                    facecam_enabled=False,
                    facecam_source=None,
                    facecam_box=None,
                    face_tracks=[],
                    audio_spikes=[],
                    scene_cuts=[],
                    dead_air_intervals=[],
                    sfx_markers=[],
                    frame_rate=int(options["frameRate"]) if options.get("frameRate") else None,
                )
            else:
                caption_only = False
        else:
            caption_only = False

    if not caption_only:
        bg_source = None
        bg_id = options.get("backgroundAssetId")
        if bg_id:
            from ..storage import vault_asset_path

            bg_source = vault_asset_path(str(bg_id), settings)

        facecam_source = None
        facecam_asset_id = options.get("facecamAssetId")
        if facecam_asset_id:
            from ..storage import vault_asset_path

            facecam_source = vault_asset_path(str(facecam_asset_id), settings)

        clip_meta = json.loads(clip.meta_json or "{}")
        project_settings = json.loads(project.settings_json or "{}")
        face_tracks = clip_meta.get("faceTracks") or project_settings.get("faceTracks") or []

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
            caption_segments=options.get("captionSegments"),
            transcript=json.loads(clip.transcript_json or "[]"),
            render_mode=options.get("renderMode") or "default",
            background_source=bg_source,
            watermark_text=(get_settings().free_watermark_text if options.get("watermark") else None),
            hook_banner=str(options.get("hookBanner") or "").strip() or None,
            preview=bool(options.get("preview")),
            keyword_highlight=bool(options.get("keywordHighlight")),
            highlight_color=options.get("highlightColor"),
            keywords=(clip_meta.get("keywords") or []),
            auto_zoom=bool(options.get("autoZoom")),
            dead_air_removal=bool(options.get("deadAirRemoval")),
            sfx_enabled=bool(options.get("sfxEnabled")) and bool(getattr(settings, "enable_sfx_hooks", False)),
            facecam_enabled=bool(options.get("facecamEnabled")),
            facecam_source=facecam_source,
            facecam_box=options.get("facecamBox") if isinstance(options.get("facecamBox"), dict) else None,
            face_tracks=face_tracks if isinstance(face_tracks, list) else [],
            audio_spikes=clip_meta.get("audioSpikes") if isinstance(clip_meta.get("audioSpikes"), list) else [],
            scene_cuts=clip_meta.get("sceneCuts") if isinstance(clip_meta.get("sceneCuts"), list) else [],
            dead_air_intervals=clip_meta.get("deadAirIntervals") if isinstance(clip_meta.get("deadAirIntervals"), list) else [],
            sfx_markers=clip_meta.get("sfxMarkers") if isinstance(clip_meta.get("sfxMarkers"), list) else [],
            frame_rate=int(options["frameRate"]) if options.get("frameRate") else None,
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

    try:
        session.commit()
    except StaleDataError as exc:
        # A clip can be deleted while a slow render is in flight (common in the
        # test suite, and possible in the UI if a user removes a project). The
        # worker's session then holds stale ORM rows. Record a terminal failure
        # instead of letting a naked DB exception leave the job "rendering".
        session.rollback()
        message = "The clip was deleted while it was rendering."
        fresh = session.query(ExportJob).filter(ExportJob.id == job.id).first()
        if fresh is not None:
            fresh.status = "failed"
            fresh.error = message
            fresh.progress = 100.0
            fresh.updated_at = utcnow()
            session.commit()
        output.unlink(missing_ok=True)
        raise ExportError(message) from exc

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