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

import logging
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


def load_model(settings: Settings):
    """Load (and cache) the Whisper model for this process."""
    global _model, _model_key

    device = resolve_device(settings.whisper_device)
    key = (settings.whisper_model, device, settings.whisper_compute_type)
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

        logger.info("loading whisper model=%s device=%s", settings.whisper_model, device)
        try:
            model = WhisperModel(
                settings.whisper_model,
                device=device,
                compute_type=settings.whisper_compute_type,
            )
        except Exception as exc:
            if device == "cuda":
                # Fall back rather than fail the job outright.
                logger.warning("cuda load failed (%s), retrying on cpu", exc)
                device = "cpu"
                model = WhisperModel(
                    settings.whisper_model,
                    device=device,
                    compute_type=settings.whisper_compute_type,
                )
            else:
                raise TranscriptionError(f"whisper model failed to load: {exc}") from exc

        _model, _model_key = model, (settings.whisper_model, device, settings.whisper_compute_type)
        return _model


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


def transcribe(
    audio_path: Path,
    settings: Settings,
    on_progress: Callable[[float], None] | None = None,
    cancel: Callable[[], bool] | None = None,
) -> tuple[list[Segment], dict]:
    """Transcribe an audio or video file into timed segments.

    Args:
        audio_path: Any file ffmpeg can decode.
        on_progress: Called with 0..1 as segments arrive.
        cancel: Polled between segments; raise ``CancelledError`` to abort.

    Returns:
        ``(segments, info)`` where info carries detected language and duration.
    """
    model = load_model(settings)

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

    try:
        raw_segments, info = model.transcribe(
            samples,  # a numpy array skips faster-whisper's PyAV decoding
            word_timestamps=True,
            vad_filter=True,  # drops silence, which improves both speed and accuracy
            vad_parameters={"min_silence_duration_ms": 500},
            beam_size=5,
            language=settings.whisper_language,
        )
    except TranscriptionError:
        raise
    except Exception as exc:
        raise TranscriptionError(f"transcription failed: {exc}") from exc

    total = max(1, int(getattr(info, "duration", 0) or len(samples) / SAMPLE_RATE))

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
            on_progress(min(1.0, cursor / total) if total else 0.0)

    meta = {
        "language": getattr(info, "language", None),
        "languageProbability": float(getattr(info, "language_probability", 0.0) or 0.0),
        "durationSec": total,
        "segmentCount": len(segments),
        "wordCount": sum(segment.word_count for segment in segments),
    }

    logger.info(
        "transcribed %s -> %d segments, %d words, lang=%s",
        audio_path.name,
        len(segments),
        meta["wordCount"],
        meta["language"],
    )
    return segments, meta


def transcribe_to_dicts(
    audio_path: Path,
    settings: Settings,
    on_progress: Callable[[float], None] | None = None,
    cancel: Callable[[], bool] | None = None,
) -> tuple[list[dict], dict]:
    """Convenience wrapper returning JSON-ready dicts."""
    segments, meta = transcribe(audio_path, settings, on_progress, cancel)
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