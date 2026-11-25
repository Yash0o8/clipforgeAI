import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, FileText, RefreshCw, Sparkles } from 'lucide-react';
import { Panel, PanelHeader, PanelBody } from '../components/common/Panel.jsx';
import { Button, IconButton } from '../components/common/Button.jsx';
import { EmptyState, ErrorState } from '../components/common/EmptyState.jsx';
import { LoaderBlock } from '../components/common/Loader.jsx';
import { ProgressBar } from '../components/common/ProgressBar.jsx';
import { Badge } from '../components/common/Badge.jsx';
import { useApp } from '../hooks/useApp.js';
import { useToast } from '../hooks/useToast.js';
import { formatDateTime } from '../utils/formatDuration.js';
import { EXPORT_STATUS_META } from '../utils/constants.js';
import { downloadFile } from '../services/api.js';
import * as clipService from '../services/clipService.js';

/**
 * Job list. Backed by `GET /exports`, so completed renders survive a reload
 * instead of only living in the ClipEditor that queued them.
 */
export function ExportsPage() {
  const { exports, refreshExports } = useApp();
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [downloading, setDownloading] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await refreshExports();
    } catch (cause) {
      setError(cause);
    } finally {
      setLoading(false);
    }
  }, [refreshExports]);

  useEffect(() => {
    // Defer the first fetch so the lint rule against synchronous effect state
    // updates does not flag a normal async load.
    queueMicrotask(() => { void load(); });
  }, [load]);

  const onDownload = async (job) => {
    setDownloading(job.id);
    try {
      const link = await clipService.getDownloadUrl(job.id);
      const extension = job.format ?? 'mp4';
      const filename = `${(job.title || 'clip').replace(/[^\w.-]+/g, '-').toLowerCase()}.${extension}`;
      await downloadFile(link.url, filename);
      toast.success('Downloaded', { body: filename });
    } catch (cause) {
      toast.error('Download failed', { body: cause.message });
    } finally {
      setDownloading(null);
    }
  };

  if (loading) {
    return <LoaderBlock label="Loading exports" hint="Asking the render worker for your recent jobs." />;
  }

  if (error && exports.length === 0) {
    return (
      <ErrorState
        title="Could not load exports"
        message={error.message ?? 'The API did not answer. Try again.'}
        onRetry={load}
        retryLabel="Retry"
      />
    );
  }

  if (exports.length === 0) {
    return (
      <EmptyState
        icon={<Download className="size-5" />}
        title="No exports yet"
        description="Edit a clip and export it to see jobs and downloads here."
        action={
          <Button as={Link} to="/app/clips">
            <Sparkles aria-hidden className="size-4" />
            Go to clips
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[17px] font-semibold text-primary">Exports</h1>
          <p className="mt-0.5 text-sm text-secondary">
            Video renders and caption sidecars for every clip you have edited.
          </p>
        </div>
        <IconButton label="Refresh exports" size="sm" variant="secondary" onClick={load} disabled={loading}>
          <RefreshCw aria-hidden className="size-3.5" />
        </IconButton>
      </header>

      {error && (
        <div role="alert" className="rounded-lg border border-warning/30 bg-warning/[0.07] px-3 py-2 text-[12.5px] text-warning">
          Showing cached jobs — refresh failed: {error.message}
        </div>
      )}

      <Panel>
        <PanelHeader title="Recent exports" subtitle={`${exports.length} job${exports.length === 1 ? '' : 's'} on record`} />
        <PanelBody className="divide-y divide-line">
          {exports.map((job) => {
            const meta = EXPORT_STATUS_META[job.status] ?? EXPORT_STATUS_META.queued;
            const complete = job.status === 'complete';
            const active = job.status === 'queued' || job.status === 'rendering';
            return (
              <article key={job.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13.5px] font-medium text-primary">{job.title}</p>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-faint">
                    <span className="tabular">{job.format?.toUpperCase()} · {job.resolution}</span>
                    <span className="tabular">{formatDateTime(job.createdAt)}</span>
                    <Badge tone={meta.tone} size="xs">{meta.label}</Badge>
                    {job.preview && <Badge tone="neutral" size="xs">480p preview</Badge>}
                  </div>
                  {active && (
                    <ProgressBar
                      value={job.progress ?? 0}
                      label={`${job.title} render progress`}
                      className="mt-2 max-w-xs"
                    />
                  )}
                  {job.status === 'failed' && (
                    <p className="mt-1 text-[11.5px] text-danger">
                      {job.error || 'The worker could not finish this render.'}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {complete && (
                    <Button
                      size="xs"
                      variant="subtle"
                      loading={downloading === job.id}
                      onClick={() => onDownload(job)}
                    >
                      <Download aria-hidden className="size-3.5" />
                      Download
                    </Button>
                  )}
                  <Button as={Link} to={`/app/clips/${job.clipId}/editor`} size="xs" variant="ghost">
                    <FileText aria-hidden className="size-3.5" />
                    Open clip
                  </Button>
                </div>
              </article>
            );
          })}
        </PanelBody>
      </Panel>
    </div>
  );
}
