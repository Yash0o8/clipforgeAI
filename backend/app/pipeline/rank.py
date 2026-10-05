"""LLM re-ranking of the heuristic shortlist.

The scorer narrows a long transcript to ~15 plausible candidates. This module
hands that shortlist to an LLM and asks for a final editorial verdict: which
candidates are actually worth posting, in what order, with a punchy title, hook
and caption line written for each.

Design decisions:

* **Only the shortlist is sent.** A two-hour video is too much context, and the
  candidates are the only parts that matter. Keeps the prompt small, fast and
  cheap.
* **Text only, plus timings.** No audio. Timings let the model reason about
  pacing and let us place the clip without re-matching.
* **Strict JSON out.** Parsed into a pydantic model. On any failure the caller
  keeps the heuristic ranking, so a flaky API never loses the run.
* **Both providers supported, Claude preferred.** Same request/response shape for
  both, so switching is a config change rather than a code change.

Nothing in this module is required for the pipeline to work. With no API key
configured, :func:`rank_candidates` returns its input unchanged and the caller
uses the heuristic order.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from ..config import Settings
from .score import Candidate

logger = logging.getLogger(__name__)


class RankingError(RuntimeError):
    """Raised when the LLM response cannot be used. Callers fall back."""


# --- Prompt -----------------------------------------------------------------

SYSTEM_PROMPT = """\
You are a short-form video editor. You are given numbered candidate moments \
pulled from a longer video transcript. Your job is to pick the moments most \
worth posting as standalone short-form clips.

Judge each candidate on:
- Does it open on a claim, a payoff, or a concrete number? A clip that starts \
with scene-setting loses the viewer.
- Does it stand alone, or does it depend on context that came earlier?
- Would someone save or share it? Is there a specific, actionable takeaway?
- Does it end on a finished thought?

Reject padding. If a candidate is rambling, repetitive, or pure throat-clearing, \
leave it out. It is better to return 4 excellent clips than 8 mediocre ones.

For each clip you keep, write:
- title: 2-7 words, concrete, no clickbait punctuation
- hook: the one sentence that makes someone want to keep watching
- caption: one short line for burned-in subtitles, under 90 characters, no \
trailing period
- score: 0-100 for predicted performance

Return JSON only, with this exact shape:
{"clips": [{"index": <int>, "title": <str>, "hook": <str>, "caption": <str>, \
"score": <int>}]}

