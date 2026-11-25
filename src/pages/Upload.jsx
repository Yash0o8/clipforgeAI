import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Link2, Upload as UploadIcon, Wand2 } from 'lucide-react';
import { Panel, PanelBody, PanelHeader } from '../components/common/Panel.jsx';
import { Button } from '../components/common/Button.jsx';
import { ErrorState } from '../components/common/EmptyState.jsx';
import { SegmentedControl } from '../components/common/SegmentedControl.jsx';
import { Select } from '../components/common/Select.jsx';
import { TextField } from '../components/common/TextField.jsx';
import { VideoDropzone } from '../components/upload/VideoDropzone.jsx';
import { UploadProgress } from '../components/upload/UploadProgress.jsx';
import { VideoMetadata } from '../components/upload/VideoMetadata.jsx';
import { useVideoUpload } from '../hooks/useVideoUpload.js';
import { useApp } from '../hooks/useApp.js';
import * as projectService from '../services/projectService.js';
import { getDeviceId } from '../services/billingService.js';
import { CREATION_PRESETS, NOTIFICATION_TONE } from '../utils/constants.js';

const SOURCE_OPTIONS = [
  { value: 'upload', label: 'Upload file', icon: <UploadIcon aria-hidden className="size-3.5" /> },
  { value: 'youtube', label: 'YouTube URL', icon: <Link2 aria-hidden className="size-3.5" /> },
];

