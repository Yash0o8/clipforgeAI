"""Regression tests for defects found while wiring the API together.

Each test here corresponds to a bug that shipped far enough to break a user
flow. They are grouped together because they read as a list of "things that used
to be wrong" rather than a description of any one subsystem.
"""

from __future__ import annotations

import subprocess
import time
from types import SimpleNamespace

import pytest

from app import storage
from app.pipeline.captions import build_style, resolve_position
from app.pipeline.subtitles import CaptionCue, WordCue, build_ass


def _cue(text="hello"):
    return CaptionCue(
        start=0.0,
        end=1.0,
        text=text,
        words=[WordCue(start=0.0, end=1.0, text=text)],
    )


@pytest.fixture()
def ffmpeg(monkeypatch):
    """Point ``storage`` at the real ffmpeg with a configurable timeout.

    ``storage.get_settings`` is replaced rather than mutated: Settings is a
    pydantic model, and setting a class attribute on one of those does not
    reliably affect instances.
    """
    real = storage.get_settings()

    class Overridable(SimpleNamespace):
        def __init__(self, timeout):
            super().__init__(
                resolved_ffmpeg=real.resolved_ffmpeg,
                resolved_ffprobe=real.resolved_ffprobe,
                ffmpeg_timeout_sec=timeout,
                data_dir=real.data_dir,
            )

    holder = Overridable(timeout=real.ffmpeg_timeout_sec)
    monkeypatch.setattr(storage, "get_settings", lambda: holder)
    return holder


# --- storage.probe: rotation swaps BOTH dimensions --------------------------


def _stream(**overrides):
    base = {"codec_type": "video", "width": 1920, "height": 1080}
    base.update(overrides)
    return base


def test_rotation_swaps_both_dimensions():
    """A phone video is coded landscape with a 90-degree flag; it displays portrait.

    Swapping only the width produced 1080x1080, which is neither the coded nor
    the displayed shape, and it silently corrupted the aspect-ratio options.
    """
    assert storage._display_size(_stream(side_data_list=[{"rotation": -90}])) == (1080, 1920)


def test_rotation_270_also_transposes():
    assert storage._display_size(_stream(side_data_list=[{"rotation": 270}])) == (1080, 1920)


def test_rotation_of_zero_keeps_the_coded_size():
    assert storage._display_size(_stream(side_data_list=[{"rotation": 0}])) == (1920, 1080)


def test_rotation_of_180_does_not_transpose():
    """180 degrees flips the image in place; the dimensions are unchanged."""
    assert storage._display_size(_stream(side_data_list=[{"rotation": 180}])) == (1920, 1080)


def test_rotation_from_tags_is_honoured():
    """Older files record rotation as a metadata tag rather than side data."""
    assert storage._display_size(_stream(tags={"rotate": "90"})) == (1080, 1920)


def test_unparseable_rotation_falls_back_to_the_coded_size():
    assert storage._display_size(_stream(side_data_list=[{"rotation": "nope"}])) == (1920, 1080)


def test_display_size_of_no_stream():
    assert storage._display_size(None) == (None, None)


def test_portrait_source_probes_as_portrait(sample_video):
    """End-to-end: the fixture is a real 640x360 file and must read back as such."""
    info = storage.probe(sample_video)

    assert (info.width, info.height) == (640, 360)
    assert info.has_video is True
    assert info.has_audio is True
    assert info.duration_sec == pytest.approx(6.0, abs=0.5)


# --- ffmpeg error reporting -------------------------------------------------


def test_ffmpeg_failure_reports_stderr(tmp_path, ffmpeg):
    """A failing ffmpeg used to raise ``ffmpeg failed (1): `` with no reason.

    The stderr pipe was closed in a ``finally`` before being read, so the one
    message that matters was always empty and failures were undiagnosable.
    """
    with pytest.raises(RuntimeError) as caught:
        storage.run_ffmpeg(["-i", str(tmp_path / "missing.mp4"), "-f", "null", "-"])

    message = str(caught.value)
    assert message.startswith("ffmpeg failed")
    assert len(message) > len("ffmpeg failed (1): "), f"stderr was not captured: {message!r}"


