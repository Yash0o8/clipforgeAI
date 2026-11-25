import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Button } from '../components/common/Button.jsx';
import { Badge } from '../components/common/Badge.jsx';
import { Panel, PanelBody, PanelHeader } from '../components/common/Panel.jsx';
import { EmptyState, ErrorState } from '../components/common/EmptyState.jsx';
import { LoaderBlock } from '../components/common/Loader.jsx';
import { ClipGrid } from '../components/clips/ClipGrid.jsx';
import { Sparkles } from 'lucide-react';
import { useApp } from '../hooks/useApp.js';
import { formatClock, formatDate, formatHours } from '../utils/formatDuration.js';
import {
  PROCESSING_STAGE_META,
  PROJECT_STATUS,
  PROJECT_STATUS_META,
} from '../utils/constants.js';

const UNKNOWN_STATUS_META = { label: 'Unknown', tone: 'neutral' };

/** Project header + metadata. */
function ProjectHeader({ project, clipCount }) {
  const meta = PROJECT_STATUS_META[project.status] ?? UNKNOWN_STATUS_META;

  return (
    <header className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate text-[17px] font-semibold text-primary">{project.title}</h1>
          <p className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-secondary">
            <span>{project.fileName}</span>
            <span className="tabular">{formatClock(project.durationSec)}</span>
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
              {PROCESSING_STAGE_META[project.currentStage]?.label ?? meta.label}
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
  const navigate = useNavigate();
  const {
    projects,
    clips: allClips,
    ensureClips,
    isLoading,
    loadError,
    refreshProjects,
  } = useApp();
  const project = projects.find((p) => p.id === id) ?? null;
  const projectStatus = project?.status;
  const ready = projectStatus === PROJECT_STATUS.READY;
  const [clipLoad, setClipLoad] = useState({ id: null, status: 'loading', error: null });

  const loadProjectClips = useCallback(
    async (projectId, isActive = () => true) => {
      // Defer state updates so an effect never sets state synchronously.
      await Promise.resolve();
      if (!isActive()) return;
      setClipLoad({ id: projectId, status: 'loading', error: null });
      try {
        await ensureClips(projectId);
        if (isActive()) setClipLoad({ id: projectId, status: 'ready', error: null });
      } catch (cause) {
        if (isActive()) setClipLoad({ id: projectId, status: 'error', error: cause });
      }
    },
    [ensureClips]
  );

  useEffect(() => {
    if (!projectStatus) return undefined;
    let active = true;

    void Promise.resolve().then(() => {
      if (!active) return;
      if (projectStatus === PROJECT_STATUS.READY) {
        void loadProjectClips(id, () => active);
      } else {
        setClipLoad({ id, status: 'ready', error: null });
      }
    });

    return () => {
      active = false;
    };
  }, [id, projectStatus, loadProjectClips]);

  const clips = allClips.filter((c) => c.projectId === id);
  const clipsReady = clipLoad.id === id && clipLoad.status === 'ready';
  const clipLoadError = clipLoad.id === id && clipLoad.status === 'error' ? clipLoad.error : null;
  const clipsLoading = ready && !clipsReady && !clipLoadError;

  if (isLoading) {
    return <LoaderBlock label="Loading project" hint="Fetching your library so this link can be resolved." />;
  }

  if (loadError) {
    return (
      <ErrorState
        title="Could not load project"
        message={loadError.message ?? 'The API did not answer. Try again.'}
        onRetry={() => { void refreshProjects().catch(() => {}); }}
        retryLabel="Retry"
      />
    );
  }

  if (!project) {
    return (
      <ErrorState
        title="Project not found"
        message="The project may have been deleted or the link is incorrect."
        onRetry={() => navigate('/app/projects')}
        retryLabel="Back to projects"
      />
    );
  }

  return (
    <div className="space-y-5">
      <ProjectHeader project={project} clipCount={clips.length} />

      <section id="clips" className="scroll-mt-6 space-y-3">
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
        {clipsLoading ? (
          <LoaderBlock label="Loading clips" hint="Checking for highlights from this project." className="py-12" />
        ) : clipLoadError ? (
          <ErrorState
            title="Could not load clips"
            message={clipLoadError.message ?? 'The clip list could not be fetched. Try again.'}
            onRetry={() => { void loadProjectClips(id); }}
            retryLabel="Retry"
          />
        ) : clips.length === 0 ? (
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
  const { projects, isLoading, loadError, refreshProjects } = useApp();

  if (isLoading) {
    return <LoaderBlock label="Loading projects" hint="Fetching your uploads from the API." />;
  }

  if (loadError) {
    return (
      <ErrorState
        title="Could not load projects"
        message={loadError.message ?? 'The API did not answer. Try again.'}
        onRetry={() => { void refreshProjects().catch(() => {}); }}
        retryLabel="Retry"
      />
    );
  }

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
          {projects.map((project) => {
            const statusMeta = PROJECT_STATUS_META[project.status] ?? UNKNOWN_STATUS_META;
            return (
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
                    <span className="tabular">{formatClock(project.durationSec)}</span>
                    <Badge tone={statusMeta.tone} size="xs">
                      {statusMeta.label}
                    </Badge>
                  </div>
                </div>
                <Button as={Link} to={`/app/projects/${project.id}`} size="xs" variant="secondary">
                  Open
                </Button>
              </article>
            );
          })}
        </PanelBody>
      </Panel>
    </div>
  );
}
