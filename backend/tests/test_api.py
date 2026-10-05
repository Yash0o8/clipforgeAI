"""API contract tests.

Two jobs here:

1. **The wire shape must match what the frontend reads.** Field names are
   asserted explicitly, not with loose subset checks, because a rename like
   ``durationSec`` -> ``duration_sec`` breaks the UI silently — the build
   succeeds and the page renders blanks.

2. **The flows must actually work end to end.** Upload real bytes, assemble them,
   probe the result, cut a real clip, render a real MP4, download it. Mocks would
   miss every bug these catch.
"""

from __future__ import annotations

import pytest

from conftest import wait_for

# Upload/project/clip/ready-project fixtures and ``push_file`` live in conftest so
# the regression module can share them.

API = "/api/v1"


# --- Meta -------------------------------------------------------------------


def test_health(client):
    payload = client.get(f"{API}/health").json()

    assert payload["status"] == "ok"
    assert payload["ffmpeg"] is True
    assert "whisperModel" in payload


def test_meta_matches_the_frontend_vocabulary(client):
    """The frontend's constants.js mirrors this; a divergence should be visible."""
    payload = client.get(f"{API}/meta").json()

    assert [s["key"] for s in payload["stages"]] == [
        "upload",
        "audio",
        "transcript",
        "highlights",
        "prepare",
    ]
    assert payload["clipStatus"] == ["suggested", "selected", "edited", "exported"]
    assert payload["exportStatus"] == ["queued", "rendering", "complete", "pending_backend", "failed"]
    assert payload["aspectRatios"][0]["id"] == "9:16"
    assert payload["clipLimits"] == {"minDuration": 5, "maxDuration": 90, "defaultDuration": 38}


def test_stage_weights_sum_to_one_hundred(client):
    stages = client.get(f"{API}/meta").json()["stages"]

    assert sum(stage["weight"] for stage in stages) == 100


# --- Uploads ----------------------------------------------------------------


def test_upload_session_returns_part_urls(client, sample_video):
    data = sample_video.read_bytes()

    response = client.post(
        f"{API}/uploads",
        json={"fileName": "v.mp4", "fileSize": len(data), "mimeType": "video/mp4"},
    )

    assert response.status_code == 201
    session = response.json()
    assert session["uploadId"].startswith("upl_")
    assert session["totalParts"] >= 1
    # Part URLs must carry the API prefix so the frontend can use them verbatim.
    assert session["parts"][0]["url"].startswith(f"{API}/uploads/")


def test_upload_rejects_an_oversized_file(client):
    settings_max = 2048 * 1024 * 1024

    response = client.post(
        f"{API}/uploads",
        json={"fileName": "huge.mp4", "fileSize": settings_max + 1, "mimeType": "video/mp4"},
    )

    assert response.status_code == 400
    assert "limit" in response.json()["detail"].lower()


def test_upload_rejects_zero_bytes(client):
    response = client.post(f"{API}/uploads", json={"fileName": "empty.mp4", "fileSize": 0})

    assert response.status_code == 422


def test_complete_without_every_part_is_rejected(client, sample_video):
    """A partial upload must not silently produce a truncated file."""
    data = sample_video.read_bytes()
    session = client.post(
        f"{API}/uploads",
        json={"fileName": "v.mp4", "fileSize": len(data), "mimeType": "video/mp4"},
    ).json()

    # Skip every part.
    response = client.post(f"{API}/uploads/{session['uploadId']}/complete")

    assert response.status_code == 400
    assert "incomplete" in response.json()["detail"]


def test_size_mismatch_is_caught(client, sample_video):
    """Lying about fileSize must fail at upload, not mysteriously inside ffprobe."""
    data = sample_video.read_bytes()
    session = client.post(
        f"{API}/uploads",
        json={
            "fileName": "v.mp4",
            "fileSize": len(data) + 5000,
            "mimeType": "video/mp4",
        },
    ).json()

    for part in session["parts"]:
        start = (part["partNumber"] - 1) * session["chunkSize"]
        client.put(part["url"], content=data[start : start + session["chunkSize"]])

    response = client.post(f"{API}/uploads/{session['uploadId']}/complete")

    assert response.status_code == 400
    assert "mismatch" in response.json()["detail"]


