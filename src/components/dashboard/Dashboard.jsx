import { Link } from 'react-router-dom';
import { StatsGrid } from './StatsGrid.jsx';
import { RecentClips } from './RecentClips.jsx';
import { QuickActions } from './QuickActions.jsx';
import { Panel, PanelHeader, PanelBody } from '../common/Panel.jsx';
import { useApp } from '../../hooks/useApp.js';

/**
 * Dashboard composition.
 *
 * Left column: stats, projects list and a "next step" guide. Right column: top
 * clips and quick actions. Clean split, easy to rearrange.
 */
export function Dashboard({ className = '' }) {
  const { projects, clips } = useApp();

  const topClips = [...clips].sort((a, b) => b.score - a.score).slice(0, 5);

  return (
    <div className={`grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px] ${className}`}>
      <div className="space-y-6">
        <StatsGrid />
        <RecentClips clips={topClips} />
        <div className="space-y-3">
          <h2 className="text-[15px] font-semibold text-primary">Your projects</h2>
          <div className="flex flex-col gap-3">
            {projects.length === 0 ? (
              <p className="text-sm text-faint">No projects yet. Upload your first video to get started.</p>
            ) : (
              projects.map((project) => (
                <Link
                  key={project.id}
                  to={`/app/projects/${project.id}`}
                  className="text-[13.5px] font-medium text-primary transition-colors hover:text-brand-300"
                >
                  {project.title}
                </Link>
              ))
            )}
          </div>
        </div>
      </div>

      <aside className="space-y-6">
        <QuickActions />
        <Panel>
          <PanelHeader title="How this works" subtitle="On your own machine" />
          <PanelBody className="space-y-2">
            <p className="text-sm text-secondary">
              Video is uploaded to your ClipForge backend, transcribed with Whisper and scored for
              highlights. Rendering runs FFmpeg on the same machine.
            </p>
            <p className="text-[12px] text-faint">
              Clips and exports live on the server, so they survive a reload and are shared by every
              job the backend is running.
            </p>
          </PanelBody>
        </Panel>
      </aside>
    </div>
  );
}
