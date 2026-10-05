"""Shared helpers: ids, stage bookkeeping, and the transcript primitives.

The five stage keys mirror ``STAGE_KEYS`` in ``src/utils/constants.js`` exactly.
Stage progress is what the Processing page stepper renders, so the ordering and
the weight split live here and nowhere else.
"""

from __future__ import annotations

import hashlib
import re
import secrets
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable

# --- Ids --------------------------------------------------------------------

_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz"


def new_id(prefix: str) -> str:
    """Short, URL-safe, prefixed id: ``clip_k3f9x2a1b``."""
    body = "".join(secrets.choice(_ALPHABET) for _ in range(10))
    return f"{prefix}_{body}"


def stable_hash(value: str, buckets: int = 360) -> int:
    """Deterministic bucket for a string.

    Used for poster seeds so a clip keeps the same colour across reloads.
    """
    digest = hashlib.sha256(value.encode("utf-8")).digest()
    return int.from_bytes(digest[:4], "big") % buckets


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def ensure_utc(value: datetime | None) -> datetime | None:
    """Treat naive datetimes as UTC. SQLite drops tzinfo on round-trip."""
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


# --- Pipeline stages --------------------------------------------------------

STAGE_KEYS: tuple[str, ...] = ("upload", "audio", "transcript", "highlights", "prepare")

# Share of total progress per stage. Sums to 100; matches the `weight` fields in
# the frontend's PROCESSING_STAGES so both progress bars agree.
STAGE_WEIGHTS: dict[str, float] = {
    "upload": 18.0,
    "audio": 14.0,
    "transcript": 34.0,
    "highlights": 22.0,
    "prepare": 12.0,
}


@dataclass
class StageTracker:
    """Tracks which pipeline stage is active and how far along it is.

    Overall progress is derived from stage weights rather than accumulated
    blindly, so a stage that finishes early or runs long still leaves the total
    consistent with the stage list the UI shows.
    """

    stage: str = "upload"
    # Per-stage completion in 0..1, keyed by stage.
    done: dict[str, float] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.done = {key: 0.0 for key in STAGE_KEYS}

    def start(self, stage: str) -> None:
        self.stage = stage

    def advance(self, stage: str, fraction: float) -> None:
        """Set a stage's local completion, clamped to 0..1."""
        if stage not in self.done:
            raise KeyError(f"unknown stage {stage!r}")
        self.stage = stage
        self.done[stage] = min(1.0, max(0.0, fraction))

    def complete_stage(self, stage: str) -> None:
        self.done[stage] = 1.0
        self.stage = stage

    def finish(self) -> None:
        for key in STAGE_KEYS:
            self.done[key] = 1.0

    @property
    def progress(self) -> float:
        """Weighted overall progress, 0..100."""
        total = sum(STAGE_WEIGHTS.values())
        return round(
            sum(STAGE_WEIGHTS[key] * self.done.get(key, 0.0) for key in STAGE_KEYS) / total * 100,
            1,
        )

    def current_stage(self) -> str:
        """First stage not yet complete, else the last stage."""
        for key in STAGE_KEYS:
            if self.done.get(key, 0.0) < 1.0:
                return key
        return STAGE_KEYS[-1]

    def to_json(self) -> list[dict[str, Any]]:
        """Serialise for ``project.stages``, the shape the stepper consumes."""
        return [
            {
                "key": key,
                "progress": round(self.done.get(key, 0.0) * 100, 1),
                "status": _stage_status(self.done.get(key, 0.0), key == self.current_stage()),
            }
            for key in STAGE_KEYS
        ]


def _stage_status(fraction: float, is_current: bool) -> str:
    if fraction >= 1.0:
        return "done"
    return "active" if is_current else "idle"


# --- Transcript primitives --------------------------------------------------


@dataclass
class WordTiming:
    start_sec: float
    end_sec: float
    text: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "startSec": round(self.start_sec, 2),
            "endSec": round(self.end_sec, 2),
            "text": self.text,
        }


@dataclass
class Segment:
    start_sec: float
    end_sec: float
    text: str
    speaker: str | None = None
    words: list[WordTiming] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "startSec": round(self.start_sec, 2),
            "endSec": round(self.end_sec, 2),
            "speaker": self.speaker,
            "text": self.text,
            "words": [word.to_dict() for word in self.words],
        }

    @property
    def duration(self) -> float:
        return max(0.0, self.end_sec - self.start_sec)

    @property
    def word_count(self) -> int:
        return len(self.words)


_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+")
_WORD_SPLIT = re.compile(r"\S+")


def split_sentences(text: str) -> list[str]:
    """Split on terminal punctuation, keeping the punctuation attached."""
    return [part.strip() for part in _SENTENCE_SPLIT.split(text or "") if part.strip()]


def split_words(text: str) -> list[str]:
    return _WORD_SPLIT.findall(text or "")


def expand_to_words(text: str, start_sec: float, end_sec: float) -> list[WordTiming]:
    """Distribute a sentence's words across its span, weighted by length.

    Fallback for when real word timings are unavailable. Weighting by character
    count roughly tracks speaking duration, so karaoke highlighting still lands
    on the right word even without an aligned transcript.
    """
    tokens = split_words(text)
    if not tokens:
        return []

    total_chars = sum(len(token) for token in tokens) or 1
    span = max(0.2, end_sec - start_sec)

    timings: list[WordTiming] = []
    cursor = start_sec
    for index, token in enumerate(tokens):
        share = (len(token) / total_chars) * span
        is_last = index == len(tokens) - 1
        word_end = end_sec if is_last else min(cursor + share, end_sec)
        timings.append(WordTiming(round(cursor, 2), round(word_end, 2), token))
        cursor = word_end
    return timings


def segments_for_window(
    segments: Iterable[Segment],
    start_sec: float,
    end_sec: float,
) -> list[Segment]:
    """Clip a transcript to ``[start_sec, end_sec]``, clamped and refilled.

    Segments that only partially overlap are trimmed to the window, so a clip's
    transcript never claims words outside its own trim range. Word timings are
    trimmed the same way and re-based to the segment's own span.
    """
    result: list[Segment] = []
    for segment in segments:
        if segment.end_sec <= start_sec or segment.start_sec >= end_sec:
            continue

        seg_start = max(segment.start_sec, start_sec)
        seg_end = min(segment.end_sec, end_sec)
        if seg_end <= seg_start:
            continue

        words = [w for w in segment.words if w.end_sec > seg_start and w.start_sec < seg_end]
        clipped_words = [
            WordTiming(
                round(max(w.start_sec, seg_start), 2),
                round(min(w.end_sec, seg_end), 2),
                w.text,
            )
            for w in words
        ]

        # Keep only words with a positive span after clipping.
        clipped_words = [w for w in clipped_words if w.end_sec > w.start_sec]

        result.append(
            Segment(
                start_sec=round(seg_start, 2),
                end_sec=round(seg_end, 2),
                text=segment.text,
                speaker=segment.speaker,
                words=clipped_words or expand_to_words(segment.text, seg_start, seg_end),
            )
        )

    return result


def next_expiry(minutes: int = 30) -> datetime:
    return utcnow() + timedelta(minutes=minutes)


def random_token() -> str:
    return uuid.uuid4().hex