def test_completed_session_reports_the_asset(client, uploaded):
    assert uploaded["status"] == "complete"
    assert uploaded["asset"]["path"].startswith("uploads/")
    assert uploaded["asset"]["fileSize"] > 0
    assert uploaded["missingParts"] == []


def test_abort_clears_the_session(client, sample_video):
    from app.routes import upload_store

    session = client.post(
        f"{API}/uploads",
        json={"fileName": "v.mp4", "fileSize": 100, "mimeType": "video/mp4"},
    ).json()

    response = client.post(f"{API}/uploads/{session['uploadId']}/abort")

    assert response.status_code == 200
    assert upload_store.get_session(session["uploadId"]) is None


def test_aborting_an_unknown_session_is_not_an_error(client):
    """The client wanted it gone, and it is."""
    assert client.post(f"{API}/uploads/upl_missing/abort").status_code == 200


# --- Projects ---------------------------------------------------------------


def test_created_project_has_the_frontend_shape(project):
    """Exact field names: ClipEditor and useClips read these by name."""
    expected = {
        "id",
        "title",
        "source",
        "fileName",
        "fileSize",
        "mimeType",
        "durationSec",
        "width",
        "height",
        "status",
        "progress",
        "currentStage",
        "stages",
        "error",
        "wordCount",
        "createdAt",
        "updatedAt",
        "objectUrl",
        "hasLocalSource",
    }
    assert set(project) == expected


def test_project_is_probed_not_trusted(project):
    """durationSec came from ffprobe, so the editor's trim bounds are real."""
    assert project["durationSec"] == pytest.approx(6.0, abs=0.5)
    assert project["width"] == 640
    assert project["height"] == 360
    assert project["objectUrl"].startswith("/media/")


def test_project_starts_with_a_complete_stepper(project):
    """The Processing page renders five steps; it must not receive an empty list."""
    keys = [stage["key"] for stage in project["stages"]]

    assert keys == ["upload", "audio", "transcript", "highlights", "prepare"]
    assert all(stage["progress"] == 0 for stage in project["stages"])


def test_list_projects_newest_first(client, project):
    payload = client.get(f"{API}/projects").json()

    assert isinstance(payload, list)
    assert any(item["id"] == project["id"] for item in payload)


def test_list_projects_filters_by_status(client, project):
    """Filtering is what the sidebar uses to bucket projects by state."""
    client.patch(f"{API}/projects/{project['id']}", json={"status": "processing"})
    client.post(f"{API}/projects/{project['id']}/cancel")

    draft = client.get(f"{API}/projects?status=draft").json()
    cancelled = client.get(f"{API}/projects?status=cancelled").json()

    assert project["id"] not in [p["id"] for p in draft]
    assert project["id"] in [p["id"] for p in cancelled]


def test_cancelling_a_draft_leaves_it_a_draft(client, project):
    """Cancel means "stop the pipeline". There is nothing running on a draft, so
    it must not be relabelled as cancelled."""
    client.post(f"{API}/projects/{project['id']}/cancel")

    assert client.get(f"{API}/projects/{project['id']}").json()["status"] == "draft"


def test_patch_project_title(client, project):
    response = client.patch(f"{API}/projects/{project['id']}", json={"title": "Renamed"})

    assert response.status_code == 200
    assert response.json()["title"] == "Renamed"


def test_patch_rejects_an_unknown_field(client, project):
    """A typo'd key should be a 422, not a silently ignored setting."""
    response = client.patch(f"{API}/projects/{project['id']}", json={"titel": "typo"})

    assert response.status_code == 422


def test_missing_project_is_404(client):
    assert client.get(f"{API}/projects/prj_nope").status_code == 404


def test_project_without_upload_has_no_media(client):
    response = client.post(f"{API}/projects", json={"title": "No media", "durationSec": 10})

    assert response.status_code == 201
    assert response.json()["objectUrl"] is None or response.json()["hasLocalSource"] is False


def test_process_requires_media(client):
    project_id = client.post(f"{API}/projects", json={"title": "No media"}).json()["id"]

    response = client.post(f"{API}/projects/{project_id}/process")

    assert response.status_code == 422


