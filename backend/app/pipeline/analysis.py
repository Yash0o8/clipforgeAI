"""Optional mode-specific analysis helpers.

These functions are best-effort and dependency-gated. The core pipeline must
continue working when optional CV/audio packages are unavailable.
"""

from __future__ import annotations

import logging
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..storage import run_ffmpeg

logger = logging.getLogger(__name__)

# OpenCV ships these cascade XML files with every opencv-python wheel. They are
# a dependency-free fallback for installs where MediaPipe is missing or only
# exposes the newer Tasks API (no ``mp.solutions``).
_HAAR_CASCADES = (
    "haarcascade_frontalface_default.xml",
    "haarcascade_frontalface_alt2.xml",
)


def _load_haar_cascade(cv2: Any) -> Any | None:
    """Load a bundled Haar face cascade, or return None when unavailable."""
    data = getattr(cv2, "data", None)
    root = Path(str(getattr(data, "haarcascades", "") or ""))
    for name in _HAAR_CASCADES:
        path = root / name
        if not path.is_file():
            continue
        try:
            cascade = cv2.CascadeClassifier(str(path))
        except Exception:
            continue
        # load() returns False on a corrupt/missing file; detectMultiScale would
        # then throw on every frame, so check it once up front.
        if hasattr(cascade, "empty") and cascade.empty():
            continue
        return cascade
    return None


def _mediapipe_frame_faces(cv2: Any, frame: Any, detector: Any) -> list[dict[str, float]]:
    """Normalize MediaPipe detections into {cx,cy,w,h,confidence} dicts."""
    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    result = detector.process(rgb)
    faces: list[dict[str, float]] = []
    for det in getattr(result, "detections", None) or []:
        box = det.location_data.relative_bounding_box
        score = float(getattr(det, "score", [0.0])[0] if getattr(det, "score", None) else 0.0)
        faces.append(
            {
                "cx": float(box.xmin + box.width / 2),
                "cy": float(box.ymin + box.height / 2),
                "w": float(box.width),
                "h": float(box.height),
                "confidence": score,
            }
        )
    return faces


def _opencv_frame_faces(cv2: Any, frame: Any, detector: Any) -> list[dict[str, float]]:
    """Normalize OpenCV Haar detections. Haar has no score, so use a fixed
    moderate confidence that survives the later gate without disabling jitter
    smoothing."""
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    height, width = gray.shape[:2]
    if height <= 0 or width <= 0:
        return []
    boxes = detector.detectMultiScale(
        gray,
        scaleFactor=1.1,
        minNeighbors=5,
        minSize=(64, 64),
    )
    faces: list[dict[str, float]] = []
    for x, y, w, h in boxes:
        norm_w = float(w) / width
        norm_h = float(h) / height
        # Gameplay HUDs and UI cards produce many tiny, tall false positives.
        # A real speaker/facecam face is reasonably large and near square.
        if norm_w < 0.05 or norm_h < 0.05:
            continue
        # Compare pixel dimensions: a square face in a 16:9 frame is *not*
        # square after normalising x and y by different frame dimensions.
        aspect = float(w) / max(float(h), 1e-6)
        if aspect < 0.6 or aspect > 1.6:
            continue
        faces.append(
            {
                "cx": (float(x) + float(w) / 2) / width,
                "cy": (float(y) + float(h) / 2) / height,
                "w": norm_w,
                "h": norm_h,
                "confidence": 0.75,
            }
        )
    return faces


def _sample_face_tracks(
    cv2: Any,
    cap: Any,
    faces_for_frame: Any,
    *,
    start_frame: int,
    end_frame: int,
    step: int,
    fps: float,
    max_samples: int,
) -> list[dict[str, Any]]:
    """Read sampled frames and keep the most prominent face in each one."""
    tracks: list[dict[str, Any]] = []
    frame_idx = start_frame
    while frame_idx < end_frame and len(tracks) < max_samples:
        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
        ok, frame = cap.read()
        if not ok:
            break
        faces = faces_for_frame(frame)
        if faces:
            # Pick the most confident/largest face as an active-speaker proxy.
            best = max(faces, key=lambda f: f["w"] * f["h"] * (0.5 + f["confidence"]))
            tracks.append(
                {
                    "t": round(frame_idx / fps, 3),
                    "cx": max(0.0, min(1.0, best["cx"])),
                    "cy": max(0.0, min(1.0, best["cy"])),
                    "w": max(0.05, min(1.0, best["w"])),
                    "h": max(0.05, min(1.0, best["h"])),
                    "confidence": max(0.0, min(1.0, best["confidence"])),
                }
            )
        frame_idx += step
    return tracks


