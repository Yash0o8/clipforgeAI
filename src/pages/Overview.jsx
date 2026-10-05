import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, ChevronRight, Download, Eye, Sparkles, Upload } from 'lucide-react';
import { Button } from '../components/common/Button.jsx';
import { Panel, PanelBody, PanelHeader } from '../components/common/Panel.jsx';
import { formatClock, formatDate } from '../utils/formatDuration.js';
import { useApp } from '../hooks/useApp.js';
import { CLIP_STATUS, PROJECT_STATUS } from '../utils/constants.js';

/** Recent highlights pulled from the latest projects. */
function Highlights({ clips }) {
  const recent = [...clips]
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);

  return (
    <Panel>
      <PanelHeader
        title="Top clips from your library"
        subtitle="Ready to edit, trim or export."
        actions={
          <Button as={Link} to="/app/clips" size="xs" variant="ghost">
            View all clips
            <ChevronRight aria-hidden className="size-3.5" />
          </Button>
        }
      />
      <PanelBody className="divide-y divide-line">
        {recent.length === 0 ? (
          <p className="text-[12.5px] text-faint">
            No clips yet. Generate highlights from a finished project.
          </p>
        ) : (
          recent.map((clip) => (
            <article key={clip.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <Link
                  to={`/app/clips/${clip.id}/editor`}
                  className="text-[13.5px] font-medium text-primary transition-colors hover:text-brand-300"
                >
                  {clip.title}
                </Link>
                <div className="mt-0.5 flex items-center gap-2 text-[11px] text-faint">
                  <span className="tabular">{formatClock(clip.startSec)}  {formatClock(clip.endSec)}</span>
                  <span aria-hidden></span>
                  <span className="font-medium text-success">{clip.score}%</span>
                </div>
              </div>
              <Button as={Link} to={`/app/clips/${clip.id}/editor`} size="xs" variant="secondary">
                Edit
                <ArrowRight aria-hidden className="size-3.5" />
              </Button>
            </article>
          ))
        )}
      </PanelBody>
    </Panel>
  );
}

/** At-a-glance usage. */
function Usage({ projects, clips }) {
  const selected = clips.filter((c) => c.status === CLIP_STATUS.SELECTED).length;

  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Panel>
        <PanelHeader title="Projects" subtitle="Finished and in progress" />
        <PanelBody className="pt-0">
          <p className="text-2xl font-semibold text-primary">{projects.length}</p>
        </PanelBody>
      </Panel>
      <Panel>
        <PanelHeader title="Clips" subtitle="Suggested + selected" />
        <PanelBody className="pt-0">
          <p className="text-2xl font-semibold text-primary">{clips.length}</p>
        </PanelBody>
      </Panel>
      <Panel>
        <PanelHeader title="Selected" subtitle="Queued for export" />
        <PanelBody className="pt-0">
          <p className="text-2xl font-semibold text-primary">{selected}</p>
        </PanelBody>
      </Panel>
    </div>
  );
}

/** Recent uploads/projects, newest first. */
function RecentProjects({ projects }) {
  if (projects.length === 0) {
    return null;
  }

  const recent = [...projects].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  ).slice(0, 5);

  return (
    <Panel>
      <PanelHeader
        title="Recent projects"
        subtitle="Pick one to review suggested clips."
        actions={
          <Button as={Link} to="/app/projects" size="xs" variant="ghost">
            All projects
            <ChevronRight aria-hidden className="size-3.5" />
          </Button>
        }
      />
      <PanelBody className="divide-y divide-line">
        {recent.map((project) => (
          <article key={project.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
            <div className="min-w-0">
              <Link
                to={`/app/projects/${project.id}`}
                className="text-[13.5px] font-medium text-primary transition-colors hover:text-brand-300"
              >
                {project.title}
              </Link>
              <div className="mt-0.5 flex items-center gap-2 text-[11px] text-faint">
                <span>{formatDate(project.createdAt)}</span>
                <span aria-hidden></span>
                <span className="tabular">{formatClock(project.durationSec)}</span>
                <span aria-hidden></span>
                <span>{project.status === 'ready' ? 'Ready' : project.status}</span>
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <Button as={Link} to={`/app/projects/${project.id}`} size="xs" variant="ghost">
                <Eye aria-hidden className="size-3.5" />
                View
              </Button>
              {project.status === 'ready' && (
                <Button as={Link} to={`/app/projects/${project.id}#clips`} size="xs" variant="secondary">
                  Clips
                </Button>
              )}
            </div>
          </article>
        ))}
      </PanelBody>
    </Panel>
  );
}

/**
 * Dashboard overview.
 *
 * Surfaces the next actions: upload, pick a ready project, export selections.
 * Counts and recent highlights are derived from the real library, so clips are
 * fetched for every ready project on mount.
 */
export function OverviewPage() {
  const { projects, clips, ensureClips } = useApp();

  useEffect(() => {
    for (const project of projects) {
      if (project.status === PROJECT_STATUS.READY) ensureClips(project.id).catch(() => {});
    }
  }, [projects, ensureClips]);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-[17px] font-semibold text-primary">Overview</h1>
          <p className="mt-0.5 text-sm text-secondary">
            Find highlights, trim them and ship them to your platforms.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button as={Link} to="/app/upload" size="sm" variant="secondary">
            <Upload aria-hidden className="size-4" />
            Upload video
          </Button>
          <Button as={Link} to="/app/clips" size="sm">
            <Sparkles aria-hidden className="size-4" />
            View clips
          </Button>
        </div>
      </header>

      <Usage projects={projects} clips={clips} />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Highlights clips={clips} />
        <Panel>
          <PanelHeader
            title="Export queue"
            subtitle="Exports unlock once the render backend is connected."
            actions={
              <Button as={Link} to="/app/exports" size="xs" variant="ghost">
                Open exports
                <ChevronRight aria-hidden className="size-3.5" />
              </Button>
            }
          />
          <PanelBody className="flex flex-col gap-3">
            <div className="rounded-lg border border-line bg-ink-900/60 px-4 py-4 text-center">
              <Download aria-hidden className="mx-auto mb-2 size-5 text-brand-400" />
              <p className="text-[13.5px] font-medium text-primary">Sidecars ready now</p>
              <p className="mt-1 text-[12px] leading-relaxed text-faint">
                Download SRT, TXT and JSON for any edited clip in the browser.
              </p>
            </div>
            <div className="rounded-lg border border-line bg-ink-900/60 px-4 py-4 text-center">
              <Sparkles aria-hidden className="mx-auto mb-2 size-5 text-brand-400" />
              <p className="text-[13.5px] font-medium text-primary">Video exports render on the server</p>
              <p className="mt-1 text-[12px] leading-relaxed text-faint">
                MP4 and WebM are queued to a worker thread. Progress and cancellation are tracked
                per clip.
              </p>
            </div>
          </PanelBody>
        </Panel>
      </div>

      <RecentProjects projects={projects} />
    </div>
  );
}













