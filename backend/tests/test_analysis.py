"""Dependency-gated analysis helpers must degrade without losing the pipeline.

MediaPipe is not always usable (newer wheels expose only the Tasks API), and
librosa cannot read audio directly from an MP4. Both cases need real fallbacks
because podcast face-cropping and dead-air removal depend on them.
"""

from __future__ import annotations

import math
import struct
import sys
import wave
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest


def test_face_tracks_fall_back_to_opencv_when_mediapipe_is_not_usable(monkeypatch, tmp_path):
    """A mediapipe without ``solutions`` must not disable face tracking."""
    from app.pipeline import analysis

    cascade_dir = tmp_path / "haarcascades"
    cascade_dir.mkdir()
    (cascade_dir / "haarcascade_frontalface_default.xml").write_text("", encoding="utf-8")

    frames = [SimpleNamespace(shape=(400, 400, 3)) for _ in range(3)]

    class FakeCapture:
        def __init__(self, source: str) -> None:
            self.source = source
            self.pos = 0

        def isOpened(self) -> bool:
            return True

        def get(self, prop: int) -> float:
            return {1: 1.0, 7: float(len(frames))}.get(prop, 0.0)

        def set(self, prop: int, value: float) -> bool:
            if prop == 201:  # CAP_PROP_POS_FRAMES
                self.pos = int(value)
            return True

        def read(self):
            if self.pos >= len(frames):
                return False, None
            frame = frames[self.pos]
            self.pos += 1
            return True, frame

        def release(self) -> None:
            return None

    class FakeCascade:
        def __init__(self, path: str) -> None:
            self.path = path

        def empty(self) -> bool:
            return False

        def detectMultiScale(self, gray, **kwargs):
            # A HUD-like small/tall rectangle must be ignored in favour of a
            # plausible face-sized, near-square box.
            return [(10, 10, 20, 80), (100, 100, 80, 80)]

    cv2 = ModuleType("cv2")
    cv2.VideoCapture = FakeCapture  # type: ignore[attr-defined]
    cv2.CAP_PROP_FPS = 1  # type: ignore[attr-defined]
    cv2.CAP_PROP_FRAME_COUNT = 7  # type: ignore[attr-defined]
    cv2.CAP_PROP_POS_FRAMES = 201  # type: ignore[attr-defined]
    cv2.COLOR_BGR2GRAY = 6  # type: ignore[attr-defined]
    cv2.cvtColor = lambda frame, code: frame  # type: ignore[attr-defined]
    cv2.data = SimpleNamespace(haarcascades=str(cascade_dir))  # type: ignore[attr-defined]
    cv2.CascadeClassifier = FakeCascade  # type: ignore[attr-defined]

    mediapipe = ModuleType("mediapipe")  # intentionally has no .solutions

    monkeypatch.setitem(sys.modules, "cv2", cv2)
    monkeypatch.setitem(sys.modules, "mediapipe", mediapipe)

    source = tmp_path / "source.mp4"
    source.write_bytes(b"fake-video")

    tracks = analysis.detect_face_tracks(source, sample_fps=2, max_samples=10)

    assert len(tracks) == len(frames)
    assert all(track["confidence"] >= 0.35 for track in tracks)
    assert tracks[0]["cx"] == pytest.approx(0.35)
    assert tracks[0]["w"] == pytest.approx(0.2)
    box = analysis.suggest_facecam_box(tracks)
    assert box is not None
    assert box["x"] == pytest.approx(0.04)


def test_dead_air_detection_decodes_video_audio_with_ffmpeg(monkeypatch, tmp_path):
    """Silence detection must work on an MP4 by decoding to WAV first."""
    pytest.importorskip("librosa")
    from app.pipeline import analysis

    # Force the librosa fallback even on machines that have auto-editor.
    for name in (
        "auto_editor",
        "auto_editor.analyze",
        "auto_editor.analyze.audio",
        "auto_editor.utils",
        "auto_editor.utils.bar",
        "auto_editor.utils.log",
    ):
        monkeypatch.setitem(sys.modules, name, None)

    decode_calls: list[list[str]] = []

    def fake_run_ffmpeg(command: list[str]) -> None:
        decode_calls.append(command)
        output = Path(command[-1])
        with wave.open(str(output), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(22050)
            samples: list[bytes] = []
            for i in range(22050 * 3):
                if 22050 <= i < 44100:
                    value = int(9000 * math.sin(2 * math.pi * 220 * i / 22050))
                else:
                    value = 0
                samples.append(struct.pack("<h", value))
            wav.writeframes(b"".join(samples))

    monkeypatch.setattr(analysis, "run_ffmpeg", fake_run_ffmpeg)

    source = tmp_path / "gameplay.mp4"
    source.write_bytes(b"fake-video")

    intervals = analysis.detect_dead_air_intervals(
        source,
        silence_threshold_db=-30,
        min_silence_sec=0.5,
    )

    assert decode_calls, "audio must be decoded through ffmpeg"
    assert decode_calls[0][0] == "-i"
    assert decode_calls[0][1] == str(source)
    assert len(intervals) >= 2
    assert intervals[0]["startSec"] <= 0.1
    assert intervals[0]["endSec"] <= 1.2
    assert intervals[-1]["endSec"] >= 2.8
