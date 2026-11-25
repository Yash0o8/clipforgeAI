import { useState } from 'react';
import { Download, RefreshCw, Trash2, UserRound } from 'lucide-react';
import { Panel, PanelHeader, PanelBody } from '../components/common/Panel.jsx';
import { Toggle } from '../components/common/Toggle.jsx';
import { Button } from '../components/common/Button.jsx';
import { TextArea, TextField } from '../components/common/TextField.jsx';
import { ConfirmDialog } from '../components/common/Modal.jsx';
import { useApp } from '../hooks/useApp.js';
import { downloadLibraryBackup } from '../utils/download.js';
import { useToast } from '../hooks/useToast.js';

/**
 * Settings.
 *
 * Profile and preferences are persisted to localStorage via `AppProvider`.
 * Projects, clips and exports are *not* cleared from here: they live on the
 * backend, so wiping the browser copy would only desynchronise the app from the
 * real library.
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
  const [confirmClear, setConfirmClear] = useState(false);

  const { profile, preferences } = settings;

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
    setConfirmClear(false);
    clearLocalData();
    toast.info('Local preferences and notifications cleared');
  };

  const patchProfile = (patch) => patchSettings({ profile: patch });
  const patchPreferences = (patch) => patchSettings({ preferences: patch });

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-[17px] font-semibold text-primary">Settings</h1>
        <p className="mt-0.5 text-sm text-secondary">
          Profile, preferences and data for this installation.
        </p>
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel className="lg:col-span-2">
          <PanelHeader
            title="Account"
            subtitle="Shown on your exports and workspace. Stored only in this browser."
            actions={<UserRound aria-hidden className="size-4 text-brand-400" />}
          />
          <PanelBody className="grid gap-3 sm:grid-cols-2">
            <TextField
              id="profile-name"
              label="Display name"
              value={profile.name}
              onChange={(event) => patchProfile({ name: event.target.value })}
              maxLength={60}
            />
            <TextField
              id="profile-email"
              label="Email"
              type="email"
              value={profile.email}
              onChange={(event) => patchProfile({ email: event.target.value })}
              maxLength={120}
            />
            <TextField
              id="profile-role"
              label="Role"
              value={profile.role}
              onChange={(event) => patchProfile({ role: event.target.value })}
              maxLength={60}
            />
            <TextField
              id="profile-company"
              label="Studio / brand"
              value={profile.company}
              onChange={(event) => patchProfile({ company: event.target.value })}
              maxLength={80}
            />
            <TextArea
              id="profile-bio"
              label="Short bio"
              rows={2}
              className="sm:col-span-2"
              value={profile.bio}
              onChange={(event) => patchProfile({ bio: event.target.value })}
              maxLength={240}
            />
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader title="Appearance" subtitle="Theme is stored locally." />
          <PanelBody className="space-y-3">
            <Toggle
              id="theme"
              checked={settings.theme === 'dark'}
              onChange={(checked) => patchSettings({ theme: checked ? 'dark' : 'light' })}
              label="Dark theme"
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
              checked={preferences.autoplayPreview}
              onChange={(checked) => patchPreferences({ autoplayPreview: checked })}
              label="Autoplay clip preview"
              description="Start playing when the editor opens."
            />
            <Toggle
              id="show-captions-default"
              checked={preferences.showCaptionsDefault}
              onChange={(checked) => patchPreferences({ showCaptionsDefault: checked })}
              label="Show captions by default"
              description="Default for poster and editor views."
            />
            <Toggle
              id="notify-complete"
              checked={preferences.notifyOnComplete}
              onChange={(checked) => patchPreferences({ notifyOnComplete: checked })}
              label="Notify when processing finishes"
              description="Shows a notification when your clips are ready."
            />
            <Toggle
              id="notify-failure"
              checked={preferences.notifyOnFailure}
              onChange={(checked) => patchPreferences({ notifyOnFailure: checked })}
              label="Notify on failures"
              description="Shows a notification if a job needs your attention."
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
            <Button size="sm" variant="danger" onClick={() => setConfirmClear(true)}>
              <Trash2 aria-hidden className="size-3.5" />
              Clear local preferences
            </Button>
          </PanelBody>
        </Panel>
      </div>

      <ConfirmDialog
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        onConfirm={onClear}
        title="Clear local preferences?"
        message="This resets your profile, theme and notifications in this browser. Projects, clips and exports on the server are not affected."
        confirmLabel="Clear preferences"
        tone="danger"
      />
    </div>
  );
}
