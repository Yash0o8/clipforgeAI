<#
.SYNOPSIS
    Start the ClipForge AI backend.

.DESCRIPTION
    Thin wrapper around uvicorn for local development. It exists so the
    documented command is one line, and so ffmpeg is checked before the server
    starts rather than failing later inside a render.

    Does not create or activate a virtualenv; it uses whichever `python` is
    first on PATH. See README.md for venv setup.

.EXAMPLE
    .\run.ps1
    Starts on 127.0.0.1:8000 with reload.

.EXAMPLE
    .\run.ps1 -Model tiny
    Faster and far lighter on CPU. Good for a first run.

.EXAMPLE
    .\run.ps1 -Port 8010 -NoReload
#>
[CmdletBinding()]
param(
    [string] $Host_Address = '127.0.0.1',
    [int]    $Port = 8000,

    # Passed through to uvicorn.
    [switch] $NoReload,

    # Overrides for the audio/video toolchain. Set these if `ffmpeg` on PATH is
    # a wrapper script: see the process-tree note in README.md.
    [string] $FfmpegBinary = $env:FFMPEG_BINARY,
    [string] $FfprobeBinary = $env:FFPROBE_BINARY,

    # Common transcription overrides, so they do not need a .env file.
    [string] $Model = $env:WHISPER_MODEL,
    [string] $Language = $env:WHISPER_LANGUAGE
)

$ErrorActionPreference = 'Stop'

# uvicorn must resolve the `app` package, which means running from backend/.
Push-Location $PSScriptRoot
try {
    $python = Get-Command python -ErrorAction SilentlyContinue
    if (-not $python) {
        throw 'python was not found on PATH. Install Python 3.11+ and retry.'
    }

    # Fail early and legibly: without ffmpeg, uploads succeed and renders do not.
    foreach ($tool in @('ffmpeg', 'ffprobe')) {
        if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
            Write-Warning "$tool was not found on PATH."
            Write-Warning 'Uploads will work, but transcription and rendering will fail.'
            Write-Warning 'Install it with: choco install ffmpeg'
        }
    }

    if ($FfmpegBinary)  { $env:FFMPEG_BINARY  = $FfmpegBinary }
    if ($FfprobeBinary) { $env:FFPROBE_BINARY = $FfprobeBinary }
    if ($Model)         { $env:WHISPER_MODEL  = $Model }
    if ($Language)      { $env:WHISPER_LANGUAGE = $Language }

    $arguments = @(
        '-m', 'uvicorn', 'app.main:app',
        '--host', $Host_Address,
        '--port', $Port
    )

    if (-not $NoReload) {
        # Reload spawns a child process, so Ctrl+C must reach the whole tree.
        $arguments += '--reload'
    }

    Write-Host "ClipForge AI -> http://${Host_Address}:$Port" -ForegroundColor Cyan
    Write-Host "Health check -> http://${Host_Address}:$Port/health" -ForegroundColor DarkGray

    & $python.Source @arguments
}
finally {
    Pop-Location
}
