"""Optional mode-specific analysis helpers.

These functions are best-effort and dependency-gated. The core pipeline must
continue working when optional CV/audio packages are unavailable.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class FaceTrack:
    # Normalized center x/y and box width/height in [0,1], keyed by source seconds.
    t: float
    cx: float
    cy: float
    w: float
    h: float
    confidence: float = 0.0


def detect_face_tracks(
    source: Path,
    *,
    start_sec: float = 0.0,
    end_sec: float | None = None,
    sample_fps: float = 2.0,
    max_samples: int = 180,
) -> list[dict[str, Any]]:
    """Detect a primary speaker face track using MediaPipe when available.

    Returns a list of dicts suitable for JSON storage. Falls back to empty list
    when mediapipe/cv2 are unavailable or detection fails.
    """
    try:
        import cv2  # type: ignore
    except Exception:
        logger.info("face tracking unavailable: opencv-python not installed")
        return []

    try:
        import mediapipe as mp  # type: ignore
    except Exception:
        logger.info("face tracking unavailable: mediapipe not installed")
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

    try:
        mp_face = mp.solutions.face_detection
        with mp_face.FaceDetection(model_selection=1, min_detection_confidence=0.35) as detector:
            frame_idx = start_frame
            while frame_idx < end_frame and len(tracks) < max_samples:
                cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
                ok, frame = cap.read()
                if not ok:
                    break
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                result = detector.process(rgb)
                detections = getattr(result, "detections", None) or []
                if detections:
                    # Pick the most confident/largest face as active speaker proxy.
                    best = None
                    best_area = -1.0
                    for det in detections:
                        box = det.location_data.relative_bounding_box
                        area = float(box.width) * float(box.height)
                        score = float(getattr(det, "score", [0.0])[0] if getattr(det, "score", None) else 0.0)
                        if area * (0.5 + score) > best_area:
                            best = det
                            best_area = area * (0.5 + score)
                    if best is not None:
                        box = best.location_data.relative_bounding_box
                        cx = float(box.xmin + box.width / 2)
                        cy = float(box.ymin + box.height / 2)
                        tracks.append(
                            {
                                "t": round(frame_idx / fps, 3),
                                "cx": max(0.0, min(1.0, cx)),
                                "cy": max(0.0, min(1.0, cy)),
                                "w": max(0.05, min(1.0, float(box.width))),
                                "h": max(0.05, min(1.0, float(box.height))),
                                "confidence": float(getattr(best, "score", [0.0])[0] if getattr(best, "score", None) else 0.0),
                            }
                        )
                frame_idx += step
    except Exception:
        logger.exception("face tracking failed; continuing without tracks")
        return []
    finally:
        cap.release()

    # Light smoothing to avoid jitter.
    if len(tracks) >= 3:
        smoothed = []
        for i, cur in enumerate(tracks):
            window = tracks[max(0, i - 1) : min(len(tracks), i + 2)]
            smoothed.append(
                {
                    **cur,
                    "cx": sum(x["cx"] for x in window) / len(window),
                    "cy": sum(x["cy"] for x in window) / len(window),
                    "w": sum(x["w"] for x in window) / len(window),
                    "h": sum(x["h"] for x in window) / len(window),
                }
            )
        tracks = smoothed

    return tracks


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

    try:
        duration = None
        offset = max(0.0, start_sec)
        if end_sec is not None:
            duration = max(0.1, end_sec - offset)
        y, sr = librosa.load(str(source), sr=22050, mono=True, offset=offset, duration=duration)
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
        y, sr = librosa.load(str(source), sr=22050, mono=True, offset=offset, duration=duration)
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