"""Upload session store.

Sits under ``routes/uploads.py`` which is the HTTP shell around it.

The frontend's ``uploadService.js`` was written for S3-style multipart uploads:
open a session, PUT parts directly to storage, then finalise. On a single-machine
backend there is nowhere to PUT to except our own API, so a session hands back
URLs pointing at ``/uploads/{id}/parts/{n}`` and the browser uploads through us.
The wire shape is identical, so moving behind object storage later means changing
only URL generation.

Sessions live in memory. They are short-lived by nature, and persisting them
would mean migrating partial uploads on every restart for no real benefit.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from starlette.concurrency import run_in_threadpool

from ..config import Settings, get_settings
from ..storage import StorageError, safe_join, sanitize_name
from ..utils import new_id, utcnow

logger = logging.getLogger(__name__)

DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024  # 8 MB, matches uploadService.js

# Sessions live in memory: they are short-lived by nature, and persisting them
# would mean migrating partial uploads on every restart for no benefit.
_SESSIONS: dict[str, "UploadSession"] = {}


@dataclass
class UploadSession:
    id: str
    file_name: str
    file_size: int
    mime_type: str | None
    chunk_size: int
    status: str = "open"
    received: set[int] = field(default_factory=set)
    # Set once ``assemble`` has produced the final file; relative to DATA_DIR.
    assembled_path: str | None = None
    created_at: str = field(default_factory=lambda: utcnow().isoformat().replace("+00:00", "Z"))

    @property
    def total_parts(self) -> int:
        return max(1, -(-self.file_size // self.chunk_size))

    def part_path(self, part_number: int, settings: Settings):
        return safe_join(settings.upload_dir, f"parts/{self.id}/{part_number:05d}.part")

    def to_dict(self, base_url: str = "") -> dict[str, Any]:
        return {
            "uploadId": self.id,
            "fileName": self.file_name,
            "fileSize": self.file_size,
            "mimeType": self.mime_type,
            "status": self.status,
            "chunkSize": self.chunk_size,
            "totalParts": self.total_parts,
            "receivedParts": sorted(self.received),
            "bytesReceived": self.bytes_received(),
            "createdAt": self.created_at,
        }

    def bytes_received(self) -> int:
        """Total bytes accepted so far, read from part file sizes."""
        settings = get_settings()
        total = 0
        for part in self.received:
            path = self.part_path(part, settings)
            try:
                total += path.stat().st_size
            except OSError:
                continue
        return total

    def urls(self, part_numbers: list[int] | None = None) -> list[dict[str, Any]]:
        """Part URLs for the browser to PUT to.

        These carry the API prefix and the host is left off, so the frontend can
        resolve them against whichever origin it is served from. That keeps them
        correct when the API runs on a different port or domain than Vite.
        """
        prefix = get_settings().api_prefix
        numbers = part_numbers if part_numbers is not None else list(range(1, self.total_parts + 1))
        return [
            {
                "partNumber": number,
                "url": f"{prefix}/uploads/{self.id}/parts/{number}",
                "method": "PUT",
            }
            for number in numbers
        ]

    def with_parts(self) -> dict[str, Any]:
        payload = self.to_dict()
        payload["parts"] = self.urls()
        return payload


def create_session(payload: dict[str, Any], settings: Settings | None = None) -> UploadSession:
    """Open a session and pre-allocate its part directory."""
    settings = settings or get_settings()

    file_size = int(payload["fileSize"])
    if file_size <= 0:
        raise StorageError("fileSize must be positive")
    if file_size > settings.max_upload_bytes:
        raise StorageError(f"file exceeds the {settings.max_upload_mb}MB limit")

    session = UploadSession(
        id=new_id("upl"),
        file_name=sanitize_name(payload["fileName"], fallback="upload.bin"),
        file_size=file_size,
        mime_type=payload.get("mimeType"),
        chunk_size=DEFAULT_CHUNK_SIZE,
    )

    settings.upload_dir.mkdir(parents=True, exist_ok=True)
    (settings.upload_dir / "parts" / session.id).mkdir(parents=True, exist_ok=True)

    _SESSIONS[session.id] = session
    logger.info(
        "upload session %s: %s (%d bytes, %d parts)",
        session.id,
        session.file_name,
        file_size,
        session.total_parts,
    )
    return session


def get_session(upload_id: str) -> UploadSession | None:
    return _SESSIONS.get(upload_id)


def drop_session(upload_id: str) -> None:
    """Forget a session and delete its parts."""
    session = _SESSIONS.pop(upload_id, None)
    if session is None:
        return

    settings = get_settings()
    directory = settings.upload_dir / "parts" / upload_id
    try:
        for child in directory.iterdir():
            child.unlink(missing_ok=True)
        directory.rmdir()
    except OSError:
        logger.debug("could not fully clean upload session %s", upload_id, exc_info=True)


def _open_part(upload_id: str, part_number: int) -> tuple["UploadSession", Path]:
    """Validate a part request and resolve where it lands on disk.

    Shared by the sync and async writers so the validation rules cannot drift
    apart between them.
    """
    session = _SESSIONS.get(upload_id)
    if session is None:
        raise StorageError("unknown upload session")
    if session.status != "open":
        raise StorageError("upload session is no longer accepting parts")

    if not (1 <= part_number <= session.total_parts):
        raise StorageError(f"part number out of range: {part_number}")

    settings = get_settings()
    path = session.part_path(part_number, settings)
    path.parent.mkdir(parents=True, exist_ok=True)
    return session, path


def _accept(session: "UploadSession", part_number: int, written: int) -> None:
    session.received.add(part_number)
    logger.debug("stored part %d/%d of %s (%d bytes)", part_number, session.total_parts, session.id, written)


def store_part(upload_id: str, part_number: int, stream) -> int:
    """Write one part from a synchronous byte iterator to disk."""
    session, path = _open_part(upload_id, part_number)

    written = 0
    with path.open("wb") as handle:
        for chunk in stream:
            written += len(chunk)
            handle.write(chunk)

    _accept(session, part_number, written)
    return written


async def store_part_async(upload_id: str, part_number: int, stream) -> int:
    """Write one part from an async byte iterator to disk.

    The request body is an async iterator, so this cannot simply be handed to the
    synchronous writer above. Each chunk is written through a worker thread to
    keep disk I/O off the event loop, and nothing is buffered whole in memory, so
    a 500 MB part costs 500 MB of network, not 500 MB of RAM.
    """
    session, path = _open_part(upload_id, part_number)

    written = 0
    with path.open("wb") as handle:
        async for chunk in stream:
            await run_in_threadpool(handle.write, chunk)
            written += len(chunk)

    _accept(session, part_number, written)
    return written


def missing_parts(session: UploadSession) -> list[int]:
    return [number for number in range(1, session.total_parts + 1) if number not in session.received]


def assemble(session: UploadSession, settings: Settings | None = None) -> tuple[str, int]:
    """Concatenate parts into the final upload file.

    Returns ``(relative_path, size_bytes)`` where the path is relative to
    ``DATA_DIR``.

    Raises:
        StorageError: if any part is missing or the total size is wrong.
    """
    settings = settings or get_settings()

    gaps = missing_parts(session)
    if gaps:
        raise StorageError(f"upload is incomplete, {len(gaps)} part(s) missing")

    target = safe_join(settings.upload_dir, f"{session.id}-{session.file_name}")

    written = 0
    with target.open("wb") as output:
        for number in range(1, session.total_parts + 1):
            part = session.part_path(number, settings)
            try:
                with part.open("rb") as handle:
                    while chunk := handle.read(1024 * 1024):
                        output.write(chunk)
                        written += len(chunk)
            except OSError as exc:
                target.unlink(missing_ok=True)
                raise StorageError(f"could not read part {number}: {exc}") from exc

    if written != session.file_size:
        # A size mismatch means the browser sent the wrong bytes. Refusing here
        # is better than failing later inside ffprobe with a baffling error.
        target.unlink(missing_ok=True)
        raise StorageError(
            f"size mismatch: expected {session.file_size} bytes, assembled {written}"
        )

    relative = target.relative_to(settings.data_dir).as_posix()
    logger.info("assembled upload %s -> %s (%d bytes)", session.id, session.file_name, written)

    # Parts have served their purpose. The session itself is kept: the client
    # polls it after completing, and POST /projects resolves the asset through
    # it by uploadId, so dropping it here would break a normal upload flow.
    for number in list(session.received):
        session.part_path(number, settings).unlink(missing_ok=True)
    session.received.clear()

    return relative, written


def describe(session: UploadSession) -> dict[str, Any]:
    """Session payload, including the asset descriptor once complete.

    This is what ``uploadVideo`` reads after ``completeUpload`` to learn where the
    file landed.
    """
    payload = session.with_parts()
    if session.status == "complete" and session.assembled_path:
        payload["missingParts"] = []
        payload["asset"] = asset_for(session, session.assembled_path, session.file_size)
    else:
        payload["missingParts"] = missing_parts(session)
    return payload


def asset_for(session: UploadSession, relative_path: str, size_bytes: int) -> dict[str, Any]:
    """The asset descriptor the frontend reads off ``completeUpload``."""
    return {
        "assetId": session.id,
        "fileName": session.file_name,
        "fileSize": size_bytes,
        "mimeType": session.mime_type,
        "path": relative_path,
        "kind": _guess_kind(session.mime_type, session.file_name),
        "uploadedAt": utcnow().isoformat().replace("+00:00", "Z"),
    }


_AUDIO_PREFIXES = ("audio/",)


def _guess_kind(mime_type: str | None, file_name: str) -> str:
    if mime_type and mime_type.startswith(_AUDIO_PREFIXES):
        return "audio"
    if file_name.lower().endswith((".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg")):
        return "audio"
    return "video"


def reset_sessions() -> None:
    """Clear all in-memory sessions. Used by tests."""
    for upload_id in list(_SESSIONS):
        drop_session(upload_id)


def prune_completed(keep_hours: int = 6) -> int:
    """Forget completed sessions older than ``keep_hours``.

    A session only has to outlive the gap between ``completeUpload`` and the
    ``POST /projects`` that claims it. Pruning keeps the in-memory map from
    growing without bound on a long-running server. The assembled *file* is not
    touched â€” it belongs to the project that now references it.
    """
    cutoff = utcnow() - timedelta(hours=keep_hours)
    stale = [
        upload_id
        for upload_id, session in _SESSIONS.items()
        if session.status == "complete" and _parse_time(session.created_at) < cutoff
    ]
    for upload_id in stale:
        _SESSIONS.pop(upload_id, None)
    return len(stale)


def _parse_time(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return utcnow()


def snapshot() -> list[dict[str, Any]]:
    """All known sessions, for the health endpoint."""
    return [session.to_dict() for session in _SESSIONS.values()]