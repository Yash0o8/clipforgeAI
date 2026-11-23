import { useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { AlertTriangle, Link2, Upload as UploadIcon, Wand2 } from 'lucide-react';
import { Panel, PanelHeader, PanelBody } from '../components/common/Panel.jsx';
import { Button } from '../components/common/Button.jsx';
import { TextField } from '../components/common/TextField.jsx';
import { VideoDropzone } from '../components/upload/VideoDropzone.jsx';
import { UploadProgress } from '../components/upload/UploadProgress.jsx';
import { VideoMetadata } from '../components/upload/VideoMetadata.jsx';
import { useVideoUpload } from '../hooks/useVideoUpload.js';
import { useApp } from '../hooks/useApp.js';
import * as projectService from '../services/projectService.js';
import { CREATION_PRESETS, NOTIFICATION_TONE } from '../utils/constants.js';

export function UploadPage() {
  const navigate = useNavigate();
  const upload = useVideoUpload();
  const { addProject, notify } = useApp();
  const [actionError, setActionError] = useState(null);
  const [isStarting, setIsStarting] = useState(false);
  const [sourceMode, setSourceMode] = useState('upload');
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [presetId, setPresetId] = useState('podcast');
  const [transcriptionHint, setTranscriptionHint] = useState('auto');
  const [ingestStatus, setIngestStatus] = useState('');

  const selectedPreset = CREATION_PRESETS.find((p) => p.id === presetId) ?? CREATION_PRESETS[0];

  const handleProcess = async () => {
    if (isStarting) return;
    setActionError(null);
    setIsStarting(true);

    try {
      let project;
      if (sourceMode === 'youtube') {
        if (!youtubeUrl.trim()) throw new Error('Paste a YouTube URL first.');
        setIngestStatus('Queueing YouTube ingest...');
        const ingest = await projectService.ingestYoutube({
          url: youtubeUrl.trim(),
          title: youtubeUrl.trim(),
          presetId,
          settings: {
            renderMode: selectedPreset.renderMode,
            captionPreset: selectedPreset.captionPreset,
            transcriptionHint: transcriptionHint === 'auto' ? undefined : transcriptionHint,
          },
        });
        project = await projectService.getProject(ingest.projectId);
        addProject(project);
        // Wait for ingest to finish downloading/probing before processing.
        for (let i = 0; i < 180; i++) {
          setIngestStatus(project?.status === 'processing' ? 'Downloading/probing YouTube media...' : `Ingest status: ${project?.status || 'queued'}...`);
          if (project?.status === 'failed') throw new Error(project.error || 'YouTube ingest failed.');
          if (project?.assetPath || project?.objectUrl || project?.hasLocalSource) break;
          await new Promise((r) => setTimeout(r, 1500));
          project = await projectService.getProject(ingest.projectId);
          addProject(project);
        }
        if (!project?.hasLocalSource && !project?.objectUrl) throw new Error('YouTube ingest did not produce a media file.');
        setIngestStatus('Media ready. Starting AI processing...');
        await projectService.processProject(project.id);
      } else {
        if (!upload.file) return;
        let uploadId = upload.uploadId;
        if (!uploadId) {
          const result = await upload.startUpload();
          if (!result?.ok) {
            if (result?.cancelled) return;
            throw result?.error ?? new Error('Upload failed.');
          }
          uploadId = result.uploadId;
        }

        project = await projectService.createProject({
          title: upload.file.name.replace(/\.[^.]+$/, ''),
          durationSec: upload.metadata.durationSec ?? 0,
          fileSize: upload.file.size,
          fileName: upload.file.name,
          mimeType: upload.file.type,
          uploadId,
          presetId,
          settings: {
            renderMode: selectedPreset.renderMode,
            captionPreset: selectedPreset.captionPreset,
            transcriptionHint: transcriptionHint === 'auto' ? undefined : transcriptionHint,
          },
        });
        project = { ...project, objectUrl: upload.objectUrl ?? project.objectUrl };
        await projectService.processProject(project.id);
      }

      addProject(project);
      navigate(`/app/projects/${project.id}/processing`);
    } catch (error) {
      const message = error?.message ?? 'Could not start processing.';
      setActionError(message);
      notify({ tone: NOTIFICATION_TONE.ERROR, title: 'Processing could not start', message });
    } finally {
      setIsStarting(false);
    }
  };

  const busy = upload.status === 'uploading' || isStarting;
  const canStart = sourceMode === 'youtube' ? Boolean(youtubeUrl.trim()) : Boolean(upload.file) && upload.status !== 'error';

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-brand-400">New project</p>
        <h1 className="text-2xl font-semibold tracking-tight text-primary sm:text-3xl">Create viral clips</h1>
        <p className="max-w-2xl text-sm text-secondary">
          Upload a file or paste a YouTube URL, pick a vibe preset, and ClipForge will generate ready-to-post clips.
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <Panel>
          <PanelHeader title="Source & preset" description="Choose input source and creation mode." />
          <PanelBody className="space-y-5">
            <div className="flex gap-2">
              <Button variant={sourceMode === 'upload' ? 'primary' : 'secondary'} size="sm" icon={UploadIcon} onClick={() => setSourceMode('upload')}>Upload file</Button>
              <Button variant={sourceMode === 'youtube' ? 'primary' : 'secondary'} size="sm" icon={Link2} onClick={() => setSourceMode('youtube')}>YouTube URL</Button>
            </div>

            {sourceMode === 'youtube' ? (
              <TextField
                label="YouTube URL"
                value={youtubeUrl}
                onChange={(e) => setYoutubeUrl(e.target.value)}
                placeholder="https://www.youtube.com/watch?v=..."
                hint="We’ll fetch the video, transcribe it, and generate clips."
              />
            ) : (
              <>
                <VideoDropzone onFiles={upload.selectFiles} hasFile={upload.hasFile} fileName={upload.file?.name} onClear={upload.reset} disabled={busy} />
                {upload.errors.length > 0 ? (
                  <div className="space-y-2" role="alert">
                    {upload.errors.map((err) => (
                      <p key={err.code + err.message} className="rounded-control border border-danger-500/30 bg-danger-500/10 px-3 py-2 text-sm text-danger-400">{err.message}</p>
                    ))}
                  </div>
                ) : null}
                <UploadProgress progress={upload.progress} status={upload.status} fileName={upload.file?.name} fileSize={upload.file?.size} onCancel={upload.cancelUpload} />
              </>
            )}

            <div className="space-y-2">
              <p className="text-sm font-medium text-primary">Vibe preset</p>
              <div className="grid gap-3 sm:grid-cols-3">
                {CREATION_PRESETS.map((preset) => {
                  const active = preset.id === presetId;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => setPresetId(preset.id)}
                      className={`rounded-card border p-3 text-left transition ${active ? 'border-brand-500 bg-brand-500/10' : 'border-border bg-surface hover:border-brand-500/40'}`}
                    >
                      <p className="text-sm font-semibold text-primary">{preset.label}</p>
                      <p className="mt-1 text-xs text-muted">{preset.description}</p>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-sm text-secondary">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-faint">Transcription</span>
                <select
                  className="w-full rounded-lg border border-line bg-ink-900 px-3 py-2 text-sm text-primary"
                  value={transcriptionHint}
                  onChange={(e) => setTranscriptionHint(e.target.value)}
                >
                  <option value="auto">Auto detect</option>
                  <option value="hinglish_roman">Hindi + Roman Hinglish</option>
                </select>
              </label>
              <div className="rounded-lg border border-line bg-ink-900/40 px-3 py-2 text-xs text-secondary">
                <p className="font-medium text-primary">Preset behavior</p>
                <p className="mt-1">{selectedPreset.description}</p>
              </div>
            </div>

            {ingestStatus ? (
              <div className="rounded-control border border-brand-500/30 bg-brand-500/10 px-3 py-2 text-sm text-brand-200">
                {ingestStatus}
              </div>
            ) : null}

            {actionError ? (
              <div role="alert" className="flex items-start gap-3 rounded-control border border-danger-500/30 bg-danger-500/10 px-3 py-3 text-sm text-danger-200">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger-400" aria-hidden="true" />
                <div className="space-y-1">
                  <p className="font-medium text-danger-100">Could not start processing</p>
                  <p className="text-danger-200/90">{actionError}</p>
                </div>
              </div>
            ) : null}
          </PanelBody>
        </Panel>

        <div className="space-y-4">
          <VideoMetadata file={upload.file} metadata={upload.metadata} isReading={upload.isReading} />
          <Panel>
            <PanelBody className="space-y-4">
              <div className="space-y-1">
                <p className="text-sm font-medium text-primary">Ready when you are</p>
                <p className="text-xs leading-relaxed text-muted">Processing runs on the server. Preset: <span className="text-primary">{selectedPreset.label}</span>.</p>
              </div>
              <Button className="w-full" size="lg" icon={Wand2} onClick={handleProcess} loading={busy} disabled={!canStart}>
                {busy ? 'Starting' : 'Generate clips'}
              </Button>
            </PanelBody>
          </Panel>
        </div>
      </div>
    </div>
  );
}