export function UploadPage() {
  const navigate = useNavigate();
  const upload = useVideoUpload();
  const { addProject, notify } = useApp();
  const [actionError, setActionError] = useState(null);
  const [isStarting, setIsStarting] = useState(false);
  const [sourceMode, setSourceMode] = useState('upload');
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [presetId, setPresetId] = useState('podcast');
  const [titleOverride, setTitleOverride] = useState(null);
  const [transcriptionHint, setTranscriptionHint] = useState('auto');
  const [transcriptionQuality, setTranscriptionQuality] = useState('auto');
  const [ingestStatus, setIngestStatus] = useState('');
  const [ingestElapsed, setIngestElapsed] = useState(0);
  const [waitingForIngest, setWaitingForIngest] = useState(false);
  const ingestCancelRef = useRef(false);

  const defaultTitle = upload.file ? upload.file.name.replace(/\.[^.]+$/, '') : '';
  const projectTitle = titleOverride ?? defaultTitle;

  // A new file gets its own sensible title; an explicit rename survives re-renders.
  const selectFiles = (files) => {
    setTitleOverride(null);
    upload.selectFiles(files);
  };

  // Show real elapsed time while the backend downloads/probes a YouTube source.
  useEffect(() => {
    if (!waitingForIngest) return undefined;
    const timer = setInterval(() => setIngestElapsed((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [waitingForIngest]);

  const selectedPreset = CREATION_PRESETS.find((p) => p.id === presetId) ?? CREATION_PRESETS[0];
  const settings = {
    renderMode: selectedPreset.renderMode,
    captionPreset: selectedPreset.captionPreset,
    transcriptionHint: transcriptionHint === 'auto' ? undefined : transcriptionHint,
    transcriptionQuality,
  };

  const stopWaiting = () => {
    ingestCancelRef.current = true;
    setWaitingForIngest(false);
    setIngestStatus('Stopped waiting for ingest. The import may still finish on the server.');
  };

  const handleProcess = async () => {
    if (isStarting) return;
    setActionError(null);
    setIsStarting(true);
    setIngestElapsed(0);
    ingestCancelRef.current = false;

    try {
      let project;
      if (sourceMode === 'youtube') {
        if (!youtubeUrl.trim()) throw new Error('Paste a YouTube URL first.');
        setIngestStatus('Queueing YouTube ingest…');
        setWaitingForIngest(true);
        const ingest = await projectService.ingestYoutube({
          url: youtubeUrl.trim(),
          title: projectTitle || youtubeUrl.trim(),
          presetId,
          settings,
        });
        project = await projectService.getProject(ingest.projectId);
        addProject(project);

        // Wait for ingest to finish downloading/probing before processing.
        for (let i = 0; i < 180; i += 1) {
          if (ingestCancelRef.current) return;
          setIngestStatus(
            project?.status === 'processing'
              ? 'Downloading and probing YouTube media…'
              : `Ingest status: ${project?.status || 'queued'}…`
          );
          if (project?.status === 'failed') throw new Error(project.error || 'YouTube ingest failed.');
          if (project?.assetPath || project?.objectUrl || project?.hasLocalSource) break;
          await new Promise((resolve) => { setTimeout(resolve, 1500); });
          project = await projectService.getProject(ingest.projectId);
          addProject(project);
        }
        if (ingestCancelRef.current) return;
        if (!project?.hasLocalSource && !project?.objectUrl) {
          throw new Error('YouTube ingest did not produce a media file.');
        }
        setIngestStatus('Media ready. Starting AI processing…');
        await projectService.processProject(project.id, { deviceId: getDeviceId() });
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
          title: projectTitle.trim() || defaultTitle,
          durationSec: upload.metadata.durationSec ?? 0,
          fileSize: upload.file.size,
          fileName: upload.file.name,
          mimeType: upload.file.type,
          uploadId,
          presetId,
          settings,
        });
        project = { ...project, objectUrl: upload.objectUrl ?? project.objectUrl };
        await projectService.processProject(project.id, { deviceId: getDeviceId() });
      }

      addProject(project);
      navigate(`/app/projects/${project.id}/processing`);
    } catch (error) {
      const message = error?.message ?? 'Could not start processing.';
      setActionError(message);
      notify({ tone: NOTIFICATION_TONE.ERROR, title: 'Processing could not start', body: message });
    } finally {
      setWaitingForIngest(false);
      setIsStarting(false);
    }
  };

  const busy = upload.status === 'uploading' || isStarting;
  const canStart = sourceMode === 'youtube' ? Boolean(youtubeUrl.trim()) : Boolean(upload.file) && upload.status !== 'error';
  const transferActive = upload.status === 'uploading' || upload.status === 'uploaded';

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
          <PanelHeader title="Source & preset" subtitle="Choose an input and the creation mode that fits your content." />
          <PanelBody className="space-y-5">
            <SegmentedControl
              label="Input source"
              options={SOURCE_OPTIONS}
              value={sourceMode}
              onChange={(value) => {
                setSourceMode(value);
                setActionError(null);
              }}
              size="sm"
            />

            {sourceMode === 'youtube' ? (
              <div className="space-y-3">
                <TextField
                  label="YouTube URL"
                  value={youtubeUrl}
                  onChange={(event) => setYoutubeUrl(event.target.value)}
                  placeholder="https://www.youtube.com/watch?v=..."
                  hint="We'll fetch the video, transcribe it, and generate clips."
                />
                {waitingForIngest && (
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-brand-500/25 bg-brand-500/[0.07] px-3 py-2.5">
                    <p className="tabular text-[12.5px] text-brand-200" role="status" aria-live="polite">
                      {ingestStatus} <span className="text-faint">· {ingestElapsed}s elapsed</span>
                    </p>
                    <Button size="xs" variant="secondary" onClick={stopWaiting}>Stop waiting</Button>
                  </div>
                )}
              </div>
            ) : (
              <>
                <VideoDropzone
                  onFiles={selectFiles}
                  errors={upload.errors}
                  hasFile={upload.hasFile}
                  fileName={upload.file?.name}
                  onClear={upload.reset}
                  disabled={busy}
                />
                {upload.status === 'error' && upload.error && (
                  <ErrorState
                    title="Upload failed"
                    message={upload.error.message ?? 'The server did not accept the file. Try again.'}
                    onRetry={handleProcess}
                    retryLabel="Retry upload"
                  />
                )}
                {transferActive && (
                  <UploadProgress
                    file={upload.file}
                    progress={upload.progress}
                    phase={upload.phase}
                    onCancel={upload.status === 'uploading' ? upload.cancelUpload : undefined}
                  />
                )}
              </>
            )}

            <div className="space-y-2.5">
              <p className="text-sm font-medium text-primary">Vibe preset</p>
              <div role="radiogroup" aria-label="Vibe preset" className="grid gap-3 sm:grid-cols-3">
                {CREATION_PRESETS.map((preset) => {
                  const active = preset.id === presetId;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => setPresetId(preset.id)}
                      className={`rounded-card border p-3 text-left transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400 ${
                        active
                          ? 'border-brand-500 bg-brand-500/10 ring-1 ring-brand-500/30'
                          : 'border-line-strong bg-ink-900 hover:border-brand-500/40 hover:bg-ink-850'
                      }`}
                    >
                      <p className="text-sm font-semibold text-primary">{preset.label}</p>
                      <p className="mt-1 text-xs leading-relaxed text-secondary">{preset.description}</p>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Select
                label="Transcription language"
                value={transcriptionHint}
                onChange={setTranscriptionHint}
                options={[
                  { value: 'auto', label: 'Auto detect' },
                  { value: 'hinglish_roman', label: 'Hindi + Roman Hinglish' },
                ]}
              />
              <Select
                label="Speed / accuracy"
                value={transcriptionQuality}
                onChange={setTranscriptionQuality}
                options={[
                  { value: 'auto', label: 'Auto — fast for long videos' },
                  { value: 'fast', label: 'Fast — quickest, slightly less accurate' },
                  { value: 'accuracy', label: 'Accuracy — slowest, best detail' },
                ]}
              />
            </div>
            <p className="text-[11px] leading-relaxed text-faint">
              Videos over 60 minutes switch to the fast preset automatically. Long jobs show live
              transcription progress; you can leave this page and come back.
            </p>

            {ingestStatus && !waitingForIngest && (
              <div className="rounded-lg border border-brand-500/25 bg-brand-500/[0.07] px-3 py-2 text-[12.5px] text-brand-200" role="status">
                {ingestStatus}
              </div>
            )}

            {actionError && (
              <div role="alert" className="flex items-start gap-3 rounded-lg border border-danger/30 bg-danger/[0.07] px-3 py-3 text-sm text-danger">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <div className="space-y-1">
                  <p className="font-medium">Could not start processing</p>
                  <p className="text-secondary">{actionError}</p>
                </div>
              </div>
            )}
          </PanelBody>
        </Panel>

        <div className="space-y-4">
          <VideoMetadata
            file={upload.file}
            metadata={upload.metadata}
            isReading={upload.isReading}
            title={sourceMode === 'upload' && upload.file ? projectTitle : undefined}
            onTitleChange={sourceMode === 'upload' ? setTitleOverride : undefined}
          />
          <Panel>
            <PanelBody className="space-y-4">
              <div className="space-y-1">
                <p className="text-sm font-medium text-primary">Ready when you are</p>
                <p className="text-xs leading-relaxed text-secondary">
                  Processing runs on your own server. Preset:{' '}
                  <span className="font-semibold text-primary">{selectedPreset.label}</span>.
                </p>
              </div>
              <Button className="w-full" size="lg" onClick={handleProcess} loading={busy} disabled={!canStart}>
                <Wand2 aria-hidden className="size-4" />
                {busy ? 'Starting…' : 'Generate clips'}
              </Button>
              {!canStart && (
                <p className="text-center text-[11.5px] text-faint">
                  {sourceMode === 'youtube' ? 'Paste a URL to continue.' : 'Choose a video to continue.'}
                </p>
              )}
            </PanelBody>
          </Panel>
        </div>
      </div>
    </div>
  );
}
