import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  Check,
  Download,
  Pencil,
  Play,
  Square,
  Trash2,
} from 'lucide-react';
import { Badge, ScoreBadge } from '../common/Badge.jsx';
import { CLIP_STATUS, CLIP_STATUS_META } from '../../utils/constants.js';
import { formatClock, formatDate, describeClipLength } from '../../utils/formatDuration.js';
import { ClipPreview } from './ClipPreview.jsx';

/** Overlay action revealed on hover/focus. */
function RowAction({ label, onClick, icon: Icon, tone = 'default', disabled }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={disabled ? `${label} — requires a finished project` : label}
      className={`inline-flex size-7 items-center justify-center rounded-md border transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400 disabled:cursor-not-allowed disabled:opacity-40 ${
        tone === 'danger'
          ? 'border-line-strong text-faint hover:border-danger/40 hover:bg-danger/10 hover:text-danger'
          : 'border-line-strong text-secondary hover:border-brand-500/50 hover:bg-brand-500/10 hover:text-brand-300'
      }`}
    >
      <Icon aria-hidden className="size-3.5" />
    </button>
  );
}

/**
 * A single clip.
 *
 * `layout="list"` swaps the vertical poster for a 16:9 thumbnail in a row, which
 * is why the aspect handling lives here rather than in `ClipPreview`.
 *
 * @param {object} props
 * @param {object} props.clip
 * @param {'grid'|'list'} [props.layout]
 * @param {object|null} [props.project]
 * @param {boolean} [props.isSelected]  Bulk-selection checkbox state.
 * @param {boolean} [props.showCheckbox]
 */
export function ClipCard({
  clip,
  project,
  layout = 'grid',
  isSelected = false,
  showCheckbox = false,
  onToggleSelect,
  onDelete,
  onExport,
  canExport = true,
}) {
  const statusMeta = CLIP_STATUS_META[clip.status] ?? CLIP_STATUS_META[CLIP_STATUS.SUGGESTED];
  const editorPath = `/app/clips/${clip.id}/editor`;

  // The list view shows a wider thumbnail than the clip's true ratio.
  const previewClip = useMemo(
    () => (layout === 'list' ? { ...clip, aspectRatio: '16:9' } : clip),
    [clip, layout]
  );

  const isSelectedClip = clip.status === CLIP_STATUS.SELECTED;

  return (
    <article
      className={`panel group relative overflow-hidden transition-colors duration-150 hover:border-line-strong ${
        isSelected ? 'border-brand-500/50' : ''
      }`}
    >
      <div className="flex flex-col sm:flex-row">
        {/* --- Thumbnail --- */}
        <div
          className={`relative shrink-0 overflow-hidden bg-ink-925 ${
            layout === 'list' ? 'aspect-video sm:w-48 sm:aspect-auto' : 'aspect-9/16'
          }`}
        >
          <ClipPreview clip={previewClip} variant="poster" showCaptions={false} />

          {/* Checkbox for bulk selection */}
          {showCheckbox && (
            <label
              className="absolute top-2 left-2 z-10 flex size-6 cursor-pointer items-center justify-center rounded-md border border-white/25 bg-ink-950/70 backdrop-blur-sm transition-opacity hover:border-white/50"
              title={isSelected ? 'Deselect clip' : 'Select clip'}
            >
              <input
                type="checkbox"
                checked={isSelected}
                onChange={onToggleSelect}
                className="peer sr-only"
                aria-label={`Select ${clip.title}`}
              />
              <span
                aria-hidden
                className={`flex size-4 items-center justify-center rounded border transition-colors peer-checked:border-brand-500 peer-checked:bg-brand-500 ${
                  isSelected ? 'border-brand-500 bg-brand-500' : 'border-white/40 bg-transparent'
                }`}
              >
                {isSelected && <Check className="size-3 text-white" strokeWidth={3} />}
              </span>
            </label>
          )}

          {/* Play affordance */}
          <Link
            to={editorPath}
            aria-label={`Edit ${clip.title}`}
            className="absolute inset-0 z-10 flex items-center justify-center opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-visible:opacity-100"
          >
            <span className="flex size-9 items-center justify-center rounded-full bg-ink-950/70 text-white backdrop-blur-sm">
              <Play aria-hidden className="size-4 translate-x-px fill-current" />
            </span>
          </Link>

          {isSelectedClip && (
            <span className="absolute top-2 right-2 z-10">
              <Badge tone="brand" size="xs" dot>
                Selected
              </Badge>
            </span>
          )}
        </div>

        {/* --- Body --- */}
        <div className="flex min-w-0 flex-1 flex-col p-3.5">
          <div className="flex items-start justify-between gap-2">
            <h3 className="min-w-0 text-[13.5px] leading-snug font-semibold text-primary">
              <Link to={editorPath} className="transition-colors hover:text-brand-300">
                {clip.title}
              </Link>
            </h3>
            <Badge tone={statusMeta.tone} size="xs">
              {statusMeta.label}
            </Badge>
          </div>

          {clip.hook && (
            <p className="mt-1.5 line-clamp-2 text-[12px] leading-relaxed text-secondary">
              {clip.hook}
            </p>
          )}

          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <ScoreBadge score={clip.score} size="xs" />
            <Badge tone="outline" size="xs">
              {clip.aspectRatio}
            </Badge>
            <Badge tone="outline" size="xs">
              {describeClipLength(clip.durationSec)}
            </Badge>
          </div>

          <dl className="tabular mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-faint">
            <div className="flex items-center gap-1">
              <dt className="sr-only">Time range</dt>
              <dd>
                {formatClock(clip.startSec)} – {formatClock(clip.endSec)}
              </dd>
            </div>
            <div className="flex items-center gap-1">
              <dt className="sr-only">Caption status</dt>
              <dd className={clip.caption?.text ? 'text-secondary' : 'text-warning'}>
                {clip.caption?.text ? 'Captions ready' : 'No captions'}
              </dd>
            </div>
            {project && (
              <div className="flex min-w-0 items-center gap-1">
                <dt className="sr-only">Project</dt>
                <dd className="truncate">{project.title}</dd>
              </div>
            )}
          </dl>

          {layout === 'list' && (
            <p className="mt-1.5 text-[11px] text-faint">Created {formatDate(clip.createdAt)}</p>
          )}

          {/* --- Actions --- */}
          <div className="mt-auto flex items-center gap-1.5 pt-3">
            <Link
              to={editorPath}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line-strong px-2.5 text-[12px] font-medium text-secondary transition-colors hover:border-brand-500/50 hover:bg-brand-500/10 hover:text-brand-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400"
            >
              <Pencil aria-hidden className="size-3" />
              Edit
            </Link>

            <RowAction
              label={isSelectedClip ? 'Remove from selection' : 'Add to selection'}
              onClick={onToggleSelect}
              icon={isSelectedClip ? Square : Check}
            />

            <RowAction
              label={canExport ? 'Export clip' : 'Export — project still processing'}
              onClick={onExport}
              icon={Download}
              disabled={!canExport}
            />

            <RowAction label="Discard clip" onClick={onDelete} icon={Trash2} tone="danger" />
          </div>
        </div>
      </div>
    </article>
  );
}
