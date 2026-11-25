"""Gameplay vault API tests.

The vault is a discovery surface, so it must never advertise a tile that cannot
actually stream, and it must never let a manifest entry escape its directory.
"""

from __future__ import annotations

import json


def _configure_vault(monkeypatch, tmp_path, items: list[dict]) -> None:
    from app.config import get_settings

    settings = get_settings()
    monkeypatch.setattr(settings, "gameplay_vault_dir", tmp_path)
    (tmp_path / "manifest.json").write_text(
        json.dumps({"version": 2, "items": items}),
        encoding="utf-8",
    )


def test_vault_lists_only_playable_assets(client, monkeypatch, tmp_path):
    """A broken manifest entry is hidden instead of becoming a dead UI tile."""
    (tmp_path / "ramp.mp4").write_bytes(b"fake-mp4")
    _configure_vault(
        monkeypatch,
        tmp_path,
        [
            {
                "id": "ramp",
                "title": "CC0 Ramp Loop",
                "category": "racing",
                "durationSec": 10,
                "license": "CC0-1.0",
                "source": "ClipForge generator",
                "path": "ramp.mp4",
                "tags": ["loop", "racing"],
            },
            {"id": "gone", "title": "Missing", "path": "missing.mp4"},
        ],
    )

    response = client.get("/api/v1/vault")
    assert response.status_code == 200
    payload = response.json()

    assert [item["id"] for item in payload["items"]] == ["ramp"]
    assert payload["count"] == 1
    assert payload["unavailable"] == 1
    assert payload["categories"] == ["racing"]
    assert payload["items"][0]["mediaUrl"] == "/api/v1/vault/ramp/media"
    assert payload["items"][0]["license"] == "CC0-1.0"
    assert payload["items"][0]["tags"] == ["loop", "racing"]


def test_vault_media_streams_the_registered_file(client, monkeypatch, tmp_path):
    """The preview `<video>` consumer has no token, so media must be public."""
    (tmp_path / "loop.mp4").write_bytes(b"fake-mp4")
    _configure_vault(
        monkeypatch,
        tmp_path,
        [{"id": "loop", "title": "Loop", "path": "loop.mp4"}],
    )

    response = client.get("/api/v1/vault/loop/media")
    assert response.status_code == 200
    assert response.content == b"fake-mp4"
    assert response.headers["content-type"].startswith("video/mp4")


def test_generator_creates_a_playable_cc0_asset(tmp_path, ffmpeg_path):
    """The bundled vault recipe must actually produce a renderable file."""
    from app.vault_assets import DEFINITIONS, generate_vault_assets

    definition = dict(DEFINITIONS[0], durationSec=1)
    items = generate_vault_assets(
        tmp_path,
        force=True,
        definitions=[definition],
        timeout_sec=20,
    )

    assert len(items) == 1
    assert items[0]["id"] == definition["id"]
    assert "CC0" in items[0]["license"]
    assert "third-party" in items[0]["source"]
    asset = tmp_path / items[0]["path"]
    assert asset.is_file()
    assert asset.stat().st_size > 1024
    assert json.loads((tmp_path / "manifest.json").read_text(encoding="utf-8"))["items"] == items


def test_vault_media_rejects_manifest_path_traversal(client, monkeypatch, tmp_path):
    """A tampered manifest must not expose a file outside the vault root."""
    secret = tmp_path.parent / f"vault-secret-{tmp_path.name}.mp4"
    secret.write_bytes(b"secret")
    _configure_vault(
        monkeypatch,
        tmp_path,
        [{"id": "escape", "title": "Escape", "path": f"../{secret.name}"}],
    )

    listed = client.get("/api/v1/vault").json()
    assert listed["count"] == 0
    assert listed["unavailable"] == 1

    response = client.get("/api/v1/vault/escape/media")
    assert response.status_code == 404
    secret.unlink(missing_ok=True)
