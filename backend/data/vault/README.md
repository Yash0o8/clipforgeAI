# Gameplay Vault

This folder backs the split-screen gameplay vault (`/api/v1/vault`). The API
only lists entries whose file actually exists, so the editor never shows a dead
tile.

## Bundled CC0 loops

ClipForge can generate 20 short, loopable **abstract** backgrounds with FFmpeg.
They are procedurally created by this repository, licensed CC0-1.0, and contain
**no third-party or copyrighted gameplay footage**.

From `backend/`:

```bash
python scripts/generate_vault_assets.py
# or regenerate every file:
python scripts/generate_vault_assets.py --force
```

The generator writes `manifest.json` and the `.mp4` files here. Media files are
ignored by git, so a clone starts with the recipe and manifest only; run the
command once on a new machine.

## Bringing your own licensed footage

You may replace any generated file with a clip you have the rights to use, or
add a new entry to `manifest.json`. Entries not produced by the generator are
preserved when it runs again.

Manifest fields:

- `id`: stable string used by API/UI
- `title`: display name
- `category`: e.g. racing | parkour | satisfying | asmr | abstract
- `durationSec`: number (optional)
- `license`: licence note shown in the editor
- `source`: source/attribution shown in the editor
- `path`: filename relative to this vault directory
- `tags`: optional keywords for search/filtering

## Rule

Do not commit copyrighted gameplay footage. The repo ignores media files; keep
only manifests, recipes and documentation under version control.