def test_delete_removes_the_project_and_its_files(client, project):
    project_id = project["id"]

    assert client.delete(f"{API}/projects/{project_id}").status_code == 204
    assert client.get(f"{API}/projects/{project_id}").status_code == 404
    # The media route must now 410/404 too, not serve an orphan.
    assert client.get(f"/media/{project_id}").status_code in (404, 410)


# --- Media ------------------------------------------------------------------


def test_media_serves_the_file(client, project):
    response = client.get(f"/media/{project['id']}")

    assert response.status_code == 200
    assert response.headers["accept-ranges"] == "bytes"
    assert len(response.content) > 1000


def test_media_supports_range_requests(client, project):
    """Without 206 the browser can play the video but not seek, and seeking is
    the entire editor workflow."""
    full = client.get(f"/media/{project['id']}")
    size = len(full.content)

    partial = client.get(f"/media/{project['id']}", headers={"Range": "bytes=0-999"})

    assert partial.status_code == 206
    assert len(partial.content) == 1000
    assert partial.headers["content-range"] == f"bytes 0-999/{size}"


def test_media_suffix_range(client, project):
    """``bytes=-500`` means the last 500 bytes."""
    response = client.get(f"/media/{project['id']}", headers={"Range": "bytes=-500"})

    assert response.status_code == 206
    assert len(response.content) == 500


def test_media_rejects_an_impossible_range(client, project):
    response = client.get(f"/media/{project['id']}", headers={"Range": "bytes=99999999999-"})

    assert response.status_code == 416


def test_media_info_matches_the_probe(client, project):
    payload = client.get(f"/media/{project['id']}/info").json()

    assert payload["width"] == 640
    assert payload["hasAudio"] is True


def test_media_for_an_unknown_project_is_404(client):
    assert client.get("/media/prj_nope").status_code == 404


# --- Clips ------------------------------------------------------------------


def test_created_clip_has_the_frontend_shape(clip_rows):
    expected = {
        "id",
        "projectId",
        "title",
        "hook",
        "startSec",
        "endSec",
        "durationSec",
        "score",
        "aspectRatio",
        "status",
        "posterSeed",
        "createdAt",
        "editedAt",
        "transcript",
        "caption",
        "export",
    }
    assert set(clip_rows[0]) == expected


def test_clip_window_is_clamped_to_the_source(client, project, clip_rows):
    """A trim past the end of the source would render black frames, so the
    backend clamps rather than trusting the client's arithmetic."""
    response = client.post(
        f"{API}/clips",
        json={"projectId": project["id"], "title": "Overlong", "startSec": 1.0, "endSec": 999},
    )

    assert response.status_code == 201
    assert response.json()["endSec"] <= project["durationSec"] + 0.01
    assert response.json()["durationSec"] == pytest.approx(
        project["durationSec"] - 1.0, abs=0.02
    )


def test_clip_shorter_than_five_seconds_is_rejected(client, project):
    response = client.post(
        f"{API}/clips",
        json={"projectId": project["id"], "title": "Too short", "startSec": 0, "endSec": 2},
    )

    assert response.status_code == 422


def test_list_clips_for_a_project(client, project, clip_rows):
    payload = client.get(f"{API}/projects/{project['id']}/clips").json()

    assert len(payload) == 2
    assert payload[0]["score"] >= payload[1]["score"], "should be sorted best-first"


def test_read_clip_includes_a_transcript_array(client, clip_rows):
    payload = client.get(f"{API}/clips/{clip_rows[0]['id']}").json()

    assert isinstance(payload["transcript"], list)


def test_patch_clip_trim(client, clip_rows):
    clip_id = clip_rows[0]["id"]

    response = client.patch(f"{API}/clips/{clip_id}", json={"startSec": 0.5, "endSec": 6.0})

    assert response.status_code == 200
    body = response.json()
    assert body["startSec"] == 0.5
    assert body["endSec"] == 6.0
    assert body["durationSec"] == pytest.approx(5.5, abs=0.02)


