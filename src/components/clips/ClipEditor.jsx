import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeft,
  Check,
  CircleAlert,
  Copy,
  Download,
  Loader2,
  RotateCcw,
  Save,
  SkipBack,
  SkipForward,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { Button, IconButton } from '../common/Button.jsx';
import { Panel, PanelHeader } from '../common/Panel.jsx';
import { TextField, TextArea } from '../common/TextField.jsx';
import { SegmentedControl } from '../common/SegmentedControl.jsx';
import { EmptyState } from '../common/EmptyState.jsx';
import { Badge } from '../common/Badge.jsx';
import { ProgressBar } from '../common/ProgressBar.jsx';
import { ConfirmDialog } from '../common/Modal.jsx';
import { ClipPreview } from './ClipPreview.jsx';
import { ClipTimeline } from './ClipTimeline.jsx';
import { CaptionEditor } from './CaptionEditor.jsx';
import { ExportSettings } from './ExportSettings.jsx';
import { useClipEditor } from '../../hooks/useClips.js';
import { useApp } from '../../hooks/useApp.js';
import { useToast } from '../../hooks/useToast.js';
import { formatClock } from '../../utils/formatDuration.js';
import { downloadCaptions, downloadClipManifest, downloadTranscript } from '../../utils/download.js';
import { ASPECT_RATIOS } from '../../utils/constants.js';
import * as clipService from '../../services/clipService.js';
import { resolveUrl, downloadFile, sleep } from '../../services/api.js';

/** How often to ask the worker how the render is doing. */
const EXPORT_POLL_MS = 900;

