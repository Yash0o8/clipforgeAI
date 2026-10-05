"""Source media streaming.

``ClipEditor`` and ``ClipPreview`` need to play the original video, seek around
inside it, and do both inside a trim window. That requires HTTP range support:
without 206 responses the browser can play the file but not seek, and seeking is
the entire editor workflow.

``project.objectUrl`` points here, so this route is the only thing standing
between the frontend and the filesystem.
"""

from __future__ import annotations

import logging
import mimetypes
import re
from pathlib import Path
from typing import Iterator

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response, status
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import Project, get_session
from ..storage import StorageError, probe, safe_join

logger = logging.getLogger(__name__)

router = APIRouter(tags=["media"])

# 1 MB. Large enough to keep the connection busy, small enough that seeking stays
# responsive without a thread per request holding a large buffer.
CHUNK_SIZE = 1024 * 1024

_RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)")


def _resolve(session: Session, project_id: str) -> tuple[Project, Path]:
    """Load the project and its on-disk media, or raise."""
    project = session.query(Project).filter(Project.id == project_id).first()
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    if not project.asset_path:
        raise HTTPException(status_code=404, detail="This project has no media")

    settings = get_settings()
    try:
        path = safe_join(settings.data_dir, project.asset_path)
    except StorageError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc

    if not path.exists():
        raise HTTPException(status_code=410, detail="Media is no longer on disk")

    return project, path


def _media_type(path: Path, project: Project) -> str:
    guessed, _ = mimetypes.guess_type(path.name)
    return guessed or project.mime_type or "application/octet-stream"


def _iter_file(path: Path, start: int, end: int) -> Iterator[bytes]:
    """Yield ``[start, end]`` in chunks, closing the handle when done."""
    remaining = end - start + 1
    with path.open("rb") as handle:
        handle.seek(start)
        while remaining > 0:
            chunk = handle.read(min(CHUNK_SIZE, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk


@router.get("/media/{project_id}")
def stream_media(
    project_id: str,
    request: Request,
    range_header: str | None = Header(default=None, alias="range"),
    session: Session = Depends(get_session),
) -> Response:
    """Serve the source file, honouring ``Range`` requests.

    Returns 206 with a ``Content-Range`` for a ranged request, or 200 for a full
    body. A browser that gets neither can play but not seek.
    """
    project, path = _resolve(session, project_id)
    size = path.stat().st_size
    media_type = _media_type(path, project)

    if not range_header:
        return StreamingResponse(
            _iter_file(path, 0, size - 1),
            media_type=media_type,
            headers={
                "Accept-Ranges": "bytes",
                "Content-Length": str(size),
                # The file is immutable once uploaded: a given project's media
                # never changes, so the browser can cache it hard.
                "Cache-Control": "private, max-age=3600",
            },
        )

    match = _RANGE_RE.fullmatch(range_header.strip())
    if not match:
        raise HTTPException(status_code=400, detail="Malformed Range header")

    raw_start, raw_end = match.groups()

    if raw_start:
        start = int(raw_start)
        end = int(raw_end) if raw_end else size - 1
    elif raw_end:
        # Suffix form: "bytes=-500" means the last 500 bytes.
        length = int(raw_end)
        start = max(0, size - length)
        end = size - 1
    else:
        raise HTTPException(status_code=400, detail="Malformed Range header")

    end = min(end, size - 1)
    if start > end or start >= size:
        return Response(
            status_code=status.HTTP_416_REQUESTED_RANGE_NOT_SATISFIABLE,
            headers={"Content-Range": f"bytes */{size}"},
        )

    return StreamingResponse(
        _iter_file(path, start, end),
        status_code=status.HTTP_206_PARTIAL_CONTENT,
        media_type=media_type,
        headers={
            "Accept-Ranges": "bytes",
            "Content-Range": f"bytes {start}-{end}/{size}",
            "Content-Length": str(end - start + 1),
            "Cache-Control": "private, max-age=3600",
        },
    )


@router.head("/media/{project_id}")
def media_head(project_id: str, session: Session = Depends(get_session)) -> Response:
    """Headers only. Some players probe with HEAD before a GET."""
    project, path = _resolve(session, project_id)
    return Response(
        headers={
            "Accept-Ranges": "bytes",
            "Content-Length": str(path.stat().st_size),
            "Content-Type": _media_type(path, project),
        }
    )


@router.get("/media/{project_id}/info")
def media_info(project_id: str, session: Session = Depends(get_session)) -> dict:
    """Probe the source on demand.

    Wrapped so the dashboard can show real dimensions and duration without
    ffprobe having to run during project creation.
    """
    project, path = _resolve(session, project_id)
    try:
        return {"projectId": project_id, **probe(path).to_dict()}
    except StorageError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc