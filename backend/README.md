# ClipForge AI — backend

FastAPI service that turns long-form video into short-form clips: multipart
upload, Whisper transcription, highlight ranking, and ffmpeg rendering.

The React frontend in `../src` is a real client of this API — there is no demo
mode, and no project or clip data is kept in the browser.

## Setup

```powershell
# From the repo root
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r backend\requirements.txt
```

Or use the shortcut, which activates nothing and assumes a working interpreter
on `PATH`:

```powershell
.\backend\run.ps1
```

Then run the frontend in a second terminal:

```powershell
npm run dev
```

Vite serves on `http://localhost:5173`; the API serves on `http://127.0.0.1:8000`.
The frontend reads the backend origin from `VITE_API_BASE_URL` in the repo-root
`.env` (see `.env.example`).

### ffmpeg is required

Every stage after upload shells out to ffmpeg and ffprobe. `GET /health` reports
`ffmpeg: false` when they are missing, and uploads will fail in confusing ways if
you skip this.

```powershell
choco install ffmpeg
```

If `ffmpeg` resolves to a wrapper script on Windows rather than the real binary,
point `FFMPEG_BINARY` at the actual executable. The Chocolatey shim at
`C:\ProgramData\chocolatey\bin\ffmpeg.exe` spawns the real binary as a child,
which breaks process-tree cancellation unless the real path is used — see
"ffmpeg process trees" below.

## Verified dependency matrix

Every pin in `requirements.txt` is the version the suite and a real end-to-end
render were verified against. Verified on Windows 11, Python 3.13.9.

| Package | Version | Why this one |
| --- | --- | --- |
| `fastapi` | 0.115.6 | Route/response model behaviour verified against the 28 routes below. |
| `uvicorn[standard]` | 0.34.0 | Dev and test server. |
| `pydantic` | 2.10.4 | `extra="forbid"` on request schemas — a stray field is a 422. |
| `SQLAlchemy` | 2.0.36 | Declarative ORM, SQLite. |
| `faster-whisper` | 1.2.1 | Only version verified to return word-level timings on CPU. |
| `ctranslate2` | 4.8.2 | Ships a Windows **CPU** wheel. See the CUDA note below. |
| `av` (PyAV) | 19.0.1 | Pinned because it *removed* an API faster-whisper still calls. See below. |
| `tokenizers` | 0.22.1 | Required by faster-whisper; pinned for reproducible installs. |
| `numpy` | ≥1.26, <2.5 | Verified at 2.4.0. Upper bound blocks numpy 3.x, which predates ctranslate2 4.8.2. |
| `anthropic` / `openai` | 0.42.0 / 1.59.6 | Optional ranking. Imported lazily; absent-safe. |
| `pytest` / `httpx` | 8.3.4 / 0.28.1 | Test suite. |

### The PyAV trap — read before touching audio loading

`faster_whisper.audio.decode_audio` **cannot be used** with any current PyAV.
It calls a keyword argument that PyAV removed in v14:

```python
>>> av.open(path, mode="r", metadata_errors="ignore")
TypeError: open() got an unexpected keyword argument 'metadata_errors'
```

`app/pipeline/transcribe.py` therefore decodes audio itself: it shells out to
ffmpeg for 16 kHz mono PCM and reads the WAV with the stdlib `wave` module. That
keeps the only audio dependency as an ffmpeg binary the pipeline already needs.

`av` is pinned explicitly even though the backend never calls it, because
faster-whisper imports it at module scope and because leaving it unpinned lets
the broken combination reappear silently on a fresh install.

### A `pip check` warning that is not ours

```
numba 0.62.1 has requirement numpy<2.4,>=1.22, but you have numpy 2.4.0
```

`numba` arrives via `datashader`, which is unrelated to this project. It does not
affect the backend and needs no action — it only appears if the backend is
installed into a shared Anaconda base environment. A dedicated virtualenv (above)
avoids it entirely.

### GPU

`resolve_device()` probes for CUDA by importing `torch` inside a `try/except`,
so **torch is optional**. Without it the pipeline returns `"cpu"` and works
normally. `torch` is commented out in `requirements.txt` because it is a ~2.5 GB
install.

On Linux with an NVIDIA GPU:

```powershell
pip install torch --index-url https://download.pytorch.org/whl/cu121
```

**On Windows, CUDA is not a supported path.** There is no CUDA-enabled
`ctranslate2` build on PyPI for Windows, and the PyTorch CUDA wheels are also
Linux-only. CPU is the supported Windows configuration. To reduce CPU render
time, prefer the `tiny` or `base` Whisper models over `small`.

Verified CPU compute types for ctranslate2 4.8.2: `int8_float32`, `int8`,
`float32`. `WHISPER_COMPUTE_TYPE` defaults to `int8`.

## ffmpeg process trees

Cancellation and timeout handling must kill the whole ffmpeg tree, not just the
PID that was spawned. `terminate_process()` in `app/storage.py` handles this per
platform:

- **Windows** — `taskkill /F /T /PID <pid>` kills the process tree.
- **POSIX** — signals the process group via `os.killpg`, which requires the
  child to have been spawned in its own group.

This is why `FFMPEG_BINARY` must point at the real binary. The Chocolatey shim
at `C:\ProgramData\chocolatey\bin\ffmpeg.exe` is a small wrapper that spawns the
actual encoder as a *child*, so killing the shim's PID orphans the encoder and
the watchdog appears to hang. The real binary lives under
`C:\ProgramData\chocolatey\lib\ffmpeg\tools\ffmpeg\bin\ffmpeg.exe`.

Silent ffmpeg invocations (no `-progress`) must also drain stderr, or a full
pipe buffer deadlocks the child until the watchdog kills it.

## Configuration

Settings come from the environment, or from `backend/.env` if present. Field
names are matched case-insensitively, so `whisper_model` and `WHISPER_MODEL` are
equivalent. Unknown variables are ignored.

| Variable | Default | Notes |
| --- | --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `8000` | |
| `API_PREFIX` | `/api/v1` | Must match the frontend's `VITE_API_PREFIX`. |
| `CORS_ORIGINS` | Vite dev origins | Comma-separated. |
| `DATA_DIR` | `backend/data` | Uploads, media, renders, SQLite file. |
| `MAX_UPLOAD_MB` | `2048` | |
| `WHISPER_MODEL` | `small` | `tiny`/`base` are much faster on CPU. |
| `WHISPER_DEVICE` | `auto` | Probes CUDA, falls back to CPU. |
| `WHISPER_COMPUTE_TYPE` | `int8` | |
| `WHISPER_LANGUAGE` | unset | Force a language instead of auto-detecting. |
| `SHORTLIST_SIZE` | `15` | Candidates scored before LLM ranking. |
| `DEFAULT_CLIP_COUNT` | `8` | Clips produced per project. |
| `CLIP_MIN_DURATION` / `CLIP_MAX_DURATION` / `CLIP_TARGET_DURATION` | `5` / `90` / `38` | Seconds. |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | unset | Optional. Without either, ranking is heuristic-only. |
| `LLM_TIMEOUT_SEC` | `45` | |
| `FFMPEG_BINARY` / `FFPROBE_BINARY` | `ffmpeg` / `ffprobe` | Point at real binaries, not shims. |
| `FFMPEG_TIMEOUT_SEC` | `1800` | |

## API

28 routes. Field names are camelCase to match the frontend's service layer;
timings are absolute fractional **seconds** (`startSec`), not timecodes.

`/media` is deliberately mounted *outside* `/api/v1`: it is a static file
endpoint, and a `<video src>` cannot carry auth headers or a version prefix
cleanly.

### Meta

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness plus `ffmpeg`, `whisperModel`, `llmProvider`, `device`. |
| `GET` | `/api/v1/meta` | Vocabulary the frontend mirrors — stages, ratios, statuses. |

### Uploads

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/v1/uploads` | Create a multipart session. |
| `GET` | `/api/v1/uploads/{id}` | Session state and received parts. |
| `POST` | `/api/v1/uploads/{id}/parts` | Allocate part URLs. |
| `PUT` | `/api/v1/uploads/{id}/parts/{n}` | Upload one part. |
| `POST` | `/api/v1/uploads/{id}/complete` | Assemble the source file. |
| `POST` | `/api/v1/uploads/{id}/abort` | Discard the session. |

### Projects

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/projects` | List, optionally by status. |
| `POST` | `/api/v1/projects` | Create from an `uploadId`. Probes the real media. |
| `GET` | `/api/v1/projects/{id}` | Project state. |
| `PATCH` | `/api/v1/projects/{id}` | Update title. |
| `DELETE` | `/api/v1/projects/{id}` | Delete and clean up. |
| `GET` | `/api/v1/projects/{id}/clips` | Clips for one project. |
| `POST` | `/api/v1/projects/{id}/process` | Start the pipeline. `202`. |
| `POST` | `/api/v1/projects/{id}/cancel` | Cancel a running job. |
| `POST` | `/api/v1/projects/{id}/clips/generate` | Regenerate highlights. |
| `GET` | `/api/v1/projects/{id}/jobs` | Job history. |

### Clips

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/clips/{id}` | One clip. |
| `PATCH` | `/api/v1/clips/{id}` | Trim, title, caption, aspect ratio. |
| `POST` | `/api/v1/clips/{id}/discard` | Discard a suggestion. |
| `POST` | `/api/v1/clips` | Create a manual clip. |

### Exports

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/v1/clips/{id}/export` | Queue a render. `202`. |
| `GET` | `/api/v1/exports` | Export history, newest first. |
| `GET` | `/api/v1/exports/{id}` | Poll a job. |
| `POST` | `/api/v1/exports/{id}/cancel` | Cancel a queued or running render. |
| `POST` | `/api/v1/exports/{id}/download` | Exchange for a time-limited URL. |
| `GET` | `/api/v1/exports/{id}/file` | Stream the rendered file. |

### Media

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/media/{project_id}` | Range-requestable source video. |
| `GET` | `/media/{project_id}/info` | Duration, dimensions, codecs. |

### Pipeline

`upload → audio → transcript → highlights → prepare`, with weights served from
`/api/v1/meta` so the frontend's progress bar cannot drift from the backend.

Audio-only projects are rejected at export time with a `422` and a readable
message, rather than failing deep inside an ffmpeg filtergraph.

## Tests

```powershell
# From the backend directory
python -m pytest -q
```

176 tests. `conftest.py` builds a real MP4 with ffmpeg and runs a real render, so
ffmpeg must be on `PATH`. Whisper-dependent tests are patched to use `tiny`;
set `WHISPER_MODEL` to override.

## Layout

```
backend/
  app/
    config.py       env-backed settings
    db.py           SQLAlchemy models and session
    jobs.py         ThreadPoolExecutor job queue
    storage.py      ffmpeg/ffprobe wrappers, process-tree termination
    schemas.py      request/response models
    main.py         app assembly, CORS, health, meta
    routes/         uploads, projects, clips, exports, media
    pipeline/       transcribe, score, rank, captions, subtitles, render, runner
  tests/
  requirements.txt
  run.ps1
```