`index` must be the exact index of the candidate you are selecting. Order the \
array best-first.\
"""


def build_user_prompt(candidates: list[Candidate], max_clips: int) -> str:
    """Render the shortlist as a numbered list for the model."""
    lines = [
        f"Candidate moments from a {candidates[0].end_sec / 60:.0f}-minute video.",
        "",
    ]
    for position, candidate in enumerate(candidates):
        lines.append(
            f"[{position}] {candidate.start_sec:.1f}s - {candidate.end_sec:.1f}s "
            f"({candidate.duration:.0f}s)"
        )
        lines.append(candidate.text)
        lines.append("")

    lines.append(
        f"Select at most {max_clips} clips. Return JSON only."
    )
    return "\n".join(lines)


# --- Response parsing -------------------------------------------------------

_JSON_BLOCK = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL)
_INDEX_KEYS = ("index", "candidateIndex", "candidate_index", "id")


def extract_json(raw: str) -> dict[str, Any]:
    """Pull a JSON object out of a model response.

    Handles the three things models actually do: return clean JSON, wrap it in a
    ```json fence, or prepend a sentence of prose.
    """
    text = (raw or "").strip()
    if not text:
        raise RankingError("empty response")

    fenced = _JSON_BLOCK.search(text)
    if fenced:
        text = fenced.group(1).strip()

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # Fall back to the outermost brace pair.
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end <= start:
        raise RankingError(f"no JSON object in response: {text[:200]!r}")

    try:
        return json.loads(text[start : end + 1])
    except json.JSONDecodeError as exc:
        raise RankingError(f"malformed JSON: {text[:200]!r}") from exc


def _coerce_index(item: dict[str, Any]) -> int | None:
    for key in _INDEX_KEYS:
        if key in item:
            try:
                return int(item[key])
            except (TypeError, ValueError):
                continue
    return None


def _clean(value: Any, limit: int, fallback: str = "") -> str:
    if not isinstance(value, str):
        return fallback
    cleaned = " ".join(value.split()).strip()
    return cleaned[:limit] if cleaned else fallback


# --- Providers --------------------------------------------------------------


def _call_anthropic(settings: Settings, user_prompt: str) -> str:
    from anthropic import Anthropic  # noqa: PLC0415 - optional dependency

    client = Anthropic(api_key=settings.anthropic_api_key, timeout=settings.llm_timeout_sec)
    response = client.messages.create(
        model=settings.anthropic_model,
        max_tokens=2048,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_prompt}],
    )
    parts = [block.text for block in response.content if getattr(block, "type", "") == "text"]
    return "\n".join(parts)


def _call_openai(settings: Settings, user_prompt: str) -> str:
    from openai import OpenAI  # noqa: PLC0415 - optional dependency

    client = OpenAI(
        api_key=settings.openai_api_key,
        timeout=settings.llm_timeout_sec,
    )
    response = client.chat.completions.create(
        model=settings.openai_model,
        max_tokens=2048,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
    )
    return response.choices[0].message.content or ""


# --- Public API -------------------------------------------------------------


def rank_candidates(
    candidates: list[Candidate],
    settings: Settings,
    max_clips: int | None = None,
) -> list[Candidate]:
    """Re-rank and re-word the shortlist with an LLM.

    Returns candidates ordered best-first with LLM-written titles, hooks and
    captions merged in. Returns the input unchanged if no provider is
    configured, or if the call or parse fails.

    Never raises: a provider outage degrades to the heuristic result rather than
    failing the project.
    """
    if not candidates:
        return []

    provider = settings.llm_provider()
    if provider is None:
        logger.info("no llm provider configured, using heuristic ranking")
        return candidates

    limit = max_clips or settings.default_clip_count
    user_prompt = build_user_prompt(candidates, limit)

    try:
        raw = _call_anthropic(settings, user_prompt) if provider == "anthropic" else _call_openai(
            settings, user_prompt
        )
    except Exception as exc:
        logger.warning("%s ranking call failed, keeping heuristic order: %s", provider, exc)
        return candidates

    try:
        payload = extract_json(raw)
    except RankingError as exc:
        logger.warning("%s returned unparseable output, keeping heuristic order: %s", provider, exc)
        return candidates

    picks = payload.get("clips")
    if not isinstance(picks, list) or not picks:
        logger.warning("%s returned no usable clips, keeping heuristic order", provider)
        return candidates

    ranked: list[Candidate] = []
    seen: set[int] = set()

    for item in picks:
        if not isinstance(item, dict):
            continue
        index = _coerce_index(item)
        # Reject out-of-range and duplicate picks: a model that repeats an index
        # should not produce two copies of the same clip.
        if index is None or not (0 <= index < len(candidates)) or index in seen:
            continue
        seen.add(index)

        candidate = candidates[index]
        ranked.append(
            Candidate(
                start_sec=candidate.start_sec,
                end_sec=candidate.end_sec,
                text=candidate.text,
                segments=candidate.segments,
                # Trust the model's score, but keep it inside the 0-100 range the
                # UI's relevance sort and badge expect.
                score=max(0, min(100, float(item.get("score", candidate.score) or candidate.score))),
                components=candidate.components,
                title=_clean(item.get("title"), 80, candidate.title),
                hook=_clean(item.get("hook"), 300, candidate.hook),
                caption=_clean(item.get("caption"), 120, candidate.caption),
            )
        )

    if not ranked:
        logger.warning("%s produced no valid picks, keeping heuristic order", provider)
        return candidates

    logger.info("%s ranked %d/%d candidates", provider, len(ranked), len(candidates))
    return ranked