def test_patch_clip_rejects_a_too_short_window(client, clip_rows):
    response = client.patch(f"{API}/clips/{clip_rows[0]['id']}", json={"startSec": 1.0, "endSec": 2.0})

    assert response.status_code == 422
    assert "at least" in response.json()["detail"]


def test_patch_clip_clamps_a_window_longer_than_the_source(client, clip_rows):
    """The 6s source is shorter than the 90s cap, so the source is the binding
    limit: the clip is clamped rather than rejected."""
    payload = client.patch(
        f"{API}/clips/{clip_rows[0]['id']}", json={"startSec": 0.0, "endSec": 200.0}
    ).json()

    assert payload["endSec"] <= 6.01
    assert payload["durationSec"] <= 6.01


def test_patch_clip_caption_merges_rather_than_replaces(client, clip_rows):
    """A partial payload must not drop fields the editor did not send."""
    clip_id = clip_rows[0]["id"]

    client.patch(f"{API}/clips/{clip_id}", json={"caption": {"text": "Hello", "presetId": "bold"}})
    payload = client.patch(f"{API}/clips/{clip_id}", json={"caption": {"text": "Updated"}}).json()

    assert payload["caption"]["text"] == "Updated"
    assert payload["caption"]["presetId"] == "bold"


def test_patch_clip_caption_keeps_a_null_position(client, clip_rows):
    """null means "inherit the preset anchor"; it must survive a round trip."""
    clip_id = clip_rows[0]["id"]

    payload = client.patch(
        f"{API}/clips/{clip_id}", json={"caption": {"text": "x", "presetId": "clean", "position": None}}
    ).json()

    assert payload["caption"]["position"] is None


def test_patch_clip_aspect_ratio(client, clip_rows):
    payload = client.patch(f"{API}/clips/{clip_rows[0]['id']}", json={"aspectRatio": "16:9"}).json()

    assert payload["aspectRatio"] == "16:9"


def test_patch_clip_rejects_an_unknown_aspect_ratio(client, clip_rows):
    response = client.patch(f"{API}/clips/{clip_rows[0]['id']}", json={"aspectRatio": "4:3"})

    assert response.status_code == 422


def test_editing_marks_the_clip_edited(client, clip_rows):
    payload = client.patch(f"{API}/clips/{clip_rows[0]['id']}", json={"title": "New title"}).json()

    assert payload["status"] == "edited"


def test_discard_clip(client, project, clip_rows):
    clip_id = clip_rows[0]["id"]

    response = client.post(f"{API}/clips/{clip_id}/discard")

    assert response.status_code == 200
    assert response.json()["discarded"] is True
    assert client.get(f"{API}/clips/{clip_id}").status_code == 404


def test_missing_clip_is_404(client):
    assert client.get(f"{API}/clips/clip_nope").status_code == 404


# --- Exports ----------------------------------------------------------------


def test_export_requires_a_ready_project(client, project, clip_rows):
    """Exporting mid-pipeline would render from a transcript that does not exist yet."""
    response = client.post(f"{API}/clips/{clip_rows[0]['id']}/export", json={})

    assert response.status_code == 409


def test_export_of_an_audio_only_project_is_rejected(client, ready_project, clip_rows):
    """An audio upload has no video track to trim, refit or burn captions onto.

    Left unchecked, this reached ffmpeg and failed with an opaque
    "[0:v:0] matches no streams" filtergraph error.
    """
    from app.db import Project, new_session

    project_id = ready_project["id"]
    clip_id = clip_rows[0]["id"]

    # Set straight on the model: the probe already classified this source.
    db = new_session()
    row = db.query(Project).filter(Project.id == project_id).first()
    row.asset_kind = "audio"
    db.commit()
    db.close()

    response = client.post(f"{API}/clips/{clip_id}/export", json={})

    assert response.status_code == 422
    assert "no video track" in response.json()["detail"]


def test_export_queues_a_job(client, ready_project, clip_rows):
    response = client.post(
        f"{API}/clips/{clip_rows[0]['id']}/export",
        json={"format": "mp4", "resolution": "1080x1080", "aspectRatio": "1:1", "burnCaptions": True},
    )

    assert response.status_code == 202
    job = response.json()
    assert job["jobId"].startswith("exp_")
    assert job["status"] in ("queued", "rendering")


