"""ASS subtitle generation for burned-in captions.

The browser draws captions as DOM. Here they become an ASS file that libass
renders into the video. Both must agree, so cue timing and styling come from
:mod:`.captions`, which mirrors the frontend's ``CAPTION_PRESETS``.

Timing model:

* **Karaoke preset, text matching a transcript segment.** Word timings are used
  verbatim. Each word becomes its own ``\\k``-timed cue so the highlight colour
  advances exactly as speech does. This is the accurate case.
* **Anything else.** Words are spread across the caption's duration by character
  weight, which approximates speaking time well enough that the highlight does
  not drift badly.

Cue duration is capped at :data:`MAX_CUE_SEC` because a single static line held
for more than ~7s is unreadable and, past a point, libass timing gets coarse.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Iterable, Sequence

from .captions import build_style, escape_text

# Long enough for a full sentence to be read, short enough to stay legible.
MAX_CUE_SEC = 7.0
# Words per cue for non-karaoke presets. 3-4 reads naturally on a phone.
WORDS_PER_CUE = 4

_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+")
_WORD_SPLIT = re.compile(r"\S+")


@dataclass
class WordCue:
    """One word with its timing, in clip-relative seconds."""

    start: float
    end: float
    text: str


@dataclass
class CaptionCue:
    """A timed caption line, in clip-relative seconds."""

    start: float
    end: float
    text: str
    words: list[WordCue]
    karaoke: bool = False


# --- Text helpers -----------------------------------------------------------


def words_of(text: str) -> list[str]:
    return _WORD_SPLIT.findall(text or "")


def sentences_of(text: str) -> list[str]:
    return [part.strip() for part in _SENTENCE_SPLIT.split(text or "") if part.strip()]


def normalize(text: str) -> str:
    """Collapse whitespace so a caption can be compared against a transcript."""
    return " ".join((text or "").split())


def clean_caption(text: str) -> str:
    """Tidy a user caption for display: no stray whitespace or hard wraps."""
    cleaned = normalize(text)
    # Collapse runs of punctuation that Whisper sometimes produces.
    cleaned = re.sub(r"([,;:!?])\1+", r"\1", cleaned)
    return cleaned.strip()


def group_words(words: Sequence[WordCue], per_cue: int = WORDS_PER_CUE) -> list[list[WordCue]]:
    """Chunk words into lines of ``per_cue``.

    Prefers breaking on punctuation so lines end at a natural pause.
    """
    if not words:
        return []

    groups: list[list[WordCue]] = []
    current: list[WordCue] = []

    for word in words:
        current.append(word)
        at_limit = len(current) >= per_cue
        # Break early if this word closed a sentence, as long as the line has
        # enough words to look deliberate.
        closed = bool(re.search(r"[.!?]$", word.text))
        if closed and len(current) >= 2:
            groups.append(current)
            current = []
        elif at_limit:
            groups.append(current)
            current = []

    if current:
        groups.append(current)
    return groups


# --- Timing -----------------------------------------------------------------


def spread_words(text: str, start: float, end: float) -> list[WordCue]:
    """Distribute words across a span, weighted by character count.

    Character length is a decent proxy for how long a word takes to say, so the
    highlight advances at roughly the right pace even without real timings.
    """
    tokens = words_of(text)
    if not tokens:
        return []

    total_chars = sum(len(token) for token in tokens) or 1
    span = max(0.2, end - start)

    cues: list[WordCue] = []
    cursor = start
    for index, token in enumerate(tokens):
        share = (len(token) / total_chars) * span
        is_last = index == len(tokens) - 1
        word_end = end if is_last else min(cursor + share, end)
        cues.append(WordCue(round(cursor, 3), round(word_end, 3), token))
        cursor = word_end
    return cues


def real_word_timings(
    transcript: Iterable[dict[str, Any]], caption_text: str
) -> list[WordCue]:
    """Pull true word timings from a transcript segment matching the caption.

    Matches on normalised text, which is how ``ClipPreview.jsx`` matches too. A
    miss here is fine: the caller falls back to spreading words evenly.
    """
    target = normalize(caption_text)
    if not target:
        return []

    for segment in transcript or []:
        if normalize(segment.get("text", "")) != target:
            continue
        words = segment.get("words") or []
        if not words:
            return []
        return [
            WordCue(
                start=float(word.get("startSec", 0.0)),
                end=float(word.get("endSec", 0.0)),
                text=str(word.get("text", "")),
            )
            for word in words
            if str(word.get("text", "")).strip()
        ]

    return []


# --- Cue construction -------------------------------------------------------


def resolve_caption_text(
    caption_text: str | None,
    transcript: list[dict[str, Any]],
    start_sec: float,
    end_sec: float,
) -> str:
    """Decide what the caption will actually say.

    Prefers explicit caption text. With none, falls back to the transcript
    covering the clip window so a clip exported with no caption set still gets
    something burned in rather than a silent video.
    """
    if caption_text and caption_text.strip():
        return clean_caption(caption_text)

    covering = [
        segment
        for segment in transcript or []
        if float(segment.get("endSec", 0)) > start_sec
        and float(segment.get("startSec", 0)) < end_sec
    ]
    if covering:
        return clean_caption(" ".join(str(s.get("text", "")) for s in covering))

    return ""


def cues_for_window(
    text: str,
    start_sec: float,
    end_sec: float,
    transcript: list[dict[str, Any]] | None = None,
    preset_id: str | None = "clean",
) -> list[CaptionCue]:
    """Build timed cues for a clip window.

    All timings are returned relative to the clip start, because the rendered
    video is trimmed to the window. Word timings from a transcript are
    source-absolute and are rebased here.
    """
    text = clean_caption(text)
    if not text:
        return []

    span = max(0.2, end_sec - start_sec)
    karaoke = preset_id == "karaoke"

    # Try real timings first. For non-karaoke presets they still help: the words
    # are chunked by weight, so each cue's duration is real even if the
    # within-word highlight is not used.
    words = real_word_timings(transcript or [], text)
    if not words:
        words = spread_words(text, 0.0, span)

    rebased = [
        WordCue(
            start=max(0.0, min(span, word.start - start_sec)),
            end=max(0.0, min(span, word.end - start_sec)),
            text=word.text,
        )
        for word in words
    ]
    # Discard degenerate timings from a mid-clip rebase.
    rebased = [word for word in rebased if word.end > word.start] or spread_words(text, 0.0, span)

    cues: list[CaptionCue] = []
    for group in group_words(rebased):
        line = " ".join(word.text for word in group).strip()
        if not line:
            continue

        cue_start = group[0].start
        cue_end = group[-1].end
        if cue_end - cue_start > MAX_CUE_SEC:
            # Hold long stretches without re-timing: a line cannot be read
            # faster than it can be read.
            cue_end = cue_start + MAX_CUE_SEC

        cues.append(
            CaptionCue(
                start=round(cue_start, 3),
                end=round(cue_end, 3),
                text=line,
                words=group,
                karaoke=karaoke,
            )
        )

    return cues


# --- ASS serialisation ------------------------------------------------------


def _timestamp(seconds: float) -> str:
    """ASS timestamp: ``H:MM:SS.cc`` with centisecond precision."""
    if seconds < 0:
        seconds = 0.0
    hours, remainder = divmod(int(seconds), 3600)
    minutes, secs = divmod(remainder, 60)
    centis = int(round((seconds - int(seconds)) * 100))
    if centis >= 100:  # rounding can tip over
        centis = 0
        secs += 1
    return f"{hours}:{minutes:02d}:{secs:02d}.{centis:02d}"


def _ass_text(cue: CaptionCue, style: Any) -> str:
    """Wrap a cue's text in inline styling, with karaoke timings when needed.

    Karaoke in ASS works like this: ``\\k<centiseconds>`` sets how long the *next*
    syllable stays in the SecondaryColour before flipping to PrimaryColour. So
    for a word-by-word highlight where the *spoken* word is the bright one, the
    already-spoken text should be Primary (bright) and the unspoken remainder
    Secondary (dim) — which is the inverse of libass's default, hence the swap in
    :func:`build_style`.
    """
    escaped = escape_text(cue.text)
    if not escaped:
        return ""

    if style.uppercase:
        escaped = escaped.upper()

    font = f"{{\\fn{style.font_name}\\fs{style.font_size}\\b{style.bold}}}"

    if not cue.karaoke:
        return f"{font}{{\\c{style.primary}}}{escaped}"

    # Per-word \k tags. Each word's duration is taken from its real timing when
    # available, otherwise split evenly.
    total_ms = max(1, round((cue.end - cue.start) * 1000))
    weights = [max(1, round((word.end - word.start) * 1000)) for word in cue.words]
    if not weights:
        weights = [max(1, total_ms // max(1, len(cue.words)))] * max(1, len(cue.words))

    # libass \k is in centiseconds, so convert ms and keep the sum exact by
    # putting the rounding remainder on the final word.
    centis = [max(1, round(value / 10)) for value in weights]
    drift = round(total_ms / 10) - sum(centis)
    centis[-1] = max(1, centis[-1] + drift)

    tokens = escaped.split(" ")
    if len(tokens) != len(centis):
        # Token count changed during escaping; fall back to an even split.
        centis = [max(1, round(total_ms / 10 / len(tokens)))] * len(tokens)
        centis[-1] = max(1, centis[-1] + (round(total_ms / 10) - sum(centis)))

    parts = [
        f"{{\\k{centis[index]}}}{token}"
        for index, token in enumerate(tokens)
    ]
    return f"{font}{{\\c{style.secondary}}}{' '.join(parts)}"


def build_ass(
    cues: list[CaptionCue],
    width: int,
    height: int,
    preset_id: str | None = "clean",
    position: str | None = None,
) -> str:
    """Serialise cues to an ASS subtitle file.

    ``PlayResX/Y`` is set to the output frame size so that the preset's
    width-relative font sizes and margins land at the intended pixel values.

    ``position`` is the per-export override. It is threaded through rather than
    left as ``None`` because the caption position is user-editable: without this
    the exported file would ignore the placement shown in the preview.
    """
    style = build_style(preset_id, position, f"{width}x{height}", width, height)

    header = f"""[Script Info]
