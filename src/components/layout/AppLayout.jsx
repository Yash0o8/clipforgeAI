import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { PlugZap, X } from 'lucide-react';
import { Sidebar } from './Sidebar.jsx';
import { Header } from './Header.jsx';
import { MobileNavigation } from './MobileNavigation.jsx';
import { IconButton } from '../common/Button.jsx';
import { useApp } from '../../hooks/useApp.js';

/**
 * Authenticated application shell.
 *
 * Desktop (`lg` and up): persistent 260px sidebar beside the content column.
 * Mobile: sidebar becomes an off-canvas drawer, plus a fixed bottom tab bar.
 */
export function AppLayout() {
  const location = useLocation();
  const { loadError, refreshProjects } = useApp();

  /**
   * The drawer stores the path it was opened on rather than a boolean, so
   * "close on navigation" is derived from the current location instead of
   * needing an effect to reset state after every route change.
   */
  const [openedAt, setOpenedAt] = useState(null);
  const drawerOpen = openedAt !== null && openedAt === location.pathname;

  const openDrawer = () => setOpenedAt(location.pathname);
  const closeDrawer = () => setOpenedAt(null);

  // Lock page scroll behind the drawer, restoring the previous value on close.
  useEffect(() => {
    if (!drawerOpen) return undefined;

    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKeyDown = (event) => {
      if (event.key === 'Escape') closeDrawer();
    };
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [drawerOpen]);

  return (
    <div className="min-h-dvh bg-ink-950">
      <a href="#main-content" className="skip-link z-50 rounded-lg bg-brand-500 px-3 py-2 text-[13px] font-semibold text-white">
        Skip to main content
      </a>

      <div className="flex min-h-dvh">
        {/* --- Desktop sidebar --- */}
        <aside className="hairline-t hidden w-[260px] shrink-0 border-r border-t-0 lg:block">
          <div className="sticky top-0 h-dvh">
            <Sidebar />
          </div>
        </aside>

        {/* --- Mobile drawer --- */}
        <AnimatePresence>
          {drawerOpen && (
            <div className="fixed inset-0 z-40 lg:hidden">
              <motion.div
                className="absolute inset-0 bg-ink-950/75 backdrop-blur-sm"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18 }}
                onClick={() => closeDrawer()}
                aria-hidden="true"
              />

              <motion.div
                role="dialog"
                aria-modal="true"
                aria-label="Navigation"
                className="panel-raised absolute inset-y-0 left-0 flex w-[min(17rem,85vw)] flex-col rounded-none border-y-0 border-l-0"
                initial={{ x: '-100%' }}
                animate={{ x: 0 }}
                exit={{ x: '-100%' }}
                transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
              >
                <IconButton
                  label="Close navigation"
                  size="sm"
                  onClick={() => closeDrawer()}
                  className="absolute top-3.5 right-3 z-10"
                >
                  <X className="size-4" />
                </IconButton>

                <Sidebar onNavigate={() => closeDrawer()} />
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* --- Content column --- */}
        <div className="flex min-w-0 flex-1 flex-col">
          <Header onOpenSidebar={() => openDrawer()} />

          {loadError && (
            <div className="hairline-t flex items-center gap-2 border-t-0 bg-danger/[0.06] px-4 py-1.5 sm:px-6">
              <PlugZap aria-hidden className="size-3.5 shrink-0 text-danger" />
              <p className="min-w-0 text-[11.5px] leading-snug text-danger">
                <span className="font-semibold">Cannot reach the ClipForge API.</span>{' '}
                {loadError.message ?? 'Check that the backend is running, then reload.'}
              </p>
              <button
                type="button"
                onClick={() => refreshProjects().catch(() => {})}
                className="ml-auto shrink-0 rounded-md px-2 py-0.5 text-[11.5px] font-medium text-danger underline underline-offset-2 hover:text-danger/80"
              >
                Retry
              </button>
            </div>
          )}

          <main
            id="main-content"
            tabIndex={-1}
            className="min-w-0 flex-1 px-4 pt-5 pb-24 sm:px-6 sm:pt-6 lg:pb-10 focus-visible:outline-none"
          >
            <Outlet />
          </main>
        </div>
      </div>

      <MobileNavigation />
    </div>
  );
}
