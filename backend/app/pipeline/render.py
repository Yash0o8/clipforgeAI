"""Real video rendering: cut, refit, burn captions, encode.

This is the module that makes exports produce an actual MP4 rather than a
tracked job. The chain is a single ffmpeg invocation per render, with one
``filter_complex`` doing trim → scale/pad → subtitles.

Key choices:

* **-ss before -i.** Seeks on the input, which is fast keyframe seeking in
  ffmpeg's newer versions and avoids decoding the whole file up to the cut.
* **scale + pad rather than crop.** Cropping loses content; padding preserves the
  frame and matches what the browser preview shows (the preview uses
  ``object-contain``).
* **-movflags +faststart.** Moves the moov atom to the front so the file starts
  playing before it has fully downloaded. Without it, a served MP4 will not seek.
* **A single render pass.** Captions are burned during the same encode, not in a
  second pass, so a re-render costs one encode either way.
"""

from __future__ import annotations

import logging
import os
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from ..config import get_settings
from ..storage import kill_after, terminate_process
from .captions import CaptionStyle, build_style, escape_text
from .subtitles import CaptionCue, WordCue, build_ass, cues_for_window, resolve_caption_text

logger = logging.getLogger(__name__)


class RenderError(RuntimeError):
    """Raised when a render fails. Message is surfaced on the export job."""


@dataclass
class RenderRequest:
    """Everything needed to produce one file."""

    source: Path
    output: Path
    start_sec: float
    end_sec: float
    aspect_ratio: str = "9:16"
    resolution: str = "1080x1920"
    fmt: str = "mp4"
    burn_captions: bool = True
    caption_preset_id: str | None = "clean"
    caption_position: str | None = None
    caption_text: str | None = None
    caption_segments: list[dict[str, Any]] | None = None
    # Transcript segments for the clip window, needed for karaoke word timings.
    transcript: list[dict[str, Any]] | None = None
    render_mode: str = "default"
    background_source: Path | None = None
    watermark_text: str | None = None
    hook_banner: str | None = None
    preview: bool = False
    keyword_highlight: bool = False
    highlight_color: str | None = None
    keywords: list[str] = field(default_factory=list)
    auto_zoom: bool = False
    dead_air_removal: bool = False
    sfx_enabled: bool = False
    facecam_enabled: bool = False
    facecam_source: Path | None = None
    facecam_box: dict[str, float] | None = None
    face_tracks: list[dict[str, Any]] = field(default_factory=list)
    audio_spikes: list[dict[str, Any]] = field(default_factory=list)
    scene_cuts: list[float] = field(default_factory=list)
    dead_air_intervals: list[dict[str, float]] = field(default_factory=list)
    sfx_markers: list[dict[str, Any]] = field(default_factory=list)
    frame_rate: int | None = None

    @property
    def duration(self) -> float:
        return max(0.1, self.end_sec - self.start_sec)


# --- Filter graph -----------------------------------------------------------


def _scale_pad_filter(width: int, height: int) -> str:
    """Scale to fit inside the frame and pad the remainder.

    ``force_original_aspect_ratio=decrease`` scales down until the source fits
    inside the target, then the pad centres it. This is the same visual result as
    ``object-fit: contain``, which is what the preview uses — so the burned file
    matches what the user approved.
    """
    return (
        f"scale={width}:{height}:force_original_aspect_ratio=decrease:flags=lanczos,"
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1"
    )


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def _zoom_expr(request: RenderRequest) -> float:
    """Legacy static zoom factor (1.0-1.12), biased by spikes/scene cuts."""
    if not request.auto_zoom:
        return 1.0
    base = 1.04 if request.render_mode == "podcast" else 1.02
    spikes = [float(s.get("t", 0)) for s in (request.audio_spikes or []) if isinstance(s, dict)]
    cuts = [float(c) for c in (request.scene_cuts or []) if isinstance(c, (int, float, str))]
    bump = 0.0
    for t in spikes:
        rt = t - request.start_sec
        if 0 <= rt <= request.duration:
            bump = max(bump, 0.05)
    for c in cuts:
        rc = c - request.start_sec
        if 0 <= rc <= request.duration:
            bump = max(bump, 0.03)
    return _clamp(base + bump, 1.0, 1.12)


