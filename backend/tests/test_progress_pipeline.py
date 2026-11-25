"""Progress visibility and long-form transcription settings.

The Processing page polls the persisted project row, so a progress value that
only lives in the in-memory job record is invisible to the user. These tests
pin the row-level contract and the speed preset selection.
"""

from __future__ import annotations

import json
import sys
import types

import numpy as np

from app.config import Settings
from app.db import Job, Project, new_session
from app.pipeline import transcribe as transcribe_module
from app.pipeline.runner import PipelineError, _persist_progress
from app.pipeline.transcribe import _segments_from_provider
from app.routes import projects as project_routes
from app.utils import StageTracker


def test_transcription_plan_uses_fast_preset_for_long_form():
    settings = Settings(whisper_model="small", whisper_fast_model="base")

    plan = settings.transcription_plan(6183)

    assert plan["fastMode"] is True
    assert plan["longForm"] is True
    assert plan["model"] == "base"
    assert plan["beamSize"] == settings.whisper_fast_beam_size
    assert plan["conditionOnPreviousText"] is False


def test_transcription_plan_keeps_accuracy_for_short_videos():
    settings = Settings(whisper_model="small", whisper_fast_model="base")

    plan = settings.transcription_plan(120)

    assert plan["fastMode"] is False
    assert plan["model"] == "small"
    assert plan["beamSize"] == settings.whisper_beam_size


def test_transcription_plan_honours_quality_override():
    settings = Settings(whisper_model="small", whisper_fast_model="base")

    forced_fast = settings.transcription_plan(10, quality="fast")
    forced_accuracy = settings.transcription_plan(6183, quality="accuracy")

    assert forced_fast["model"] == "base"
    assert forced_accuracy["model"] == "small"
    assert forced_accuracy["fastMode"] is False


def test_transcription_plan_uses_groq_only_with_a_key():
    local = Settings(transcription_provider="auto", groq_api_key=None)
    hosted = Settings(transcription_provider="auto", groq_api_key="test-key")

    assert local.transcription_plan(6183)["provider"] == "local"
    assert hosted.transcription_plan(6183)["provider"] == "groq"
    # Short videos stay local even when a hosted key is configured.
    assert hosted.transcription_plan(60)["provider"] == "local"


def test_provider_segments_apply_chunk_offset_and_keep_words():
    payload = {
        "segments": [
            {
                "start": 1.0,
                "end": 3.0,
                "text": "hello world",
                "words": [
                    {"word": "hello", "start": 1.0, "end": 2.0},
                    {"word": "world", "start": 2.0, "end": 3.0},
                ],
            }
        ]
    }
    counter = [0]

    segments = _segments_from_provider(payload, offset=600.0, counter=counter)

    assert segments[0].start_sec == 601.0
    assert segments[0].end_sec == 603.0
    assert [word.text for word in segments[0].words] == ["hello", "world"]
    assert segments[0].words[0].start_sec == 601.0
    assert counter[0] == 2


def test_loader_uses_cached_weights_without_network(monkeypatch):
    """A cached model must load with local_files_only=True, no HF round trip."""
    calls = []

    class FakeModel:
        def __init__(self, name, **kwargs):
            calls.append((name, kwargs))
            self.name = name

    fake_module = types.ModuleType("faster_whisper")
    fake_module.WhisperModel = FakeModel
    monkeypatch.setitem(sys.modules, "faster_whisper", fake_module)
    monkeypatch.setattr(transcribe_module, "_model", None)
    monkeypatch.setattr(transcribe_module, "_model_key", None)
    monkeypatch.setattr(transcribe_module, "cached_models", lambda: {"small"})

    settings = Settings(whisper_model="small", whisper_local_files_only=True)
    model = transcribe_module.load_model(settings, "small")

    assert model.name == "small"
    assert calls[0][1]["local_files_only"] is True


def test_loader_falls_back_to_a_cached_model(monkeypatch):
    """A missing model (offline) must not fail the job while weights exist."""
    calls = []

    class FakeModel:
        def __init__(self, name, **kwargs):
            calls.append(name)
            if name == "base" and len(calls) == 1:
                raise OSError("network unreachable")
            self.name = name

    fake_module = types.ModuleType("faster_whisper")
    fake_module.WhisperModel = FakeModel
    monkeypatch.setitem(sys.modules, "faster_whisper", fake_module)
    monkeypatch.setattr(transcribe_module, "_model", None)
    monkeypatch.setattr(transcribe_module, "_model_key", None)
    monkeypatch.setattr(transcribe_module, "cached_models", lambda: {"small", "tiny"})

    settings = Settings(
        whisper_model="small",
        whisper_fast_model="base",
        whisper_model_fallbacks="small,tiny",
        whisper_local_files_only=True,
    )
    model = transcribe_module.load_model(settings, "base")

    assert model.name == "small"
    assert calls[0] == "base"
    assert calls[1] == "small"