@dataclass
class FaceTrack:
    # Normalized center x/y and box width/height in [0,1], keyed by source seconds.
    t: float
    cx: float
    cy: float
    w: float
    h: float
    confidence: float = 0.0


def suggest_facecam_box(face_tracks: list[dict[str, Any]]) -> dict[str, float] | None:
    """Suggest a gaming PiP facecam box from detected face tracks.

    Returns normalized {x,y,w,h} in [0,1] or None when confidence/data is weak.
    """
    pts = [t for t in face_tracks if isinstance(t, dict)]
    if not pts:
        return None
    good = [t for t in pts if float(t.get("confidence", 0.0) or 0.0) >= 0.45]
    use = good or pts
    if len(use) < 2:
        return None
    avg_conf = sum(float(t.get("confidence", 0.0) or 0.0) for t in use) / len(use)
    if avg_conf < 0.4:
        return None
    avg_w = sum(float(t.get("w", 0.2) or 0.2) for t in use) / len(use)
    avg_h = sum(float(t.get("h", 0.2) or 0.2) for t in use) / len(use)
    avg_cx = sum(float(t.get("cx", 0.5) or 0.5) for t in use) / len(use)
    avg_cy = sum(float(t.get("cy", 0.4) or 0.4) for t in use) / len(use)
    # Facecam PiP should be compact; keep within safe bounds.
    w = min(0.34, max(0.18, avg_w * 1.9))
    h = min(0.34, max(0.18, avg_h * 1.9))
    # Prefer detected face side, but keep margin from edges.
    x = 0.72 if avg_cx >= 0.5 else 0.04
    y = 0.04 if avg_cy <= 0.55 else 0.08
    return {
        "x": round(min(0.95 - w, max(0.02, x)), 4),
        "y": round(min(0.95 - h, max(0.02, y)), 4),
        "w": round(w, 4),
        "h": round(h, 4),
    }


def detect_face_tracks(
    source: Path,
    *,
    start_sec: float = 0.0,
    end_sec: float | None = None,
    sample_fps: float = 2.0,
    max_samples: int = 180,
) -> list[dict[str, Any]]:
    """Detect a primary speaker face track.

    MediaPipe is preferred, but OpenCV's bundled Haar cascade is used when
    MediaPipe is absent or exposes only its newer Tasks API. Returns dicts
    suitable for JSON storage; an empty list means no face was found.
    """
    try:
        import cv2  # type: ignore
    except Exception:
        logger.info("face tracking unavailable: opencv-python not installed")
        return []

    cap = cv2.VideoCapture(str(source))
    if not cap.isOpened():
        return []

    fps = float(cap.get(cv2.CAP_PROP_FPS) or 30.0)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    duration = (total_frames / fps) if fps > 0 else 0.0
    clip_end = min(duration, end_sec) if end_sec is not None else duration
    clip_start = max(0.0, start_sec)
    if clip_end <= clip_start:
        cap.release()
        return []

    step = max(1, int(round(fps / max(0.2, sample_fps))))
    start_frame = int(clip_start * fps)
    end_frame = int(clip_end * fps) if clip_end > 0 else total_frames
    tracks: list[dict[str, Any]] = []
    sample_kwargs = {
        "start_frame": start_frame,
        "end_frame": end_frame,
        "step": step,
        "fps": fps,
        "max_samples": max_samples,
    }

    try:
        # A missing mp.solutions attribute is expected with newer MediaPipe
        # releases; it must fall through instead of aborting face tracking.
        try:
            import mediapipe as mp  # type: ignore
        except Exception:
            mp = None

        if mp is not None:
            try:
                mp_face = mp.solutions.face_detection
                with mp_face.FaceDetection(model_selection=1, min_detection_confidence=0.35) as detector:
                    tracks = _sample_face_tracks(
                        cv2,
                        cap,
                        lambda frame: _mediapipe_frame_faces(cv2, frame, detector),
                        **sample_kwargs,
                    )
            except Exception as exc:
                logger.info("MediaPipe face detector unusable (%s); using OpenCV fallback", exc)
                tracks = []

        if not tracks:
            cascade = _load_haar_cascade(cv2)
            if cascade is None:
                logger.info("face tracking unavailable: no MediaPipe or Haar cascade")
            else:
                tracks = _sample_face_tracks(
                    cv2,
                    cap,
                    lambda frame: _opencv_frame_faces(cv2, frame, cascade),
                    **sample_kwargs,
                )
    finally:
        cap.release()

    # Confidence gate + smoothing to reduce jitter and bad jumps.
    filtered: list[dict[str, Any]] = []
    min_conf = 0.35
    for t in tracks:
        conf = float(t.get("confidence", 0.0) or 0.0)
        if conf < min_conf:
            continue
        if filtered:
            prev = filtered[-1]
            dt = max(0.001, float(t["t"]) - float(prev["t"]))
            max_jump = 0.35 * dt + 0.08  # normalized frame jump allowance
            if abs(float(t["cx"]) - float(prev["cx"])) > max_jump and conf < 0.7:
                # Low-confidence jump: keep previous center but update timestamp lightly.
                filtered.append({**prev, "t": t["t"], "confidence": conf})
                continue
        filtered.append(t)

    tracks = filtered
    if len(tracks) >= 3:
        smoothed = []
        alpha = 0.35  # EMA smoothing
        prev = dict(tracks[0])
        smoothed.append(prev)
        for cur in tracks[1:]:
            nxt = dict(cur)
            for k in ("cx", "cy", "w", "h"):
                nxt[k] = (alpha * float(cur[k])) + ((1 - alpha) * float(prev[k]))
            smoothed.append(nxt)
            prev = nxt
        tracks = smoothed

    return tracks


