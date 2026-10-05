"""Upload routes.

Thin HTTP shell over ``upload_store.py``: parse the request, delegate, and map
storage errors onto 4xx responses.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import Response

from ..schemas import RefreshPartsRequest, UploadSessionCreate
from ..storage import StorageError
from . import upload_store as store

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/uploads", tags=["uploads"])


def _require(upload_id: str) -> store.UploadSession:
    session = store.get_session(upload_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Upload session not found")
    return session


@router.post("", status_code=status.HTTP_201_CREATED)
def create_session(payload: UploadSessionCreate) -> dict:
    """Open an upload session and return presigned-style part URLs."""
    try:
        session = store.create_session(payload.model_dump())
    except StorageError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    # Opportunistic cleanup rather than a background timer: sessions are only
    # created on upload, so this is the one moment the map can grow.
    store.prune_completed()

    return session.with_parts()


@router.get("/{upload_id}")
def read_session(upload_id: str) -> dict:
    """Poll a session, e.g. after resuming an interrupted upload."""
    try:
        return store.describe(_require(upload_id))
    except StorageError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/{upload_id}/parts")
def refresh_parts(upload_id: str, payload: RefreshPartsRequest) -> dict:
    """Re-issue URLs for parts the client still needs to push."""
    try:
        session = _require(upload_id)
        return {
            "uploadId": session.id,
            "parts": session.urls(payload.partNumbers),
            "missingParts": store.missing_parts(session),
        }
    except StorageError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.put("/{upload_id}/parts/{part_number}")
async def upload_part(upload_id: str, part_number: int, request: Request) -> Response:
    """Accept one part.

    Streamed straight to disk by the store's async writer, so a multi-hundred-
    megabyte part never sits in memory and the event loop stays responsive.
    """
    try:
        if store.get_session(upload_id) is None:
            raise HTTPException(status_code=404, detail="Upload session not found")

        written = await store.store_part_async(upload_id, part_number, request.stream())
    except StorageError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    # The ETag is informational for our own storage, but uploadService reads it.
    return Response(status_code=status.HTTP_200_OK, headers={"ETag": f'"{written:x}"'})


@router.post("/{upload_id}/complete")
def complete_session(upload_id: str) -> dict:
    """Assemble the parts into the final file."""
    try:
        session = _require(upload_id)

        if session.status == "complete" and session.assembled_path:
            # Idempotent: a retried complete should not fail the whole upload.
            return {
                "uploadId": session.id,
                "status": "complete",
                "bytesWritten": session.file_size,
                "asset": store.asset_for(session, session.assembled_path, session.file_size),
            }

        relative, size = store.assemble(session)
        session.status = "complete"
        session.assembled_path = relative
    except StorageError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return {
        "uploadId": session.id,
        "status": "complete",
        "bytesWritten": size,
        "asset": store.asset_for(session, relative, size),
    }


@router.post("/{upload_id}/abort")
def abort_session(upload_id: str) -> dict:
    """Discard a partially uploaded session."""
    if store.get_session(upload_id) is None:
        # Aborting something already gone is a success: the client wanted it
        # gone, and it is.
        return {"uploadId": upload_id, "status": "aborted"}

    store.drop_session(upload_id)
    return {"uploadId": upload_id, "status": "aborted"}