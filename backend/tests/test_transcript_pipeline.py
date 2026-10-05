"""Transcript, scoring and ranking primitives.

These tests are about *shape conformance* rather than transcription accuracy:
the frontend has hard expectations about field names and units, and a silent
renaming breaks karaoke captions in a way no runtime error would catch.
"""

from __future__ import annotations

import pytest

from app.config import Settings
from app.pipeline.score import Candidate, derive_caption, shortlist, top_candidates
from app.utils import Segment, WordTiming, expand_to_words, segments_for_window, split_sentences


@pytest.fixture()
def settings() -> Settings:
    return Settings(whisper_model="tiny")


def build_transcript() -> list[Segment]:
    """A transcript with real signal: a hook phrase, a question, clean endings."""
    lines = [
        "Here is why most creators lose their audience in the first three seconds.",
        "Nobody is warming up for you, so lead with the payoff instead.",
        "What do you actually do with those three seconds?",
        "Tell people the exact thing they will be able to do by the end.",
        "Retention is a packaging problem, not a content problem.",
        "The first ten seconds have to earn the next ten seconds.",
    ]
    segments: list[Segment] = []
    cursor = 0.0
    for line in lines:
        start = cursor
        end = start + 4.0
        segments.append(
            Segment(
                start_sec=start,
                end_sec=end,
                text=line,
                words=expand_to_words(line, start, end),
            )
        )
        cursor = end
    return segments


# --- Word expansion ---------------------------------------------------------


def test_expand_to_words_covers_the_whole_span():
    words = expand_to_words("one two three four", 10.0, 20.0)

    assert len(words) == 4
    assert words[0].start_sec == pytest.approx(10.0)
    # The final word must land exactly on the end, or karaoke drift accumulates.
    assert words[-1].end_sec == pytest.approx(20.0)


def test_expand_to_words_is_monotonic():
    words = expand_to_words("alpha beta gamma delta epsilon", 0.0, 5.0)

    for earlier, later in zip(words, words[1:]):
        assert earlier.end_sec <= later.start_sec


def test_expand_to_words_handles_empty_text():
    assert expand_to_words("", 0.0, 5.0) == []


# --- Sentence splitting -----------------------------------------------------


def test_split_sentences_keeps_terminal_punctuation():
    parts = split_sentences("First point. Second point! Third question?")

    assert parts == ["First point.", "Second point!", "Third question?"]


# --- Windowing --------------------------------------------------------------


def test_segments_for_window_trims_to_the_clip():
    transcript = build_transcript()

    window = segments_for_window(transcript, 5.0, 15.0)

    assert window, "expected at least one segment inside the window"
    assert window[0].start_sec >= 5.0
    assert window[-1].end_sec <= 15.0


def test_segments_for_window_never_leaks_outside_timings():
    """The bug this guards: a clip's transcript claiming words outside its trim
    range, which would show up as captions appearing outside the exported cut."""
    transcript = build_transcript()

    window = segments_for_window(transcript, 3.0, 7.0)

    for segment in window:
        assert segment.start_sec >= 3.0
        assert segment.end_sec <= 7.0
        for word in segment.words:
            assert word.start_sec >= 3.0
            assert word.end_sec <= 7.0


def test_segments_for_window_keeps_words():
    transcript = build_transcript()

    window = segments_for_window(transcript, 0.0, 24.0)

    assert all(segment.words for segment in window), "every segment needs word timings"


def test_segments_for_window_empty_when_no_overlap():
    transcript = build_transcript()

    assert segments_for_window(transcript, 500.0, 600.0) == []


# --- Scoring ----------------------------------------------------------------


def test_scoring_produces_candidates(settings):
    candidates = top_candidates(build_transcript(), settings, count=4)

    assert candidates, "expected candidates from a signal-rich transcript"
    assert len(candidates) <= 4


def test_candidates_are_sorted_best_first(settings):
    candidates = top_candidates(build_transcript(), settings)

    scores = [c.score for c in candidates]
    assert scores == sorted(scores, reverse=True)


def test_scores_stay_in_the_ui_range(settings):
    """ClipCard renders the raw score, and the sort assumes 0-100."""
    for candidate in top_candidates(build_transcript(), settings):
        assert 0 <= candidate.score <= 100


def test_candidate_windows_are_valid(settings):
    for candidate in top_candidates(build_transcript(), settings):
        assert candidate.end_sec > candidate.start_sec


def test_every_component_is_reported(settings):
    """Components are what make a score auditable, so all seven must be present."""
    candidates = top_candidates(build_transcript(), settings)

    assert candidates
    expected = {
        "hook",
        "question",
        "salience",
        "density",
        "selfcontained",
        "completeness",
        "position",
    }
    assert set(candidates[0].components) == expected


def test_hook_phrase_scores_higher_than_filler(settings):
    """The scorer must actually discriminate, not just return numbers."""
    strong = Candidate(
        start_sec=0,
        end_sec=20,
        text="",
        segments=[],
        score=0,
        components={},
    )
    signal = top_candidates(build_transcript(), settings)
    filler = top_candidates(
        [
            Segment(
                start_sec=0,
                end_sec=4,
                text="um so yeah like basically just uh i mean stuff",
                words=expand_to_words("um so yeah like basically just uh i mean stuff", 0, 4),
            )
        ],
        settings,
    )

    assert signal
    # A hook phrase in the transcript should outrank pure filler.
    assert signal[0].score > (filler[0].score if filler else 0)
    del strong


def test_empty_transcript_yields_nothing(settings):
    assert top_candidates([], settings) == []


def test_shortlist_drops_overlapping_windows(settings):
    """Two candidates covering the same moment are one clip, not two."""
    segments = build_transcript()
    base = segments[0]
    overlapping = [
        Candidate(start_sec=0.0, end_sec=8.0, text="a", segments=[base], score=90, components={}),
        Candidate(start_sec=0.5, end_sec=8.5, text="b", segments=[base], score=80, components={}),
    ]

    kept = shortlist(overlapping, settings, count=5)

    assert len(kept) == 1
    assert kept[0].score == 90


# --- Derived text -----------------------------------------------------------


def test_derive_caption_stays_within_the_display_limit():
    long_sentence = "word " * 60

    caption = derive_caption(long_sentence)

    assert len(caption) <= 111


def test_derive_caption_trims_on_a_word_boundary():
    caption = derive_caption("This is a fairly long sentence that will certainly need to be cut " * 3)

    assert "  " not in caption
    assert not caption.split(" ")[-1].endswith("cuttin")


def test_derive_caption_prefers_the_signal_sentence():
    text = "So anyway I was just thinking about stuff. The mistake is opening with your logo."

    assert "logo" in derive_caption(text).lower()


# --- Serialisation ----------------------------------------------------------


def test_segment_serialises_with_frontend_field_names():
    segment = Segment(start_sec=1.5, end_sec=3.25, text="hello there", words=expand_to_words("hello there", 1.5, 3.25))

    payload = segment.to_dict()

    assert set(payload) == {"startSec", "endSec", "speaker", "text", "words"}
    assert set(payload["words"][0]) == {"startSec", "endSec", "text"}


def test_word_timing_serialises_rounded():
    word = WordTiming(1.23456, 2.98765, "word")

    payload = word.to_dict()

    assert payload["startSec"] == pytest.approx(1.23)
    assert payload["endSec"] == pytest.approx(2.99)