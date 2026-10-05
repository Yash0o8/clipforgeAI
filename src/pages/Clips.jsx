import { Link, useSearchParams } from 'react-router-dom';
import { useMemo, useState } from 'react';
import {
  CheckCircle,
  Download,
  Grid,
  List,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { Panel, PanelHeader, PanelBody } from '../components/common/Panel.jsx';
import { Button } from '../components/common/Button.jsx';
import { SegmentedControl } from '../components/common/SegmentedControl.jsx';
import { TextField } from '../components/common/TextField.jsx';
import { Select } from '../components/common/Select.jsx';
import { ConfirmDialog } from '../components/common/Modal.jsx';
import { ClipGrid } from '../components/clips/ClipGrid.jsx';
import { useClips } from '../hooks/useClips.js';
import { useApp } from '../hooks/useApp.js';
import { CLIP_FILTERS, CLIP_SORTS, CLIP_STATUS } from '../utils/constants.js';

/** `Select` reads `value`/`label`, so the sort constants need remapping. */
const SORT_OPTIONS = CLIP_SORTS.map((option) => ({ value: option.id, label: option.label }));

/**
 * Clips library.
 *
 * Consolidated view across all projects with search, sort, view and bulk
 * actions. Exporting from here still delegates to the editor where the real
 * controls live.
 */
export function ClipsPage() {
  const [searchParams] = useSearchParams();
  const projectId = searchParams.get('projectId') || undefined;

  const {
    clips,
    counts,
    filter,
    setFilter,
    sort,
    setSort,
    query,
    setQuery,
    view,
    setView,
    getProjectForClip,
    toggleSelect,
    applyToVisible,
  } = useClips({ projectId });

  const { setClipStatus, discardClip } = useApp();
  const [bulkOpen, setBulkOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const selectedIds = useMemo(
    () => clips.filter((c) => c.status === CLIP_STATUS.SELECTED).map((c) => c.id),
    [clips]
  );

  const canBulkExport = selectedIds.length > 0;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-[17px] font-semibold text-primary">
            {projectId ? 'Clips for project' : 'All clips'}
          </h1>
          <p className="mt-0.5 text-sm text-secondary">
            Search, select and send to the editor or exports page.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button as={Link} to="/app/exports" size="sm" variant="secondary">
            <Download aria-hidden className="size-4" />
            Exports
          </Button>
          <Button as={Link} to="/app/upload" size="sm">
            <Sparkles aria-hidden className="size-4" />
            Upload new
          </Button>
        </div>
      </header>

      <Panel>
        <PanelHeader title="Filters" />
        <PanelBody className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {CLIP_FILTERS.map((item) => {
              const count = counts[item.id] ?? 0;
              const active = filter === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setFilter(item.id)}
                  className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[12.5px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400 ${
                    active
                      ? 'border-brand-500/60 bg-brand-500/10 text-primary'
                      : 'border-line-strong bg-ink-900 text-secondary hover:border-line-hover'
                  }`}
                >
                  {item.label}
                  {count > 0 && (
                    <span
                      className={`tabular inline-flex min-w-5 justify-center rounded-full px-1 text-[11px] ${
                        active ? 'bg-brand-500/20' : 'bg-ink-750'
                      }`}
                    >
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_200px_160px_auto]">
            <TextField
              label="Search"
              placeholder="Title, hook or caption"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <Select
              label="Sort by"
              value={sort}
              onChange={setSort}
              options={SORT_OPTIONS}
            />
            <div className="flex flex-col justify-end gap-2">
              <label className="text-[13px] font-medium text-secondary">View</label>
              <SegmentedControl
                options={[
                  { value: 'grid', label: 'Grid', icon: <Grid aria-hidden className="size-3.5" /> },
                  { value: 'list', label: 'List', icon: <List aria-hidden className="size-3.5" /> },
                ]}
                value={view}
                onChange={setView}
              />
            </div>
            <div className="flex items-end">
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="secondary" onClick={() => applyToVisible('select')}>
                  <CheckCircle aria-hidden className="size-3.5" />
                  Select all visible
                </Button>
                <Button size="sm" variant="ghost" onClick={() => applyToVisible('deselect')}>
                  Deselect
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => setDeleteOpen(true)}
                  disabled={clips.length === 0}
                >
                  <Trash2 aria-hidden className="size-3.5" />
                  Discard visible
                </Button>
              </div>
            </div>
          </div>
        </PanelBody>
      </Panel>

      <ClipGrid
        clips={clips}
        view={view}
        projectForClip={getProjectForClip}
        selectedIds={selectedIds}
        onToggleSelect={toggleSelect}
        onDelete={(id) => discardClip(id).catch(() => {})}
        onExport={(id) => setClipStatus([id], CLIP_STATUS.EXPORTED)}
        canExport={true}
      />

      <div className="flex items-center justify-between">
        <p className="text-[12px] text-faint">
          {clips.length} {clips.length === 1 ? 'clip' : 'clips'} shown
        </p>
        <Button size="sm" variant="secondary" disabled={!canBulkExport} onClick={() => setBulkOpen(true)}>
          <Download aria-hidden className="size-3.5" />
          Export selected
        </Button>
      </div>

      <ConfirmDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={() => {
          applyToVisible('remove');
          setDeleteOpen(false);
        }}
        title="Discard visible clips?"
        message="These clips will be removed from this library. Any unsaved edits are lost."
        confirmLabel="Discard"
        tone="danger"
      />

      <ConfirmDialog
        open={bulkOpen}
        onClose={() => setBulkOpen(false)}
        onConfirm={() => {
          setBulkOpen(false);
        }}
        title="Export selected clips"
        message="Use the clip editor to choose formats and render options. Sidecars (.SRT, .TXT, .JSON) are ready to download now."
        confirmLabel="Go to editor"
        cancelLabel="Close"
      />
    </div>
  );
}













