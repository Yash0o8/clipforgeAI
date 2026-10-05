import { Clock, Film, Gauge, HardDrive, MonitorPlay } from 'lucide-react';
import { MetaRow, Panel, PanelHeader } from '../common/Panel.jsx';
import { DotsLoader } from '../common/Loader.jsx';
import { getFormatLabel } from '../../utils/fileValidation.js';
import { formatBytes, formatDurationLong } from '../../utils/formatDuration.js';

/**
 * Facts about the selected file, read from the browser's own metadata APIs.
 *
 * Unknown values render as "Reading…" or an em dash rather than a fabricated
 * zero, because a wrong duration would quietly corrupt the clip timeline later.
 */
export function VideoMetadata({ file, metadata, isReading = false, title, onTitleChange }) {
  if (!file) return null;

  const dimensions =
    metadata.width && metadata.height ? `${metadata.width} x ${metadata.height}` : null;

  return (
    <Panel>
      <PanelHeader
        title={title ?? 'Selected video'}
        subtitle={isReading ? 'Reading file metadata…' : undefined}
        actions={
          title && onTitleChange ? null : (
            <span className="rounded-md border border-line-strong px-2 py-1 text-[11px] font-medium text-secondary">
              {getFormatLabel(file)}
            </span>
          )
        }
      >
        {title && onTitleChange && (
          <label className="mt-2.5 block space-y-1.5">
            <span className="block text-[12px] font-medium text-secondary">Project name</span>
            <input
              type="text"
              value={title}
              onChange={(event) => onTitleChange(event.target.value)}
              maxLength={80}
              placeholder="Give this project a name"
              className="h-9 w-full rounded-lg border border-line-strong bg-ink-925 px-3 text-[13px] text-primary placeholder:text-faint focus:border-brand-500 focus:ring-2 focus:ring-brand-500/25 focus:outline-none"
            />
          </label>
        )}
      </PanelHeader>

      <div className="px-4 pb-4 sm:px-5 sm:pb-5">
        {isReading ? (
          <p className="flex items-center gap-2 py-2 text-[12.5px] text-secondary">
            <DotsLoader label="Reading metadata" />
            Reading duration and dimensions
          </p>
        ) : (
          <dl className="divide-y divide-line">
            <MetaRow
              label="File name"
              value={<span className="block max-w-[16rem] truncate">{file.name}</span>}
            />
            <MetaRow label="Size" value={formatBytes(file.size)} />
            <MetaRow label="Type" value={getFormatLabel(file)} />

            <MetaRow
              label="Duration"
              value={
                <span className="inline-flex items-center justify-end gap-1.5">
                  <Clock aria-hidden className="size-3 text-faint" />
                  {metadata.durationSec
                    ? formatDurationLong(metadata.durationSec)
                    : 'Unavailable in this browser'}
                </span>
              }
            />
            <MetaRow
              label="Resolution"
              value={
                <span className="inline-flex items-center justify-end gap-1.5">
                  <MonitorPlay aria-hidden className="size-3 text-faint" />
                  {dimensions ?? 'Unavailable'}
                </span>
              }
            />
            <MetaRow
              label="Storage"
              value={
                <span className="inline-flex items-center justify-end gap-1.5 text-secondary">
                  <HardDrive aria-hidden className="size-3 text-faint" />
                  This browser only
                </span>
              }
            />
          </dl>
        )}

        <p className="mt-3.5 flex items-start gap-2 rounded-lg border border-line bg-ink-900/60 px-3 py-2.5 text-[11.5px] leading-relaxed text-faint">
          <Gauge aria-hidden className="mt-px size-3.5 shrink-0" />
          <span>
            Your file is uploaded to your own ClipForge backend and processed there. Nothing
            is sent to a third-party service.
          </span>
        </p>
      </div>
    </Panel>
  );
}

/** Compact metadata row used under a project thumbnail in lists. */
export function InlineMetadata({ project, clipCount = 0 }) {
  return (
    <div className="tabular flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-faint">
      <span className="inline-flex items-center gap-1">
        <Clock aria-hidden className="size-3" />
        {formatDurationLong(project.durationSec ?? 0)}
      </span>
      <span className="inline-flex items-center gap-1">
        <Film aria-hidden className="size-3" />
        {clipCount} {clipCount === 1 ? 'clip' : 'clips'}
      </span>
    </div>
  );
}
