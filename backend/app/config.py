"""Runtime configuration, read from environment variables and ``backend/.env``.

Every value has a working default except the API keys, which are optional: with
neither key set the highlight pipeline still runs, it just skips the LLM
ranking pass and uses the local scorer alone.
"""

from __future__ import annotations

import shutil
from functools import lru_cache
from pathlib import Path
from typing import Any

from pydantic_settings import BaseSettings, SettingsConfigDict

# backend/app/config.py -> backend/
BACKEND_ROOT = Path(__file__).resolve().parent.parent


def _default_data_dir() -> Path:
    return BACKEND_ROOT / "data"


class Settings(BaseSettings):
    """Environment-backed settings.

    Reads ``backend/.env`` if present. Field names are upper-cased and matched
    case-insensitively, so ``whisper_model`` and ``WHISPER_MODEL`` both work.
    """

    model_config = SettingsConfigDict(
        env_file=BACKEND_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- Server -----------------------------------------------------------

    host: str = "127.0.0.1"
    port: int = 8000
    api_prefix: str = "/api/v1"

    # Origins allowed to call this API. The Vite dev server default plus the
    # common alternates, since the port shifts when 5173 is taken.
    cors_origins: str = (
        "http://localhost:5173,http://127.0.0.1:5173,"
        "http://localhost:5174,http://127.0.0.1:5174"
    )

    # --- Storage ----------------------------------------------------------

    data_dir: Path = _default_data_dir()
    max_upload_mb: int = 2048

    # --- Transcription ----------------------------------------------------

    # "small" is ~460MB and a good accuracy/speed balance. Use "medium" for
    # noticeably better accuracy if you have the VRAM and patience.
    whisper_model: str = "small"
    # "auto" picks CUDA when torch reports it, else CPU.
    whisper_device: str = "auto"
    # int8 is required to fit larger models in 4GB of VRAM.
    whisper_compute_type: str = "int8"
    whisper_language: str | None = None
    whisper_initial_prompt: str | None = None
    transcription_hint: str | None = None  # e.g. hinglish_roman

    # Long-form speed controls. A 100-minute CPU transcription is dominated by
    # this stage, so long sources switch to a cheaper preset automatically.
    # Short clips keep the accuracy-first defaults above.
    whisper_fast_model: str = "base"
    whisper_long_video_threshold_sec: float = 3600.0
    whisper_beam_size: int = 5
    whisper_fast_beam_size: int = 1
    whisper_condition_on_previous_text: bool = True
    # A cached model is loaded without contacting HuggingFace at all. This is
    # the difference between a 2-second load and a 10-second timeout that used
    # to fail whole jobs on flaky networks.
    whisper_local_files_only: bool = True
    # Comma-separated fallback order when the requested model is unavailable.
    whisper_model_fallbacks: str = "small,base,tiny"
    # "auto" uses Groq only for long/fast runs when a key is present, and falls
    # back to the local model for everything else. "local" never calls out.
    transcription_provider: str = "auto"  # auto | local | groq
    groq_transcribe_model: str = "whisper-large-v3-turbo"
    groq_chunk_sec: int = 600
    transcript_cache_enabled: bool = True

    # --- Highlight pipeline ----------------------------------------------

    # How many heuristic candidates to shortlist before LLM ranking.
    shortlist_size: int = 15
    # Clips produced per project when no explicit count is requested.
    default_clip_count: int = 8
    clip_min_duration: float = 5.0
    clip_max_duration: float = 90.0
    clip_target_duration: float = 38.0

    # --- LLM (all optional) ----------------------------------------------

    anthropic_api_key: str | None = None
    openai_api_key: str | None = None
    gemini_api_key: str | None = None
    qwen_api_key: str | None = None
    groq_api_key: str | None = None
    openrouter_api_key: str | None = None
    openai_base_url: str | None = None
    qwen_base_url: str | None = None
    groq_base_url: str = "https://api.groq.com/openai/v1"
    openrouter_base_url: str = "https://openrouter.ai/api/v1"
    anthropic_model: str = "claude-sonnet-4-5"
    openai_model: str = "gpt-4o-mini"
    gemini_model: str = "gemini-2.5-flash"
    qwen_model: str = "qwen2.5-7b-instruct"
    groq_model: str = "llama-3.3-70b-versatile"
    openrouter_model: str = "meta-llama/llama-3.3-70b-instruct:free"
    llm_timeout_sec: float = 45.0

    # --- Ingestion / modes -----------------------------------------------

    enable_youtube_ingest: bool = True
    youtube_max_duration_sec: int = 7200
    gameplay_vault_dir: Path | None = None

    # --- Optional analysis/render features -------------------------------

    enable_face_tracking: bool = True
    enable_audio_spike_detection: bool = True
    enable_scene_cut_detection: bool = True
    enable_dead_air_removal: bool = True
    enable_sfx_hooks: bool = False
    face_tracking_sample_fps: float = 2.0
    auto_zoom_min: float = 1.0
    auto_zoom_max: float = 1.12

    # --- Queue / productization ------------------------------------------

    job_queue: str = "inline"  # inline | celery
    redis_url: str = "redis://127.0.0.1:6379/0"
    enable_demo_limits: bool = False
    demo_max_projects: int = 3
    demo_max_exports_per_day: int = 10
    free_watermark_text: str = "ClipForge Free"
    allow_1080p60_exports: bool = False  # paid/entitled tier gate; false keeps 60fps HD as upgrade path

    # --- Credits / plans --------------------------------------------------
    # Credit accounting is always available through /billing. Enforcement at
    # job submission is opt-in so existing local installs keep working until a
    # deployment explicitly turns the freemium gate on.
    enable_credit_gate: bool = False
    free_monthly_minutes: int = 30
    creator_monthly_minutes: int = 300
    pro_monthly_minutes: int = 1200
    referral_bonus_minutes: int = 15
    stripe_secret_key: str | None = None
    stripe_creator_price_id: str | None = None
    stripe_pro_price_id: str | None = None

    # --- ffmpeg -----------------------------------------------------------

    ffmpeg_binary: str = "ffmpeg"
    ffprobe_binary: str = "ffprobe"
    ffmpeg_timeout_sec: float = 1800.0

    # --- Derived paths ----------------------------------------------------

    @property
    def upload_dir(self) -> Path:
        return self.data_dir / "uploads"

    @property
    def render_dir(self) -> Path:
        return self.data_dir / "renders"

    @property
    def vault_dir(self) -> Path:
        return self.gameplay_vault_dir or (self.data_dir / "vault")

    @property
    def transcript_cache_dir(self) -> Path:
        return self.data_dir / "transcripts"

    def transcription_plan(self, duration_sec: float, quality: str | None = None) -> dict[str, Any]:
        """Effective transcription settings for a source of ``duration_sec``.

        ``quality`` is an optional project-level override: ``fast`` forces the
        cheap preset, ``accuracy`` forces the accuracy preset, anything else
        (including ``None``) selects automatically by duration.

        The result is deliberately JSON-shaped so it can be returned by the API
        and shown in the UI: the user should know whether they are waiting on a
        local CPU model or a hosted provider.
        """
        requested = (quality or "auto").strip().lower()
        long_form = float(duration_sec or 0) > self.whisper_long_video_threshold_sec
        if requested == "accuracy":
            fast = False
        elif requested == "fast":
            fast = True
        else:
            fast = long_form

        provider = (self.transcription_provider or "auto").strip().lower()
        if provider not in {"auto", "local", "groq"}:
            provider = "auto"
        if provider == "auto":
            provider = "groq" if fast and bool(self.groq_api_key) else "local"

        return {
            "model": self.whisper_fast_model if fast else self.whisper_model,
            "beamSize": self.whisper_fast_beam_size if fast else self.whisper_beam_size,
            "conditionOnPreviousText": (
                False if fast else self.whisper_condition_on_previous_text
            ),
            "provider": provider,
            "chunkSec": max(60, int(self.groq_chunk_sec)),
            "fastMode": fast,
            "longForm": long_form,
            "quality": requested or "auto",
        }

    @property
    def database_url(self) -> str:
        """SQLite file inside the data dir. Absolute so relative CWD is safe."""
        self.data_dir.mkdir(parents=True, exist_ok=True)
        return f"sqlite:///{(self.data_dir / 'clipforge.db').as_posix()}"

    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024

    def resolved_ffmpeg(self) -> str:
        """Absolute path to ffmpeg, falling back to a bare name for PATH lookup."""
        found = shutil.which(self.ffmpeg_binary)
        return found or self.ffmpeg_binary

    def resolved_ffprobe(self) -> str:
        found = shutil.which(self.ffprobe_binary)
        return found or self.ffprobe_binary

    def llm_provider(self) -> str | None:
        """Preferred configured LLM provider. ``None`` means heuristic-only."""
        for name in ("groq", "openrouter", "anthropic", "gemini", "openai", "qwen"):
            if getattr(self, f"{name}_api_key", None):
                return name
        return None

    def llm_providers(self) -> list[str]:
        providers: list[str] = []
        for name in ("groq", "openrouter", "anthropic", "gemini", "openai", "qwen"):
            if getattr(self, f"{name}_api_key", None):
                providers.append(name)
        return providers

    def ensure_dirs(self) -> None:
        self.upload_dir.mkdir(parents=True, exist_ok=True)
        self.render_dir.mkdir(parents=True, exist_ok=True)
        self.vault_dir.mkdir(parents=True, exist_ok=True)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Cached settings singleton."""
    settings = Settings()
    settings.ensure_dirs()
    return settings