def _auto_zoom_timeline(request: RenderRequest) -> list[tuple[float, float, float]]:
    """Build (start,end,zoom) windows in clip-relative seconds."""
    if not request.auto_zoom:
        return [(0.0, max(0.1, request.duration), 1.0)]

    dur = max(0.1, request.duration)
    base = 1.03 if request.render_mode == "podcast" else 1.015
    max_zoom = 1.12 if request.render_mode in ("podcast", "gaming") else 1.08
    points: list[tuple[float, float]] = []

    for s in request.audio_spikes or []:
        if isinstance(s, dict):
            try:
                t = float(s.get("t", 0.0)) - request.start_sec
                strength = float(s.get("strength", 0.0) or 0.0)
            except Exception:
                continue
            if 0 <= t <= dur:
                points.append((t, 0.06 + min(0.04, strength / 20.0)))
    for c in request.scene_cuts or []:
        try:
            t = float(c) - request.start_sec
        except Exception:
            continue
        if 0 <= t <= dur:
            points.append((t, 0.04))
    for m in request.sfx_markers or []:
        if isinstance(m, dict):
            try:
                t = float(m.get("t", 0.0)) - request.start_sec
            except Exception:
                continue
            if 0 <= t <= dur:
                points.append((t, 0.03))

    if not points:
        return [(0.0, dur, base)]

    # Merge overlapping punch-in windows.
    windows: list[tuple[float, float, float]] = []
    for t, bump in sorted(points, key=lambda x: x[0]):
        start = _clamp(t - 0.35, 0.0, dur)
        end = _clamp(t + 0.95, 0.0, dur)
        zoom = _clamp(base + bump, 1.0, max_zoom)
        if not windows or start > windows[-1][1] + 0.15:
            windows.append((start, end, zoom))
        else:
            ps, pe, pz = windows[-1]
            windows[-1] = (ps, max(pe, end), max(pz, zoom))

    # Fill gaps with base zoom.
    timeline: list[tuple[float, float, float]] = []
    cursor = 0.0
    for s, e, z in windows:
        if s > cursor:
            timeline.append((cursor, s, base))
        timeline.append((s, e, z))
        cursor = e
    if cursor < dur:
        timeline.append((cursor, dur, base))
    return timeline


def _zoom_expr_for_timeline(timeline: list[tuple[float, float, float]], default_zoom: float) -> str:
    expr = f"{default_zoom:.4f}"
    for s, e, z in reversed(timeline):
        expr = f"if(between(t,{s:.3f},{e:.3f}),{z:.4f},{expr})"
    return expr


def _keep_intervals(
    request_or_duration: RenderRequest | float,
    dead_air_intervals: list[dict[str, Any]] | None = None,
    *,
    source_start_sec: float = 0.0,
) -> list[tuple[float, float]]:
    """Clip-relative keep intervals after dead-air removal.

    Accepts either a RenderRequest (normal render path) or (duration, intervals)
    for caption-only remapping on an already-rendered clip timeline.
    """
    if isinstance(request_or_duration, RenderRequest):
        request = request_or_duration
        start = 0.0
        end = request.duration
        intervals = request.dead_air_intervals
        offset = request.start_sec
        enabled = request.dead_air_removal
    else:
        start = 0.0
        end = max(0.0, float(request_or_duration))
        intervals = dead_air_intervals or []
        offset = float(source_start_sec)
        enabled = True
    if not enabled or not intervals:
        return [(start, end)]

    cuts: list[tuple[float, float]] = []
    for it in intervals:
        if not isinstance(it, dict):
            continue
        try:
            s = float(it.get("startSec", it.get("start", 0.0))) - offset
            e = float(it.get("endSec", it.get("end", 0.0))) - offset
        except Exception:
            continue
        s = _clamp(s, start, end)
        e = _clamp(e, start, end)
        if e - s >= 0.35:
            cuts.append((s, e))
    cuts.sort()
    merged: list[tuple[float, float]] = []
    for s, e in cuts:
        if not merged or s > merged[-1][1]:
            merged.append((s, e))
        else:
            merged[-1] = (merged[-1][0], max(merged[-1][1], e))

    keeps: list[tuple[float, float]] = []
    cur = start
    for s, e in merged:
        if s - cur >= 0.25:
            keeps.append((cur, s))
        cur = max(cur, e)
    if end - cur >= 0.25:
        keeps.append((cur, end))
    if not keeps:
        return [(start, end)]
    kept = sum(e - s for s, e in keeps)
    if kept < end * 0.45:
        return [(start, end)]
    return keeps


