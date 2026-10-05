import { Link, useNavigate, useParams } from 'react-router-dom';
import { useEffect, useRef } from 'react';
import { Check, Loader, RotateCw, Sparkles, X } from 'lucide-react';
import { Panel, PanelHeader, PanelBody } from '../components/common/Panel.jsx';
import { Button } from '../components/common/Button.jsx';
import { ProgressBar } from '../components/common/ProgressBar.jsx';
import { ErrorState } from '../components/common/EmptyState.jsx';
import { useProcessing } from '../hooks/useProcessing.js';
import { formatClock } from '../utils/formatDuration.js';
import { PROCESSING_STAGE_META, PROJECT_STATUS } from '../utils/constants.js';

/**
 * Processing screen.
 *
 * Runs the simulated pipeline, patches the project state, and ultimately lands
 * the user on the project detail where clips are shown. For real backends this
 * would poll `getProject` and `listClips` instead of simulating stages.
 */
export function ProcessingPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const ranRef = useRef(false);

  const processing = useProcessing(projectId);
  const { project, progress, stages, currentStage, error, status, isRunning, needsResume, canRetry, canCancel, start, retry, cancel } =
    processing;

  // Auto-start once on mount so arriving from the upload flow just works.
  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;
    if (project) start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Let the toast stack breathe before leaving for the project detail.
  useEffect(() => {
    if (status !== PROJECT_STATUS.READY) return undefined;
    const timer = setTimeout(() => navigate(`/app/projects/${projectId}`), 600);
    return () => clearTimeout(timer);
  }, [status, navigate, projectId]);

  if (!project) {
    return (
      <ErrorState
        title="Project not found"
        message="The processing job no longer exists."
        onRetry={() => navigate('/app/projects')}
        retryLabel="Back to projects"
      />
    );
  }

  const stageMeta = PROCESSING_STAGE_META[currentStage?.key] ?? currentStage ?? null;
  const completed = status === PROJECT_STATUS.READY;
  const stopped = status === PROJECT_STATUS.FAILED || status === PROJECT_STATUS.CANCELLED;

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <Panel>
        <PanelHeader
          title={project.title}
          subtitle={project.originalName}
          actions={
            <Button as={Link} to={`/app/projects/${project.id}`} size="xs" variant="ghost">
              Go to project
            </Button>
          }
        />
        <PanelBody className="space-y-5">
          <div className="flex flex-col items-center gap-4 py-6 text-center sm:py-10">
            {completed ? (
              <span className="flex size-14 items-center justify-center rounded-full border border-success/30 bg-success/10 text-success">
                <Check aria-hidden className="size-6" />
              </span>
            ) : (
              <span className="flex size-14 items-center justify-center rounded-full border border-brand-500/30 bg-brand-500/10 text-brand-400">
                <Loader aria-hidden className="size-5 animate-spin" />
              </span>
            )}

            <div className="space-y-2">
              <h2 className="text-[17px] font-semibold text-primary">
                {completed
                  ? 'Clips ready'
                  : stopped
                    ? 'Processing stopped'
                    : 'Generating highlight clips'}
              </h2>
              <p className="max-w-md text-sm leading-relaxed text-secondary">
                {completed
                  ? 'We found the best moments. Take them to the editor to trim, caption and export.'
                  : stopped
                    ? error
                    : (stageMeta?.description ?? 'Working through the pipeline.')}
              </p>
            </div>

            <div className="w-full max-w-md space-y-2">
              <ProgressBar value={progress} />
              <div className="flex items-center justify-between text-[11.5px] text-faint">
                <span className="tabular">{Math.round(progress)}%</span>
                <span className="capitalize">{completed ? 'done' : (currentStage?.key ?? 'idle')}</span>
              </div>
            </div>
          </div>

          <ol className="space-y-2" aria-label="Pipeline stages">
            {stages.map((stage) => (
              <li
                key={stage.key}
                className={`flex items-center justify-between gap-3 rounded-lg border px-4 py-2.5 transition-colors ${
                  stage.status === 'done'
                    ? 'border-success/25 bg-success/[0.06]'
                    : stage.status === 'active'
                      ? 'border-brand-500/35 bg-brand-500/[0.07]'
                      : 'border-line bg-ink-900/40'
                }`}
              >
                <div className="min-w-0">
                  <p className="text-[13px] font-medium text-primary">{stage.label}</p>
                  <p className="mt-0.5 text-[11.5px] text-faint">{stage.description}</p>
                </div>
                <span className="tabular shrink-0 text-[11.5px] text-faint">
                  {stage.status === 'done' ? 'Done' : stage.status === 'active' ? `${stage.progress}%` : 'Queued'}
                </span>
              </li>
            ))}
          </ol>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-line bg-ink-900/60 px-4 py-3">
              <p className="text-[11.5px] uppercase tracking-wide text-faint">Source length</p>
              <p className="mt-0.5 text-[15px] font-medium text-primary tabular">
                {formatClock(project.durationSec)}
              </p>
            </div>
            <div className="rounded-lg border border-line bg-ink-900/60 px-4 py-3">
              <p className="text-[11.5px] uppercase tracking-wide text-faint">Pipeline stages</p>
              <p className="mt-0.5 text-[15px] font-medium text-primary tabular">
                {stages.filter((stage) => stage.status === 'done').length} / {stages.length}
              </p>
            </div>
          </div>

          {completed ? (
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button as={Link} to={`/app/projects/${project.id}`}>
                <Sparkles aria-hidden className="size-4" />
                View project & clips
              </Button>
              <Button as={Link} to="/app/clips" variant="secondary">
                Go to clips
              </Button>
            </div>
          ) : stopped ? (
            <div className="flex flex-wrap items-center justify-center gap-2">
              {canRetry && (
                <Button onClick={retry}>
                  <RotateCw aria-hidden className="size-4" />
                  Retry processing
                </Button>
              )}
              <Button as={Link} to={`/app/projects/${project.id}`} variant="secondary">
                Back to project
              </Button>
            </div>
          ) : needsResume ? (
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button onClick={start}>
                <RotateCw aria-hidden className="size-4" />
                Resume processing
              </Button>
              {canCancel && (
                <Button onClick={cancel} variant="danger">
                  <X aria-hidden className="size-4" />
                  Stop
                </Button>
              )}
            </div>
          ) : (
            <p className="text-center text-[11px] text-faint">
              {isRunning
                ? 'This runs in demo mode. No video is sent to a server.'
                : 'Processing is paused while you are away.'}
            </p>
          )}
        </PanelBody>
      </Panel>
    </div>
  );
}












