"""Shared pytest fixtures.

Isolates every test from the real ``DATA_DIR`` and ``DATABASE_URL`` by pointing
them at a temp directory *before* any app module reads settings. That ordering
matters: ``get_settings`` is cached with ``lru_cache``, so the override has to
land before the first import that calls it.
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import pytest

BACKEND_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_ROOT))

# Point the app at a throwaway data dir before anything imports settings.
_TMP_ROOT = BACKEND_ROOT / ".pytest-data"


@pytest.fixture(scope="session", autouse=True)
def isolated_env(tmp_path_factory):
    """Redirect DATA_DIR to a temp directory for the whole session."""
    root = tmp_path_factory.mktemp("clipforge")
    os.environ["DATA_DIR"] = str(root)
    os.environ["ANTHROPIC_API_KEY"] = ""
    os.environ["OPENAI_API_KEY"] = ""
    # Keep model loading out of unit tests; transcribe() is exercised separately.
    os.environ["WHISPER_MODEL"] = "tiny"
    yield root


@pytest.fixture(scope="session")
def app_module(isolated_env):
    """Import ``app.main`` once, after the env override is in place."""
    from app import main

    return main


@pytest.fixture(scope="session")
def client(app_module):
    """A TestClient with lifespan run, so startup recovery has executed."""
    from fastapi.testclient import TestClient

    with TestClient(app_module.app) as test_client:
        yield test_client


@pytest.fixture()
def db_session():
    """A fresh session with all tables truncated between tests."""
    from app.db import Base, init_engine, new_session
    from sqlalchemy import text

    init_engine()
    session = new_session()
    # Order matters: children before parents, or FK constraints complain.
    for table in ("exports", "clips", "jobs", "projects"):
        session.execute(text(f"DELETE FROM {table}"))
    session.commit()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture(autouse=True)
def reset_upload_sessions():
    """Clear in-memory upload sessions between tests."""
    from app.routes import upload_store

    upload_store.reset_sessions()
    yield
    upload_store.reset_sessions()


@pytest.fixture()
def ffmpeg_path():
    """Skip a test when ffmpeg is unavailable, rather than failing obscurely."""
    from app.storage import ffmpeg_available

    if not ffmpeg_available():
        pytest.skip("ffmpeg is not available on PATH")
    return True


@pytest.fixture()
def sample_video(tmp_path, ffmpeg_path):
    """Generate a real 6-second test video with a spoken-ish tone and a subtitle
    track, so rendering, probing and range requests can all be exercised."""
    from app.config import get_settings
    from app.storage import run_ffmpeg

    settings = get_settings()
    output = tmp_path / "sample.mp4"

    # `testsrc2` gives real moving video; `sine` gives a real audio track. No
    # speech, so this exercises everything except transcription accuracy.
    run_ffmpeg(
        [
            "-y",
            "-f", "lavfi",
            "-i", "testsrc2=size=640x360:rate=24:duration=6",
            "-f", "lavfi",
            "-i", "sine=frequency=440:duration=6",
            "-c:v", "libx264",
            "-preset", "ultrafast",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac",
            "-shortest",
            str(output),
        ]
    )

    assert output.exists() and output.stat().st_size > 0
    return output


@pytest.fixture()
def sample_audio(tmp_path, ffmpeg_path):
    """A 6-second 16 kHz mono WAV, the format Whisper wants."""
    from app.storage import run_ffmpeg

    output = tmp_path / "sample.wav"
    run_ffmpeg(
        [
            "-y",
            "-f", "lavfi",
            "-i", "sine=frequency=440:duration=6",
            "-ac", "1",
            "-ar", "16000",
            str(output),
        ]
    )
    return output


# --- Shared API fixtures ----------------------------------------------------
#
# These live in conftest because several test modules need the same uploaded
# project, and a fixture defined inside a test module is invisible to the others.

API = "/api/v1"


def wait_for(client, path, predicate, timeout=90.0, interval=0.25):
    """Poll ``path`` until ``predicate(payload)`` is true. Returns the payload."""
    deadline = time.time() + timeout
    payload = None
    while time.time() < deadline:
        response = client.get(path)
        assert response.status_code == 200, response.text
        payload = response.json()
        if predicate(payload):
            return payload
        time.sleep(interval)
    pytest.fail(f"condition not met within {timeout}s; last payload: {payload}")


def push_file(client, path, file_name=None, mime_type="video/mp4"):
    """Push a real file through the multipart upload API.

    Mirrors what ``uploadService.uploadVideo`` does, including the per-part PUT
    loop, so the contract is exercised exactly as the browser will use it.
    """
    data = path.read_bytes()
    file_name = file_name or path.name

    response = client.post(
        f"{API}/uploads",
        json={"fileName": file_name, "fileSize": len(data), "mimeType": mime_type},
    )
    assert response.status_code == 201, response.text
    session = response.json()

    # Read the chunk size from the session rather than assuming the client's
    # default, so a server-side change does not silently break the test.
    for part in session["parts"]:
        start = (part["partNumber"] - 1) * session["chunkSize"]
        blob = data[start : min(start + session["chunkSize"], len(data))]
        put = client.put(
            part["url"], content=blob, headers={"Content-Type": "application/octet-stream"}
        )
        assert put.status_code == 200, f"part {part['partNumber']}: {put.text}"

    done = client.post(f"{API}/uploads/{session['uploadId']}/complete")
    assert done.status_code == 200, done.text

    polled = client.get(f"{API}/uploads/{session['uploadId']}")
    assert polled.status_code == 200
    return polled.json()


@pytest.fixture()
def uploaded(client, sample_video):
    """A completed upload session for a real 6-second test video."""
    return push_file(client, sample_video)


@pytest.fixture()
def project(client, uploaded):
    """A project created from that upload, probed and ready."""
    response = client.post(
        f"{API}/projects",
        json={"title": "Test interview", "durationSec": 0, "uploadId": uploaded["uploadId"]},
    )
    assert response.status_code == 201, response.text
    return response.json()


@pytest.fixture()
def clip_rows(client, project):
    """Two clips created directly, since detection needs real speech."""
    created = []
    for index, (start, end) in enumerate(((0.5, 8.0), (1.0, 9.0))):
        response = client.post(
            f"{API}/clips",
            json={
                "projectId": project["id"],
                "title": f"Clip {index + 1}",
                "startSec": start,
                "endSec": end,
            },
        )
        assert response.status_code == 201, response.text
        created.append(response.json())
    return created


@pytest.fixture()
def ready_project(client, project):
    """A project in the ``ready`` state, which exports require."""
    client.post(f"{API}/projects/{project['id']}/process")  # sets processing
    response = client.patch(f"{API}/projects/{project['id']}", json={"status": "ready"})
    assert response.json()["status"] == "ready"
    return response.json()