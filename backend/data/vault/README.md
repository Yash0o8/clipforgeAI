# Gameplay Vault

This folder backs the split-screen gameplay vault (`/api/v1/vault`).

## What to put here
- Royalty-free / loopable background clips you have rights to use.
- Add files to this folder and register them in `manifest.json`.

## Manifest format
Each item:
- `id`: stable string used by API/UI
- `title`: display name
- `category`: gta | minecraft | asmr | subway | other
- `durationSec`: number (optional)
- `license`: license note
- `source`: source/attribution
- `path`: filename relative to this vault directory

## Note
Do not commit copyrighted gameplay footage. The repo `.gitignore` ignores media files; keep only manifest/docs.