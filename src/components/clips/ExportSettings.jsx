import { AlertTriangle, Check, Download, FileText, Loader } from 'lucide-react';
import { Button } from '../common/Button.jsx';
import { Toggle } from '../common/Toggle.jsx';
import { Select } from '../common/Select.jsx';
import { Panel, PanelHeader } from '../common/Panel.jsx';
import { ASPECT_RATIOS, ASPECT_RATIO_MAP, EXPORT_FORMATS, EXPORT_RESOLUTIONS } from '../../utils/constants.js';
import { formatBytes } from '../../utils/formatDuration.js';

/** Estimated output size from bitrate heuristics. */
function estimateSize({ durationSec, width, height }) {
  // ~0.09 bits per pixel per second is a reasonable H.264 average for social.
  const bitsPerSecond = width * height * 0.09;
  const megabytes = (bitsPerSecond * durationSec) / 8 / 1000 ** 2;
  return Math.max(1, Math.round(megabytes));
}

/**
 * Export configuration and the export action.
 *
 * Video rendering is clearly marked as backend-only. The caption/transcript
 * sidecar is a real, working download generated in the browser.
 */
export function ExportSettings({
  clip,
  aspectRatio,
  onChangeAspectRatio,
  settings,
  onChange,
  onExport,
  onDownloadCaptions,
  onDownloadTranscript,
  onDownloadProject,
  isExporting = false,
  progress = 0,
  canExport = true,
  className = '',
}) {
  // The aspect ratio lives on the clip, not the render settings, so one preview
  // frame always matches what will actually be rendered.
  const aspect = ASPECT_RATIO_MAP[aspectRatio] ?? ASPECT_RATIO_MAP['9:16'];
  const resolution = EXPORT_RESOLUTIONS.find((item) => item.id === settings.resolution);
  const width = resolution ? Number(resolution.id.split('x')[0]) : aspect.width;
  const height = resolution ? Number(resolution.id.split('x')[1]) : aspect.height;

  const estimated = estimateSize({ durationSec: clip?.durationSec ?? 0, width, height });

  return (
    <Panel className={className}>
      <PanelHeader
        title="Export"
        subtitle="Configure the render, or download caption data as text."
      />

      <div className="space-y-4 px-4 pb-4 sm:px-5 sm:pb-5">
        <Select
          label="Aspect ratio"
          value={aspectRatio}
          onChange={onChangeAspectRatio}
          options={ASPECT_RATIOS.map((item) => ({
            value: item.id,
            label: `${item.label} — ${item.name} (${item.hint})`,
          }))}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            label="Format"
            value={settings.format}
            onChange={(value) => onChange({ format: value })}
            options={EXPORT_FORMATS.map((item) => ({ value: item.id, label: item.label }))}
          />
          <Select
            label="Resolution"
            value={settings.resolution}
            onChange={(value) => onChange({ resolution: value })}
            options={EXPORT_RESOLUTIONS.map((item) => ({
              value: item.id,
              label: `${item.label} — ${item.note}`,
            }))}
          />
        </div>

        <Toggle
          id="burn-captions"
          checked={settings.burnCaptions}
          onChange={(value) => onChange({ burnCaptions: value })}
          label="Burn in captions"
          description="Render the caption track into the video. Turn off for a clean cut."
        />

        <p className="tabular flex items-center justify-between rounded-lg border border-line bg-ink-900/60 px-3 py-2 text-[11.5px] text-secondary">
          <span>Estimated size</span>
          <span className="font-medium text-primary">~{formatBytes(estimated * 1000 ** 2)}</span>
        </p>

        {!canExport && (
          <p className="flex items-start gap-2 rounded-lg border border-warning/25 bg-warning/[0.07] px-3 py-2.5 text-[11.5px] leading-relaxed text-warning">
            <AlertTriangle aria-hidden className="mt-px size-3.5 shrink-0" />
            <span>
              This project is still processing. Exports unlock once highlight detection finishes.
            </span>
          </p>
        )}

        <Button
          fullWidth
          size="md"
          onClick={onExport}
          loading={isExporting}
          disabled={!canExport}
        >
          {isExporting ? (
            <>
              <Loader aria-hidden className="size-4 animate-spin" />
              Queueing render…
            </>
          ) : (
            <>
              <Download aria-hidden className="size-4" />
              Export {settings.format.toUpperCase()}
            </>
          )}
        </Button>

        {isExporting && (
          <p className="tabular text-center text-[11px] text-faint">{Math.round(progress)}% queued</p>
        )}

        {/* --- Real, working downloads --- */}
        <div className="space-y-2.5 border-t border-line pt-4">
          <p className="text-[12px] font-semibold tracking-wide text-secondary uppercase">
            Caption data
          </p>
          <p className="text-[11.5px] leading-relaxed text-faint">
            These files are generated in your browser and download immediately. The video render
            above is encoded on the backend with FFmpeg.
          </p>

          <div className="flex flex-wrap gap-2">
            <Button size="xs" variant="secondary" onClick={onDownloadCaptions}>
              <FileText aria-hidden className="size-3" />
              .SRT captions
            </Button>
            <Button size="xs" variant="secondary" onClick={onDownloadTranscript}>
              <FileText aria-hidden className="size-3" />
              Transcript .TXT
            </Button>
            <Button size="xs" variant="secondary" onClick={onDownloadProject}>
              <FileText aria-hidden className="size-3" />
              Clip settings .JSON
            </Button>
          </div>
        </div>

        {settings.lastExportedAt && (
          <p className="flex items-center gap-1.5 text-[11.5px] text-success">
            <Check aria-hidden className="size-3" />
            Rendered {new Date(settings.lastExportedAt).toLocaleString('en-GB')}
          </p>
        )}
      </div>
    </Panel>
  );
}
