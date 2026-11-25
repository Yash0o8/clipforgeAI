"""Gameplay vault API.

Serves a manifest of royalty-free/loopable background clips. Assets are managed
on disk under the configured vault directory; this endpoint only exposes
metadata and a media stream path. Entries whose file is missing or outside the
vault directory are hidden so the UI never offers a dead tile.
"""

from __future__ import annotations

import json
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from ..config import get_settings
from ..storage import StorageError, safe_join, vault_asset_path

router = APIRouter(prefix="/vault", tags=["vault"])

_MEDIA_TYPES = {
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
}


def _read_manifest() -> dict:
    settings = get_settings()
    manifest = settings.vault_dir / "manifest.json"
    if not manifest.exists():
        return {}
    try:
        data = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if isinstance(data, list):
        return {"items": data}
    return data if isinstance(data, dict) else {}


def _available_items() -> tuple[list[dict], int]:
    """Return playable metadata plus the count of unusable entries."""
    settings = get_settings()
    items = _read_manifest().get("items", [])
    available: list[dict] = []
    unavailable = 0

    for raw in items:
        if not isinstance(raw, dict):
            continue
        asset_id = raw.get("id")
        if not asset_id:
            continue
        rel = raw.get("path") or raw.get("file")
        path: Path | None = None
        if rel:
            try:
                candidate = safe_join(settings.vault_dir, str(rel))
            except StorageError:
                candidate = None
            if candidate is not None and candidate.is_file():
                path = candidate
        if path is None:
            unavailable += 1
            continue

        tags = raw.get("tags", [])
        available.append(
            {
                "id": str(asset_id),
                "title": raw.get("title") or raw.get("name") or str(asset_id),
                "category": raw.get("category", "gameplay"),
                "durationSec": raw.get("durationSec"),
                "license": raw.get("license", "see source"),
                "source": raw.get("source"),
                "tags": [str(tag) for tag in tags if isinstance(tag, (str, int, float))] if isinstance(tags, list) else [],
                "thumbnail": raw.get("thumbnail"),
                "mediaUrl": f"{settings.api_prefix}/vault/{quote(str(asset_id), safe='')}/media",
            }
        )
    return available, unavailable


@router.get("")
def list_vault() -> dict:
    """List only assets that can actually be previewed and rendered."""
    items, unavailable = _available_items()
    categories = sorted({str(item["category"]) for item in items if item.get("category")})
    return {
        "items": items,
        "count": len(items),
        "unavailable": unavailable,
        "categories": categories,
    }


@router.get("/{asset_id}/media")
def vault_media(asset_id: str) -> FileResponse:
    """Stream a vault file by id.

    ``vault_asset_path`` re-checks the manifest and refuses traversal attempts,
    so a stale or malicious manifest entry cannot expose files outside the vault.
    """
    settings = get_settings()
    path = vault_asset_path(asset_id, settings)
    if path is None or not path.is_file():
        raise HTTPException(status_code=404, detail="Vault asset not found")
    return FileResponse(path, media_type=_MEDIA_TYPES.get(path.suffix.lower()))
