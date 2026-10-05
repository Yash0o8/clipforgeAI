import { Scissors } from 'lucide-react';
import { ClipCard } from './ClipCard.jsx';
import { EmptyState } from '../common/EmptyState.jsx';

/**
 * Responsive clip collection.
 *
 * Uses an explicit list so screen readers announce the item count, and switches
 * to a denser row layout on wide viewports instead of stretching thumbnails.
 *
 * @param {object} props
 * @param {'grid'|'list'} [props.view]
 * @param {Array} props.clips
 * @param {Map|Function} [props.projectForClip]
 * @param {Array} [props.selectedIds]  For bulk-select checkboxes.
 */
export function ClipGrid({
  clips,
  view = 'grid',
  projectForClip,
  selectedIds = [],
  onToggleSelect,
  onDelete,
  onExport,
  canExport = true,
  emptyState,
}) {
  if (clips.length === 0) {
    return emptyState ?? (
      <EmptyState
        icon={<Scissors className="size-5" />}
        title="No clips match these filters"
        description="Try a different filter, clear the search, or generate clips from a finished project."
      />
    );
  }

  return (
    <ul
      aria-label={`${clips.length} ${clips.length === 1 ? 'clip' : 'clips'}`}
      className={
        view === 'grid'
          ? 'grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4'
          : 'flex flex-col gap-3'
      }
    >
      {clips.map((clip) => (
        <li key={clip.id} className={view === 'grid' ? '' : 'list-none'}>
          <ClipCard
            clip={clip}
            project={typeof projectForClip === 'function' ? projectForClip(clip) : projectForClip}
            layout={view}
            isSelected={selectedIds.includes(clip.id)}
            showCheckbox
            onToggleSelect={() => onToggleSelect?.(clip.id)}
            onDelete={() => onDelete?.(clip.id)}
            onExport={() => onExport?.(clip.id)}
            canExport={canExport}
          />
        </li>
      ))}
    </ul>
  );
}
