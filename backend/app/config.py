"""Runtime configuration, read from environment variables and ``backend/.env``.

Every value has a working default except the API keys, which are optional: with
neither key set the highlight pipeline still runs, it just skips the LLM
ranking pass and uses the local scorer alone.
"""

from __future__ import annotations

import shutil
from functools import lru_cache
from pathlib import Path

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

    # --- Highlight pipeline ----------------------------------------------

    # How many heuristic candidates to shortlist before LLM ranking.
    shortlist_size: int = 15
    # Clips produced per project when no explicit count is requested.
    default_clip_count: int = 8
    clip_min_duration: float = 5.0
    clip_max_duration: float = 90.0
    clip_target_duration: float = 38.0

    # --- LLM (both optional) ---------------------------------------------

    anthropic_api_key: str | None = None
    openai_api_key: str | None = None
    anthropic_model: str = "claude-sonnet-4-5"
    openai_model: str = "gpt-4o-mini"
    llm_timeout_sec: float = 45.0

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
        """Which LLM to use, preferring Claude. ``None`` means heuristic-only."""
        if self.anthropic_api_key:
            return "anthropic"
        if self.openai_api_key:
            return "openai"
        return None

    def ensure_dirs(self) -> None:
        self.upload_dir.mkdir(parents=True, exist_ok=True)
        self.render_dir.mkdir(parents=True, exist_ok=True)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Cached settings singleton."""
    settings = Settings()
    settings.ensure_dirs()
    return settings