def test_ffmpeg_timeout_is_reported(ffmpeg):
    """A filter slow enough that ffmpeg emits no progress at all.

    The watchdog has to stop it on a wall clock. Reading stdout for a deadline
    check cannot work here, because the read simply blocks: that is exactly why
    this test uses an input that produces no output for minutes.
    """
    ffmpeg.ffmpeg_timeout_sec = 2

    command = [
        "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=60",
        "-vf", "geq=random(1)*255:128:128",
        "-f", "null", "-",
    ]

    started = time.monotonic()
    with pytest.raises(RuntimeError, match="timed out"):
        storage.run_ffmpeg(command)
    elapsed = time.monotonic() - started

    assert elapsed < 30, f"the watchdog took {elapsed:.1f}s to fire"


def test_ffmpeg_cancel_stops_the_process(ffmpeg):
    command = [
        "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=60",
        "-f", "null", "-",
    ]

    started = time.monotonic()
    with pytest.raises(RuntimeError, match="cancelled"):
        storage.run_ffmpeg(command, cancel=lambda: True)
    elapsed = time.monotonic() - started

    assert elapsed < 30, f"cancellation took {elapsed:.1f}s to take effect"


def test_ffmpeg_cancel_is_honoured_while_ffmpeg_is_silent(ffmpeg):
    """Cancel must not depend on ffmpeg emitting another progress line.

    With a stalled filter there is no next line, so a read-loop-driven cancel
    would leave the render running.
    """
    command = [
        "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=60",
        "-vf", "geq=random(1)*255:128:128",
        "-f", "null", "-",
    ]

    started = time.monotonic()
    with pytest.raises(RuntimeError, match="cancelled"):
        storage.run_ffmpeg(command, cancel=lambda: True)
    elapsed = time.monotonic() - started

    assert elapsed < 30, f"cancellation took {elapsed:.1f}s to take effect"


def test_a_slow_but_healthy_render_is_not_killed(ffmpeg):
    """The watchdog must not fire on a render that is merely working hard."""
    command = [
        "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=4",
        "-c:v", "libx264", "-preset", "veryslow",
        "-f", "null", "-",
    ]

    assert storage.run_ffmpeg(command) == 0


def test_ffmpeg_progress_reaches_the_callback(ffmpeg):
    """``-progress pipe:1`` parsing: the Exports page renders this number."""
    seen: list[float] = []

    storage.run_ffmpeg(
        ["-f", "lavfi", "-i", "testsrc2=size=64x64:rate=10:duration=1", "-f", "null", "-"],
        progress=seen.append,
    )

    assert seen, "no out_time_us values were reported"


# --- job identity -----------------------------------------------------------


def test_submit_accepts_a_caller_supplied_job_id():
    """The pipeline persists a Job row, then finds it via ``context.job_id``.

    When the queue invented its own ID the lookup missed and every progress
    update and error was silently dropped.
    """
    from app.jobs import JobQueue

    queue = JobQueue(max_workers=1)
    try:
        queue.submit("process", "prj_x", lambda ctx: None, job_id="job_persisted")

        record = queue.get("job_persisted")
        assert record is not None
        assert record.project_id == "prj_x"
        assert record.id == "job_persisted"
    finally:
        queue.shutdown()


def test_submit_still_generates_an_id_by_default():
    from app.jobs import JobQueue

    queue = JobQueue(max_workers=1)
    try:
        record = queue.submit("process", "prj_x", lambda ctx: None)

        assert record.id.startswith("job_")
    finally:
        queue.shutdown()


def test_cancel_targets_a_single_job():
    """Cancelling one export must not kill the project's other renders.

    Previously the only lever was ``cancel_for_project``, so cancelling a single
    export tore down every render for that project.
    """
    from app.jobs import JobQueue

    queue = JobQueue(max_workers=1)
    try:
        queue.submit("export", "prj_x", lambda ctx: None, job_id="exp_one")
        queue.submit("export", "prj_x", lambda ctx: None, job_id="exp_two")

        assert queue.cancel("exp_one") is True

        assert queue.get("exp_one")._cancel.is_set() is True
        assert queue.get("exp_two")._cancel.is_set() is False
    finally:
        queue.shutdown()


def test_cancel_of_an_unknown_job_is_false():
    from app.jobs import JobQueue

    queue = JobQueue(max_workers=1)
    try:
        assert queue.cancel("job_missing") is False
    finally:
        queue.shutdown()