def _remap_time_for_keep(t: float, keeps: list[tuple[float, float]]) -> float | None:
    out = 0.0
    for s, e in keeps:
        if t < s:
            return None
        if s <= t <= e:
            return out + (t - s)
        out += e - s
    return None


def _face_position_expr(request: RenderRequest, axis: str, default: float) -> str:
    """Build a piecewise-constant ffmpeg expression for face center over time."""
    tracks = []
    for t in request.face_tracks or []:
        if not isinstance(t, dict):
            continue
        try:
            ts = float(t.get("t", 0.0)) - request.start_sec
            val = float(t.get(axis, default))
        except Exception:
            continue
        if -0.5 <= ts <= request.duration + 0.5:
            tracks.append((max(0.0, min(request.duration, ts)), _clamp(val, 0.15, 0.85)))
    if not tracks:
        return f"{default:.4f}"
    tracks.sort(key=lambda x: x[0])
    # Downsample to keep filter graph size reasonable.
    if len(tracks) > 48:
        step = max(1, len(tracks) // 48)
        tracks = tracks[::step] + [tracks[-1]]
    expr = f"{tracks[-1][1]:.4f}"
    for i in range(len(tracks) - 2, -1, -1):
        t, v = tracks[i]
        next_t = tracks[i + 1][0]
        expr = f"if(lt(t,{next_t:.3f}),{v:.4f},{expr})"
    return expr


def _face_crop_filter(request: RenderRequest, width: int, height: int) -> str | None:
    """Best-effort face-centered crop with dynamic zoom punch-ins."""
    if request.render_mode not in ("podcast", "gaming") and not request.auto_zoom:
        return None
    tracks = [t for t in request.face_tracks if isinstance(t, dict)]
    if not tracks:
        return None

    pts = []
    for t in tracks:
        try:
            ts = float(t.get("t", 0.0))
        except Exception:
            continue
        if request.start_sec - 1.0 <= ts <= request.end_sec + 1.0:
            pts.append(t)
    if not pts:
        pts = tracks
    avg_cx = sum(float(p.get("cx", 0.5)) for p in pts) / len(pts)
    avg_cy = sum(float(p.get("cy", 0.42)) for p in pts) / len(pts)
    avg_cy = _clamp(avg_cy - 0.04, 0.15, 0.85)
    avg_cx = _clamp(avg_cx, 0.15, 0.85)

    cx_expr = _face_position_expr(request, "cx", avg_cx)
    cy_expr = _face_position_expr(request, "cy", avg_cy)
    timeline = _auto_zoom_timeline(request)
    default_zoom = 1.03 if request.render_mode == "podcast" else 1.015
    zoom_expr = _zoom_expr_for_timeline(timeline, default_zoom)

    src_aspect = 16 / 9
    target_aspect = width / max(1, height)
    if target_aspect < 1:
        base_h_expr = f"clip(1/({zoom_expr}),0.35,1.0)"
        base_w_expr = f"clip(({base_h_expr})*{target_aspect / src_aspect:.6f},0.22,1.0)"
    else:
        base_w_expr = f"clip(1/({zoom_expr}),0.35,1.0)"
        base_h_expr = base_w_expr

    crop_w = f"iw*({base_w_expr})"
    crop_h = f"ih*({base_h_expr})"
    x = f"clip(iw*({cx_expr})-({crop_w})/2,0,iw-({crop_w}))"
    y = f"clip(ih*({cy_expr})-({crop_h})/2,0,ih-({crop_h}))"
    return (
        f"crop={crop_w}:{crop_h}:{x}:{y},"
        f"scale={width}:{height}:flags=lanczos,setsar=1"
    )


def _center_zoom_filter(request: RenderRequest, width: int, height: int) -> str | None:
    """Dynamic center zoom fallback when no face tracks are available."""
    if not request.auto_zoom and request.render_mode not in ("podcast", "gaming"):
        return None
    timeline = _auto_zoom_timeline(request)
    default_zoom = 1.02 if request.render_mode == "podcast" else 1.01
    zoom_expr = _zoom_expr_for_timeline(timeline, default_zoom)
    src_aspect = 16 / 9
    target_aspect = width / max(1, height)
    if target_aspect < 1:
        base_h_expr = f"clip(1/({zoom_expr}),0.35,1.0)"
        base_w_expr = f"clip(({base_h_expr})*{target_aspect / src_aspect:.6f},0.22,1.0)"
    else:
        base_w_expr = f"clip(1/({zoom_expr}),0.35,1.0)"
        base_h_expr = base_w_expr
    crop_w = f"iw*({base_w_expr})"
    crop_h = f"ih*({base_h_expr})"
    x = f"(iw-({crop_w}))/2"
    y = f"(ih-({crop_h}))/2"
    return f"crop={crop_w}:{crop_h}:{x}:{y},scale={width}:{height}:flags=lanczos,setsar=1"


def _escape_filter_path(path: Path) -> str:
    """Escape a Windows path for use inside an ffmpeg filter argument.

    Backslashes and colons both need escaping; ``:`` separates options in a filter
    argument, and a backslash is an escape character in filter parsing.
    """
    text = str(path)
    text = text.replace("\\", "/")
    text = text.replace(":", "\\:")
    text = text.replace("'", "\\'")
    text = text.replace("[", "\\[").replace("]", "\\]")
    return text


def _encoder_args(fmt: str, preview: bool = False, frame_rate: int | None = None) -> list[str]:
    """Codec and container flags per output format."""
    fps_args = ["-r", str(frame_rate)] if frame_rate else []
    if fmt == "webm":
        return fps_args + [
            "-c:v", "libvpx-vp9",
            "-c:a", "libopus",
            "-b:v", "0",
            "-crf", "36" if preview else "32",
            "-deadline", "realtime" if preview else "good",
            "-cpu-used", "6" if preview else "2",
            "-row-mt", "1",
        ]
    return fps_args + [
        "-c:v", "libx264",
        "-preset", "veryfast" if preview else "medium",
        "-crf", "28" if preview else "20",
        "-pix_fmt", "yuv420p",
        "-profile:v", "high",
        "-level", "4.2",
        "-c:a", "aac",
        "-b:a", "128k" if preview else "192k",
        "-ar", "48000",
        "-movflags", "+faststart",
    ]


def _build_trim_filter(stream: str, keeps: list[tuple[float, float]], out_label: str | None = None) -> str:
    """Build trim+concat filter for dead-air removal on a single stream."""
    if len(keeps) <= 1:
        return ""
    is_audio = stream.endswith(":a") or stream.endswith("a")
    out_label = out_label or ("[0a]" if is_audio else "[0v]")
    parts: list[str] = []
    labels: list[str] = []
    for i, (s, e) in enumerate(keeps):
        lbl = f"[k{ 'a' if is_audio else 'v'}{i}]"
        labels.append(lbl)
        if is_audio:
            parts.append(f"[{stream}]atrim=start={s:.3f}:end={e:.3f},asetpts=PTS-STARTPTS{lbl}")
        else:
            parts.append(f"[{stream}]trim=start={s:.3f}:end={e:.3f},setpts=PTS-STARTPTS{lbl}")
    if is_audio:
        parts.append(f"{''.join(labels)}concat=n={len(labels)}:v=0:a=1{out_label}")
    else:
        parts.append(f"{''.join(labels)}concat=n={len(labels)}:v=1:a=0{out_label}")
    return ";".join(parts)


def _audio_present(source: Path) -> bool:
    """Whether the source has an audio stream worth keeping."""
    try:
        result = subprocess.run(
            [
                get_settings().resolved_ffprobe(),
                "-v", "error",
                "-select_streams", "a:0",
                "-show_entries", "stream=index",
                "-of", "csv=p=0",
                str(source),
            ],
            capture_output=True,
            text=True,
            timeout=60,
        )
        return bool(result.stdout.strip())
    except (subprocess.TimeoutExpired, OSError):
        # Assume audio exists on failure; the graph below handles either case.
        return True


def _build_sfx_audio_filter(request: RenderRequest, keeps: list[tuple[float, float]]) -> str:
    """Mix synthesized whooshes/pops; no third-party SFX assets required.

    ``impact`` is a low thump, ``whoosh`` is a filtered noise sweep and ``pop``
    is a short high tone. All are delayed to their marker time and mixed at a
    low level by the caller's ``amix`` weights.
    """
    if not request.sfx_enabled or not request.sfx_markers or not keeps:
        return ""
    markers: list[tuple[float, str]] = []
    for marker in request.sfx_markers[:16]:
        if not isinstance(marker, dict):
            continue
        try:
            t = float(marker.get("t", 0.0)) - request.start_sec
        except (TypeError, ValueError):
            continue
        t = _remap_time_for_keep(t, keeps) if len(keeps) > 1 else t
        if t is None or t < 0:
            continue
        kind = str(marker.get("type") or "impact").strip().lower()
        if kind not in {"impact", "whoosh", "pop"}:
            kind = "impact"
        markers.append((t, kind))
    if not markers:
        return ""

    out_dur = sum(e - s for s, e in keeps)
    unique: list[tuple[float, str]] = []
    for t, kind in sorted(markers):
        if any(abs(t - kept_t) < 0.18 for kept_t, _ in unique):
            continue
        unique.append((t, kind))
        if len(unique) >= 12:
            break

    parts: list[str] = []
    labels: list[str] = []
    for i, (t, kind) in enumerate(unique):
        delay_ms = max(0, int(t * 1000))
        lbl = f"[sfx{i}]"
        labels.append(lbl)
        if kind == "whoosh":
            source = "anoisesrc=color=pink:r=48000:d=0.16"
            envelope = "highpass=f=320,lowpass=f=3200,afade=t=in:st=0:d=0.02,afade=t=out:st=0.09:d=0.07"
        else:
            # Pop is brighter than an impact thump.
            frequency = 880 if kind == "pop" else 240
            source = f"sine=frequency={frequency}:sample_rate=48000:duration=0.08"
            envelope = "afade=t=in:st=0:d=0.01,afade=t=out:st=0.05:d=0.03"
        parts.append(f"{source},{envelope},adelay={delay_ms}|{delay_ms}{lbl}")

    if not parts:
        return ""
    mix = "".join(labels) + f"amix=inputs={len(labels)}:duration=longest,atrim=0:{out_dur:.3f},asetpts=PTS-STARTPTS[sfx]"
    return ";".join(parts + [mix])


def _build_filter_graph(request: RenderRequest, width: int, height: int) -> tuple[str, list[str]]:
    """Build filter_complex and output map args for supported render modes."""

    keeps = _keep_intervals(request)
    request._keep_intervals = keeps  # type: ignore[attr-defined]

    sub_filter = ""
    if request.burn_captions:
        cues = _build_cues(request, width, height, keeps=keeps)
        if cues:
            ass_path = _write_temp_ass(
                cues,
                width,
                height,
                request.caption_preset_id,
                request.caption_position,
                highlight_color=request.highlight_color,
                keyword_highlight=request.keyword_highlight,
                keywords=request.keywords,
            )
            request._ass_path = ass_path  # type: ignore[attr-defined]
            sub_filter = f",subtitles='{_escape_filter_path(ass_path)}'"

    hook_banner = ""
    if request.hook_banner:
        hb = request.hook_banner.strip().replace("\\", "\\\\").replace("'", "\\'").replace(":", "\\:").replace("%", "\\%")
        hb = hb[:60]
        if hb:
            font_size = max(34, int(height * 0.042))
            y_pos = max(48, int(height * 0.06))
            hook_banner = (
                f",drawtext=text='{hb}':x=(w-text_w)/2:y={y_pos}:fontsize={font_size}:fontcolor=white:"
                "borderw=3:bordercolor=black@0.75:box=1:boxcolor=black@0.5:boxborderw=18:"
                "enable='between(t,0,3)'"
            )

    watermark = ""
    if request.watermark_text:
        text = request.watermark_text.replace("\\", "\\\\").replace("'", "\\'").replace(":", "\\:").replace("%", "\\%")
        watermark = f",drawtext=text='{text}':x=w-tw-24:y=h-th-24:fontsize=28:fontcolor=white@0.75:box=1:boxcolor=black@0.35:boxborderw=10"

    has_audio = _audio_present(request.source)
    pre_v = _build_trim_filter("0:v", keeps, out_label="[0v]") if len(keeps) > 1 else ""
    pre_a = _build_trim_filter("0:a", keeps, out_label="[0a]") if len(keeps) > 1 and has_audio else ""

    if request.render_mode == "split_screen" and request.background_source and request.background_source.exists():
        top_h = height // 2
        bottom_h = height - top_h
        src_v = "[0v]" if pre_v else "[0:v:0]"
        graph = ""
        if pre_v:
            graph += pre_v
        graph += (
            f"{src_v}{_scale_pad_filter(width, top_h)}[top];"
            f"[1:v:0]scale={width}:{bottom_h}:force_original_aspect_ratio=increase:flags=lanczos,"
            f"crop={width}:{bottom_h},setsar=1[bottom];"
            f"[top][bottom]vstack=inputs=2{sub_filter}{hook_banner}{watermark}[vout]"
        )
        if pre_a or has_audio:
            sfx = _build_sfx_audio_filter(request, keeps=keeps)
            audio_in = "[0a]" if pre_a else "[0:a:0]"
            if sfx:
                if pre_a:
                    graph += ";" + pre_a
                graph += ";" + sfx
                graph += f";{audio_in}[sfx]amix=inputs=2:duration=first:dropout_transition=0:weights=1 0.18[aout]"
                return graph, ["-map", "[vout]", "-map", "[aout]"]
        if pre_a:
            graph += ";" + pre_a
            return graph, ["-map", "[vout]", "-map", "[0a]"]
        if has_audio:
            return graph, ["-map", "[vout]", "-map", "0:a:0?"]
        return graph, ["-map", "[vout]"]

    if request.render_mode == "gaming" and request.facecam_enabled and request.facecam_source and request.facecam_source.exists():
        fc = request.facecam_box or {"x": 0.72, "y": 0.04, "w": 0.24, "h": 0.24}
        x = _clamp(float(fc.get("x", 0.72)), 0.0, 0.95)
        y = _clamp(float(fc.get("y", 0.04)), 0.0, 0.95)
        w = _clamp(float(fc.get("w", 0.24)), 0.1, 0.6)
        h = _clamp(float(fc.get("h", 0.24)), 0.1, 0.6)
        overlay_w = max(64, int(width * w))
        overlay_h = max(64, int(height * h))
        overlay_x = int(width * x)
        overlay_y = int(height * y)
        base_filter = _face_crop_filter(request, width, height) or _scale_pad_filter(width, height)
        src_v = "[0v]" if pre_v else "[0:v:0]"
        graph = ""
        if pre_v:
            graph += pre_v
        graph += (
            f"{src_v}{base_filter}[base];"
            f"[1:v:0]scale={overlay_w}:{overlay_h}:force_original_aspect_ratio=increase:flags=lanczos,"
            f"crop={overlay_w}:{overlay_h},setsar=1[cam];"
            f"[base][cam]overlay={overlay_x}:{overlay_y}{sub_filter}{hook_banner}{watermark}[vout]"
        )
        if pre_a or has_audio:
            sfx = _build_sfx_audio_filter(request, keeps=keeps)
            audio_in = "[0a]" if pre_a else "[0:a:0]"
            if sfx:
                if pre_a:
                    graph += ";" + pre_a
                graph += ";" + sfx
                graph += f";{audio_in}[sfx]amix=inputs=2:duration=first:dropout_transition=0:weights=1 0.18[aout]"
                return graph, ["-map", "[vout]", "-map", "[aout]"]
        if pre_a:
            graph += ";" + pre_a
            return graph, ["-map", "[vout]", "-map", "[0a]"]
        if has_audio:
            return graph, ["-map", "[vout]", "-map", "0:a:0?"]
        return graph, ["-map", "[vout]"]

    base_filter = _face_crop_filter(request, width, height) or _center_zoom_filter(request, width, height) or _scale_pad_filter(width, height)
    src_v = "[0v]" if pre_v else "[0:v:0]"
    graph = ""
    if pre_v:
        graph += pre_v
    graph += f"{src_v}{base_filter}{sub_filter}{hook_banner}{watermark}[vout]"

    # SFX mix (best-effort): short tones at marker times.
    if pre_a or has_audio:
        sfx = _build_sfx_audio_filter(request, keeps=keeps)
        if sfx:
            base_audio_label = "[0a]" if pre_a else "[0:a:0]"
            if pre_a:
                graph += ";" + pre_a
            graph += ";" + sfx
            graph += f";{base_audio_label}[sfx]amix=inputs=2:duration=first:dropout_transition=0:weights=1 0.18[aout]"
            return graph, ["-map", "[vout]", "-map", "[aout]"]

    if pre_a:
        graph += ";" + pre_a
        return graph, ["-map", "[vout]", "-map", "[0a]"]
    if has_audio:
        return graph, ["-map", "[vout]", "-map", "0:a:0?"]
    return graph, ["-map", "[vout]"]


# --- Render -----------------------------------------------------------------


def render_clip(
    request: RenderRequest,
    on_progress: Callable[[float], None] | None = None,
    cancel: Callable[[], bool] | None = None,
) -> Path:
    """Render one clip and return the output path.

    Raises:
        RenderError: on any ffmpeg failure or invalid request.
        RuntimeError: with ``"cancelled"`` if ``cancel()`` returned True.
    """
    settings = get_settings()

    if not request.source.exists():
        raise RenderError(f"source file is missing: {request.source}")
    if request.end_sec <= request.start_sec:
        raise RenderError("clip window is empty")

    width, height = _parse_resolution(request.resolution)

    command: list[str] = [
        settings.resolved_ffmpeg(),
        "-hide_banner",
        "-nostdin",
        "-loglevel", "error",
        "-y",
    ]

    # Fast input seek, then an accurate output trim. Keyframe seeking can land a
    # frame or two early, so the output -ss is what actually guarantees the cut
    # point is exact.
    command += ["-ss", f"{max(0.0, request.start_sec):.3f}", "-i", str(request.source)]
    if request.render_mode == "split_screen" and request.background_source and request.background_source.exists():
        # Loop background gameplay to cover the main clip duration.
        command += ["-stream_loop", "-1", "-i", str(request.background_source)]
    if request.render_mode == "gaming" and request.facecam_enabled and request.facecam_source and request.facecam_source.exists():
        command += ["-stream_loop", "-1", "-i", str(request.facecam_source)]
    command += ["-t", f"{request.duration:.3f}"]

    graph, map_args = _build_filter_graph(request, width, height)
    command += ["-filter_complex", graph] + map_args

    has_audio = _audio_present(request.source)
    mapped_audio = any(a in {"[0a]", "0:a:0?", "0:a"} or ":a" in a for a in map_args)
    if mapped_audio:
        if "-shortest" not in command and "-shortest" not in map_args:
            command += ["-shortest"]
    elif has_audio:
        command += ["-map", "0:a:0?", "-shortest"]
    else:
        logger.info("no audio stream in %s, rendering video only", request.source.name)

    command += _encoder_args(request.fmt, preview=request.preview, frame_rate=request.frame_rate)
    command += ["-progress", "pipe:1", "-nostats", str(request.output)]

    ass_path = getattr(request, "_ass_path", None)
    try:
        _run(command, on_progress, cancel)
    finally:
        if isinstance(ass_path, Path):
            ass_path.unlink(missing_ok=True)

    if not request.output.exists() or request.output.stat().st_size == 0:
        raise RenderError("ffmpeg reported success but produced no output")

    logger.info(
        "rendered %s -> %s (%s, %sx%s, %.1fs)",
        request.source.name,
        request.output.name,
        request.fmt,
        width,
        height,
        request.duration,
    )
    return request.output


def _parse_resolution(resolution: str) -> tuple[int, int]:
    try:
        width, height = resolution.lower().split("x", 1)
        # libx264 with yuv420p needs even dimensions.
        return max(2, int(width) // 2 * 2), max(2, int(height) // 2 * 2)
    except (ValueError, AttributeError):
        return 1080, 1920


def _build_cues(
    request: RenderRequest,
    width: int,
    height: int,
    keeps: list[tuple[float, float]] | None = None,
) -> list[CaptionCue]:
    """Resolve caption text into timed cues.

    Prefers the user's caption text. When that text still matches a transcript
    segment, the segment's real word timings are reused, which is what makes the
    Karaoke preset accurate rather than approximated.
    """
    text = resolve_caption_text(
        caption_text=request.caption_text,
        transcript=request.transcript or [],
        start_sec=request.start_sec,
        end_sec=request.end_sec,
    )
    if not text:
        return []

    cues = cues_for_window(
        text=text,
        start_sec=request.start_sec,
        end_sec=request.end_sec,
        transcript=request.transcript or [],
        preset_id=request.caption_preset_id,
        caption_segments=request.caption_segments,
    )
    if not keeps or len(keeps) <= 1:
        return cues

    remapped: list[CaptionCue] = []
    for cue in cues:
        ns = _remap_time_for_keep(cue.start, keeps)
        ne = _remap_time_for_keep(cue.end, keeps)
        if ns is None or ne is None:
            # Try midpoint for cues spanning a cut boundary.
            mid = (cue.start + cue.end) / 2
            nm = _remap_time_for_keep(mid, keeps)
            if nm is None:
                continue
            dur = max(0.2, cue.end - cue.start)
            ns = max(0.0, nm - dur / 2)
            ne = ns + dur
        if ne - ns < 0.12:
            continue
        words = []
        for w in cue.words:
            ws = _remap_time_for_keep(w.start, keeps)
            we = _remap_time_for_keep(w.end, keeps)
            if ws is None or we is None or we <= ws:
                continue
            words.append(WordCue(start=round(ws, 3), end=round(we, 3), text=w.text))
        remapped.append(CaptionCue(start=round(ns, 3), end=round(ne, 3), text=cue.text, words=words or cue.words, karaoke=cue.karaoke))
    return remapped


def _write_temp_ass(
    cues: list[CaptionCue],
    width: int,
    height: int,
    preset_id: str | None = None,
    position: str | None = None,
    highlight_color: str | None = None,
    keyword_highlight: bool = False,
    keywords: list[str] | None = None,
) -> Path:
    """Write the ASS subtitle file to a temp location."""
    handle = tempfile.NamedTemporaryFile(
        suffix=".ass",
        prefix="clipforge_",
        mode="w",
        delete=False,
        encoding="utf-8",
    )
    path = Path(handle.name)
    with handle:
        handle.write(
            build_ass(
                cues,
                width,
                height,
                preset_id,
                position,
                highlight_color=highlight_color,
                keyword_highlight=keyword_highlight,
                keywords=keywords,
            )
        )
    return path


def _run(
    command: list[str],
    on_progress: Callable[[float], None] | None,
    cancel: Callable[[], bool] | None,
) -> None:
    """Run ffmpeg, streaming progress and honouring cancellation."""
    settings = get_settings()

    try:
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
    except OSError as exc:
        raise RenderError(f"could not start ffmpeg: {exc}") from exc

    stderr_text = ""
    # Watchdog, not a clock check in the read loop: reading stdout blocks until
    # ffmpeg closes it, and a stalled encode emits nothing, so a loop-driven
    # deadline could never fire. A killed render leaves a partial file behind,
    # so this must be able to stop even a silent process.
    expired = kill_after(process, settings.ffmpeg_timeout_sec, cancel=cancel)

    try:
        assert process.stdout is not None
        for line in process.stdout:
            if on_progress is None:
                continue
            key, _, value = line.strip().partition("=")
            if key == "out_time_us":
                try:
                    on_progress(float(value))
                except (TypeError, ValueError):
                    pass
        process.wait()
    except subprocess.TimeoutExpired:
        terminate_process(process)
        stderr_text = _drain(process.stderr)
        raise RenderError("ffmpeg timed out") from None
    except BaseException:
        # Cancellation, or anything else unwinding: do not leave the child
        # running or the pipes dangling.
        terminate_process(process)
        _drain(process.stderr)
        raise
    else:
        # Must happen before the streams are closed. Reading a closed pipe
        # returns an empty string, which turns every ffmpeg error into a
        # useless "ffmpeg failed (code): " with nothing to diagnose.
        stderr_text = _drain(process.stderr)
    finally:
        expired.cancel()
        for stream in (process.stdout, process.stderr):
            if stream is not None and not stream.closed:
                try:
                    stream.close()
                except OSError:
                    pass

    if expired.fired:
        if expired.reason == "cancelled":
            raise RuntimeError("cancelled")
        raise RenderError(f"ffmpeg timed out after {settings.ffmpeg_timeout_sec}s")
    if process.returncode != 0:
        raise RenderError(
            f"ffmpeg failed ({process.returncode}): {stderr_text.strip()[:600]}"
        )


def _drain(stream) -> str:
    """Read a pipe to EOF and return it. Best-effort: a read error must not
    mask the ffmpeg failure that is the actual problem."""
    if stream is None or stream.closed:
        return ""
    try:
        return stream.read() or ""
    except (OSError, ValueError):
        return ""


def default_output_name(clip_title: str, fmt: str) -> str:
    """Filesystem-safe output filename derived from the clip title."""
    from ..storage import sanitize_name

    stem = sanitize_name(clip_title, fallback="clip").rsplit(".", 1)[0] or "clip"
    return f"{stem}.{fmt}"


def estimate_size_bytes(duration_sec: float, width: int, height: int, fmt: str) -> int:
    """Rough output size, mirroring the frontend's ``estimateSize`` heuristic."""
    bits_per_second = width * height * (0.09 if fmt == "mp4" else 0.07)
    return int(bits_per_second * duration_sec / 8)


def render_env() -> dict[str, str]:
    """Environment for ffmpeg subprocesses.

    libass needs a writable fontconfig cache or it can fail to find Arial on
    Windows, which surfaces as a broken subtitles filter.
    """
    env = dict(os.environ)
    env.setdefault("FONTCONFIG_PATH", tempfile.gettempdir())
    return env