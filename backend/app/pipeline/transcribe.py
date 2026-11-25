"""Transcript generation via faster-whisper.

Word-level timestamps are mandatory, not optional: the Karaoke caption preset
animates individual words against ``segment.words[]``, and there is no fallback
that looks as good. So ``word_timestamps=True`` is always requested, and any
segment that comes back without usable words is refilled from
``expand_to_words`` so the shape is never broken.

The model is loaded once per process and reused. Loading is the expensive part
(several seconds plus disk reads), so a per-call load would dominate runtime for
short clips.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import tempfile
import threading
import wave
from pathlib import Path
from typing import Callable, Iterator

from ..config import Settings
from ..storage import run_ffmpeg
from ..utils import Segment, WordTiming, expand_to_words, split_words

logger = logging.getLogger(__name__)

_model = None
_model_key: tuple | None = None
_model_lock = threading.Lock()


class TranscriptionError(RuntimeError):
    """Raised when audio cannot be transcribed. Surfaced on the project."""


def resolve_device(requested: str) -> str:
    """Pick a device, preferring CUDA when it is actually usable.

    ``faster-whisper`` raises at model-load time if CUDA is requested but the
    runtime is missing, so probing torch up front avoids failing the whole job.
    """
    if requested != "auto":
        return requested
    try:
        import torch  # noqa: PLC0415 - optional heavy import

        if torch.cuda.is_available():
            return "cuda"
    except Exception:  # pragma: no cover - torch absent or broken
        pass
    return "cpu"


def _model_cache_roots() -> list[Path]:
    """HuggingFace cache locations that may already hold Whisper weights."""
    roots: list[Path] = []
    env_cache = os.environ.get("HF_HUB_CACHE")
    if env_cache:
        roots.append(Path(env_cache))
    roots.append(Path.home() / ".cache" / "huggingface" / "hub")
    return [root for root in roots if root.is_dir()]


def cached_models() -> set[str]:
    """Names of fully downloaded ``Systran/faster-whisper-*`` snapshots.

    faster-whisper still performs a network "is this up to date?" check even
    when weights are cached. Knowing what is local lets us skip that round trip
    entirely — critical on machines where the HF CDN times out.
    """
    names: set[str] = set()
    prefix = "models--Systran--faster-whisper-"
    for root in _model_cache_roots():
        try:
            candidates = root.glob(f"{prefix}*")
        except OSError:  # pragma: no cover - unreadable cache
            continue
        for entry in candidates:
            snapshot_dir = entry / "snapshots"
            if not snapshot_dir.is_dir():
                continue
            try:
                has_weights = any(
                    (snapshot / "model.bin").is_file()
                    for snapshot in snapshot_dir.iterdir()
                    if snapshot.is_dir()
                )
            except OSError:  # pragma: no cover - unreadable snapshot
                continue
            if has_weights:
                names.add(entry.name[len(prefix) :])
    return names


def _construct_model(WhisperModel, name: str, device: str, settings: Settings, local_only: bool):
    """Instantiate a model, tolerating older faster-whisper signatures."""
    kwargs = {
        "device": device,
        "compute_type": settings.whisper_compute_type,
    }
    try:
        return WhisperModel(name, local_files_only=local_only, **kwargs)
    except TypeError as exc:
        if "local_files_only" not in str(exc):
            raise
        return WhisperModel(name, **kwargs)


def load_model(settings: Settings, model_name: str | None = None):
    """Load (and cache) a Whisper model, preferring weights already on disk.

    ``model_name`` lets a long-form job use the cheaper preset without changing
    the process-wide setting. Models are keyed by name, so switching back is
    safe and the common case still reuses a single loaded model.

    A failed download no longer kills the job: any other locally cached model
    is tried in ``whisper_model_fallbacks`` order before giving up.
    """
    global _model, _model_key

    requested = model_name or settings.whisper_model
    device = resolve_device(settings.whisper_device)
    key = (requested, device, settings.whisper_compute_type)
    if _model is not None and _model_key == key:
        return _model

    with _model_lock:
        if _model is not None and _model_key == key:
            return _model
        try:
            from faster_whisper import WhisperModel  # noqa: PLC0415 - heavy import
        except ImportError as exc:  # pragma: no cover - install-time issue
            raise TranscriptionError(
                "faster-whisper is not installed. Run: pip install -r backend/requirements.txt"
            ) from exc

        local = cached_models()
        fallbacks = [
            item.strip()
            for item in (settings.whisper_model_fallbacks or "").split(",")
            if item.strip()
        ]
        # Keep order stable and remove duplicates without losing priority.
        candidates = list(dict.fromkeys([requested, settings.whisper_model, *fallbacks]))

        errors: list[str] = []
        for candidate in candidates:
            local_only = candidate in local and settings.whisper_local_files_only
            logger.info(
                "loading whisper model=%s device=%s cached=%s localOnly=%s",
                candidate,
                device,
                candidate in local,
                local_only,
            )
            try:
                model = _construct_model(WhisperModel, candidate, device, settings, local_only)
                _model, _model_key = model, (candidate, device, settings.whisper_compute_type)
                return _model
            except Exception as exc:
                errors.append(f"{candidate}: {exc}")
                # CUDA can fail for driver reasons even with correct weights.
                if device == "cuda":
                    logger.warning("cuda load failed for %s (%s), retrying on cpu", candidate, exc)
                    try:
                        model = _construct_model(WhisperModel, candidate, "cpu", settings, local_only)
                        device = "cpu"
                        _model, _model_key = model, (candidate, device, settings.whisper_compute_type)
                        return _model
                    except Exception as cpu_exc:
                        errors[-1] += f" / cpu: {cpu_exc}"
                if not local_only:
                    logger.warning("could not load whisper model %s: %s", candidate, exc)

        raise TranscriptionError(
            "no whisper model could be loaded. " + " | ".join(errors[-4:])
        )


SAMPLE_RATE = 16000


def _read_wav(path: Path):
    """Read a PCM WAV into mono float32 at 16 kHz.

    Uses the stdlib ``wave`` module rather than PyAV. faster-whisper's own
    ``decode_audio`` calls ``av.open(..., metadata_errors=...)``, a keyword that
    PyAV removed in v14, so pinning faster-whisper to a compatible PyAV is a
    moving target. Decoding here means the only audio dependency is ffmpeg,
    which the pipeline already requires.
    """
    import numpy as np  # noqa: PLC0415 - pulled in with ctranslate2

    with wave.open(str(path), "rb") as handle:
        channels = handle.getnchannels()
        width = handle.getsampwidth()
        rate = handle.getframerate()
        frames = handle.readframes(handle.getnframes())

    if width == 2:
        samples = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    elif width == 1:
        # 8-bit WAV is unsigned.
        samples = (np.frombuffer(frames, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    elif width == 4:
        samples = np.frombuffer(frames, dtype=np.int32).astype(np.float32) / 2147483648.0
    else:
        raise TranscriptionError(f"unsupported PCM sample width: {width * 8}-bit")

    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)

    if rate != SAMPLE_RATE:
        # Cheap linear resample. Only reached if a caller hands us a WAV we did
        # not produce; the pipeline always requests 16 kHz up front.
        target = int(round(len(samples) * SAMPLE_RATE / float(rate)))
        samples = np.interp(
            np.linspace(0, len(samples) - 1, target, dtype=np.float64),
            np.arange(len(samples), dtype=np.float64),
            samples,
        ).astype(np.float32)

    return np.ascontiguousarray(samples, dtype=np.float32)


def load_audio(audio_path: Path, cancel: Callable[[], bool] | None = None):
    """Return a mono float32 array at 16 kHz, transcoding if necessary."""
    import numpy as np  # noqa: PLC0415

    if audio_path.suffix.lower() == ".wav":
        try:
            return _read_wav(audio_path)
        except (wave.Error, TranscriptionError, ValueError) as exc:
            logger.debug("%s is not readable PCM WAV (%s); re-encoding", audio_path.name, exc)

    with tempfile.TemporaryDirectory(prefix="clipforge_audio_") as scratch:
        wav_path = Path(scratch) / "audio.wav"
        try:
            run_ffmpeg(
                [
                    "-i", str(audio_path),
                    "-vn",
                    "-ac", "1",
                    "-ar", str(SAMPLE_RATE),
                    "-c:a", "pcm_s16le",
                    "-f", "wav",
                    str(wav_path),
                ],
                cancel=cancel,
            )
        except RuntimeError as exc:
            raise TranscriptionError(f"could not decode audio: {exc}") from exc

        return _read_wav(wav_path)


def _write_wav_chunk(samples, path: Path) -> None:
    """Write a float32 mono array as 16-bit PCM WAV for hosted transcription."""
    import numpy as np  # noqa: PLC0415 - already pulled in with ctranslate2

    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(SAMPLE_RATE)
        pcm = np.clip(samples, -1.0, 1.0)
        handle.writeframes((pcm * 32767).astype("<i2").tobytes())


def _segments_from_provider(
    payload: dict, offset: float, counter: list[int]
) -> list[Segment]:
    """Map a hosted provider's verbose JSON onto our Segment/WordTiming shape."""
    result: list[Segment] = []
    for raw in payload.get("segments") or []:
        text = str(raw.get("text") or "").strip()
        if not text:
            continue
        start = float(raw.get("start") or 0.0) + offset
        end = float(raw.get("end") or start) + offset
        if end <= start:
            end = start + 0.4

        words: list[WordTiming] = []
        for word in raw.get("words") or []:
            token = str(word.get("word") or word.get("text") or "").strip()
            if not token:
                continue
            w_start = float(word.get("start") or start) + offset
            w_end = float(word.get("end") or w_start) + offset
            if w_end <= w_start:
                continue
            words.append(WordTiming(w_start, w_end, token))
        if not words:
            words = expand_to_words(text, start, end)

        counter[0] += len(words)
        result.append(Segment(start_sec=start, end_sec=end, text=text, words=words))
    return result