def _decode_mono_wav(source: Path, scratch: Path, offset: float, duration: float | None) -> Path:
    """Decode an audio window to a WAV librosa can always read.

    soundfile (librosa's default backend) cannot open most MP4 containers, so
    both audio-based analysers use the ffmpeg binary the pipeline already
    requires instead of calling ``librosa.load`` on the source video.
    """
    wav_path = Path(scratch) / "audio.wav"
    cmd = ["-i", str(source), "-vn", "-ac", "1", "-ar", "22050"]
    if offset > 0:
        cmd += ["-ss", str(offset)]
    if duration is not None:
        cmd += ["-t", str(duration)]
    cmd += ["-c:a", "pcm_s16le", "-f", "wav", str(wav_path)]
    run_ffmpeg(cmd)
    return wav_path


def detect_audio_spikes(
    source: Path,
    *,
    start_sec: float = 0.0,
    end_sec: float | None = None,
    top_n: int = 12,
) -> list[dict[str, float]]:
    """Detect loud/action moments using librosa when available."""
    try:
        import librosa  # type: ignore
        import numpy as np  # type: ignore
    except Exception:
        logger.info("audio spike detection unavailable: librosa/numpy not installed")
        return []

    offset = max(0.0, start_sec)
    duration = max(0.1, end_sec - offset) if end_sec is not None else None

    # soundfile (librosa's default backend) cannot open most MP4 containers.
    # Decode the requested window to a 22.05 kHz mono WAV with the ffmpeg the
    # rest of the pipeline already requires, then hand that to librosa.
    try:
        with tempfile.TemporaryDirectory(prefix="clipforge_spikes_") as scratch:
            wav_path = _decode_mono_wav(source, Path(scratch), offset, duration)
            y, sr = librosa.load(str(wav_path), sr=22050, mono=True)
    except Exception:
        logger.warning("audio spike decode failed for %s", source.name)
        return []

    try:
        if y is None or len(y) == 0:
            return []
        hop = 512
        rms = librosa.feature.rms(y=y, hop_length=hop)[0]
        if len(rms) == 0:
            return []
        times = librosa.frames_to_time(range(len(rms)), sr=sr, hop_length=hop) + offset
        thresh = float(np.percentile(rms, 92))
        peaks: list[dict[str, float]] = []
        for i, val in enumerate(rms):
            if float(val) >= thresh:
                peaks.append({"t": round(float(times[i]), 3), "strength": round(float(val), 5)})
        # Deduplicate close peaks.
        peaks.sort(key=lambda p: p["strength"], reverse=True)
        selected: list[dict[str, float]] = []
        for p in peaks:
            if all(abs(p["t"] - s["t"]) > 1.5 for s in selected):
                selected.append(p)
            if len(selected) >= top_n:
                break
        selected.sort(key=lambda p: p["t"])
        return selected
    except Exception:
        logger.exception("audio spike detection failed; continuing without spikes")
        return []


