"""Gameplay vault API.

Serves a manifest of royalty-free/loopable background clips. Assets are managed
on disk under the configured vault directory; this endpoint only exposes metadata
and a media stream path.
"""

from __future__ import annotations

import json
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from ..config import get_settings
from ..storage import safe_join

router = APIRouter(prefix="/vault", tags=["vault"])


def _load_manifest() -> list[dict]:
    settings = get_settings()
    manifest = settings.vault_dir / "manifest.json"
    if not manifest.exists():
        return []
    try:
        data = json.loads(manifest.read_text(encoding="utf-8"))
    except Exception:
        return []
    items = data if isinstance(data, list) else data.get("items", [])
    out = []
    for item in items:
        if not isinstance(item, dict):
            continue
        out.append(
            {
                "id": item.get("id"),
                "title": item.get("title") or item.get("name") or "Gameplay",
                "category": item.get("category", "gameplay"),
                "durationSec": item.get("durationSec"),
                "license": item.get("license", "royalty-free"),
                "source": item.get("source"),
                "thumbnail": item.get("thumbnail"),
                "mediaUrl": f"{settings.api_prefix}/vault/{item.get('id')}/media" if item.get("id") else None,
            }
        )
    return out


@router.get("")
def list_vault() -> dict:
    return {"items": _load_manifest()}


@router.get("/{asset_id}/media")
def vault_media(asset_id: str) -> FileResponse:
    settings = get_settings()
    manifest = settings.vault_dir / "manifest.json"
    if not manifest.exists():
        raise HTTPException(status_code=404, detail="Vault not configured")
    data = json.loads(manifest.read_text(encoding="utf-8"))
    items = data if isinstance(data, list) else data.get("items", [])
    match = next((i for i in items if str(i.get("id")) == asset_id), None)
    if not match:
        raise HTTPException(status_code=404, detail="Vault asset not found")
    rel = match.get("path") or match.get("file")
    if not rel:
        raise HTTPException(status_code=404, detail="Vault asset file missing")
    path = safe_join(settings.vault_dir, str(rel))
    if not path.exists():
        raise HTTPException(status_code=404, detail="Vault asset file missing")
    return FileResponse(path)