def test_a_failed_job_records_its_error():
    """The failure has to reach the record; swallowing it silently strands the UI."""

    def boom(ctx):
        raise ValueError("kaboom")

    from app.jobs import JobQueue

    queue = JobQueue(max_workers=1)
    try:
        record = queue.submit("process", "prj_x", boom, job_id="job_boom")
        record.future.result(timeout=10)

        assert record.status == "failed"
        assert "kaboom" in record.error
    finally:
        queue.shutdown()


# --- caption position override ---------------------------------------------


def test_position_override_changes_alignment():
    assert build_style("clean", None, "1080x1920", 1080, 1920).alignment == 2
    assert build_style("clean", "top", "1080x1920", 1080, 1920).alignment == 8
    assert build_style("clean", "center", "1080x1920", 1080, 1920).alignment == 5


def test_null_position_inherits_the_preset_anchor():
    """``position: null`` means "use the preset's own", which is centre for bold."""
    assert resolve_position("clean", None) == "lower"
    assert resolve_position("bold", None) == "center"
    assert resolve_position("creator", None) == "center"


def test_an_unknown_position_falls_back_to_lower():
    assert resolve_position("clean", "sideways") == "lower"


def _style_line(ass: str) -> str:
    """The ``Style:`` line, which is where ASS stores alignment.

    Alignment is not repeated on each Dialogue line, so asserting on the events
    section finds nothing.
    """
    for line in ass.splitlines():
        if line.startswith("Style:"):
            return line
    raise AssertionError("no Style: line in the generated ASS")


def test_build_ass_applies_a_position_override():
    """The export path took a per-render position but never passed it through,
    so the exported file ignored the placement shown in the preview."""
    lower = _style_line(build_ass([_cue()], 1080, 1920, "clean", None))
    top = _style_line(build_ass([_cue()], 1080, 1920, "clean", "top"))

    # ASS alignment: 2 = bottom-centre, 5 = middle-centre, 8 = top-centre.
    assert lower.rstrip().endswith(",2,90,90,220,1"), lower
    assert top.rstrip().endswith(",8,90,90,220,1"), top
    assert lower != top


def test_build_ass_defaults_to_the_presets_own_anchor():
    assert build_ass([_cue()], 1080, 1920, "clean", None) == build_ass(
        [_cue()], 1080, 1920, "clean", "lower"
    )
    # "bold" is a centred preset, so null position must mean centre, not lower.
    # Style fields: ... Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
    assert _style_line(build_ass([_cue()], 1080, 1920, "bold", None)).endswith(
        ",3.0,3.0,5,70,70,0,1"
    )


# --- project serialisation --------------------------------------------------


def test_project_without_media_reports_no_object_url(db_session):
    """A project with no upload must not hand the UI a media URL to fail on."""
    from app.db import Project

    project = Project(id="prj_bare", title="Bare", status="draft")
    db_session.add(project)
    db_session.commit()

    payload = project.to_dict()

    assert payload["objectUrl"] is None
    assert payload["hasLocalSource"] is False


def test_project_with_media_reports_an_object_url(db_session):
    from app.db import Project

    project = Project(
        id="prj_ready", title="Ready", status="draft", asset_path="uploads/x.mp4"
    )
    db_session.add(project)
    db_session.commit()

    payload = project.to_dict()

    assert payload["objectUrl"] == "/media/prj_ready"
    assert payload["hasLocalSource"] is True


# --- project creation -------------------------------------------------------


def test_create_project_inherits_the_uploaded_file_name(client, sample_video):
    """The frontend sends only ``title`` and ``uploadId``.

    Without inheriting from the session, ``fileName`` and ``fileSize`` were null
    and the project list showed a nameless entry.
    """
    data = sample_video.read_bytes()
    session = client.post(
        "/api/v1/uploads",
        json={"fileName": "interview.mp4", "fileSize": len(data), "mimeType": "video/mp4"},
    ).json()
    for part in session["parts"]:
        start = (part["partNumber"] - 1) * session["chunkSize"]
        client.put(part["url"], content=data[start : start + session["chunkSize"]])
    client.post(f"/api/v1/uploads/{session['uploadId']}/complete")

    response = client.post(
        "/api/v1/projects", json={"title": "Inherited", "uploadId": session["uploadId"]}
    )

    assert response.status_code == 201
    body = response.json()
    assert body["fileName"] == "interview.mp4"
    assert body["fileSize"] == len(data)
    assert body["durationSec"] > 0
    assert body["objectUrl"] is not None


