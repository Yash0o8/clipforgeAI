"""Caption styling and ASS/SRT generation.

The ASS format has two traps this module exists to avoid:

1. Colour is ``&HAABBGGRR`` — alpha first, then *reversed* RGB. Getting this
   wrong produces silently wrong-coloured burned captions.
2. A comma inside a Dialogue line is a field separator, so unescaped commas
   shift every column after the text.

Both are invisible in a diff and obvious in the rendered file, hence tests.
"""

from __future__ import annotations

import pytest

from app.pipeline.captions import (
    PRESETS,
    build_style,
    escape_text,
    is_transparent,
    parse_color,
    resolve_position,
    strip_ass_formatting,
    to_ass_color,
)
from app.pipeline.subtitles import (
    CaptionCue,
    WordCue,
    build_ass,
    build_srt,
    build_vtt,
    clean_caption,
    cues_for_window,
    group_words,
    real_word_timings,
    resolve_caption_text,
    spread_words,
)


# --- Colour -----------------------------------------------------------------


def test_parse_color_hex6():
    assert parse_color("#c4b5fd") == (196, 181, 253)


def test_parse_color_hex3_expands():
    assert parse_color("#fff") == (255, 255, 255)


def test_parse_color_rejects_garbage():
    with pytest.raises(ValueError):
        parse_color("chartreuse")


def test_ass_color_is_bgr_with_alpha_first():
    """#RRGGBB opaque -> &H00BBGGRR. This is the single most common mistake."""
    assert to_ass_color("#ff8800") == "&H000088FF"


def test_ass_color_rgba_alpha_is_inverted():
    """CSS alpha 0.62 opacity -> 0.38 transparency -> 0x61 alpha."""
    result = to_ass_color("rgba(9, 9, 16, 0.62)")

    # Layout is "&H" + AA + BB + GG + RR.
    assert result[:2] == "&H"
    assert int(result[2:4], 16) == pytest.approx(97, abs=2)


def test_ass_color_explicit_alpha_overrides():
    assert to_ass_color("rgba(9, 9, 16, 0.62)", alpha=0) == "&H00100909"


def test_is_transparent_detects_both_forms():
    assert is_transparent("transparent")
    assert is_transparent("rgba(0,0,0,0)")
    assert not is_transparent("rgba(0,0,0,0.6)")
    assert not is_transparent("#ffffff")


# --- Position ---------------------------------------------------------------


def test_null_position_inherits_the_preset():
    assert resolve_position("bold", None) == "center"
    assert resolve_position("clean", None) == "lower"


def test_explicit_position_overrides_the_preset():
    assert resolve_position("clean", "top") == "top"


def test_unknown_preset_falls_back_to_defaults():
    style = build_style("does-not-exist", None, "1080x1920", 1080, 1920)

    assert style == build_style("clean", None, "1080x1920", 1080, 1920)


# --- Scaling ----------------------------------------------------------------


def test_font_size_scales_with_frame_width():
    vertical = build_style("clean", None, "1080x1920", 1080, 1920)
    landscape = build_style("clean", None, "1920x1080", 1920, 1080)

    assert landscape.font_size > vertical.font_size


def test_font_size_is_readable_at_every_ratio():
    for resolution, width, height in (
        ("1080x1920", 1080, 1920),
        ("1080x1080", 1080, 1080),
        ("1920x1080", 1920, 1080),
    ):
        style = build_style("bold", None, resolution, width, height)
        assert style.font_size >= 12


def test_margins_scale_with_the_frame():
    vertical = build_style("clean", None, "1080x1920", 1080, 1920)
    square = build_style("clean", None, "1080x1080", 1080, 1080)

    assert vertical.margin_v > square.margin_v


def test_every_preset_builds():
    """A preset that cannot be styled is a preset that crashes at render time."""
    for preset_id in PRESETS:
        style = build_style(preset_id, None, "1080x1920", 1080, 1920)
        assert style.font_size >= 12
        assert style.style_line("Default").startswith("Style: Default")


def test_box_presets_use_border_style_three():
    """clean has a background plate; it needs an opaque box, not an outline."""
    clean = build_style("clean", None, "1080x1920", 1080, 1920)
    minimal = build_style("minimal", None, "1080x1920", 1080, 1920)

    assert clean.border_style == 3
    assert minimal.border_style == 1


# --- Escaping ---------------------------------------------------------------


def test_escape_text_protects_braces():
    """Unescaped braces are ASS override blocks and would eat the caption."""
    assert "\\{" in escape_text("hello {world}")
    assert "\\}" in escape_text("hello {world}")


def test_escape_text_escapes_commas():
    """A raw comma shifts every Dialogue column after the text."""
    escaped = escape_text("one, two, three")

    assert "\\," in escaped


def test_escape_text_doubles_backslashes_first():
    # A single pass must not re-escape its own output.
    assert escape_text("a\\b") == "a\\\\b"


def test_escape_text_strips_existing_formatting():
    assert strip_ass_formatting("{\\pos(10,20)}hello") == "hello"


def test_escape_text_collapses_newlines():
    assert "\n" not in escape_text("one\ntwo")


# --- Cue construction -------------------------------------------------------


def test_spread_words_covers_the_span():
    words = spread_words("one two three", 0.0, 9.0)

    assert words[0].start == pytest.approx(0.0)
    assert words[-1].end == pytest.approx(9.0)


def test_group_words_respects_the_limit():
    words = spread_words("one two three four five six seven eight", 0.0, 8.0)

    groups = group_words(words, per_cue=3)

    assert all(len(group) <= 3 for group in groups)
    assert sum(len(group) for group in groups) == 8


