import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Download, FileText, Sparkles } from 'lucide-react';
import { Panel, PanelHeader, PanelBody } from '../components/common/Panel.jsx';
import { Button } from '../components/common/Button.jsx';
import { EmptyState } from '../components/common/EmptyState.jsx';
import { Badge } from '../components/common/Badge.jsx';
import { useApp } from '../hooks/useApp.js';
import { formatDateTime } from '../utils/formatDuration.js';
import { EXPORT_STATUS_META } from '../utils/constants.js';

/**
 * Job list. Backed by `GET /exports`, so completed renders survive a reload
 * instead of only living in the ClipEditor that queued them.
 */
export function ExportsPage() {
  const { exports, refreshExports } = useApp();

  useEffect(() => {
    refreshExports().catch(() => {});
  }, [refreshExports]);

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
      <header>
        <h1 className="text-[17px] font-semibold text-primary">Exports</h1>
        <p className="mt-0.5 text-sm text-secondary">
          Video renders and caption sidecars for every clip you have edited.
        </p>
      </header>

      <Panel>
        <PanelHeader title="Recent exports" />
        <PanelBody className="divide-y divide-line">
          {exports.map((job) => {
            const meta = EXPORT_STATUS_META[job.status] ?? EXPORT_STATUS_META.queued;
            return (
              <article key={job.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-[13.5px] font-medium text-primary">{job.title}</p>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-faint">
                    <span>{job.format.toUpperCase()}  {job.resolution}</span>
                    <span aria-hidden></span>
                    <span className="tabular">{formatDateTime(job.createdAt)}</span>
                    <Badge tone={meta.tone} size="xs">
                      {meta.label}
                    </Badge>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
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