/** Transcript rows, clickable to jump the playhead to that line. */
function TranscriptPanel({ transcript, currentTime, onSeek }) {
  if (!transcript?.length) {
    return (
      <p className="px-4 pb-4 text-[12.5px] text-faint sm:px-5 sm:pb-5">
        No transcript is attached to this clip yet.
      </p>
    );
  }

  return (
    <ol className="max-h-64 space-y-0.5 overflow-y-auto px-2 pb-3 scrollbar-thin">
      {transcript.map((segment, index) => {
        const active = currentTime >= segment.startSec && currentTime < segment.endSec;
        return (
          <li key={`${segment.startSec}-${index}`}>
            <button
              type="button"
              onClick={() => onSeek(segment.startSec)}
              aria-current={active ? 'true' : undefined}
              className={`flex w-full gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-ink-850 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-400 ${
                active ? 'bg-brand-500/10' : ''
              }`}
            >
              <span
                className={`tabular shrink-0 pt-px text-[11px] ${active ? 'text-brand-300' : 'text-faint'}`}
              >
                {formatClock(segment.startSec)}
              </span>
              <span
                className={`text-[12.5px] leading-relaxed ${active ? 'text-primary' : 'text-secondary'}`}
              >
                {segment.text}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The clip editing workspace.
 *
 * Owns its own state through `useClipEditor`, which seeds a draft from the
 * stored clip. The caller must pass `key={clipId}` so switching clips remounts
 * with a clean draft.
 *
 * Layout: preview + transport in the centre, controls on the left, captions and
 * export on the right. Everything stays visible at once because comparing the
 * frame against the trim handles is the whole task.
 */
export function ClipEditor({ clipId }) {
  const toast = useToast();
  const { setClipStatus, patchClip, trackExport, patchExport, settings, capabilities } = useApp();

  const {
    clip,
    project,
    draft,
    preset,
    bounds,
    isDirty,
    canExport,
    revert,
    save,
    setTrim,
    setTitle,
    setAspectRatio,
    setCaptionText,
    setCaptionPreset,
    setCaptionPosition,
    setCaptionSegments,
    setCaptionSettings,
    setExportSettings,
    setMeta,
  } = useClipEditor(clipId);

  const [isPlaying, setIsPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(draft?.startSec ?? 0);
  const [scrubTarget, setScrubTarget] = useState(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [showMarkers, setShowMarkers] = useState(true);

  /**
   * Render job state.
   *
   * `status` mirrors the server's own job resource so the button, the bar and
   * the download link can never disagree about what happened.
   */
  const [job, setJob] = useState(null);
  const [isExporting, setIsExporting] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [vaultItems, setVaultItems] = useState([]);
  const abortExportRef = useRef(null);

  // Never leave a render poll running after the editor unmounts.
  useEffect(() => () => abortExportRef.current?.abort(), []);

  useEffect(() => {
    let cancelled = false;
    clipService.listVault().then((items) => {
      if (!cancelled) setVaultItems(Array.isArray(items) ? items : []);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  /**
   * Adopt a render that already finished in an earlier session.
   *
   * Without this, `job` stays null on reload and the preview silently falls back
   * to the full source, so a completed export would never be shown.
   */
  useEffect(() => {
    const ownerProjectId = project?.id;
    if (!clipId || !ownerProjectId || job) return undefined;

    const controller = new AbortController();
    const { signal } = controller;

    // Scoping the request to the project keeps the lookup cheap; without it the
    // server returns every render this server has ever produced.
    clipService
      .listExports({ projectId: ownerProjectId, signal })
      .then((jobs) => {
        if (signal.aborted) return;
        // Newest first, so the first match is this clip's latest render.
        const latest = jobs.find((item) => item.clipId === clipId);
        if (!latest) return;
        setJob(latest);
        patchExport(latest.jobId ?? latest.id, latest);
      })
      .catch(() => {});

    return () => controller.abort();
  }, [clipId, project?.id, job, patchExport]);

  /**
   * Which file the preview should play.
   *
   * A completed render is the better source — it is already trimmed, captioned
   * and at the clip's aspect ratio — so it wins whenever one exists. The
   * `streamUrl` is the tokenless inline endpoint: `<video>` cannot attach an
   * Authorization header or fetch a token first, so the tokenised download link
   * is unusable here and would 403.
   */
  const renderJob = job;
  const isRenderReady =
    renderJob?.status === 'complete' && Boolean(renderJob?.streamUrl ?? renderJob?.url);
  const sourceUrl = isRenderReady
    ? resolveUrl(renderJob.streamUrl ?? renderJob.url)
    : (project?.objectUrl ? resolveUrl(project.objectUrl) : null);

  const durationSec = (draft?.endSec ?? 0) - (draft?.startSec ?? 0);

  // Hoisted so the callbacks below depend on plain values rather than on
  // optional chains the compiler cannot narrow inside a closure.
  const draftStart = draft?.startSec ?? 0;
  const draftEnd = draft?.endSec ?? 0;

  const seek = useCallback(
    (seconds) => {
      const clamped = Math.min(Math.max(seconds, draftStart), draftEnd);
      setPlayhead(clamped);
      setScrubTarget(clamped);
    },
    [draftStart, draftEnd]
  );

  /** Jump the playhead by `delta`, clamped to the trim window. */
  const nudge = useCallback(
    (delta) => {
      setPlayhead((current) => {
        const next = Math.min(Math.max(current + delta, draftStart), draftEnd);
        setScrubTarget(next);
        return next;
      });
    },
    [draftStart, draftEnd]
  );

  const timelineMarkers = useMemo(() => {
    if (!showMarkers || !draft) return [];
    const meta = draft.meta || clip?.meta || {};
    const markers = [];
    for (const s of (meta.audioSpikes || []).slice(0, 120)) {
      const t = Number(s?.t);
      if (Number.isFinite(t)) markers.push({ type: 'spike', t, label: 'Audio spike' });
    }
    for (const tRaw of (meta.sceneCuts || []).slice(0, 120)) {
      const t = Number(tRaw);
      if (Number.isFinite(t)) markers.push({ type: 'scene', t, label: 'Scene cut' });
    }
    for (const d of (meta.deadAirIntervals || []).slice(0, 60)) {
      const start = Number(d?.startSec ?? d?.start);
      const end = Number(d?.endSec ?? d?.end);
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
        markers.push({ type: 'dead', t: start, end, label: 'Dead air' });
      }
    }
    for (const s of (meta.sfxMarkers || []).slice(0, 60)) {
      const t = Number(s?.t);
      if (Number.isFinite(t)) markers.push({ type: 'sfx', t, label: s?.kind ? `SFX: ${s.kind}` : 'SFX marker' });
    }
    return markers;
  }, [showMarkers, draft, clip]);

  const jumpToNextMarker = () => {
    const start = draft?.startSec ?? 0;
    const end = draft?.endSec ?? start;
    const candidates = timelineMarkers
      .map((m) => Number(m.t))
      .filter((t) => Number.isFinite(t) && t >= start && t <= end && t > playhead + 0.2)
      .sort((a, b) => a - b);
    if (candidates.length) {
      seek(candidates[0]);
      return;
    }
    // Wrap to first marker in the selected clip window.
    const wrap = timelineMarkers
      .map((m) => Number(m.t))
      .filter((t) => Number.isFinite(t) && t >= start && t <= end)
      .sort((a, b) => a - b);
    if (wrap.length) seek(wrap[0]);
  };

  const onSave = () => {
    const saved = save();
    if (!saved) return;
    setPlayhead(saved.startSec);
    setIsPlaying(false);
    toast.success('Clip saved', { body: saved.title });
  };

  const onDiscard = () => {
    revert();
    setPlayhead(draft?.startSec ?? 0);
    setIsPlaying(false);
    toast.info('Changes discarded');
  };

  const onTogglePlay = () => setIsPlaying((value) => !value);

  /** Poll the render job until it finishes, fails or is cancelled. */
  const watchExport = useCallback(
    async (jobId) => {
      const controller = new AbortController();
      abortExportRef.current = controller;
      const { signal } = controller;
      setIsExporting(true);

      try {
        for (;;) {
          await sleep(EXPORT_POLL_MS, signal);

          let fresh;
          try {
            fresh = await clipService.getExportJob(jobId, { signal });
          } catch {
            // Transient poll failure: keep waiting rather than stranding a
            // render the worker is still doing.
            continue;
          }

          setJob(fresh);
          patchExport(fresh.jobId ?? jobId, fresh);

          if (fresh.status === 'complete') {
            setClipStatus([clipId], 'exported');
            patchClip(clipId, {
              export: { ...draft.export, lastExportedAt: fresh.completedAt ?? null },
            });
            toast.success('Render complete', { body: `${draft.title} is ready to download.` });
            return;
          }

          if (fresh.status === 'failed' || fresh.status === 'cancelled') {
            if (fresh.status === 'failed') {
              toast.error('Render failed', { body: fresh.error ?? 'The worker could not finish.' });
            }
            return;
          }
        }
      } catch {
        // Loop was cancelled; `onCancelExport` owns the user-facing message.
      } finally {
        if (abortExportRef.current === controller) abortExportRef.current = null;
        setIsExporting(false);
      }
    },
    [clipId, draft.export, draft.title, patchClip, patchExport, setClipStatus, toast]
  );

  /** Queue the render and follow it to completion. */
  const queueRender = async (overrides = {}) => {
    const saved = save();
    if (!saved || isExporting) return;
    const exportSettings = { ...saved.export, ...overrides };

    setIsExporting(true);
    setJob({ status: 'queued', progress: 0, preview: Boolean(exportSettings.preview) });

    try {
      const created = await clipService.exportClip(saved.id, {
        format: exportSettings.format,
        resolution: exportSettings.preview ? (exportSettings.resolution === '854x480' ? '854x480' : '480x854') : exportSettings.resolution,
        aspectRatio: saved.aspectRatio,
        burnCaptions: exportSettings.burnCaptions,
        captionPresetId: draft.caption?.presetId,
        captionText: draft.caption?.text,
        captionPosition: draft.caption?.position,
        captionSegments: draft.caption?.segments || undefined,
        keywordHighlight: Boolean(draft.caption?.keywordHighlight),
        highlightColor: draft.caption?.highlightColor || undefined,
        hookBanner: draft.hookBanner || undefined,
        renderMode: exportSettings.renderMode || 'default',
        backgroundAssetId: exportSettings.backgroundAssetId || undefined,
        preview: Boolean(exportSettings.preview),
        watermark: Boolean(exportSettings.watermark || exportSettings.preview),
        autoZoom: Boolean(exportSettings.autoZoom),
        deadAirRemoval: Boolean(exportSettings.deadAirRemoval),
        sfxEnabled: Boolean(exportSettings.sfxEnabled),
        facecamEnabled: Boolean(exportSettings.facecamEnabled),
        facecamAssetId: exportSettings.facecamAssetId || undefined,
        facecamBox: exportSettings.facecamBox || undefined,
        frameRate: exportSettings.frameRate ? Number(exportSettings.frameRate) : undefined,
      });

      trackExport({ ...created, clipId: saved.id, title: saved.title, preview: Boolean(exportSettings.preview) });
      setJob({ ...created, preview: Boolean(exportSettings.preview) });
      watchExport(created.jobId);
    } catch (error) {
      setIsExporting(false);
      setJob(null);
      toast.error('Could not queue the render', { body: error.message });
    }
  };

  const onExport = () => queueRender({ preview: false, watermark: Boolean(draft?.export?.watermark) });
  const onExportPreview = () => queueRender({ preview: true, watermark: true });
  const onApproveHD = () => queueRender({ preview: false, watermark: Boolean(draft?.export?.watermark), resolution: '1080x1920' });
  const onRerenderCaptions = () => queueRender({ captionOnly: true, burnCaptions: true, preview: Boolean(job?.preview) });

  /** Stop a queued or running render. */
  const onCancelExport = useCallback(async () => {
    const jobId = job?.jobId;
    abortExportRef.current?.abort();
    abortExportRef.current = null;
    setIsExporting(false);
    if (!jobId) return;

    try {
      const cancelled = await clipService.cancelExportJob(jobId);
      setJob(cancelled);
    } catch (error) {
      toast.error('Could not cancel the render', { body: error.message });
    }
  }, [job, toast]);

  /** Fetch the finished file through the tokenised link and save it. */
  const onDownloadVideo = async () => {
    if (!job?.jobId) return;
    setIsDownloading(true);
    try {
      const link = await clipService.getDownloadUrl(job.jobId);
      const extension = job.format ?? draft.export.format ?? 'mp4';
      const filename = `${(draft.title || 'clip').replace(/[^\w.-]+/g, '-').toLowerCase()}.${extension}`;
      await downloadFile(link.url, filename);
      toast.success('Downloaded', { body: filename });
    } catch (error) {
      toast.error('Download failed', { body: error.message });
    } finally {
      setIsDownloading(false);
    }
  };

  const onDownloadCaptions = () => {
    const name = downloadCaptions(draft ?? clip);
    toast.success(`Downloaded ${name}`);
  };

  const onDownloadTranscript = () => {
    const name = downloadTranscript(draft ?? clip, project);
    toast.success(`Downloaded ${name}`);
  };

  const onDownloadProject = () => {
    const name = downloadClipManifest(draft ?? clip, project, draft?.export);
    toast.success(`Downloaded ${name}`);
  };

  const statusOptions = useMemo(
    () => [
      { value: 'suggested', label: 'Suggested' },
      { value: 'selected', label: 'Selected' },
      { value: 'edited', label: 'Edited' },
    ],
    []
  );

  if (!clip || !draft) {
    return (
      <EmptyState
        icon={<CircleAlert className="size-5" />}
        title="Clip not found"
        description="It may have been discarded, or the link is out of date."
        action={
          <Button as={Link} to="/app/clips" variant="secondary">
            <ArrowLeft aria-hidden className="size-4" />
            Back to clips
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* --- Sticky action bar --- */}
      <div className="sticky top-16 z-30 -mx-4 border-b border-line bg-ink-950/85 px-4 py-3 backdrop-blur-md sm:-mx-6 sm:px-6">
        <div className="flex flex-wrap items-center gap-3">
          <Button as={Link} to="/app/clips" size="sm" variant="secondary">
            <ArrowLeft aria-hidden className="size-3.5" />
            Clips
          </Button>

          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[15px] font-semibold text-primary">{clip.title}</h1>
            <p className="tabular flex items-center gap-2 text-[11.5px] text-faint">
              <span>{formatClock(clip.startSec)} – {formatClock(clip.endSec)}</span>
              <span aria-hidden>·</span>
              <span>{formatClock(durationSec)} long</span>
              {isDirty && (
                <>
                  <span aria-hidden>·</span>
                  <span className="text-warning">Unsaved changes</span>
                </>
              )}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={onDiscard} disabled={!isDirty}>
              <RotateCcw aria-hidden className="size-3.5" />
              Discard
            </Button>
            <Button size="sm" onClick={onSave} disabled={!isDirty}>
              <Save aria-hidden className="size-3.5" />
              Save clip
            </Button>
          </div>
        </div>
      </div>

      {/* --- Workspace --- */}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        {/* Centre: preview + transport */}
        <div className="space-y-4">
          <Panel>
            <div className="relative aspect-9/16 max-h-[62vh] w-full overflow-hidden bg-black sm:aspect-video">
              <ClipPreview
                clip={draft}
                sourceUrl={sourceUrl}
                variant="player"
                currentTime={playhead}
                isPlaying={isPlaying}
                seekTo={scrubTarget}
                onTogglePlay={onTogglePlay}
                onPlayingChange={setIsPlaying}
                onTimeUpdate={setPlayhead}
                preset={preset}
                captionText={draft.caption?.text}
                showCaptions={settings.preferences.showCaptionsDefault}
                autoPlay={settings.preferences.autoplayPreview}
                timeBase={isRenderReady ? draft.startSec : 0}
                backgroundUrl={vaultItems.find((i) => i.id === draft.export?.backgroundAssetId)?.mediaUrl || null}
                facecamUrl={vaultItems.find((i) => i.id === draft.export?.facecamAssetId)?.mediaUrl || null}
              />
            </div>

            {/* Transport */}
            <div className="flex items-center gap-2 border-t border-line px-4 py-3 sm:px-5">
              <Button
                size="sm"
                variant="secondary"
                onClick={onTogglePlay}
                className="min-w-24"
                disabled={!sourceUrl}
                title={sourceUrl ? undefined : 'Upload this video in this session to preview it'}
              >
                {isPlaying ? (
                  <>
                    <span aria-hidden>❚❚</span> Pause
                  </>
                ) : (
                  <>
                    <span aria-hidden>▶</span> Preview
                  </>
                )}
              </Button>

              <IconButton
                label="Back 5 seconds"
                variant="ghost"
                onClick={() => nudge(-5)}
              >
                <SkipBack aria-hidden className="size-4" />
              </IconButton>
              <IconButton
                label="Forward 5 seconds"
                variant="ghost"
                onClick={() => nudge(5)}
              >
                <SkipForward aria-hidden className="size-4" />
              </IconButton>

              <p className="tabular ml-auto text-[12px] text-secondary">
                {formatClock(Math.max(0, playhead - draft.startSec))} /{' '}
                {formatClock(durationSec)}
              </p>
            </div>
          </Panel>

          <Panel>
            <div className="px-4 pt-4 pb-4 sm:px-5 sm:pb-5 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="rounded-md border border-line px-2 py-1 text-[11px] text-secondary hover:text-primary"
                  onClick={() => setShowMarkers((v) => !v)}
                >
                  {showMarkers ? 'Hide' : 'Show'} analysis markers
                </button>
                <button
                  type="button"
                  className="rounded-md border border-line px-2 py-1 text-[11px] text-secondary hover:text-primary"
                  onClick={jumpToNextMarker}
                  disabled={!timelineMarkers.length}
                >
                  Jump to next highlight
                </button>
                <span className="text-[11px] text-faint">
                  {timelineMarkers.length ? `${timelineMarkers.length} markers (spikes/cuts/dead-air/sfx)` : 'No analysis markers yet'}
                </span>
              </div>
              <ClipTimeline
                startSec={draft.startSec}
                endSec={draft.endSec}
                sourceDuration={bounds.sourceDuration}
                playheadSec={playhead}
                markers={showMarkers ? timelineMarkers : []}
                onChange={setTrim}
                onScrub={seek}
              />
            </div>
          </Panel>

          {!sourceUrl && (
            <p className="text-center text-[11px] leading-relaxed text-faint">
              The source video is not available on this project, so the preview shows a generated
              poster. The trim and captions are still applied exactly as shown.
            </p>
          )}
        </div>

        {/* Right: controls */}
        <div className="space-y-4">
          <Panel>
            <PanelHeader title="Clip details" />
            <div className="space-y-4 px-4 pb-4 sm:px-5 sm:pb-5">
              <TextField
                label="Title"
                value={draft.title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={90}
              />

              <div className="space-y-2">
                <p className="text-[13px] font-medium text-secondary">Aspect ratio</p>
                <div className="grid grid-cols-3 gap-1.5">
                  {ASPECT_RATIOS.map((item) => {
                    const selected = item.id === draft.aspectRatio;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setAspectRatio(item.id)}
                        aria-pressed={selected}
                        className={`flex flex-col items-center gap-1.5 rounded-lg border px-2 py-2.5 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400 ${
                          selected
                            ? 'border-brand-500/60 bg-brand-500/10'
                            : 'border-line-strong bg-ink-900 hover:border-line-hover'
                        }`}
                      >
                        {/* True ratio, so the options are self-explanatory. */}
                        <span
                          aria-hidden
                          className={`rounded-sm border ${selected ? 'border-brand-400' : 'border-line-strong'}`}
                          style={{
                            width: item.id === '1:1' ? 14 : item.id === '9:16' ? 9 : 20,
                            height: item.id === '1:1' ? 14 : item.id === '9:16' ? 16 : 11,
                          }}
                        />
                        <span className={`text-[11.5px] ${selected ? 'text-primary' : 'text-secondary'}`}>
                          {item.label}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-2">
                <p className="text-[13px] font-medium text-secondary">Status</p>
                <SegmentedControl
                  options={statusOptions}
                  value={clip.status}
                  onChange={(value) => setClipStatus([clip.id], value)}
                  fullWidth
                />
              </div>

              <div className="space-y-3 rounded-lg border border-line bg-ink-900/60 px-3 py-3">
                <div className="flex items-center gap-2">
                  <Sparkles aria-hidden className="size-3.5 shrink-0 text-brand-400" />
                  <p className="text-[11.5px] leading-relaxed text-secondary">
                    Hook score <span className="font-semibold text-primary">{clip.score}</span>
                    {' · '}Virality <span className="font-semibold text-primary">{draft.viralScore ?? clip.viralScore ?? clip.score}</span>
                  </p>
                </div>
                {Boolean((draft.meta || clip.meta)?.audioSpikes?.length || (draft.meta || clip.meta)?.sceneCuts?.length || (draft.meta || clip.meta)?.sfxMarkers?.length) && (
                  <p className="text-[11px] text-faint">
                    Attractive signals: {(draft.meta || clip.meta)?.audioSpikes?.length || 0} spikes, {(draft.meta || clip.meta)?.sceneCuts?.length || 0} scene cuts, {(draft.meta || clip.meta)?.sfxMarkers?.length || 0} SFX markers.
                  </p>
                )}
                <TextField
                  label="Hook banner"
                  value={draft.hookBanner ?? ''}
                  onChange={(e) => setMeta({ hookBanner: e.target.value })}
                  placeholder="2-5 word top banner"
                />
                <TextField
                  label="Hashtags"
                  value={(draft.hashtags || []).join(' ')}
                  onChange={(e) => setMeta({ hashtags: e.target.value.split(/\s+/).map((t) => t.trim()).filter(Boolean) })}
                  placeholder="#shorts #podcast"
                />
                <TextArea
                  label="Description"
                  rows={3}
                  value={draft.description ?? ''}
                  onChange={(e) => setMeta({ description: e.target.value })}
                />
                <div className="flex flex-wrap gap-2">
                  <Button size="xs" variant="secondary" onClick={() => navigator.clipboard?.writeText((draft.hashtags || []).join(' '))}>
                    <Copy aria-hidden className="size-3" />Copy hashtags
                  </Button>
                  <Button size="xs" variant="secondary" onClick={() => navigator.clipboard?.writeText(draft.description || '')}>
                    <Copy aria-hidden className="size-3" />Copy description
                  </Button>
                </div>
              </div>
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="Captions" subtitle="Edits re-render on the preview immediately." />
            <div className="px-4 pb-4 sm:px-5 sm:pb-5">
              <CaptionEditor
                caption={draft.caption?.text ?? ''}
                captionSettings={draft.caption}
                presetId={draft.caption?.presetId}
                onChangeText={setCaptionText}
                onChangePreset={setCaptionPreset}
                onChangeCaption={setCaptionSettings}
                originalText={clip.caption?.text ?? ''}
                position={draft.caption?.position ?? preset?.style?.position ?? 'lower'}
                onChangePosition={setCaptionPosition}
                segments={draft.caption?.segments ?? []}
                onChangeSegments={setCaptionSegments}
                clipStartSec={draft.startSec}
                clipEndSec={draft.endSec}
              />

              {(draft.export?.renderMode === 'split_screen' || project?.presetId === 'split_screen') && (
                <div className="rounded-lg border border-line bg-ink-900/40 p-3 space-y-2">
                  <p className="text-[12px] font-semibold text-secondary uppercase tracking-wide">1-click background swap</p>
                  <p className="text-[11px] text-faint">Swaps gameplay background for export only; no reanalysis needed. Save to persist.</p>
                  <div className="flex flex-wrap gap-2">
                    {vaultItems.slice(0, 8).map((item) => {
                      const active = draft.export?.backgroundAssetId === item.id;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => setExportSettings({ renderMode: 'split_screen', backgroundAssetId: item.id })}
                          className={`rounded-md border px-2 py-1 text-[11px] ${active ? 'border-brand-400 bg-brand-500/15 text-brand-200' : 'border-line text-secondary hover:text-primary'}`}
                        >
                          {item.title || item.id}
                        </button>
                      );
                    })}
                    {!vaultItems.length && <span className="text-[11px] text-faint">No vault assets configured.</span>}
                  </div>
                </div>
              )}
            </div>
          </Panel>

          <Panel>
            <PanelHeader
              title="Transcript"
              subtitle="Click any line to jump the playhead there."
              actions={
                <Badge tone="outline" size="xs">
                  {clip.transcript?.length ?? 0} lines
                </Badge>
              }
            />
            <TranscriptPanel
              transcript={clip.transcript}
              currentTime={playhead}
              onSeek={seek}
            />
          </Panel>

          <ExportSettings
            clip={draft}
            aspectRatio={draft.aspectRatio}
            onChangeAspectRatio={setAspectRatio}
            settings={draft.export}
            onChange={setExportSettings}
            onExport={onExport}
            onExportPreview={onExportPreview}
            onDownloadCaptions={onDownloadCaptions}
            onDownloadTranscript={onDownloadTranscript}
            onDownloadProject={onDownloadProject}
            isExporting={isExporting}
            canExport={canExport}
            vaultItems={vaultItems}
            capabilities={capabilities}
          />

          {/* Live render state, driven by the server's job resource. */}
          {job && (
            <Panel>
              <PanelHeader
                title="Render job"
                subtitle={
                  job.status === 'complete'
                    ? 'Finished on the server.'
                    : job.status === 'failed'
                      ? (job.error ?? 'The worker could not finish this render.')
                      : job.status === 'cancelled'
                        ? 'Cancelled before it finished.'
                        : 'Encoding on the backend.'
                }
                actions={
                  job.status === 'complete' ? (
                    <div className="flex items-center gap-2">
                      <Button size="xs" variant="ghost" onClick={onRerenderCaptions} disabled={isExporting}>
                        Re-render captions
                      </Button>
                      {job.preview && (
                        <Button size="xs" variant="secondary" onClick={onApproveHD} disabled={isExporting}>
                          Approve & Export HD
                        </Button>
                      )}
                      <Button size="xs" loading={isDownloading} onClick={onDownloadVideo}>
                        <Download aria-hidden className="size-3.5" />
                        Download
                      </Button>
                    </div>
                  ) : isExporting ? (
                    <Button size="xs" variant="ghost" onClick={onCancelExport}>
                      Cancel
                    </Button>
                  ) : null
                }
              />
              <div className="px-4 pb-4 sm:px-5 sm:pb-5">
                {isExporting ? (
                  <>
                    <ProgressBar
                      value={job.progress ?? 0}
                      label="Render progress"
                      showValue
                    />
                    <p className="tabular mt-2 flex items-center gap-1.5 text-[11px] text-faint">
                      <Loader2 aria-hidden className="size-3 animate-spin" />
                      {Math.round(job.progress ?? 0)}% encoded
                    </p>
                  </>
                ) : (
                  <p className="tabular flex items-center gap-1.5 text-[11px] text-faint">
                    {job.status === 'complete' ? (
                      <>
                        <Check aria-hidden className="size-3 text-success" />
                        {job.preview ? 'Preview ready' : 'HD render ready'}
                        {job.sizeBytes ? ` · ${Math.round(job.sizeBytes / 1024)} KB` : ''}
                        {job.durationSec ? ` · ${formatClock(job.durationSec)}` : ''}
                      </>
                    ) : (
                      <>
                        <CircleAlert aria-hidden className="size-3 text-warning" />
                        {job.status}
                      </>
                    )}
                  </p>
                )}
              </div>
            </Panel>
          )}

          <Button
            variant="danger"
            size="sm"
            fullWidth
            onClick={() => setConfirmDiscard(true)}
          >
            <Trash2 aria-hidden className="size-3.5" />
            Discard this clip
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDiscard}
        onClose={() => setConfirmDiscard(false)}
        onConfirm={async () => {
          setConfirmDiscard(false);
          try {
            await clipService.deleteClip(clip.id);
            setClipStatus([clip.id], 'suggested');
            toast.info('Clip returned to suggestions');
          } catch (error) {
            toast.error('Could not discard this clip', { body: error.message });
          }
        }}
        title="Remove from selection?"
        message="The clip stays in your library as a suggestion. This cannot be undone from here."
        confirmLabel="Reset clip"
      />

      <p className="flex items-center justify-center gap-1.5 pb-2 text-[11px] text-faint">
        <Check aria-hidden className="size-3 text-success" />
        Changes are saved to your ClipForge server.
      </p>
    </div>
  );
}