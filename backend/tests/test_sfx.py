"""Auto-SFX cues: generated from multimodal signals and rendered safely."""

from __future__ import annotations

from app.pipeline.render import RenderRequest, _build_sfx_audio_filter, render_clip
from app.pipeline.runner import build_sfx_markers
from app.pipeline.score import Candidate
from app.storage import probe
from app.utils import Segment, WordTiming


def test_build_sfx_markers_uses_spikes_cuts_and_keyword_hits():
    """Markers are clip-relative, deduplicated and ranked by signal strength."""
    candidate = Candidate(
        start_sec=10.0,
        end_sec=20.0,
        text="Bhai kya scene hai",
        segments=[],
        score=80,
        keywords=["bhai", "scene"],
    )
    transcript = [
        Segment(
            10.0,
            20.0,
            "Bhai kya scene hai",
            words=[
                WordTiming(10.5, 10.8, "Bhai"),
                WordTiming(12.0, 12.3, "kya"),
                WordTiming(13.0, 13.4, "scene"),
            ],
        )
    ]
    settings = {
        "audioSpikes": [
            {"t": 12.2, "strength": 0.9},  # collides with a cut; impact wins
            {"t": 14.8, "strength": 0.8},
        ],
        "sceneCuts": [12.1, 16.0],
    }

    markers = build_sfx_markers(candidate, transcript, settings)

    assert [marker["t"] for marker in markers] == sorted(marker["t"] for marker in markers)
    kinds = [marker["type"] for marker in markers]
    assert "impact" in kinds
    assert "whoosh" in kinds
    assert "pop" in kinds
    # The colliding whoosh at 2.1s must lose to the impact at 2.2s.
    assert not any(marker["t"] == 2.1 for marker in markers)
    assert {marker["source"] for marker in markers} >= {"audio_spike", "scene_cut", "keyword"}
    # 'kya' is not a keyword and must not produce a cue.
    assert not any(marker["t"] == 2.0 for marker in markers)


def test_sfx_filter_builds_whoosh_and_distinct_pops(tmp_path):
    request = RenderRequest(
        source=tmp_path / "source.mp4",
        output=tmp_path / "out.mp4",
        start_sec=0.0,
        end_sec=4.0,
        sfx_enabled=True,
        sfx_markers=[
            {"t": 1.0, "type": "whoosh"},
            {"t": 2.0, "type": "pop"},
            {"t": 3.0, "type": "impact"},
        ],
    )

    graph = _build_sfx_audio_filter(request, keeps=[(0.0, 4.0)])

    assert "anoisesrc=color=pink" in graph
    assert "sine=frequency=880" in graph
    assert "sine=frequency=240" in graph
    assert graph.endswith("[sfx]")


def test_sfx_markers_render_into_a_playable_mp4(sample_video, tmp_path):
    """The synthesized SFX filter must survive a real ffmpeg encode."""
    output = tmp_path / "sfx.mp4"
    render_clip(
        RenderRequest(
            source=sample_video,
            output=output,
            start_sec=0.5,
            end_sec=3.5,
            aspect_ratio="16:9",
            resolution="320x180",
            burn_captions=False,
            sfx_enabled=True,
            sfx_markers=[
                {"t": 1.0, "type": "whoosh"},
                {"t": 1.8, "type": "pop"},
                {"t": 2.4, "type": "impact"},
            ],
        )
    )

    assert output.exists()
    info = probe(output)
    assert info.has_video
    assert info.has_audio
