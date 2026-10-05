import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Clock, FolderOpen, Scissors } from 'lucide-react';
import { Panel, PanelHeader, PanelBody } from '../common/Panel.jsx';
import { useApp } from '../../hooks/useApp.js';
import { formatHours } from '../../utils/formatDuration.js';
import { CLIP_STATUS, PROJECT_STATUS } from '../../utils/constants.js';

/** Compact stat tile. */
function StatTile({ title, value, description, icon: Icon }) {
  return (
    <Panel>
      <PanelHeader title={title} />
      <PanelBody className="flex items-end justify-between gap-3 pt-0">
        <div>
          <p className="text-2xl font-semibold text-primary">{value}</p>
          {description && <p className="mt-0.5 text-[12px] text-faint">{description}</p>}
        </div>
        {Icon && (
          <span className="flex size-9 items-center justify-center rounded-lg border border-line-strong bg-ink-850 text-brand-400">
            <Icon aria-hidden className="size-4" />
          </span>
        )}
      </PanelBody>
    </Panel>
  );
}

/**
 * Dashboard KPIs.
 *
 * Counts projects, ready clips and total runtime, using values already in
 * context. No extra network calls, no memo churn.
 */
export function StatsGrid() {
  const { projects, clips } = useApp();

  const stats = useMemo(() => {
    const totalProjects = projects.length;
    const readyProjects = projects.filter((p) => p.status === PROJECT_STATUS.READY).length;
    const totalClips = clips.length;
    const selected = clips.filter((c) => c.status === CLIP_STATUS.SELECTED).length;
    const edited = clips.filter((c) => c.status === CLIP_STATUS.EDITED).length;
    const totalMinutes = projects.reduce((sum, p) => sum + (p.durationSec ?? 0), 0) / 60;

    return {
      totalProjects,
      readyProjects,
      totalClips,
      selected,
      edited,
      totalMinutes,
    };
  }, [projects, clips]);

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <StatTile
        title="Projects"
        value={stats.totalProjects}
        description={`${stats.readyProjects} ready`}
        icon={FolderOpen}
      />
      <StatTile
        title="Clips"
        value={stats.totalClips}
        description={`${stats.selected} selected · ${stats.edited} edited`}
        icon={Scissors}
      />
      <StatTile
        title="Total runtime"
        value={formatHours(projects.reduce((sum, p) => sum + (p.durationSec ?? 0), 0))}
        description={`${stats.totalMinutes.toFixed(0)} minutes`}
        icon={Clock}
      />
      <StatTile
        title="Ready to export"
        value={stats.selected}
        description={stats.selected === 0 ? 'Select clips in library' : 'Go to Exports'}
        icon={ArrowUpRight}
      />
    </div>
  );
}