import { useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Button } from '../components/common/Button.jsx';
import { Badge } from '../components/common/Badge.jsx';
import { Panel, PanelBody, PanelHeader } from '../components/common/Panel.jsx';
import { EmptyState, ErrorState } from '../components/common/EmptyState.jsx';
import { ClipGrid } from '../components/clips/ClipGrid.jsx';
import { Sparkles } from 'lucide-react';
import { useApp } from '../hooks/useApp.js';
import { formatClock, formatDate, formatHours } from '../utils/formatDuration.js';
import {
  PROCESSING_STAGE_META,
  PROJECT_STATUS,
  PROJECT_STATUS_META,
} from '../utils/constants.js';

/** Project header + metadata. */
function ProjectHeader({ project, clipCount }) {
  const meta = PROJECT_STATUS_META[project.status] ?? PROJECT_STATUS_META[PROJECT_STATUS.UPLOADED];

  return (
    <header className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate text-[17px] font-semibold text-primary">{project.title}</h1>
          <p className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-secondary">
            <span>{project.originalName}</span>
            <span aria-hidden></span>
            <span className="tabular">{formatClock(project.durationSec)}</span>
            <span aria-hidden></span>
            <span>{formatHours(project.durationSec)} total</span>
            <Badge tone={meta.tone} size="xs">
              {meta.label}
            </Badge>
          </p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Panel>
          <PanelHeader title="Created" />
          <PanelBody className="pt-0">
            <p className="text-[15px] font-medium text-primary">{formatDate(project.createdAt)}</p>
          </PanelBody>
        </Panel>
        <Panel>
          <PanelHeader title="Clips found" />
          <PanelBody className="pt-0">
            <p className="text-[15px] font-medium text-primary">{clipCount}</p>
          </PanelBody>
        </Panel>
        <Panel>
          <PanelHeader title="Processing stage" />
          <PanelBody className="pt-0">
            <p className="text-[15px] font-medium text-primary">
              {PROCESSING_STAGE_META[project.currentStage]?.label ?? PROJECT_STATUS_META[project.status]?.label}
            </p>
          </PanelBody>
        </Panel>
      </div>
    </header>
  );
}

/**
 * Single project page.
 *
 * Shows the processing state and its generated clips. Editing still happens on
 * `/app/clips/:clipId/editor`, keeping URL semantics separate from projects.
 */
export function ProjectPage() {
  const { id } = useParams();
  const { projects, clips: allClips, ensureClips } = useApp();
  const project = projects.find((p) => p.id === id) ?? null;

  // Clips are a separate collection from projects, so a reload or a direct link
  // to `/app/projects/{id}` finds an empty list until they are fetched.
  useEffect(() => {
    if (project?.status === PROJECT_STATUS.READY) ensureClips(id).catch(() => {});
  }, [id, project?.status, ensureClips]);

  const clips = allClips.filter((c) => c.projectId === id);

  if (!project) {
    return (
      <ErrorState
        title="Project not found"
        message="The project may have been deleted or the link is incorrect."
        onRetry={() => {}}
        retryLabel="Back to projects"
      />
    );
  }

  const ready = project.status === PROJECT_STATUS.READY;

  return (
    <div className="space-y-5">
      <ProjectHeader project={project} clipCount={clips.length} />

      <section className="space-y-3">
        <PanelHeader
          title="Clips for this project"
          subtitle={ready ? 'Trim, caption and export.' : 'These appear once processing finishes.'}
          actions={
            ready && clips.length > 0 ? (
              <Button as={Link} to={`/app/clips?projectId=${id}`} size="xs" variant="ghost">
                Manage in clips
              </Button>
            ) : null
          }
        />
        {clips.length === 0 ? (
          <EmptyState
            icon={<Sparkles className="size-5" />}
            title={ready ? 'No clips generated' : 'Processing in progress'}
            description={
              ready
                ? 'Try regenerating clips from the upload/processing flow, or import a longer source.'
                : 'Clips surface automatically once highlight detection finishes. Check back in a moment.'
            }
          />
        ) : (
          <ClipGrid clips={clips} view="grid" canExport={ready} />
        )}
      </section>
    </div>
  );
}

/** Project list page. */
export function ProjectsPage() {
  const { projects } = useApp();

  if (projects.length === 0) {
    return (
      <EmptyState
        title="No projects yet"
        description="Upload your first video to generate clips."
        action={
          <Button as={Link} to="/app/upload">
            Upload video
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-[17px] font-semibold text-primary">Projects</h1>
        <p className="mt-0.5 text-sm text-secondary">Everything you have uploaded so far.</p>
      </header>

      <Panel>
        <PanelBody className="divide-y divide-line">
          {projects.map((project) => (
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
                  <Badge
                    tone={
                      project.status === 'ready'
                        ? 'success'
                        : project.status === 'processing'
                          ? 'brand'
                          : 'neutral'
                    }
                    size="xs"
                  >
                    {PROJECT_STATUS_META[project.status]?.label ?? project.status}
                  </Badge>
                </div>
              </div>
              <Button as={Link} to={`/app/projects/${project.id}`} size="xs" variant="secondary">
                Open
              </Button>
            </article>
          ))}
        </PanelBody>
      </Panel>
    </div>
  );
}