def _transcribe_groq(
    samples,
    settings: Settings,
    plan: dict,
    on_progress: Callable[[float], None] | None,
    cancel: Callable[[], bool] | None,
) -> tuple[list[Segment], dict]:
    """Hosted transcription, chunked so long files stay under upload limits.

    Chunk responses are cached by content hash, so a retry after a network error
    or a worker restart only pays for the chunks that have not finished. Any
    failure propagates to :func:`transcribe`, which falls back to the local model.
    """
    import httpx  # noqa: PLC0415 - optional path, only needed with a Groq key

    chunk_size = max(60, int(plan.get("chunkSec") or 600)) * SAMPLE_RATE
    total = max(1, int(len(samples) / SAMPLE_RATE))
    chunk_count = max(1, (len(samples) + chunk_size - 1) // chunk_size)
    cache_dir = settings.transcript_cache_dir
    if settings.transcript_cache_enabled:
        cache_dir.mkdir(parents=True, exist_ok=True)

    base_url = settings.groq_base_url.rstrip("/")
    headers = {"Authorization": f"Bearer {settings.groq_api_key}"}
    segments: list[Segment] = []
    word_counter = [0]

    with tempfile.TemporaryDirectory(prefix="clipforge_groq_") as scratch:
        for index in range(chunk_count):
            if cancel is not None and cancel():
                from .runner import CancelledError  # noqa: PLC0415 - avoid import cycle

                raise CancelledError("transcription cancelled")

            start_sample = index * chunk_size
            chunk = samples[start_sample : start_sample + chunk_size]
            digest = hashlib.sha256(chunk.tobytes()).hexdigest()[:24]
            cache_file = cache_dir / f"groq_{digest}.json"

            payload = None
            if settings.transcript_cache_enabled and cache_file.exists():
                try:
                    payload = json.loads(cache_file.read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    payload = None

            if payload is None:
                chunk_path = Path(scratch) / f"chunk_{index:04d}.wav"
                _write_wav_chunk(chunk, chunk_path)
                with chunk_path.open("rb") as handle:
                    response = httpx.post(
                        f"{base_url}/audio/transcriptions",
                        headers=headers,
                        data={
                            "model": settings.groq_transcribe_model,
                            "response_format": "verbose_json",
                            "language": settings.whisper_language or "",
                        },
                        files={"file": (chunk_path.name, handle, "audio/wav")},
                        params=[("timestamp_granularities[]", "word")],
                        timeout=settings.llm_timeout_sec * 4,
                    )
                response.raise_for_status()
                payload = response.json()
                if settings.transcript_cache_enabled:
                    try:
                        cache_file.write_text(
                            json.dumps(payload), encoding="utf-8"
                        )
                    except OSError:  # pragma: no cover - cache is best-effort
                        logger.debug("could not cache groq chunk %s", digest)

            offset = start_sample / SAMPLE_RATE
            segments.extend(_segments_from_provider(payload, offset, word_counter))

            if on_progress is not None:
                done_sample = min(len(samples), start_sample + len(chunk))
                on_progress(min(1.0, done_sample / SAMPLE_RATE / max(1, total)))

    meta = {
        "language": settings.whisper_language,
        "languageProbability": 0.0,
        "durationSec": total,
        "segmentCount": len(segments),
        "wordCount": word_counter[0],
        "provider": "groq",
    }
    return segments, meta


def transcribe(
    audio_path: Path,
    settings: Settings,
    on_progress: Callable[[float], None] | None = None,
    cancel: Callable[[], bool] | None = None,
    plan: dict | None = None,
) -> tuple[list[Segment], dict]:
    """Transcribe an audio or video file into timed segments.

    Args:
        audio_path: Any file ffmpeg can decode.
        on_progress: Called with 0..1 as segments arrive.
        cancel: Polled between segments; raise ``CancelledError`` to abort.

    Returns:
        ``(segments, info)`` where info carries detected language and duration.
    """
    if on_progress is not None:
        on_progress(0.0)

    # Decoded up front rather than lazily inside model.transcribe: the decode is
    # the slow part for long files, and an empty result would otherwise look
    # like a silent video instead of an error.
    try:
        samples = load_audio(audio_path, cancel=cancel)
    except TranscriptionError:
        raise
    except Exception as exc:
        raise TranscriptionError(f"could not decode audio: {exc}") from exc

    if samples.size == 0:
        raise TranscriptionError("the file contains no audio track to transcribe")

    duration = len(samples) / SAMPLE_RATE
    effective_plan = dict(plan or settings.transcription_plan(duration))
    if on_progress is not None:
        on_progress(0.03)  # decode finished; model/provider work is next

    # Hosted transcription is fastest for long files, but it stays optional:
    # a missing key, network error or API change simply falls through to local.
    if effective_plan.get("provider") == "groq" and settings.groq_api_key:
        try:
            return _transcribe_groq(samples, settings, effective_plan, on_progress, cancel)
        except Exception as exc:
            logger.warning("groq transcription failed, falling back to local model: %s", exc)

    if on_progress is not None:
        on_progress(0.05)  # model load shares the same visible stage

    model = load_model(settings, effective_plan.get("model"))
    initial_prompt = getattr(settings, "whisper_initial_prompt", None)
    project_hint = (getattr(settings, "transcription_hint", "") or "").strip().lower()
    if project_hint in {"hinglish", "roman", "hinglish_roman"}:
        initial_prompt = (
            "Transcribe Hindi and English mixed speech as Roman Hinglish. "
            "Use Latin letters, preserve code-switching, and keep common words like bhai, yaar, scene, kya, matlab, seriously, bro."
        )
    try:
        raw_segments, info = model.transcribe(
            samples,  # a numpy array skips faster-whisper's PyAV decoding
            word_timestamps=True,
            vad_filter=True,  # drops silence, which improves both speed and accuracy
            vad_parameters={"min_silence_duration_ms": 500},
            beam_size=int(effective_plan.get("beamSize") or 5),
            condition_on_previous_text=bool(
                effective_plan.get("conditionOnPreviousText", True)
            ),
            language=settings.whisper_language,
            initial_prompt=initial_prompt,
        )
    except TranscriptionError:
        raise
    except TypeError as exc:
        # An older faster-whisper may not accept condition_on_previous_text.
        # Retry without it rather than failing an otherwise valid job.
        if "condition_on_previous_text" not in str(exc):
            raise TranscriptionError(f"transcription failed: {exc}") from exc
        logger.warning("faster-whisper rejected condition_on_previous_text; retrying")
        try:
            raw_segments, info = model.transcribe(
                samples,
                word_timestamps=True,
                vad_filter=True,
                vad_parameters={"min_silence_duration_ms": 500},
                beam_size=int(effective_plan.get("beamSize") or 5),
                language=settings.whisper_language,
                initial_prompt=initial_prompt,
            )
        except Exception as inner:
            raise TranscriptionError(f"transcription failed: {inner}") from inner
    except Exception as exc:
        raise TranscriptionError(f"transcription failed: {exc}") from exc

    total = max(1, int(getattr(info, "duration", 0) or duration))

    segments: list[Segment] = []
    for index, raw in enumerate(raw_segments):
        if cancel is not None and cancel():
            from .runner import CancelledError  # noqa: PLC0415 - avoid import cycle

            raise CancelledError("transcription cancelled")

        text = (getattr(raw, "text", "") or "").strip()
        if not text:
            continue

        start = float(getattr(raw, "start", 0.0) or 0.0)
        end = float(getattr(raw, "end", start) or start)
        if end <= start:
            end = start + 0.4

        words: list[WordTiming] = []
        for word in getattr(raw, "words", None) or []:
            token = (getattr(word, "word", "") or "").strip()
            if not token:
                continue
            w_start = float(getattr(word, "start", start) or start)
            w_end = float(getattr(word, "end", w_start) or w_start)
            if w_end <= w_start:
                continue
            words.append(WordTiming(w_start, w_end, token))

        # Guarantee words: karaoke needs them and Whisper occasionally omits a
        # short segment's timings entirely.
        if not words:
            words = expand_to_words(text, start, end)

        segments.append(Segment(start_sec=start, end_sec=end, text=text, words=words))

        if on_progress is not None:
            cursor = min(end, float(total))
            on_progress(min(1.0, 0.05 + 0.95 * (cursor / total)) if total else 0.05)

    # VAD can drop everything on a silent clip. Without this final tick the
    # stage would appear frozen at 5% until the pipeline reports the error.
    if on_progress is not None:
        on_progress(1.0)

    meta = {
        "language": getattr(info, "language", None),
        "languageProbability": float(getattr(info, "language_probability", 0.0) or 0.0),
        "durationSec": total,
        "segmentCount": len(segments),
        "wordCount": sum(segment.word_count for segment in segments),
        "provider": "local",
        "model": effective_plan.get("model"),
        "fastMode": bool(effective_plan.get("fastMode")),
    }

    logger.info(
        "transcribed %s -> %d segments, %d words, lang=%s, model=%s",
        audio_path.name,
        len(segments),
        meta["wordCount"],
        meta["language"],
        meta["model"],
    )
    return segments, meta


def transcribe_to_dicts(
    audio_path: Path,
    settings: Settings,
    on_progress: Callable[[float], None] | None = None,
    cancel: Callable[[], bool] | None = None,
    plan: dict | None = None,
) -> tuple[list[dict], dict]:
    """Convenience wrapper returning JSON-ready dicts."""
    segments, meta = transcribe(audio_path, settings, on_progress, cancel, plan)
    return [segment.to_dict() for segment in segments], meta


def iter_words(segments: Iterator[Segment]):
    """Flatten segments into words. Used by the caption renderer."""
    for segment in segments:
        for word in segment.words:
            yield word


def count_words(segments: list[Segment]) -> int:
    return sum(segment.word_count for segment in segments)


def text_of(segments: list[Segment]) -> str:
    return " ".join(segment.text for segment in segments)


def words_estimate(text: str) -> int:
    return len(split_words(text))