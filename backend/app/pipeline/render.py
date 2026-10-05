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
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from ..config import get_settings
from ..storage import kill_after, terminate_process
from .captions import CaptionStyle, build_style, escape_text
from .subtitles import CaptionCue, build_ass, cues_for_window, resolve_caption_text

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
    # Transcript segments for the clip window, needed for karaoke word timings.
    transcript: list[dict[str, Any]] | None = None

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


def _encoder_args(fmt: str) -> list[str]:
    """Codec and container flags per output format."""
    if fmt == "webm":
        # VP9 + Opus. No faststart equivalent, but the muxer still writes a
        # seekable index.
        return [
            "-c:v", "libvpx-vp9",
            "-c:a", "libopus",
            "-b:v", "0",
            "-crf", "32",
            "-deadline", "good",
            "-cpu-used", "2",
            "-row-mt", "1",
        ]
    return [
        "-c:v", "libx264",
        "-preset", "medium",
        "-crf", "20",
        "-pix_fmt", "yuv420p",
        # even dimensions are required by yuv420p; scale already forces them.
        "-profile:v", "high",
        "-level", "4.2",
        "-c:a", "aac",
        "-b:a", "192k",
        "-ar", "48000",
        "-movflags", "+faststart",
    ]


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
    command += ["-t", f"{request.duration:.3f}"]

    chain: list[str] = [_scale_pad_filter(width, height)]

    ass_path: Path | None = None
    if request.burn_captions:
        cues = _build_cues(request, width, height)
        if cues:
            ass_path = _write_temp_ass(
                cues, width, height, request.caption_preset_id, request.caption_position
            )
            # `subtitles` uses libass, which honours the karaoke and box styling
            # written into the ASS file.
            chain.append(f"subtitles='{_escape_filter_path(ass_path)}'")

    # Labels are attached to the chain with no comma: "," joins filter stages,
    # so a stray separator would read as an empty filter name.
    graph = "[0:v:0]" + ",".join(chain) + "[vout]"

    command += ["-filter_complex", graph, "-map", "[vout]"]

    has_audio = _audio_present(request.source)
    if has_audio:
        command += ["-map", "0:a:0?", "-shortest"]
    else:
        # Silent source: still valid, just no audio stream.
        logger.info("no audio stream in %s, rendering video only", request.source.name)

    command += _encoder_args(request.fmt)
    command += ["-progress", "pipe:1", "-nostats", str(request.output)]

    try:
        _run(command, on_progress, cancel)
    finally:
        if ass_path is not None:
            # The ASS file is a temp artifact; the burned video is the deliverable.
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


def _build_cues(request: RenderRequest, width: int, height: int) -> list[CaptionCue]:
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

    return cues_for_window(
        text=text,
        start_sec=request.start_sec,
        end_sec=request.end_sec,
        transcript=request.transcript or [],
        preset_id=request.caption_preset_id,
    )


def _write_temp_ass(
    cues: list[CaptionCue],
    width: int,
    height: int,
    preset_id: str | None = None,
    position: str | None = None,
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
        handle.write(build_ass(cues, width, height, preset_id, position))
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