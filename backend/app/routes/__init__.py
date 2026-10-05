"""HTTP routers.

Note that ``media`` is *not* in here. Its routes live at the app root, outside
the ``/api/v1`` prefix, because they are consumed as plain ``src`` values by a
``<video>`` element rather than through the JSON client.
"""

from __future__ import annotations

from fastapi import APIRouter

from .clips import router as clips_router
from .exports import router as exports_router
from .projects import router as projects_router
from .uploads import router as uploads_router

api_router = APIRouter()
api_router.include_router(uploads_router)
api_router.include_router(projects_router)
api_router.include_router(clips_router)
api_router.include_router(exports_router)

__all__ = ["api_router"]