ScriptType: v4.00+
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709
PlayResX: {width}
PlayResY: {height}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
{style.style_line("Default")}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""

    lines = [header]
    for cue in cues:
        if cue.end <= cue.start:
            continue
        text = _ass_text(cue, style)
        if not text:
            continue
        lines.append(
            f"Dialogue: 0,{_timestamp(cue.start)},{_timestamp(cue.end)},Default,,0,0,0,,{text}"
        )

    return "\n".join(lines) + "\n"


def srt_timestamp(seconds: float) -> str:
    """SRT timestamp: ``HH:MM:SS,mmm``. Used by the sidecar writers."""
    if seconds < 0:
        seconds = 0.0
    millis = int(round(seconds * 1000))
    hours, millis = divmod(millis, 3_600_000)
    minutes, millis = divmod(millis, 60_000)
    secs, millis = divmod(millis, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def build_srt(cues: list[CaptionCue]) -> str:
    """Serialise cues to SubRip, for the caption sidecar download."""
    blocks: list[str] = []
    for index, cue in enumerate(cues, start=1):
        blocks.append(
            f"{index}\n{srt_timestamp(cue.start)} --> {srt_timestamp(cue.end)}\n{cue.text}\n"
        )
    return "\n".join(blocks)


def build_vtt(cues: list[CaptionCue]) -> str:
    """Serialise cues to WebVTT, for the caption sidecar download."""
    lines = ["WEBVTT", ""]
    for cue in cues:
        start = srt_timestamp(cue.start).replace(",", ".")
        end = srt_timestamp(cue.end).replace(",", ".")
        lines.append(f"{start} --> {end}")
        lines.append(cue.text)
        lines.append("")
    return "\n".join(lines)