import { NavLink } from 'react-router-dom';
import { Download, FolderClosed, LayoutDashboard, Scissors, Sparkles } from 'lucide-react';
import { MOBILE_NAV_ITEMS } from '../../utils/constants.js';

const ICONS = {
  LayoutDashboard,
  FolderClosed,
  Sparkles,
  Scissors,
  Download,
};

/**
 * Fixed bottom tab bar for phones.
 *
 * Hidden from `lg` up, where the full sidebar is visible. `pb-safe` keeps the
 * bar clear of the iOS home indicator.
 */
export function MobileNavigation() {
  return (
    <nav
      aria-label="Primary"
      className="pb-safe hairline-t fixed inset-x-0 bottom-0 z-30 border-t bg-ink-900/95 backdrop-blur-xl lg:hidden"
    >
      <ul className="grid grid-cols-4">
        {MOBILE_NAV_ITEMS.map((item) => {
          const Icon = ICONS[item.icon] ?? LayoutDashboard;
          return (
            <li key={item.id}>
              <NavLink
                to={item.to}
                className={({ isActive }) =>
                  `flex flex-col items-center gap-1 px-1 pt-2.5 pb-2 text-[10.5px] font-medium transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-400 ${
                    isActive ? 'text-brand-400' : 'text-faint hover:text-secondary'
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    <Icon aria-hidden className="size-5" />
                    <span className="truncate">{item.label.replace('Create Clips', 'Create')}</span>
                    {isActive && (
                      <span aria-hidden className="absolute bottom-0 h-0.5 w-8 rounded-t bg-brand-500" />
                    )}
                  </>
                )}
              </NavLink>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
