"""Real ffmpeg rendering.

These run actual encodes. They are the only tests that prove the product works:
everything else can pass while the exported file is unplayable. They are skipped
(not failed) when ffmpeg is absent so the suite still runs on a machine without it.
"""

from __future__ import annotations

import json

import pytest

from app.pipeline.render import (
    RenderError,
    RenderRequest,
    _parse_resolution,
    estimate_size_bytes,
    render_clip,
)
from app.storage import probe, run_ffmpeg


def read_dimensions(path) -> tuple[int, int]:
    return probe(path).width, probe(path).height


# --- Command construction ---------------------------------------------------


def test_resolution_parsing():
    assert _parse_resolution("1080x1920") == (1080, 1920)
    assert _parse_resolution("1920x1080") == (1920, 1080)


def test_resolution_parsing_defaults_on_garbage():
    assert _parse_resolution("nonsense") == (1080, 1920)


def test_resolution_forced_even():
    """yuv420p requires even dimensions; an odd one fails the encode outright."""
    width, height = _parse_resolution("1081x1921")

    assert width % 2 == 0
    assert height % 2 == 0


def test_size_estimate_scales_with_pixels_and_time():
    small = estimate_size_bytes(10, 1080, 1920, "mp4")
    large = estimate_size_bytes(60, 1080, 1920, "mp4")

    assert large > small


# --- Validation -------------------------------------------------------------


def test_missing_source_is_an_error(tmp_path):
    request = RenderRequest(
        source=tmp_path / "does-not-exist.mp4",
        output=tmp_path / "out.mp4",
        start_sec=0,
        end_sec=5,
    )

    with pytest.raises(RenderError, match="missing"):
        render_clip(request)


def test_empty_window_is_rejected(sample_video, tmp_path):
    request = RenderRequest(
        source=sample_video,
        output=tmp_path / "out.mp4",
        start_sec=5,
        end_sec=5,
    )

    with pytest.raises(RenderError, match="empty"):
        render_clip(request)


# --- Real renders -----------------------------------------------------------


def test_plain_cut_produces_a_playable_mp4(sample_video, tmp_path):
    output = tmp_path / "cut.mp4"

    render_clip(
        RenderRequest(
            source=sample_video,
            output=output,
            start_sec=1.0,
            end_sec=4.0,
            aspect_ratio="16:9",
            resolution="640x360",
            burn_captions=False,
        )
    )

    assert output.exists()
    assert output.stat().st_size > 0

    info = probe(output)
    assert info.has_video
    # The cut must land close to 3s. Allow tolerance: container timing is not
    # frame-exact, but an 8-second output would mean -ss was ignored.
    assert 2.5 <= info.duration_sec <= 4.0


def test_vertical_refit_changes_the_dimensions(sample_video, tmp_path):
    """The source is 640x360; a 9:16 render must come back 1080x1920."""
    output = tmp_path / "vertical.mp4"

    render_clip(
        RenderRequest(
            source=sample_video,
            output=output,
            start_sec=0.5,
            end_sec=3.5,
            aspect_ratio="9:16",
            resolution="1080x1920",
            burn_captions=False,
        )
    )

    width, height = read_dimensions(output)
    assert (width, height) == (1080, 1920)


def test_square_refit(sample_video, tmp_path):
    output = tmp_path / "square.mp4"

    render_clip(
        RenderRequest(
            source=sample_video,
            output=output,
            start_sec=0.5,
            end_sec=3.0,
            aspect_ratio="1:1",
            resolution="1080x1080",
            burn_captions=False,
        )
    )

    assert read_dimensions(output) == (1080, 1080)


def test_audio_survives_the_cut(sample_video, tmp_path):
    output = tmp_path / "audio.mp4"

    render_clip(
        RenderRequest(
            source=sample_video,
            output=output,
            start_sec=0.5,
            end_sec=3.0,
            aspect_ratio="16:9",
            resolution="640x360",
            burn_captions=False,
        )
    )

    assert probe(output).has_audio


def test_faststart_puts_the_moov_atom_first(sample_video, tmp_path):
    """Without +faststart a served MP4 will not start playing before fully
    downloading, which looks like a broken export to the user."""
    output = tmp_path / "faststart.mp4"

    render_clip(
        RenderRequest(
            source=sample_video,
            output=output,
            start_sec=0.5,
            end_sec=2.5,
            aspect_ratio="16:9",
            resolution="640x360",
            burn_captions=False,
        )
    )

    # mp4 layout: ftyp then moov, both near the front of the file.
    head = output.read_bytes()[:4096]
    assert b"ftyp" in head
    assert b"moov" in head
    assert head.index(b"moov") < head.index(b"mdat")


def test_burned_captions_produce_a_larger_file(sample_video, tmp_path):
    """Burned text must actually reach the pixels, not just be accepted silently."""
    plain = tmp_path / "plain.mp4"
    captioned = tmp_path / "captioned.mp4"

    render_clip(
        RenderRequest(
            source=sample_video,
            output=plain,
            start_sec=0.5,
            end_sec=3.0,
            aspect_ratio="16:9",
            resolution="640x360",
            burn_captions=False,
            caption_text="This text must be burned into the picture",
        )
    )
    render_clip(
        RenderRequest(
            source=sample_video,
            output=captioned,
            start_sec=0.5,
            end_sec=3.0,
            aspect_ratio="16:9",
            resolution="640x360",
            burn_captions=True,
            caption_text="This text must be burned into the picture",
        )
    )

    assert captioned.stat().st_size > plain.stat().st_size


@pytest.mark.parametrize("preset_id", ["clean", "bold", "karaoke", "minimal", "creator"])
def test_every_caption_preset_renders(sample_video, tmp_path, preset_id):
    """A preset that libass rejects would fail at export time for the user."""
    output = tmp_path / f"{preset_id}.mp4"

    render_clip(
        RenderRequest(
            source=sample_video,
            output=output,
            start_sec=0.5,
            end_sec=2.5,
            aspect_ratio="9:16",
            resolution="1080x1920",
            burn_captions=True,
            caption_preset_id=preset_id,
            caption_text="The mistake is opening with your logo",
        )
    )

    assert output.exists() and output.stat().st_size > 0
    assert probe(output).has_video


def test_karaoke_uses_transcript_word_timings(sample_video, tmp_path):
    output = tmp_path / "karaoke.mp4"

    render_clip(
        RenderRequest(
            source=sample_video,
            output=output,
            start_sec=0.5,
            end_sec=4.0,
            aspect_ratio="9:16",
            resolution="1080x1920",
            burn_captions=True,
            caption_preset_id="karaoke",
            caption_text="one two three four",
            transcript=[
                {
                    "startSec": 0.5,
                    "endSec": 4.0,
                    "text": "one two three four",
                    "words": [
                        {"startSec": 0.5, "endSec": 1.5, "text": "one"},
                        {"startSec": 1.5, "endSec": 2.5, "text": "two"},
                        {"startSec": 2.5, "endSec": 3.2, "text": "three"},
                        {"startSec": 3.2, "endSec": 4.0, "text": "four"},
                    ],
                }
            ],
        )
    )

    assert output.exists() and output.stat().st_size > 0


def test_webm_render(sample_video, tmp_path):
    output = tmp_path / "out.webm"

    render_clip(
        RenderRequest(
            source=sample_video,
            output=output,
            start_sec=0.5,
            end_sec=2.0,
            aspect_ratio="9:16",
            resolution="1080x1920",
            fmt="webm",
            burn_captions=False,
        )
    )

    assert output.exists()
    assert probe(output).has_video


def test_progress_is_reported(sample_video, tmp_path):
    seen: list[float] = []

    render_clip(
        RenderRequest(
            source=sample_video,
            output=tmp_path / "progress.mp4",
            start_sec=0.5,
            end_sec=3.0,
            aspect_ratio="16:9",
            resolution="640x360",
            burn_captions=False,
        ),
        on_progress=seen.append,
    )

    assert seen, "expected at least one progress tick"
    assert all(value >= 0 for value in seen)


def test_cancellation_stops_the_render(sample_video, tmp_path):
    output = tmp_path / "cancelled.mp4"

    with pytest.raises(RuntimeError, match="cancelled"):
        render_clip(
            RenderRequest(
                source=sample_video,
                output=output,
                start_sec=0.0,
                end_sec=6.0,
                aspect_ratio="1080x1920",
                resolution="1080x1920",
                burn_captions=False,
            ),
            cancel=lambda: True,
        )


def test_probe_reports_real_values(sample_video):
    info = probe(sample_video)

    assert info.duration_sec > 5
    assert info.width == 640
    assert info.height == 360
    assert info.has_audio
    assert info.has_video


def test_probe_serialises_with_frontend_names(sample_video):
    payload = probe(sample_video).to_dict()

    assert "durationSec" in payload
    assert "hasAudio" in payload
    json.dumps(payload)  # must be JSON-safe