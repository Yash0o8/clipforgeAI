import { Download, RefreshCw, Trash2 } from 'lucide-react';
import { Panel, PanelHeader, PanelBody } from '../components/common/Panel.jsx';
import { Toggle } from '../components/common/Toggle.jsx';
import { Button } from '../components/common/Button.jsx';
import { useApp } from '../hooks/useApp.js';
import { downloadLibraryBackup } from '../utils/download.js';
import { useToast } from '../hooks/useToast.js';

/**
 * Settings.
 *
 * Preferences are persisted to localStorage via `AppProvider`. Projects, clips
 * and exports are *not* cleared from here: they live on the backend, so wiping
 * the browser copy would only desynchronise the app from the real library.
 */
export function SettingsPage() {
  const {
    settings,
    patchSettings,
    clearLocalData,
    refreshProjects,
    isLoading,
    projects,
    clips,
    exports,
    notifications,
  } = useApp();
  const toast = useToast();

  const themeLabel = settings.theme === 'dark' ? 'Dark' : 'Light';

  const onBackup = () => {
    downloadLibraryBackup({
      projects,
      clips,
      exports,
      notifications,
      settings,
    });
    toast.success('Backup downloaded');
  };

  const onRefresh = async () => {
    try {
      const list = await refreshProjects();
      toast.success('Library refreshed', { body: `${list.length} projects loaded.` });
    } catch (error) {
      toast.error('Could not reach the API', { body: error.message });
    }
  };

  const onClear = () => {
    clearLocalData();
    toast.info('Local preferences and notifications cleared');
  };

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-[17px] font-semibold text-primary">Settings</h1>
        <p className="mt-0.5 text-sm text-secondary">
          Preferences and data for this installation.
        </p>
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel>
          <PanelHeader title="Appearance" subtitle="Theme is stored locally." />
          <PanelBody className="space-y-3">
            <Toggle
              id="theme"
              checked={settings.theme === 'dark'}
              onChange={(checked) => patchSettings({ theme: checked ? 'dark' : 'light' })}
              label={`Theme  ${themeLabel}`}
              description="Dark is the default; light keeps the same layout and palette."
            />
            <Toggle
              id="reduced-motion"
              checked={settings.reducedMotion}
              onChange={(checked) => patchSettings({ reducedMotion: checked })}
              label="Reduce motion"
              description="Disables non-essential animations and transitions."
            />
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader title="Processing" subtitle="Applied across the editor." />
          <PanelBody className="space-y-3">
            <Toggle
              id="autoplay-preview"
              checked={settings.preferences.autoplayPreview}
              onChange={(checked) =>
                patchSettings({ preferences: { autoplayPreview: checked } })
              }
              label="Autoplay clip preview"
              description="Start playing when the editor opens."
            />
            <Toggle
              id="showCaptionsDefault"
              checked={settings.preferences.showCaptionsDefault}
              onChange={(checked) =>
                patchSettings({ preferences: { showCaptionsDefault: checked } })
              }
              label="Show captions by default"
              description="Default for poster and editor views."
            />
          </PanelBody>
        </Panel>

        <Panel className="lg:col-span-2">
          <PanelHeader
            title="Data"
            subtitle="Projects and clips live on your ClipForge server; preferences are kept in this browser."
          />
          <PanelBody className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" onClick={onBackup}>
              <Download aria-hidden className="size-3.5" />
              Export backup (JSON)
            </Button>
            <Button size="sm" variant="secondary" loading={isLoading} onClick={onRefresh}>
              <RefreshCw aria-hidden className="size-3.5" />
              Refresh from server
            </Button>
            <Button size="sm" variant="danger" onClick={onClear}>
              <Trash2 aria-hidden className="size-3.5" />
              Clear local preferences
            </Button>
          </PanelBody>
        </Panel>
      </div>
    </div>
  );
}












