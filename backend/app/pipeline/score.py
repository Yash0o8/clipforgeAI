"""Heuristic highlight scoring.

This is the part that works with no API key and no model download. It scores
every candidate window in the transcript on signals that are actually
computable from a word-timed transcript, then emits a shortlist.

Design note on why these signals: short-form editors consistently favour
moments that open on a claim rather than context, that contain a question (which
implies a payoff later), that are dense in content words rather than filler, and
that end on a sentence boundary (so the cut does not land mid-thought). Position
matters too: the opening 20% and the closing third carry disproportionate
engagement in long-form source material, because that is where the thesis and
the payoff live.

Every score is normalised to 0..100. The components are kept separate in the
result so the frontend could explain *why* a clip was picked, and so the weights
below are auditable rather than magic.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Any, Sequence

from ..config import Settings
from ..utils import Segment, split_words

# --- Lexicons ---------------------------------------------------------------

# Openers that signal a claim or a promise rather than scene-setting.
HOOK_PHRASES = (
    "here's why",
    "here is why",
    "the truth is",
    "the real reason",
    "the mistake",
    "the biggest mistake",
    "nobody tells you",
    "no one tells you",
    "what nobody",
    "let me tell you",
    "the secret",
    "the answer is",
    "it turns out",
    "the problem is",
    "the difference between",
    "most people",
    "almost everyone",
    "stop doing",
    "never do",
    "the one thing",
    "the single biggest",
    "if you only do one",
    "this is why",
    "that's why",
    "here's the thing",
    "the rule is",
    "my rule",
    "the shortcut",
    "i was wrong",
    "the hard truth",
)

# High-salience content words. Deliberately generic rather than domain-specific:
# a domain lexicon would need retraining per vertical and would overfit.
SALIENCE_TERMS = frozenset(
    """
    important crucial critical key essential vital massive huge huge enormous
    fast quick rapid instantly immediately simple easy hard difficult complex
    free money profit revenue growth scale scaling audience retention conversion
    hook viral algorithm platform creator content video edit editing cut footage
    story narrative audience viewer watch time seconds minute
    mistake mistakes problem problems solution answer reason why how
    always never every none most some better best worst worse
    actually honestly basically literally simply
    because since unless however therefore instead rather
    """.split()
)

# Filler that carries no information. Counted to penalise padded windows.
FILLER_TERMS = frozenset(
    """
    um uh like so yeah okay ok right well now just actually basically literally
    anyway though really very quite rather kind sort thing stuff going get got
    gonna wanna let lets put mean means said say says know think
    """.split()
)

# Pronouns indicate a window that leans on shared context, so it does not stand
# alone as a clip.
PRONOUN_TERMS = frozenset(
    """
    i you he she it we they me him her them us my your his its our their
    this that these those there here what which who whom whose
    """.split()
)

QUESTION_WORDS = frozenset(
    {"what", "why", "how", "when", "where", "who", "which", "isn't", "aren't", "don't", "doesn't", "can't", "shouldn't", "ever"}
)

_WORD_RE = re.compile(r"[a-z']+")

# Component weights. Sum to 1.0.
WEIGHTS = {
    "hook": 0.26,
    "question": 0.14,
    "salience": 0.18,
    "density": 0.14,
    "selfcontained": 0.12,
    "completeness": 0.09,
    "position": 0.07,
}


@dataclass
class Candidate:
    """One scored window over the transcript."""

    start_sec: float
    end_sec: float
    text: str
    segments: list[Segment]
    score: float
    components: dict[str, float] = field(default_factory=dict)
    title: str = ""
    hook: str = ""
    caption: str = ""

    @property
    def duration(self) -> float:
        return self.end_sec - self.start_sec

    def to_dict(self) -> dict[str, Any]:
        return {
            "startSec": round(self.start_sec, 2),
            "endSec": round(self.end_sec, 2),
            "durationSec": round(self.duration, 2),
            "text": self.text,
            "score": round(self.score, 1),
            "components": {k: round(v, 3) for k, v in self.components.items()},
            "title": self.title,
            "hook": self.hook,
            "caption": self.caption,
        }


# --- Token helpers ----------------------------------------------------------


def _tokens(text: str) -> list[str]:
    return _WORD_RE.findall((text or "").lower())


def _clamp01(value: float) -> float:
    return min(1.0, max(0.0, value))


def _squash(value: float, midpoint: float, steepness: float = 1.0) -> float:
    """Map a raw count onto 0..1 with a soft knee at ``midpoint``.

    Avoids a hard threshold: three question marks and twenty both score near the
    top, while zero is always zero.
    """
    if midpoint <= 0:
        return _clamp01(value)
    return _clamp01(1.0 - math.exp(-steepness * value / midpoint))


def _position_prior(start: float, total: float) -> float:
    """Peaks at ~15% (thesis) and ~78% (payoff) into the source.

    A simple two-Gaussian mixture. Weighted so the opening peak dominates, since
    an opening that works tends to travel further than a closing line.
    """
    if total <= 0:
        return 0.5
    fraction = _clamp01(start / total)
    early = math.exp(-(((fraction - 0.15) / 0.22) ** 2))
    late = math.exp(-(((fraction - 0.78) / 0.20) ** 2))
    return _clamp01(0.72 * early + 0.58 * late)


# --- Component scorers ------------------------------------------------------


def _hook_score(text: str) -> float:
    lowered = text.lower()
    hits = sum(1 for phrase in HOOK_PHRASES if phrase in lowered)
    bonus = 0.12 * min(lowered.count("?"), 2)
    # Opens strong if a hook phrase lands in the first sentence, which is what
    # a viewer actually experiences before scrolling away.
    opening = lowered.split(".")[0] if "." in lowered else lowered
    opener_hit = any(phrase in opening for phrase in HOOK_PHRASES)
    return _clamp01(_squash(hits, 1.4, 1.6) + bonus + (0.22 if opener_hit else 0.0))


def _question_score(text: str) -> float:
    tokens = _tokens(text)
    questions = sum(1 for token in tokens if token in QUESTION_WORDS)
    marks = text.count("?")
    return _clamp01(_squash(questions + marks, 1.1, 1.5))


def _salience_score(text: str) -> float:
    tokens = _tokens(text)
    if not tokens:
        return 0.0
    hits = sum(1 for token in tokens if token in SALIENCE_TERMS)
    # Normalise by a target density rather than raw length, so a long window is
    # not rewarded just for being long.
    density = hits / max(1.0, math.sqrt(len(tokens)))
    return _clamp01(_squash(density, 0.22, 1.4))


def _density_score(text: str, duration: float) -> float:
    """Content-word density: penalises filler-heavy, padded windows."""
    tokens = _tokens(text)
    if not tokens or duration <= 0:
        return 0.0
    filler = sum(1 for token in tokens if token in FILLER_TERMS)
    ratio = filler / len(tokens)
    # Words per second also matters: a 90s window with 40 words is dead air.
    pace = len(tokens) / duration
    pace_score = _squash(pace, 2.6, 1.1)
    return _clamp01((1.0 - ratio) * 0.65 + pace_score * 0.35)


def _self_contained_score(text: str) -> float:
    """How well the window stands alone.

    Few pronouns and few unresolved references means the clip does not open
    mid-thought with "that thing I mentioned".
    """
    tokens = _tokens(text)
    if not tokens:
        return 0.0
    pronouns = sum(1 for token in tokens if token in PRONOUN_TERMS)
    ratio = pronouns / len(tokens)
    # Starts with a concrete or claim-ish word rather than a function word.
    first = tokens[0]
    opener_ok = 1.0 if first in SALIENCE_TERMS or first in QUESTION_WORDS else 0.55
    return _clamp01((1.0 - min(1.0, ratio * 1.9)) * 0.72 + opener_ok * 0.28)


def _completeness_score(end: float, segments: Sequence[Segment], source_end: float) -> float:
    """Does the window end on a clean boundary?

    Landing mid-sentence is the single most obvious tell of an automatic cut.
    """
    text = (segments[-1].text if segments else "").strip()
    ends_clean = bool(text.endswith((".", "!", "?")))
    # Discount a window that ends at the very tail: source endings often trail
    # off mid-thought, so that cut is weaker than one just before it.
    tail = 1.0 if end < source_end - 0.5 else 0.55
    return _clamp01((0.75 if ends_clean else 0.28) + 0.25 * tail)


# --- Window construction ----------------------------------------------------


def _build_windows(
    segments: list[Segment],
    min_duration: float,
    max_duration: float,
    target_duration: float,
) -> list[tuple[float, float, list[Segment]]]:
    """Slide a window over the transcript, snapping to segment boundaries.

    Windows are built from whole segments rather than arbitrary time offsets,
    so a candidate never cuts mid-sentence at the edges.
    """
    if not segments:
        return []

    windows: list[tuple[float, float, list[Segment]]] = []
    start_index = 0

    while start_index < len(segments):
        accumulated: list[Segment] = []
        for end_index in range(start_index, len(segments)):
            accumulated.append(segments[end_index])
            duration = segments[end_index].end_sec - segments[start_index].start_sec
            if duration < min_duration:
                continue
            if duration > max_duration:
                # Window overflowed. If even a single segment is too long, emit
                # it alone rather than dropping the content entirely.
                if len(accumulated) > 1:
                    trimmed = accumulated[:-1]
                    span = trimmed[-1].end_sec - trimmed[0].start_sec
                    windows.append((trimmed[0].start_sec, trimmed[-1].end_sec, trimmed))
                    # Continue from the segment that caused the overflow.
                    start_index = end_index - 1
                    break
                windows.append((accumulated[0].start_sec, accumulated[0].end_sec, accumulated))
                start_index = end_index + 1
                break

            windows.append((accumulated[0].start_sec, accumulated[-1].end_sec, accumulated))
            # Slide forward: if the window is already longer than the target,
            # advance the start so windows do not pile up at the same position.
            if duration >= target_duration:
                start_index = end_index - 1
                break
        else:
            break

        start_index = max(start_index + 1, 0)

    return windows


def _dedupe_windows(windows: list[tuple[float, float, list[Segment]]], min_gap: float):
    """Drop windows that overlap an already-kept, higher-scoring one.

    Runs after scoring so it keeps the *better* of any overlapping pair rather
    than whichever came first.
    """
    kept: list[tuple[float, float, list[Segment]]] = []
    for window in windows:
        start, end = window[0], window[1]
        overlaps = any(
            start < kept_end - min_gap and kept_start < end - min_gap
            for kept_start, kept_end, _ in kept
        )
        if not overlaps:
            kept.append(window)
    return kept


# --- Titles, hooks, captions ------------------------------------------------


def _best_sentence(text: str) -> str:
    """Pick the sentence carrying the most signal, for title and hook source."""
    from ..utils import split_sentences

    sentences = split_sentences(text)
    if not sentences:
        return text.strip()

    def rank(sentence: str) -> float:
        tokens = _tokens(sentence)
        if not tokens:
            return 0.0
        hits = sum(1 for token in tokens if token in SALIENCE_TERMS)
        numbers = 1.6 * len(re.findall(r"\d", sentence))
        questions = 1.4 * sentence.count("?")
        return _squash(hits, 1.6, 1.3) + numbers + questions

    return max(sentences, key=rank).strip()


def derive_title(text: str, fallback: str = "Highlight") -> str:
    """A short title from the strongest sentence in the window."""
    sentence = _best_sentence(text)
    words = split_words(sentence) or [fallback]
    trimmed = " ".join(words[:7])
    if len(words) > 7:
        trimmed = f"{trimmed}…"
    return trimmed or fallback


def derive_hook(text: str) -> str:
    """The hook line: the strongest single sentence, capped for display."""
    sentence = _best_sentence(text)
    if len(sentence) > 140:
        sentence = f"{sentence[:137].rstrip()}…"
    return sentence


def derive_caption(text: str) -> str:
    """On-screen caption line, trimmed to a readable length."""
    sentence = _best_sentence(text)
    if len(sentence) <= 110:
        return sentence
    # Trim on a word boundary rather than mid-word.
    clipped = sentence[:107].rsplit(" ", 1)[0].rstrip(" ,;:")
    return f"{clipped}…"


# --- Public API -------------------------------------------------------------


def score_windows(
    segments: list[Segment],
    settings: Settings,
    min_duration: float | None = None,
    max_duration: float | None = None,
    target_duration: float | None = None,
) -> list[Candidate]:
    """Score every candidate window and return them sorted best-first."""
    if not segments:
        return []

    min_duration = min_duration or settings.clip_min_duration
    max_duration = max_duration or settings.clip_max_duration
    target_duration = target_duration or settings.clip_target_duration
    min_duration = min(min_duration, max_duration)

    source_end = max(segment.end_sec for segment in segments)

    windows = _build_windows(segments, min_duration, max_duration, target_duration)
    if not windows:
        return []

    candidates: list[Candidate] = []
    for start, end, window_segments in windows:
        text = " ".join(segment.text for segment in window_segments).strip()
        if not text:
            continue
        duration = max(0.1, end - start)

        components = {
            "hook": _hook_score(text),
            "question": _question_score(text),
            "salience": _salience_score(text),
            "density": _density_score(text, duration),
            "selfcontained": _self_contained_score(text),
            "completeness": _completeness_score(end, window_segments, source_end),
            "position": _position_prior(start, source_end),
        }

        weighted = sum(WEIGHTS[key] * value for key, value in components.items())
        # Blend in a mild length preference: hits the target duration without
        # punishing genuinely short, punchy moments.
        length_fit = math.exp(-((duration - target_duration) / (target_duration * 0.8)) ** 2)
        blended = 0.9 * weighted + 0.1 * length_fit

        candidates.append(
            Candidate(
                start_sec=start,
                end_sec=end,
                text=text,
                segments=list(window_segments),
                score=round(blended * 100, 1),
                components=components,
                title=derive_title(text),
                hook=derive_hook(text),
                caption=derive_caption(text),
            )
        )

    candidates.sort(key=lambda item: item.score, reverse=True)
    return candidates


def shortlist(
    candidates: list[Candidate],
    settings: Settings,
    count: int | None = None,
    dedupe_gap: float = 1.5,
) -> list[Candidate]:
    """Trim to the best non-overlapping ``count`` candidates."""
    if not candidates:
        return []

    limit = count or settings.shortlist_size
    # Dedupe across the full sorted list so a lower-ranked but distinct window
    # can still surface when every top window overlaps.
    windows = [(c.start_sec, c.end_sec, c.segments) for c in candidates]
    kept_windows = _dedupe_windows(windows, dedupe_gap)
    kept_spans = {(round(w[0], 2), round(w[1], 2)) for w in kept_windows}

    result = [c for c in candidates if (round(c.start_sec, 2), round(c.end_sec, 2)) in kept_spans]
    return result[:limit]


def top_candidates(
    segments: list[Segment],
    settings: Settings,
    count: int | None = None,
    min_duration: float | None = None,
    max_duration: float | None = None,
) -> list[Candidate]:
    """Score then shortlist. The main entry point for the heuristic pass."""
    candidates = score_windows(
        segments,
        settings,
        min_duration=min_duration,
        max_duration=max_duration,
    )
    return shortlist(candidates, settings, count=count)