def test_export_rejects_an_invalid_resolution(client, ready_project, clip_rows):
    response = client.post(
        f"{API}/clips/{clip_rows[0]['id']}/export", json={"resolution": "9999x9999"}
    )

    assert response.status_code == 422


def test_export_renders_a_real_mp4_and_downloads_it(client, ready_project, clip_rows, ffmpeg_path):
    """The end-to-end promise: upload -> clip -> export -> a playable file."""
    queued = client.post(
        f"{API}/clips/{clip_rows[0]['id']}/export",
        json={
            "format": "mp4",
            "resolution": "1080x1080",
            "aspectRatio": "1:1",
            "burnCaptions": True,
            "captionPresetId": "bold",
            "captionText": "This caption is burned into the render",
        },
    ).json()

    job_id = queued["jobId"]

    finished = wait_for(
        client,
        f"{API}/exports/{job_id}",
        lambda payload: payload["status"] in ("complete", "failed"),
        timeout=180,
    )
    assert finished["status"] == "complete", finished.get("error")
    assert finished["progress"] == 100
    assert finished["sizeBytes"] > 0
    assert finished["canDownload"] is True

    # The download URL must carry the API prefix and a token.
    link = client.post(f"{API}/exports/{job_id}/download").json()
    assert link["url"].startswith(f"{API}/exports/")
    assert "token=" in link["url"]
    assert link["fileName"].endswith(".mp4")

    token = link["url"].split("token=")[1]
    file_response = client.get(f"{API}/exports/{job_id}/file", params={"token": token})

    assert file_response.status_code == 200
    assert file_response.headers["content-type"] == "video/mp4"
    assert len(file_response.content) > 1000
    # A real MP4 starts with an ftyp box.
    assert file_response.content[4:8] == b"ftyp"


def test_completed_export_streams_inline_for_the_video_element(
    client, ready_project, clip_rows, ffmpeg_path
):
    """`<video src>` has no way to send a token, so streaming must not need one.

    This is the path ClipEditor plays. If it 403s or forces a download the
    preview silently falls back to a poster and the render is invisible.
    """
    queued = client.post(f"{API}/clips/{clip_rows[0]['id']}/export", json={}).json()
    job_id = queued["jobId"]

    finished = wait_for(
        client,
        f"{API}/exports/{job_id}",
        lambda payload: payload["status"] in ("complete", "failed"),
        timeout=180,
    )
    assert finished["status"] == "complete", finished.get("error")

    # The job payload must advertise a tokenless, inline URL for the player.
    assert finished["streamUrl"] == f"{API}/exports/{job_id}/stream"
    assert finished["url"] == finished["streamUrl"]

    full = client.get(finished["streamUrl"])

    assert full.status_code == 200
    assert full.headers["content-type"] == "video/mp4"
    assert full.headers["accept-ranges"] == "bytes"
    # `attachment` makes a browser download instead of playing.
    assert "attachment" not in full.headers.get("content-disposition", "")
    assert full.content[4:8] == b"ftyp"

    # Seeking requires 206; without it the player can start but never scrub.
    first = client.get(finished["streamUrl"], headers={"Range": "bytes=0-9"})

    assert first.status_code == 206
    assert first.headers["content-range"].startswith("bytes 0-9/")
    assert first.content[4:8] == b"ftyp"

    middle = client.get(finished["streamUrl"], headers={"Range": "bytes=1000-1099"})
    assert middle.status_code == 206
    assert middle.headers["content-range"] == f"bytes 1000-1099/{full.headers['content-length']}"

    # Suffix form: the last N bytes.
    suffix = client.get(finished["streamUrl"], headers={"Range": "bytes=-16"})
    assert suffix.status_code == 206
    assert len(suffix.content) == 16

    # Past the end of the file is a 416, not a 500 that would kill playback.
    past_end = client.get(finished["streamUrl"], headers={"Range": "bytes=99999999-"})
    assert past_end.status_code == 416

    # Some players probe with HEAD before issuing a GET.
    head = client.head(finished["streamUrl"])
    assert head.status_code == 200
    assert head.headers["content-type"] == "video/mp4"
    assert head.headers["accept-ranges"] == "bytes"


