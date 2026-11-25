"""Silent videos must still produce clips from action/audio signals."""

from __future__ import annotations

from app.config import Settings
from app.pipeline.score import signal_only_candidates


def test_signal_only_candidates_use_audio_and_scene_cuts():
    settings = Settings(clip_min_duration=5, clip_max_duration=30, clip_target_duration=15)
    candidates = signal_only_candidates(
        120,
        settings,
        audio_spikes=[{"t": 12.0, "strength": 0.9}, {"t": 13.0, "strength": 0.8}],
        scene_cuts=[40.0, 41.0],
        face_tracks=[{"t": 12.5, "confidence": 0.8}],
    )

    assert candidates
    assert all(5 <= c.duration <= 30 for c in candidates)
    assert any(c.start_sec <= 12 <= c.end_sec for c in candidates)
    assert all(c.title and c.hook and c.caption for c in candidates)
    assert candidates == sorted(candidates, key=lambda item: item.score, reverse=True)


def test_signal_only_candidates_fall_back_to_even_windows():
    settings = Settings(clip_min_duration=5, clip_max_duration=30, clip_target_duration=15)
    candidates = signal_only_candidates(120, settings, count=4)

    assert len(candidates) == 4
    assert all(c.duration >= 5 for c in candidates)
    # Spread across the source, not all piled at time zero.
    assert len({round(c.start_sec) for c in candidates}) == 4
