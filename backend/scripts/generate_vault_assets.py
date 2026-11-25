"""Convenience wrapper for the CC0 gameplay vault generator.

Run from the repository root::

    cd backend
    python scripts/generate_vault_assets.py --force
"""

from __future__ import annotations

import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_ROOT))

from app.vault_assets import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())
