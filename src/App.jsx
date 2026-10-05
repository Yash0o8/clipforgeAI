import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AppLayout } from './components/layout/AppLayout.jsx';
import { ToastViewport } from './components/common/Toast.jsx';
import { LandingPage } from './pages/Landing.jsx';
import { OverviewPage } from './pages/Overview.jsx';
import { ProjectsPage, ProjectPage } from './pages/Projects.jsx';
import { UploadPage } from './pages/Upload.jsx';
import { ProcessingPage } from './pages/Processing.jsx';
import { ClipsPage } from './pages/Clips.jsx';
import { ClipEditorPage } from './pages/ClipEditorPage.jsx';
import { ExportsPage } from './pages/Exports.jsx';
import { SettingsPage } from './pages/Settings.jsx';
import { NotFoundPage } from './pages/NotFound.jsx';
import { useApp } from './hooks/useApp.js';

/**
 * Top-level router.
 *
 * `/app` defaults to `/app/overview` after "Get started" so the user lands
 * directly in the working dashboard. All app routes live under `/app/*` to keep
 * the marketing landing at `/`.
 */
function AppRoutes() {
  const { settings } = useApp();

  // Sync the document with the user's theme preference. The `data-theme`
  // attribute is what actually drives the palette (`index.css`); the `dark`
  // class is kept for any component that keys off it.
  useEffect(() => {
    const isLight = settings.theme === 'light';
    document.documentElement.classList.toggle('dark', !isLight);
    document.documentElement.setAttribute('data-theme', settings.theme);

    // Browser UI (address bar, notch) follows the page background.
    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) themeColor.setAttribute('content', isLight ? '#f5f5f8' : '#07070c');
  }, [settings.theme]);

  // Respect prefers-reduced-motion at the root level.
  useEffect(() => {
    document.documentElement.classList.toggle(
      'reduce-motion',
      settings.reducedMotion || window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  }, [settings.reducedMotion]);

  return (
    <BrowserRouter>
      <Routes>
        {/* Marketing */}
        <Route path="/" element={<LandingPage />} />

        {/* Application */}
        <Route element={<AppLayout />}>
          <Route path="/app/overview" element={<OverviewPage />} />
          <Route path="/app/projects" element={<ProjectsPage />} />
          <Route path="/app/projects/:id" element={<ProjectPage />} />
          <Route path="/app/upload" element={<UploadPage />} />
          <Route path="/app/upload/processing/:projectId" element={<ProcessingPage />} />
          <Route path="/app/clips" element={<ClipsPage />} />
          <Route path="/app/clips/:clipId/editor" element={<ClipEditorPage />} />
          <Route path="/app/exports" element={<ExportsPage />} />
          <Route path="/app/settings" element={<SettingsPage />} />
          <Route path="/app" element={<Navigate to="/app/overview" replace />} />
        </Route>

        <Route path="*" element={<NotFoundPage />} />
      </Routes>

      <ToastViewport />
    </BrowserRouter>
  );
}

export default AppRoutes;