def detect_scene_cuts(
    source: Path,
    *,
    start_sec: float = 0.0,
    end_sec: float | None = None,
    max_cuts: int = 40,
) -> list[float]:
    """Detect scene cuts using PySceneDetect when available."""
    try:
        from scenedetect import SceneManager, open_video  # type: ignore
        from scenedetect.detectors import ContentDetector  # type: ignore
    except Exception:
        logger.info("scene cut detection unavailable: scenedetect not installed")
        return []

    try:
        video = open_video(str(source))
        scene_manager = SceneManager()
        scene_manager.add_detector(ContentDetector())
        # PySceneDetect API differs across versions; detect_scenes handles whole video.
        scene_manager.detect_scenes(video)
        scene_list = scene_manager.get_scene_list()
        cuts: list[float] = []
        for _, end in scene_list:
            t = float(end.get_seconds())
            if t < start_sec:
                continue
            if end_sec is not None and t > end_sec:
                continue
            cuts.append(round(t, 3))
            if len(cuts) >= max_cuts:
                break
        return cuts
    except Exception:
        logger.exception("scene cut detection failed; continuing without cuts")
        return []


def detect_dead_air_intervals(
    source: Path,
    *,
    start_sec: float = 0.0,
    end_sec: float | None = None,
    silence_threshold_db: float = -32.0,
    min_silence_sec: float = 0.6,
) -> list[dict[str, float]]:
    """Detect silence/dead-air intervals.

    Uses auto-editor's loudness analysis when installed; falls back to librosa RMS.
    Returns source-absolute intervals.
    """
    try:
        from auto_editor.analyze.audio import audio_detection  # type: ignore
        from auto_editor.utils.bar import Bar  # type: ignore
        from auto_editor.utils.log import Log  # type: ignore

        # auto-editor internals are not a stable public API; guard carefully.
        log = Log(quiet=True)
        bar = Bar("none")
        # audio_detection signature can vary; try common form.
        loud = audio_detection(str(source), bar, log, stream=0)  # type: ignore[misc]
        # loud is usually a numpy bool/float array per frame chunk; derive silence spans.
        import numpy as np  # type: ignore

        arr = np.asarray(loud)
        if arr.ndim > 1:
            arr = arr.reshape(-1)
        # assume ~10 fps chunks if unknown; better to fallback below on weird shapes.
        fps_guess = 10.0
        silent = arr <= 0.5 if arr.dtype != bool else ~arr
        intervals: list[dict[str, float]] = []
        cur_start = None
        for i, is_silent in enumerate(silent):
            t = start_sec + i / fps_guess
            if end_sec is not None and t > end_sec:
                break
            if is_silent and cur_start is None:
                cur_start = t
            elif not is_silent and cur_start is not None:
                if t - cur_start >= min_silence_sec:
                    intervals.append({"startSec": round(cur_start, 3), "endSec": round(t, 3)})
                cur_start = None
        if cur_start is not None:
            t = start_sec + len(silent) / fps_guess
            if end_sec is not None:
                t = min(t, end_sec)
            if t - cur_start >= min_silence_sec:
                intervals.append({"startSec": round(cur_start, 3), "endSec": round(t, 3)})
        if intervals:
            return intervals
    except Exception:
        pass

    try:
        import librosa  # type: ignore
        import numpy as np  # type: ignore

        offset = max(0.0, start_sec)
        duration = max(0.1, end_sec - offset) if end_sec is not None else None
        # librosa cannot read MP4 audio directly; use the same ffmpeg WAV decode
        # as spike detection so silence removal works on uploaded videos.
        with tempfile.TemporaryDirectory(prefix="clipforge_deadair_") as scratch:
            wav_path = _decode_mono_wav(source, Path(scratch), offset, duration)
            y, sr = librosa.load(str(wav_path), sr=22050, mono=True)
        if y is None or len(y) == 0:
            return []
        hop = 512
        rms = librosa.feature.rms(y=y, hop_length=hop)[0]
        db = librosa.amplitude_to_db(rms, ref=np.max)
        times = librosa.frames_to_time(range(len(db)), sr=sr, hop_length=hop) + offset
        intervals = []
        cur_start = None
        for i, val in enumerate(db):
            t = float(times[i])
            is_silent = float(val) < silence_threshold_db
            if is_silent and cur_start is None:
                cur_start = t
            elif not is_silent and cur_start is not None:
                if t - cur_start >= min_silence_sec:
                    intervals.append({"startSec": round(cur_start, 3), "endSec": round(t, 3)})
                cur_start = None
        if cur_start is not None:
            t = float(times[-1])
            if t - cur_start >= min_silence_sec:
                intervals.append({"startSec": round(cur_start, 3), "endSec": round(t, 3)})
        return intervals
    except Exception:
        logger.info("dead-air detection unavailable; continuing without silence removal")
        return []