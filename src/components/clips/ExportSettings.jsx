import { AlertTriangle, Check, Download, FileText, Loader, Wand2 } from 'lucide-react';
import { Button } from '../common/Button.jsx';
import { Toggle } from '../common/Toggle.jsx';
import { Select } from '../common/Select.jsx';
import { Panel, PanelHeader } from '../common/Panel.jsx';
import { ASPECT_RATIOS, ASPECT_RATIO_MAP, EXPORT_FORMATS, EXPORT_RESOLUTIONS, RENDER_MODES } from '../../utils/constants.js';
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
  onExportPreview,
  onDownloadCaptions,
  onDownloadTranscript,
  onDownloadProject,
  isExporting = false,
  progress = 0,
  canExport = true,
  vaultItems = [],
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

        <Select
          label="Frame rate"
          value={String(settings.frameRate || 30)}
          onChange={(value) => onChange({ frameRate: Number(value) })}
          options={[
            { value: '30', label: '30 fps — Standard' },
            { value: '60', label: '60 fps — Smooth (HD/gaming)' },
          ]}
        />

        <Select
          label="Render mode"
          value={settings.renderMode || 'default'}
          onChange={(value) => onChange({ renderMode: value })}
          options={RENDER_MODES.map((item) => ({ value: item.id, label: `${item.label} — ${item.description}` }))}
        />

        {(settings.renderMode === 'split_screen') && (
          <Select
            label="Gameplay background"
            value={settings.backgroundAssetId || ''}
            onChange={(value) => onChange({ backgroundAssetId: value || null })}
            options={[
              { value: '', label: vaultItems.length ? 'Select gameplay from vault' : 'No vault assets found' },
              ...vaultItems.map((item) => ({ value: item.id, label: item.title || item.id })),
            ]}
          />
        )}

        {(settings.renderMode === 'gaming' && settings.facecamEnabled) && (
          <div className="space-y-3 rounded-lg border border-line bg-ink-900/40 p-3">
            <Select
              label="Facecam asset"
              value={settings.facecamAssetId || ''}
              onChange={(value) => onChange({ facecamAssetId: value || null })}
              options={[
                { value: '', label: vaultItems.length ? 'Select facecam/video overlay from vault' : 'No vault assets found' },
                ...vaultItems.map((item) => ({ value: item.id, label: item.title || item.id })),
              ]}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              {[
                ['x', 'Facecam X'],
                ['y', 'Facecam Y'],
                ['w', 'Facecam width'],
                ['h', 'Facecam height'],
              ].map(([key, label]) => (
                <label key={key} className="text-[11px] text-secondary">
                  <span className="mb-1 block">{label} ({Math.round((settings.facecamBox?.[key] ?? 0) * 100)}%)</span>
                  <input
                    type="range"
                    min={key === 'w' || key === 'h' ? 10 : 0}
                    max={key === 'w' || key === 'h' ? 60 : 95}
                    value={Math.round((settings.facecamBox?.[key] ?? (key === 'w' || key === 'h' ? 0.24 : key === 'x' ? 0.72 : 0.04)) * 100)}
                    onChange={(e) => {
                      const v = Number(e.target.value) / 100;
                      onChange({ facecamBox: { ...(settings.facecamBox || { x: 0.72, y: 0.04, w: 0.24, h: 0.24 }), [key]: v } });
                    }}
                    className="w-full"
                  />
                </label>
              ))}
            </div>
            <p className="text-[11px] text-faint">Manual PiP override. Auto-extraction is best-effort; use this to place/size facecam.</p>
          </div>
        )}

        <Toggle
          id="burn-captions"
          checked={settings.burnCaptions}
          onChange={(value) => onChange({ burnCaptions: value })}
          label="Burn in captions"
          description="Render the caption track into the video. Turn off for a clean cut."
        />

        <div className="grid gap-3 sm:grid-cols-2">
          <Toggle
            id="preview-render"
            checked={Boolean(settings.preview)}
            onChange={(value) => onChange({ preview: value, resolution: value ? '480x854' : settings.resolution, frameRate: value ? 30 : (settings.frameRate || 30) })}
            label="Quick preview (480p)"
            description="Fast low-res approval render before HD export."
          />
          <Toggle
            id="watermark"
            checked={Boolean(settings.watermark)}
            onChange={(value) => onChange({ watermark: value })}
            label="Free watermark"
            description="Add ClipForge watermark for demo/free tier."
          />
          <Toggle
            id="auto-zoom"
            checked={Boolean(settings.autoZoom)}
            onChange={(value) => onChange({ autoZoom: value })}
            label="Auto zoom"
            description="Subtle zoom punch-ins for podcast/gaming moments."
          />
          <Toggle
            id="dead-air"
            checked={Boolean(settings.deadAirRemoval)}
            onChange={(value) => onChange({ deadAirRemoval: value })}
            label="Dead-air removal"
            description="Skip detected silent gaps during render (best effort)."
          />
          <Toggle
            id="sfx-hooks"
            checked={Boolean(settings.sfxEnabled)}
            onChange={(value) => onChange({ sfxEnabled: value })}
            label="SFX hooks"
            description="Mix subtle marker-based SFX when enabled on server (best-effort)."
          />
          <Toggle
            id="facecam-pip"
            checked={Boolean(settings.facecamEnabled)}
            onChange={(value) => onChange({ facecamEnabled: value })}
            label="Facecam PiP"
            description="Overlay facecam for gaming mode (manual asset)."
          />
        </div>

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

        <div className="grid gap-2 sm:grid-cols-2">
          <Button
            fullWidth
            size="md"
            variant="secondary"
            onClick={onExportPreview}
            loading={isExporting && Boolean(settings.preview)}
            disabled={!canExport || isExporting}
          >
            <Wand2 aria-hidden className="size-4" />
            Quick 480p preview
          </Button>
          <Button
            fullWidth
            size="md"
            onClick={() => onExport?.()}
            loading={isExporting && !settings.preview}
            disabled={!canExport || isExporting}
          >
            {isExporting && !settings.preview ? (
              <>
                <Loader aria-hidden className="size-4 animate-spin" />
                Queueing render…
              </>
            ) : (
              <>
                <Download aria-hidden className="size-4" />
                Export HD
              </>
            )}
          </Button>
        </div>

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
