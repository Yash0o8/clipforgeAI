"""Clip resources.

Maps onto ``src/services/clipService.js``.

One contract detail worth stating: ``startSec``/``endSec`` are **source-absolute**
fractions of a second, not clip-relative. ``ClipPreview.jsx`` assigns them
straight to ``video.currentTime``, and ``ClipEditor`` builds its scrubber from
them, so anything relative would make the preview seek to the wrong place.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from ..db import Clip, Project, get_session, utcnow
from ..schemas import ClipPatch
from ..utils import new_id

logger = logging.getLogger(__name__)

router = APIRouter(tags=["clips"])


def get_clip_or_404(session: Session, clip_id: str) -> Clip:
    clip = session.query(Clip).filter(Clip.id == clip_id).first()
    if clip is None:
        raise HTTPException(status_code=404, detail="Clip not found")
    return clip


@router.get("/clips/{clip_id}")
def read_clip(clip_id: str, session: Session = Depends(get_session)) -> dict[str, Any]:
    """A single clip including its full timed transcript.

    ``GET /clips/{id}`` is what the editor calls on mount.
    """
    return get_clip_or_404(session, clip_id).to_dict()


@router.patch("/clips/{clip_id}")
def update_clip(
    clip_id: str,
    payload: ClipPatch,
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    """Persist editor changes.

    Any real change flips the clip to ``edited``, matching ``useClipEditor.save``
    so the status is consistent whichever side writes first.
    """
    clip = get_clip_or_404(session, clip_id)
    project = session.query(Project).filter(Project.id == clip.project_id).first()

    start = clip.start_sec
    end = clip.end_sec

    if payload.startSec is not None:
        start = payload.startSec
    if payload.endSec is not None:
        end = payload.endSec

    # Validate the window against the source and the platform's limits. The
    # frontend enforces the same numbers, so this is defence in depth rather
    # than the only guard.
    limits = {"min": 5.0, "max": 90.0}
    source_duration = project.duration_sec if project else 0.0

    if source_duration > 0:
        start = max(0.0, min(start, source_duration))
        end = max(0.0, min(end, source_duration))

    if end - start < limits["min"]:
        raise HTTPException(
            status_code=422,
            detail=f"A clip must be at least {int(limits['min'])} seconds long.",
        )
    if end - start > limits["max"]:
        raise HTTPException(
            status_code=422,
            detail=f"A clip cannot exceed {int(limits['max'])} seconds.",
        )

    # An exported clip is no longer current: the file on disk was rendered from
    # the old window, so mark it edited rather than leaving a false "exported".
    was_exported = clip.status == "exported"
    substantive = (
        abs(start - clip.start_sec) > 0.001
        or abs(end - clip.end_sec) > 0.001
        or (payload.title is not None and payload.title.strip() != clip.title)
        or payload.aspectRatio is not None
        or payload.caption is not None
    )

    clip.start_sec = round(start, 2)
    clip.end_sec = round(end, 2)
    clip.duration_sec = round(end - start, 2)

    if payload.title is not None:
        clip.title = payload.title.strip() or clip.title
    if payload.hook is not None:
        clip.hook = payload.hook
    if payload.aspectRatio is not None:
        clip.aspect_ratio = payload.aspectRatio
    if payload.caption is not None:
        # Merge rather than replace, so a partial payload cannot drop a field.
        caption = json.loads(clip.caption_json or "{}")
        caption.update(payload.caption.model_dump(exclude_unset=True))
        clip.caption_json = json.dumps(caption)
    if payload.export is not None:
        exports = json.loads(clip.export_json or "{}")
        exports.update(payload.export.model_dump(exclude_unset=True))
        clip.export_json = json.dumps(exports)

    if payload.status is not None:
        clip.status = payload.status
    elif substantive and not was_exported:
        clip.status = "edited"

    clip.edited_at = utcnow()
    session.commit()

    return clip.to_dict()


@router.post("/clips/{clip_id}/discard")
def discard_clip(clip_id: str, session: Session = Depends(get_session)) -> dict[str, Any]:
    """Delete a suggested clip the user chose to discard.

    Matches ``clipService.deleteClip``, which POSTs here then removes the row from
    local state. Returns a descriptor rather than a bare 204 so the client can
    reconcile without a follow-up fetch.
    """
    clip = get_clip_or_404(session, clip_id)

    payload = {
        "id": clip.id,
        "projectId": clip.project_id,
        "title": clip.title,
        "discarded": True,
    }

    session.delete(clip)
    session.commit()

    logger.info("discarded clip %s from project %s", clip_id, payload["projectId"])
    return payload


@router.post("/clips", status_code=status.HTTP_201_CREATED)
def create_clip(payload: dict[str, Any], session: Session = Depends(get_session)) -> dict[str, Any]:
    """Create a clip manually against a project's source.

    Not used by the current UI, but it is the only way to create a clip the
    highlight detector did not suggest, which is a real gap in the product.
    """
    project_id = payload.get("projectId")
    if not project_id:
        raise HTTPException(status_code=422, detail="projectId is required")

    project = session.query(Project).filter(Project.id == project_id).first()
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")

    try:
        start = float(payload["startSec"])
        end = float(payload["endSec"])
    except (KeyError, TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail="startSec and endSec are required") from exc

    if project.duration_sec > 0:
        start = max(0.0, min(start, project.duration_sec))
        end = max(0.0, min(end, project.duration_sec))
    if end - start < 5.0 or end - start > 90.0:
        raise HTTPException(status_code=422, detail="Clip duration must be between 5 and 90 seconds")

    clip = Clip(
        id=new_id("clip"),
        project_id=project.id,
        title=str(payload.get("title") or "Untitled clip").strip()[:200],
        hook=payload.get("hook"),
        start_sec=round(start, 2),
        end_sec=round(end, 2),
        duration_sec=round(end - start, 2),
        score=0,
        aspect_ratio=payload.get("aspectRatio") if payload.get("aspectRatio") in ("9:16", "1:1", "16:9") else "9:16",
        status="selected",
        poster_seed=payload.get("posterSeed") or 0,
        transcript_json=json.dumps(payload.get("transcript") or []),
        caption_json=json.dumps(
            payload.get("caption") or {"text": "", "presetId": "clean", "position": None}
        ),
        export_json=json.dumps(
            payload.get("export") or {"format": "mp4", "resolution": "1080x1920", "burnCaptions": True}
        ),
    )
    session.add(clip)
    session.commit()

    return clip.to_dict()