def test_group_words_breaks_on_sentences():
    words = spread_words("End of one. Start of two and more text here", 0.0, 6.0)

    groups = group_words(words, per_cue=6)

    assert groups[0][-1].text.endswith(".")


def test_real_word_timings_used_when_the_caption_matches():
    transcript = [
        {
            "startSec": 10.0,
            "endSec": 12.0,
            "text": "Exact caption text",
            "words": [
                {"startSec": 10.0, "endSec": 10.5, "text": "Exact"},
                {"startSec": 10.5, "endSec": 12.0, "text": "caption text"},
            ],
        }
    ]

    words = real_word_timings(transcript, "Exact   caption text")

    assert [w.text for w in words] == ["Exact", "caption text"]
    assert words[0].start == pytest.approx(10.0)


def test_real_word_timings_empty_on_mismatch():
    assert real_word_timings([{"text": "something else", "words": []}], "no match") == []


def test_clean_caption_normalises_whitespace():
    assert clean_caption("  hello \n  world  ") == "hello world"


def test_clean_caption_collapses_repeated_punctuation():
    assert clean_caption("what??? really!!!") == "what? really!"


def test_resolve_caption_text_prefers_explicit_text():
    transcript = [{"startSec": 0.0, "endSec": 5.0, "text": "from transcript", "words": []}]

    assert resolve_caption_text("mine", transcript, 0.0, 5.0) == "mine"


def test_resolve_caption_text_falls_back_to_transcript():
    transcript = [{"startSec": 0.0, "endSec": 5.0, "text": "from the transcript", "words": []}]

    assert resolve_caption_text(None, transcript, 0.0, 5.0) == "from the transcript"


def test_resolve_caption_text_empty_with_nothing_to_work_from():
    assert resolve_caption_text(None, [], 0.0, 5.0) == ""


def test_cues_are_rebased_to_clip_relative_time():
    """The rendered video is trimmed, so cue times must start near zero."""
    transcript = [
        {
            "startSec": 100.0,
            "endSec": 106.0,
            "text": "Spoken at one hundred seconds",
            "words": [
                {"startSec": 100.0, "endSec": 102.0, "text": "Spoken"},
                {"startSec": 102.0, "endSec": 106.0, "text": "at one hundred seconds"},
            ],
        }
    ]

    cues = cues_for_window(
        text="Spoken at one hundred seconds",
        start_sec=100.0,
        end_sec=106.0,
        transcript=transcript,
        preset_id="karaoke",
    )

    assert cues
    assert cues[0].start == pytest.approx(0.0, abs=0.2)
    assert all(cue.start < 6.0 for cue in cues)


def test_empty_caption_produces_no_cues():
    assert cues_for_window("", 0.0, 10.0, [], "clean") == []


# --- Serialisation ----------------------------------------------------------


def test_ass_header_declares_the_output_resolution():
    """PlayRes must match the frame or the preset's sizes land wrong."""
    ass = build_ass([], 1080, 1920)

    assert "PlayResX: 1080" in ass
    assert "PlayResY: 1920" in ass


def test_ass_has_an_events_section():
    cue = CaptionCue(0.0, 2.0, "hello", [WordCue(0.0, 1.0, "hello")])

    ass = build_ass([cue], 1080, 1920)

    assert "[Events]" in ass
    assert "Dialogue:" in ass


def test_ass_timestamps_use_centiseconds():
    cue = CaptionCue(1.5, 3.25, "hello", [WordCue(1.5, 3.25, "hello")])

    ass = build_ass([cue], 1080, 1920)

    assert "0:00:01.50" in ass
    assert "0:00:03.25" in ass


def test_karaoke_emits_per_word_timing_tags():
    cue = CaptionCue(
        0.0,
        4.0,
        "one two three",
        [WordCue(0.0, 1.3, "one"), WordCue(1.3, 2.6, "two"), WordCue(2.6, 4.0, "three")],
        karaoke=True,
    )

    ass = build_ass([cue], 1080, 1920, preset_id="karaoke")

    # \\k is in centiseconds: 1.3s -> 130.
    assert "{\\k130}" in ass
    assert ass.count("{\\k") == 3


def test_non_karaoke_has_no_word_tags():
    cue = CaptionCue(0.0, 4.0, "one two", [WordCue(0.0, 2.0, "one"), WordCue(2.0, 4.0, "two")])

    ass = build_ass([cue], 1080, 1920, preset_id="clean")

    assert "\\k" not in ass


def test_uppercase_preset_uppercases_the_caption():
    cue = CaptionCue(0.0, 2.0, "shouting now", [WordCue(0.0, 2.0, "shouting")])

    ass = build_ass([cue], 1080, 1920, preset_id="bold")

    assert "SHOUTING NOW" in ass


def test_zero_length_cue_is_dropped():
    ass = build_ass([CaptionCue(1.0, 1.0, "x", [])], 1080, 1920)

    assert "Dialogue:" not in ass


def test_srt_is_well_formed():
    cue = CaptionCue(0.0, 2.5, "first line", [WordCue(0.0, 2.5, "first")])

    srt = build_srt([cue])

    assert srt.startswith("1\n")
    assert "00:00:00,000 --> 00:00:02,500" in srt


def test_vtt_has_the_required_header():
    cue = CaptionCue(0.0, 1.0, "hello", [WordCue(0.0, 1.0, "hello")])

    vtt = build_vtt([cue])

    assert vtt.startswith("WEBVTT")
    assert "00:00:00.000 --> 00:00:01.000" in vtt