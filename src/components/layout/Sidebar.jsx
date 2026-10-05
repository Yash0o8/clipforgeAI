import { NavLink } from 'react-router-dom';
import {
  Download,
  FolderClosed,
  LayoutDashboard,
  Scissors,
  Settings,
  Sparkles,
} from 'lucide-react';
import { NAV_ITEMS } from '../../utils/constants.js';
import { ClipForgeLogo } from '../../assets/icons/ClipForgeMark.jsx';
import { formatHours } from '../../utils/formatDuration.js';
import { useApp } from '../../hooks/useApp.js';

/** Icon lookup by name, so `NAV_ITEMS` stays a plain serialisable array. */
const ICONS = {
  LayoutDashboard,
  FolderClosed,
  Sparkles,
  Scissors,
  Download,
  Settings,
};

/**
 * Primary navigation.
 *
 * `NavLink` supplies `aria-current="page"` automatically, and active styling is
 * driven by `end` so `/app/overview` does not also light up `/app/overview/x`.
 */
export function Sidebar({ onNavigate }) {
  const { projects, clips } = useApp();

  // Real totals from the library, rather than a plan quota that does not exist.
  const totalMinutes = projects.reduce(
    (sum, project) => sum + (project.durationSec ?? 0) / 60,
    0
  );

  return (
    <div className="flex h-full flex-col bg-ink-900">
      <div className="hairline-t flex h-16 shrink-0 items-center border-t-0 px-5">
        <NavLink to="/app/overview" onClick={onNavigate} aria-label="ClipForge AI home">
          <ClipForgeLogo />
        </NavLink>
      </div>

      <nav aria-label="Main" className="scrollbar-thin flex-1 overflow-y-auto px-3 py-4">
        <p className="px-3 pb-2 text-[10.5px] font-semibold tracking-widest text-faint uppercase">
          Workspace
        </p>

        <ul className="space-y-0.5">
          {NAV_ITEMS.map((item) => {
            const Icon = ICONS[item.icon] ?? LayoutDashboard;
            return (
              <li key={item.id}>
                <NavLink
                  to={item.to}
                  onClick={onNavigate}
                  className={({ isActive }) =>
                    `group relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-[13.5px] font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400 ${
                      isActive
                        ? 'bg-brand-500/12 text-primary'
                        : 'text-secondary hover:bg-ink-850 hover:text-primary'
                    }`
                  }
                >
                  {({ isActive }) => (
                    <>
                      {/* Active rail: a colour cue that survives greyscale. */}
                      <span
                        aria-hidden
                        className={`absolute top-1/2 left-0 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-brand-400 transition-opacity duration-150 ${
                          isActive ? 'opacity-100' : 'opacity-0'
                        }`}
                      />
                      <Icon
                        aria-hidden
                        className={`size-4.5 shrink-0 transition-colors ${
                          isActive ? 'text-brand-400' : 'text-faint group-hover:text-secondary'
                        }`}
                      />
                      <span className="truncate">{item.label}</span>
                    </>
                  )}
                </NavLink>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="shrink-0 border-t border-line p-3">
        <div className="rounded-lg border border-line bg-ink-850 p-3.5">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-faint">
            Your library
          </p>
          <p className="tabular mt-1.5 text-[12px] text-secondary">
            <span className="text-primary">{projects.length}</span>{' '}
            {projects.length === 1 ? 'project' : 'projects'}
            {' · '}
            <span className="text-primary">{clips.length}</span>{' '}
            {clips.length === 1 ? 'clip' : 'clips'}
          </p>
          {totalMinutes > 0 && (
            <p className="tabular mt-0.5 text-[11px] text-faint">
              <span className="text-secondary">{formatHours(totalMinutes * 60)}</span> of source
              video
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
