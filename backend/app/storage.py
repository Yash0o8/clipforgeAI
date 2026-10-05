"""Filesystem and ffmpeg/ffprobe helpers.

Every path that reaches the filesystem goes through :func:`safe_join`, which
strips traversal segments before joining. Asset ids come from URLs, so they
are untrusted input even though they are generated ids server-side.
"""

from __future__ import annotations

import json
import re
import os
import shutil
import signal
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from .config import get_settings

# Path separators and drive-relative prefixes to reject outright.
_UNSAFE = re.compile(r"[^A-Za-z0-9._-]+")


class StorageError(RuntimeError):
    """Raised when a path escapes the data directory or a file is missing."""


def sanitize_name(name: str, fallback: str = "file") -> str:
    """Reduce an arbitrary string to a safe single path segment.

    Strips directories, keeps the extension, and caps the length so Windows
    MAX_PATH is not a problem.
    """
    raw = Path(name).name  # drops any directory component
    cleaned = _UNSAFE.sub("-", raw).strip("-.")
    if not cleaned:
        return fallback
    stem, dot, ext = cleaned.rpartition(".")
    if dot and len(ext) <= 5 and len(stem) <= 120:
        return cleaned[:150]
    return cleaned[:150]


def safe_join(root: Path, relative: str) -> Path:
    """Join ``relative`` under ``root``, refusing anything that escapes it.

    Raises :class:`StorageError` on traversal attempts so callers can turn that
    into a 4xx rather than a 500.
    """
    root = root.resolve()
    candidate = (root / relative).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as exc:  # pragma: no cover - defensive
        raise StorageError(f"path escapes storage root: {relative!r}") from exc
    return candidate


def write_upload(project_id: str, filename: str, source: Iterable[bytes]) -> Path:
    """Stream an upload to disk in chunks, returning the written path.

    Chunked rather than ``shutil.copyfileobj`` over a fully-read body so a
    multi-GB video does not have to sit in memory first.
    """
    settings = get_settings()
    target = safe_join(settings.upload_dir, f"{project_id}-{sanitize_name(filename)}")
    written = 0
    limit = settings.max_upload_bytes
    with target.open("wb") as handle:
        for chunk in source:
            written += len(chunk)
            if written > limit:
                handle.close()
                target.unlink(missing_ok=True)
                raise StorageError(f"upload exceeds {settings.max_upload_mb}MB limit")
            handle.write(chunk)
    if written == 0:
        target.unlink(missing_ok=True)
        raise StorageError("uploaded file was empty")
    return target


@dataclass(frozen=True)
class MediaInfo:
    duration_sec: float
    width: int | None
    height: int | None
    has_audio: bool
    has_video: bool
    video_codec: str | None
    audio_codec: str | None
    fps: float | None

    def to_dict(self) -> dict[str, Any]:
        return {
            "durationSec": self.duration_sec,
            "width": self.width,
            "height": self.height,
            "hasAudio": self.has_audio,
            "hasVideo": self.has_video,
            "videoCodec": self.video_codec,
            "audioCodec": self.audio_codec,
            "fps": self.fps,
        }


def _parse_fps(raw: str | None) -> float | None:
    """Turn ffprobe's ``"30000/1001"`` rational into a float."""
    if not raw:
        return None
    try:
        if "/" in raw:
            num, den = raw.split("/", 1)
            den_value = float(den)
            return float(num) / den_value if den_value else None
        return float(raw)
    except (TypeError, ValueError):
        return None


def _display_size(stream: dict | None) -> tuple[int | None, int | None]:
    """Return ``(width, height)`` as displayed, honouring a rotation flag.

    A phone recording is usually stored as 1920x1080 with a 90-degree rotation
    side-data entry. ffmpeg autorotates on decode, so the frame a player shows is
    the transposed one. Reporting the coded size would make the frontend build a
    9:16 clip from what is actually a landscape frame.

    Both dimensions must swap together: swapping only the width yields a
    nonsensical pair like 1080x1080 for a 1080x1920 video.
    """
    if not stream:
        return None, None

    width = stream.get("width")
    height = stream.get("height")

    rotation = 0
    for entry in stream.get("side_data_list") or []:
        if "rotation" in entry:
            try:
                rotation = int(float(entry["rotation"]))
            except (TypeError, ValueError):
                rotation = 0
    if not rotation:
        # Older files carry it as a metadata tag rather than side data.
        try:
            rotation = int(float((stream.get("tags") or {}).get("rotate", 0)))
        except (TypeError, ValueError):
            rotation = 0

    try:
        width = int(width) if width else None
        height = int(height) if height else None
    except (TypeError, ValueError):
        return None, None

    if width and height and abs(rotation) in (90, 270):
        return height, width
    return width, height


def probe(path: Path) -> MediaInfo:
    """Read real duration and dimensions via ffprobe.

    This is what fixes the ``durationSec: 0`` class of bug: browser-reported
    metadata is unreliable for streamed or oddly-muxed files, ffprobe is not.
    """
    settings = get_settings()
    command = [
        settings.resolved_ffprobe(),
        "-v", "error",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        str(path),
    ]
    completed = subprocess.run(command, capture_output=True, text=True, timeout=120)
    if completed.returncode != 0:
        raise StorageError(f"ffprobe failed: {completed.stderr.strip()[:400]}")

    try:
        payload = json.loads(completed.stdout or "{}")
    except json.JSONDecodeError as exc:
        raise StorageError("ffprobe returned unparseable output") from exc

    streams = payload.get("streams") or []
    fmt = payload.get("format") or {}

    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)

    # Format duration is preferred; some containers only set it there.
    duration_raw = fmt.get("duration") or (video or {}).get("duration")
    try:
        duration = float(duration_raw or 0.0)
    except (TypeError, ValueError):
        duration = 0.0

    display_width, display_height = _display_size(video)

    return MediaInfo(
        duration_sec=max(duration, 0.0),
        width=display_width,
        height=display_height,
        has_audio=audio is not None,
        has_video=video is not None,
        video_codec=(video or {}).get("codec_name"),
        audio_codec=(audio or {}).get("codec_name"),
        fps=_parse_fps((video or {}).get("avg_frame_rate")),
    )