def test_silent_audio_still_reports_transcript_completion(monkeypatch):
    """Silence must advance progress to 100% instead of freezing the stage."""

    class SilentModel:
        def transcribe(self, *_args, **_kwargs):
            class Info:
                duration = 3.0
                language = "en"
                language_probability = 0.9

            return iter([]), Info()

    monkeypatch.setattr(
        transcribe_module,
        "load_audio",
        lambda *_a, **_k: np.zeros(48000, dtype=np.float32),
    )
    monkeypatch.setattr(transcribe_module, "load_model", lambda *_a, **_k: SilentModel())

    settings = Settings(whisper_model="tiny")
    progress = []
    segments, meta = transcribe_module.transcribe(
        types.SimpleNamespace(suffix=".wav", name="silent.wav"), settings,
        on_progress=progress.append,
    )

    assert segments == []
    assert meta["wordCount"] == 0
    assert progress[-1] == 1.0


def test_progress_tick_never_downgrades_a_finished_project(db_session):
    """The final 100% callback must not flip a ready project back to processing."""
    project = Project(
        id="prj_done",
        title="Done",
        source="upload",
        status="ready",
        progress=100.0,
        current_stage=None,
    )
    db_session.add(project)
    db_session.commit()

    tracker = StageTracker()
    tracker.finish()

    _persist_progress(db_session, project, None, tracker, None, None)
    db_session.expire_all()

    fresh = db_session.query(Project).filter(Project.id == project.id).one()
    assert fresh.status == "ready"
    assert fresh.current_stage is None
    assert fresh.progress == 100.0


def test_persist_progress_writes_the_row_the_ui_polls(db_session):
    project = Project(
        id="prj_progress",
        title="Progress test",
        source="upload",
        status="processing",
    )
    job = Job(
        id="job_progress",
        project_id=project.id,
        kind="process",
        status="running",
    )
    db_session.add_all([project, job])
    db_session.commit()

    tracker = StageTracker()
    tracker.advance("upload", 1.0)
    tracker.advance("audio", 1.0)
    tracker.advance("transcript", 0.42)
    meta = {
        "startedAt": "2026-11-24T10:00:00Z",
        "transcriptProgress": 42.0,
        "processedSec": 2600.0,
        "wordCount": 0,
        "provider": "groq",
        "model": "whisper-large-v3-turbo",
        "fastMode": True,
    }

    _persist_progress(db_session, project, job, tracker, "transcript", meta)
    db_session.expire_all()

    fresh = db_session.query(Project).filter(Project.id == project.id).one()
    fresh_job = db_session.query(Job).filter(Job.id == job.id).one()
    assert fresh.current_stage == "transcript"
    assert fresh.progress == tracker.progress
    assert 0 < fresh.progress < 100
    assert fresh_job.progress == tracker.progress

    payload = fresh.to_dict()
    assert payload["transcription"]["progress"] == 42.0
    assert payload["transcription"]["processedSec"] == 2600.0
    assert payload["transcription"]["provider"] == "groq"
    assert payload["processingStartedAt"] == "2026-11-24T10:00:00Z"
    # Internal bookkeeping must not leak into the editable settings object.
    assert "_processing" not in payload["settings"]
    assert json.loads(fresh.settings_json)["_processing"]["fastMode"] is True


def test_pipeline_error_is_a_terminal_project_state(db_session, monkeypatch):
    """A handled failure must not leave the Processing page polling forever."""
    project = Project(
        id="prj_failed",
        title="Failure test",
        source="upload",
        status="processing",
        progress=65.3,
        current_stage="transcript",
    )
    job = Job(
        id="job_failed",
        project_id=project.id,
        kind="process",
        status="running",
        progress=65.3,
        stage="transcript",
    )
    db_session.add_all([project, job])
    db_session.commit()

    def boom(*_args, **_kwargs):
        raise PipelineError("no usable moments")

    monkeypatch.setattr(project_routes, "run_processing", boom)
    context = types.SimpleNamespace(project_id=project.id, job_id=job.id)
    try:
        project_routes._run_process(new_session(), job.id, context)
    except PipelineError as exc:
        assert str(exc) == "no usable moments"
    else:
        raise AssertionError("the adapter should propagate the pipeline failure")

    db_session.expire_all()
    fresh = db_session.query(Project).filter(Project.id == project.id).one()
    fresh_job = db_session.query(Job).filter(Job.id == job.id).one()
    assert fresh.status == "failed"
    assert fresh.error == "no usable moments"
    assert fresh_job.status == "failed"
    assert fresh_job.error == "no usable moments"