def test_create_project_rejects_an_unfinished_upload(client, sample_video):
    session = client.post(
        "/api/v1/uploads",
        json={
            "fileName": "v.mp4",
            "fileSize": sample_video.stat().st_size,
            "mimeType": "video/mp4",
        },
    ).json()

    response = client.post(
        "/api/v1/projects", json={"title": "Eager", "uploadId": session["uploadId"]}
    )

    assert response.status_code == 409


def test_create_project_rejects_an_unknown_upload(client):
    response = client.post("/api/v1/projects", json={"title": "Ghost", "uploadId": "upl_ghost"})

    assert response.status_code == 404


# --- upload part streaming --------------------------------------------------


def test_a_part_written_after_completion_is_refused(client, sample_video):
    """Late parts must not corrupt an already-assembled file."""
    data = sample_video.read_bytes()
    session = client.post(
        "/api/v1/uploads",
        json={"fileName": "v.mp4", "fileSize": len(data), "mimeType": "video/mp4"},
    ).json()
    for part in session["parts"]:
        start = (part["partNumber"] - 1) * session["chunkSize"]
        client.put(part["url"], content=data[start : start + session["chunkSize"]])
    client.post(f"/api/v1/uploads/{session['uploadId']}/complete")

    response = client.put(session["parts"][0]["url"], content=data[:16])

    assert response.status_code == 400


def test_part_number_out_of_range_is_refused(client, sample_video):
    data = sample_video.read_bytes()
    session = client.post(
        "/api/v1/uploads",
        json={"fileName": "v.mp4", "fileSize": len(data), "mimeType": "video/mp4"},
    ).json()

    response = client.put(f"/api/v1/uploads/{session['uploadId']}/parts/999", content=data[:16])

    assert response.status_code == 400


def test_upload_part_to_an_unknown_session_is_404(client):
    assert client.put("/api/v1/uploads/upl_ghost/parts/1", content=b"abc").status_code == 404


def test_a_multi_part_upload_reassembles_byte_for_byte(client, sample_video):
    """Force several parts by asking for a tiny chunk size.

    The browser sends 8 MB parts, so a single-part test would never exercise the
    concatenation loop that most often corrupts a file.
    """
    from app.routes import upload_store

    data = sample_video.read_bytes()
    original = upload_store.DEFAULT_CHUNK_SIZE
    upload_store.DEFAULT_CHUNK_SIZE = 64 * 1024
    try:
        session = client.post(
            "/api/v1/uploads",
            json={"fileName": "split.mp4", "fileSize": len(data), "mimeType": "video/mp4"},
        ).json()
        assert session["totalParts"] > 2

        for part in session["parts"]:
            start = (part["partNumber"] - 1) * session["chunkSize"]
            client.put(part["url"], content=data[start : start + session["chunkSize"]])

        client.post(f"/api/v1/uploads/{session['uploadId']}/complete")
        asset = client.get(f"/api/v1/uploads/{session['uploadId']}").json()["asset"]
    finally:
        upload_store.DEFAULT_CHUNK_SIZE = original

    from app.config import get_settings

    assembled = (get_settings().data_dir / asset["path"]).read_bytes()

    assert len(assembled) == len(data)
    assert assembled == data, "the reassembled file differs from what was uploaded"


# --- download tokens --------------------------------------------------------


def test_file_download_without_a_token_is_forbidden(client, ready_project, clip_rows):
    """A missing token is a bad link, not a malformed request.

    FastAPI's default for a required query parameter is 422, which tells the user
    nothing about an expired download link.
    """
    queued = client.post(f"/api/v1/clips/{clip_rows[0]['id']}/export", json={}).json()

    assert client.get(f"/api/v1/exports/{queued['jobId']}/file").status_code == 403


def test_cancelling_one_export_leaves_another_alone(client, ready_project, clip_rows, ffmpeg_path):
    """The regression that motivated queue job_id: cancel was project-wide."""
    first = client.post(f"/api/v1/clips/{clip_rows[0]['id']}/export", json={}).json()
    second = client.post(f"/api/v1/clips/{clip_rows[1]['id']}/export", json={}).json()

    response = client.post(f"/api/v1/exports/{first['jobId']}/cancel")

    assert response.status_code == 200
    assert response.json()["status"] == "cancelled"

    other = client.get(f"/api/v1/exports/{second['jobId']}").json()
    assert other["status"] != "cancelled"