def test_stream_rejects_an_unfinished_export(client, ready_project, clip_rows):
    queued = client.post(f"{API}/clips/{clip_rows[0]['id']}/export", json={}).json()

    response = client.get(f"{API}/exports/{queued['jobId']}/stream")

    assert response.status_code == 409


def test_stream_404s_for_an_unknown_export(client):
    assert client.get(f"{API}/exports/exp_missing/stream").status_code == 404


def test_exports_can_be_listed_scoped_by_project_id(client, ready_project, clip_rows):
    """The frontend filters with `?projectId=`; the server must honour it."""
    clip_id = clip_rows[0]["id"]
    queued = client.post(f"{API}/clips/{clip_id}/export", json={}).json()
    wait_for(
        client,
        f"{API}/exports/{queued['jobId']}",
        lambda payload: payload["status"] in ("complete", "failed"),
        timeout=180,
    )

    scoped = client.get(f"{API}/exports", params={"projectId": ready_project["id"]}).json()

    assert scoped, "the project filter returned nothing"
    assert {item["clipId"] for item in scoped} == {clip_id}
    assert all(item["streamUrl"] for item in scoped if item["status"] == "complete")


def test_download_requires_a_valid_token(client, ready_project, clip_rows, ffmpeg_path):
    queued = client.post(f"{API}/clips/{clip_rows[0]['id']}/export", json={}).json()
    job_id = queued["jobId"]
    wait_for(
        client,
        f"{API}/exports/{job_id}",
        lambda payload: payload["status"] in ("complete", "failed"),
        timeout=180,
    )

    assert client.get(f"{API}/exports/{job_id}/file", params={"token": "forged"}).status_code == 403
    assert client.get(f"{API}/exports/{job_id}/file").status_code == 403


def test_download_before_completion_is_rejected(client, ready_project, clip_rows):
    queued = client.post(f"{API}/clips/{clip_rows[0]['id']}/export", json={}).json()

    response = client.post(f"{API}/exports/{queued['jobId']}/download")

    assert response.status_code == 409


def test_export_marks_the_clip_exported(client, ready_project, clip_rows, ffmpeg_path):
    clip_id = clip_rows[0]["id"]
    queued = client.post(f"{API}/clips/{clip_id}/export", json={}).json()
    job_id = queued["jobId"]

    wait_for(
        client,
        f"{API}/exports/{job_id}",
        lambda payload: payload["status"] in ("complete", "failed"),
        timeout=180,
    )

    assert client.get(f"{API}/clips/{clip_id}").json()["status"] == "exported"


def test_export_polling_shape(client, ready_project, clip_rows, ffmpeg_path):
    """`clipService.pollJob` reads status and progress; both must be present."""
    queued = client.post(f"{API}/clips/{clip_rows[0]['id']}/export", json={}).json()

    payload = client.get(f"{API}/exports/{queued['jobId']}").json()

    assert payload["status"] in ("queued", "rendering", "complete", "failed")
    assert isinstance(payload["progress"], (int, float))
    assert payload["jobId"] == queued["jobId"]


def test_list_exports_for_a_project(client, ready_project, clip_rows, ffmpeg_path):
    queued = client.post(f"{API}/clips/{clip_rows[0]['id']}/export", json={}).json()
    wait_for(
        client,
        f"{API}/exports/{queued['jobId']}",
        lambda payload: payload["status"] in ("complete", "failed"),
        timeout=180,
    )

    payload = client.get(f"{API}/exports", params={"project_id": ready_project["id"]}).json()

    assert isinstance(payload, list)
    assert any(item["id"] == queued["jobId"] for item in payload)


def test_second_export_for_the_same_clip_reuses_the_job(client, ready_project, clip_rows, ffmpeg_path):
    """Two ffmpeg processes writing the same filename would race."""
    first = client.post(f"{API}/clips/{clip_rows[0]['id']}/export", json={}).json()
    second = client.post(f"{API}/clips/{clip_rows[0]['id']}/export", json={}).json()

    assert second["jobId"] == first["jobId"]


def test_missing_export_job_is_404(client):
    assert client.get(f"{API}/exports/exp_nope").status_code == 404