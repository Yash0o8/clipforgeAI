import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Bell,
  CheckCheck,
  FolderClosed,
  Menu,
  Plus,
  Scissors,
  Search,
  X,
} from 'lucide-react';
import { useApp } from '../../hooks/useApp.js';
import { Button, IconButton } from '../common/Button.jsx';
import { formatRelativeTime } from '../../utils/formatDuration.js';

const TONE_CLASSES = {
  info: 'bg-info',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
};

function initials(name = '') {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0].toUpperCase())
      .join('') || 'CF'
  );
}

/**
 * Click-away helper shared by the search and notification popovers.
 * Closes on outside pointer-down or Escape, and ignores clicks on the trigger.
 */
function useDismiss(open, onClose) {
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    const onPointerDown = (event) => {
      if (ref.current && !ref.current.contains(event.target)) onClose();
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose]);

  return ref;
}

/** Type-ahead over projects and clips. Caps results to keep the list short. */
function GlobalSearch({ onNavigate }) {
  const { projects, clips } = useApp();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const close = useDismiss(open, () => setOpen(false));

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length < 2) return null;

    const projectHits = projects
      .filter((project) => project.title.toLowerCase().includes(needle))
      .slice(0, 4)
      .map((project) => ({
        id: project.id,
        type: 'project',
        title: project.title,
        meta: `${project.fileName ?? 'Video'} · ${project.status}`,
        to: `/app/projects/${project.id}`,
      }));

    const clipHits = clips
      .filter((clip) => clip.title.toLowerCase().includes(needle))
      .slice(0, 5)
      .map((clip) => ({
        id: clip.id,
        type: 'clip',
        title: clip.title,
        meta: `${clip.score}% match · ${clip.aspectRatio}`,
        to: `/app/clips/${clip.id}/editor`,
      }));

    return [...projectHits, ...clipHits];
  }, [query, projects, clips]);

  const go = (to) => {
    setOpen(false);
    setQuery('');
    onNavigate?.();
    navigate(to);
  };

  return (
    <div ref={close} className="relative min-w-0 flex-1 sm:max-w-md">
      <form
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          if (results?.length) go(results[0].to);
        }}
      >
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint">
          <Search aria-hidden className="size-4" />
        </span>
        <input
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder="Search projects and clips"
          aria-label="Search projects and clips"
          className="h-9 w-full rounded-lg border border-line-strong bg-ink-900 pl-9 pr-9 text-[13px] text-primary placeholder:text-faint transition-colors hover:border-line-hover focus:border-brand-500 focus:ring-2 focus:ring-brand-500/25 focus:outline-none"
        />
        {query && (
          <button
            type="button"
            onClick={() => {
              setQuery('');
              setOpen(false);
            }}
            aria-label="Clear search"
            className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-faint transition-colors hover:text-primary"
          >
            <X className="size-3.5" />
          </button>
        )}
      </form>

      {open && query.trim().length >= 2 && (
        <div className="panel-raised absolute left-0 right-0 top-[calc(100%+6px)] z-30 max-h-80 overflow-y-auto p-1.5 scrollbar-thin">
          {results === null ? null : results.length === 0 ? (
            <p className="px-3 py-6 text-center text-[13px] text-secondary">
              Nothing matches “{query.trim()}”.
            </p>
          ) : (
            <>
              {results.some((result) => result.type === 'project') && (
                <p className="px-2.5 pt-1.5 pb-1 text-[10px] font-semibold tracking-widest text-faint uppercase">
                  Projects
                </p>
              )}
              {results
                .filter((result) => result.type === 'project')
                .map((result) => (
                  <button
                    key={result.id}
                    type="button"
                    onClick={() => go(result.to)}
                    className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-ink-750"
                  >
                    <FolderClosed aria-hidden className="size-4 shrink-0 text-faint" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-primary">
                        {result.title}
                      </span>
                      <span className="block truncate text-[11px] text-faint capitalize">
                        {result.meta}
                      </span>
                    </span>
                  </button>
                ))}

              {results.some((result) => result.type === 'clip') && (
                <p className="px-2.5 pt-2 pb-1 text-[10px] font-semibold tracking-widest text-faint uppercase">
                  Clips
                </p>
              )}
              {results
                .filter((result) => result.type === 'clip')
                .map((result) => (
                  <button
                    key={result.id}
                    type="button"
                    onClick={() => go(result.to)}
                    className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-ink-750"
                  >
                    <Scissors aria-hidden className="size-4 shrink-0 text-faint" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-primary">
                        {result.title}
                      </span>
                      <span className="block truncate text-[11px] text-faint">{result.meta}</span>
                    </span>
                  </button>
                ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Bell + popover listing the notification feed. */
function NotificationBell() {
  const { notifications, unreadCount, markNotificationsRead, clearNotifications } = useApp();
  const [open, setOpen] = useState(false);
  const close = useDismiss(open, () => setOpen(false));
  const navigate = useNavigate();

  return (
    <div ref={close} className="relative">
      <IconButton
        label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'}
        size="sm"
        onClick={() => setOpen((value) => !value)}
        className="relative"
        aria-expanded={open}
      >
        <Bell className="size-4" />
        {unreadCount > 0 && (
          <span className="absolute top-1 right-1 flex size-3.5 items-center justify-center rounded-full bg-brand-500 ring-2 ring-ink-900">
            <span className="tabular text-[9px] font-bold text-white">
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          </span>
        )}
      </IconButton>

      {open && (
        <div className="panel-raised absolute right-0 top-[calc(100%+6px)] z-30 w-[min(22rem,calc(100vw-2rem))] overflow-hidden">
          <header className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
            <h2 className="text-[13px] font-semibold text-primary">Notifications</h2>
            <div className="flex items-center gap-0.5">
              <IconButton label="Mark all as read" size="xs" onClick={markNotificationsRead}>
                <CheckCheck className="size-3.5" />
              </IconButton>
              <IconButton label="Clear notifications" size="xs" onClick={clearNotifications}>
                <X className="size-3.5" />
              </IconButton>
            </div>
          </header>

          <div className="scrollbar-thin max-h-80 overflow-y-auto">
            {notifications.length === 0 ? (
              <p className="px-4 py-8 text-center text-[13px] text-secondary">
                You're all caught up.
              </p>
            ) : (
              <ul className="divide-y divide-line">
                {notifications.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setOpen(false);
                        if (item.type === 'project') navigate(`/app/projects/${item.projectId}`);
                      }}
                      className={`flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-ink-800 ${
                        item.read ? '' : 'bg-brand-500/[0.05]'
                      }`}
                    >
                      <span
                        aria-hidden
                        className={`mt-1.5 size-1.5 shrink-0 rounded-full ${
                          item.read ? 'bg-transparent' : TONE_CLASSES[item.tone] ?? 'bg-brand-400'
                        }`}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline justify-between gap-2">
                          <span className="truncate text-[13px] font-medium text-primary">
                            {item.title}
                          </span>
                          <span className="shrink-0 text-[10.5px] text-faint">
                            {formatRelativeTime(item.at)}
                          </span>
                        </span>
                        <span className="mt-0.5 block text-[12px] leading-relaxed text-secondary">
                          {item.body}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Application header: search, notifications, account and the primary action.
 * The hamburger appears only below the `lg` breakpoint.
 */
export function Header({ onOpenSidebar }) {
  const { settings } = useApp();
  const { profile } = settings;

  return (
    <header className="hairline-t sticky top-0 z-30 flex h-16 shrink-0 items-center gap-2 border-t-0 bg-ink-950/85 px-3 backdrop-blur-xl sm:gap-3 sm:px-5">
      <IconButton label="Open navigation" size="sm" className="lg:hidden" onClick={onOpenSidebar}>
        <Menu className="size-4.5" />
      </IconButton>

      <GlobalSearch />

      <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
        <NotificationBell />

        <Link
          to="/app/settings"
          aria-label={`Account settings for ${profile.name}`}
          className="hidden items-center gap-2.5 rounded-lg border border-line-strong bg-ink-900 py-1 pr-3 pl-1 transition-colors hover:border-line-hover sm:flex"
        >
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-brand-400 to-brand-700 text-[11px] font-bold text-white">
            {initials(profile.name)}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[12.5px] leading-tight font-medium text-primary">
              {profile.name}
            </span>
            <span className="block truncate text-[10.5px] leading-tight text-faint">
              {profile.role}
            </span>
          </span>
        </Link>

        <Button size="sm" className="shrink-0" as={Link} to="/app/upload">
          <Plus aria-hidden className="size-4" />
          <span className="hidden sm:inline">Create new</span>
        </Button>
      </div>
    </header>
  );
}