def run_ffmpeg(args: list[str], progress: Any = None, cancel: Any = None) -> int:
    """Run ffmpeg with progress, cancellation and a hard timeout.

    ``progress`` is called with a 0-100 float parsed from ffmpeg's
    ``-progress pipe:1`` stream. ``cancel`` is polled between output chunks;
    returning True kills the process and raises :class:`RuntimeError`.
    """
    settings = get_settings()
    command = [
        settings.resolved_ffmpeg(),
        "-hide_banner",
        "-nostdin",
        "-loglevel", "error",
        "-progress", "pipe:1",
        "-nostats",
        *args,
    ]

    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )

    stderr_text = ""
    # The timeout is enforced by a watchdog rather than by checking a clock in
    # the read loop. Reading stdout blocks until ffmpeg closes it, and ffmpeg
    # emits nothing while it is stuck grinding on a single slow frame, so a
    # loop-driven deadline can never fire on exactly the case it exists for.
    expired = kill_after(process, settings.ffmpeg_timeout_sec, cancel=cancel)

    try:
        assert process.stdout is not None
        for line in process.stdout:
            key, _, value = line.strip().partition("=")
            if progress is not None and key == "out_time_us":
                try:
                    progress(float(value))
                except (TypeError, ValueError):
                    pass
        process.wait()
    except subprocess.TimeoutExpired:
        terminate_process(process)
        stderr_text = _read_pipe(process.stderr)
        raise RuntimeError("ffmpeg timed out") from None
    except BaseException:
        terminate_process(process)
        _read_pipe(process.stderr)
        raise
    else:
        # Read before the pipes are closed: a closed stream reads as empty, which
        # turns every ffmpeg error into an undiagnosable message.
        stderr_text = _read_pipe(process.stderr)
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
        raise RuntimeError(f"ffmpeg timed out after {settings.ffmpeg_timeout_sec}s")
    if process.returncode != 0:
        raise RuntimeError(f"ffmpeg failed ({process.returncode}): {stderr_text.strip()[:600]}")
    return process.returncode


def terminate_process(process) -> None:
    """Kill a subprocess and anything it spawned.

    ``Popen.kill`` alone is not enough, and the failure is silent: on Windows an
    ``ffmpeg.exe`` on PATH may be a Chocolatey shim, which spawns the real
    binary as a child. Killing the shim returns immediately, the child keeps
    encoding, and because the child still holds the inherited stdout handle the
    reader never sees EOF. The job appears to ignore cancellation and eventually
    reports success for a render the user stopped seconds ago.

    ``taskkill /T`` walks the real process tree, so it catches grandchildren too.
    """
    if process.poll() is not None:
        return

    if os.name == "nt":
        try:
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(process.pid)],
                capture_output=True,
                timeout=20,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            pass
    else:
        try:
            os.killpg(os.getpgid(process.pid), signal.SIGKILL)
        except (OSError, AttributeError):
            pass

    try:
        process.kill()
    except OSError:
        pass

    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        pass


class Watchdog:
    """Watches an ffmpeg process from a timer thread.

    Two jobs, both of which must work while ffmpeg is producing *no* output:

    * enforce a hard timeout, so a wedged encode cannot pin a worker thread; and
    * poll ``cancel``, so a user pressing Cancel is not ignored until ffmpeg
      happens to emit another progress line.

    Both were originally driven from the stdout read loop, which means neither
    worked in the exact case that matters: a filter grinding on one very slow
    frame emits nothing at all.

    ``reason`` is ``"timeout"`` or ``"cancelled"`` once ``fired`` is true.
    """

    def __init__(
        self,
        process,
        seconds: float,
        cancel: Any = None,
        interval: float = 0.25,
    ) -> None:
        self.fired = False
        self.reason = ""
        self._process = process
        self._cancel = cancel
        self._deadline = seconds
        self._interval = interval
        self._stop = threading.Event()
        # Daemon: a stuck watcher must never keep the server process alive.
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self) -> None:
        deadline = time.monotonic() + self._deadline
        while not self._stop.wait(self._interval):
            if self._process.poll() is not None:
                return
            if time.monotonic() >= deadline:
                self._trip("timeout")
                return
            if self._cancel is not None and self._cancel():
                self._trip("cancelled")
                return

    def _trip(self, reason: str) -> None:
        self.fired = True
        self.reason = reason
        terminate_process(self._process)

    def cancel(self) -> None:
        self._stop.set()


def kill_after(process, seconds: float, cancel: Any = None) -> Watchdog:
    return Watchdog(process, seconds, cancel=cancel)


def _read_pipe(stream) -> str:
    """Drain a pipe to EOF. Best-effort: must never mask the real failure."""
    if stream is None or stream.closed:
        return ""
    try:
        return stream.read() or ""
    except (OSError, ValueError):
        return ""


def ffmpeg_available() -> bool:
    """True when both ffmpeg and ffprobe resolve. Surfaced on the health route."""
    import shutil

    settings = get_settings()
    return bool(shutil.which(settings.ffmpeg_binary) and shutil.which(settings.ffprobe_binary))
