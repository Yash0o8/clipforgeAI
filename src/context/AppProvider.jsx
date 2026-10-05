import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import {
  NOTIFICATION_TONE,
  STORAGE_KEY,
} from '../utils/constants.js';
import { localId } from '../services/api.js';
import * as projectService from '../services/projectService.js';
import * as clipService from '../services/clipService.js';
import { AppContext } from './AppContext.js';

/* -------------------------------------------------------------------------- */
/*  Defaults                                                                   */
/* -------------------------------------------------------------------------- */

const DEFAULT_SETTINGS = {
  profile: {
    name: 'Alex Rivera',
    email: 'alex@clipforge.app',
    role: 'Content creator',
    company: 'Rivera Studio',
    bio: 'Short-form editor. I turn long interviews into clips that actually get watched.',
  },
  preferences: {
    defaultAspectRatio: '9:16',
    defaultCaptionPreset: 'clean',
    autoSelectClipsAbove: 85,
    captionPosition: 'lower',
    burnCaptions: true,
    notifyOnComplete: true,
    notifyOnFailure: true,
    weeklyDigest: false,
    autoSaveEdits: true,
    autoplayPreview: true,
    showCaptionsDefault: true,
  },
  appearance: {
    accent: 'brand',
  },
  /** Root-level flags read by `App.jsx` and the Settings page. */
  theme: 'dark',
  reducedMotion: false,
};

const INITIAL_STATE = {
  projects: [],
  clips: [],
  exports: [],
  notifications: [],
  settings: DEFAULT_SETTINGS,
  /** True until the first project list has come back from the API. */
  isLoading: true,
  /** Set when the API could not be reached, so pages can explain themselves. */
  loadError: null,
};

/* -------------------------------------------------------------------------- */
/*  Persistence                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Only genuinely client-side state is persisted.
 *
 * Projects, clips and exports are *not*: the backend owns them, and mirroring
 * them into localStorage creates a second source of truth that drifts the moment
 * a job finishes on a worker thread. Persisting them also used to resurrect
 * projects after the API's data directory was wiped.
 */
const PERSISTED_KEYS = ['notifications', 'settings'];

function readPersistedState() {
  if (typeof localStorage === 'undefined') return null;

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    const data = parsed?.data ?? parsed;
    if (!data || typeof data !== 'object') return null;

    return {
      ...DEFAULT_SETTINGS,
      ...(data.settings ?? {}),
      // Merge so newly added preference keys still get their defaults.
      profile: { ...DEFAULT_SETTINGS.profile, ...(data.settings?.profile ?? {}) },
      preferences: { ...DEFAULT_SETTINGS.preferences, ...(data.settings?.preferences ?? {}) },
      appearance: { ...DEFAULT_SETTINGS.appearance, ...(data.settings?.appearance ?? {}) },
    };
  } catch {
    // Corrupt payload: fall back to defaults rather than crashing on boot.
    return null;
  }
}

function writePersistedState(state) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        savedAt: new Date().toISOString(),
        data: Object.fromEntries(PERSISTED_KEYS.map((key) => [key, state[key]])),
      })
    );
  } catch {
    // Quota exceeded, or storage disabled in private mode. The app keeps
    // working in memory, it just will not survive a reload.
  }
}

/* -------------------------------------------------------------------------- */
/*  Reducer                                                                    */
/* -------------------------------------------------------------------------- */

function reducer(state, action) {
  switch (action.type) {
    case 'hydrate/start':
      return { ...state, isLoading: true, loadError: null };

    case 'hydrate/failure':
      return { ...state, isLoading: false, loadError: action.error };

    case 'hydrate/success':
      return {
        ...state,
        isLoading: false,
        loadError: null,
        projects: action.projects,
        // Drop clips for projects the API no longer knows about.
        clips: state.clips.filter((clip) =>
          action.projects.some((project) => project.id === clip.projectId)
        ),
      };

    case 'projects/add':
      return { ...state, projects: [action.project, ...state.projects] };

    case 'projects/replace':
      // Upsert: the server is the source of truth, and this action is dispatched
      // with projects we may not hold yet (a project created moments ago, or one
      // discovered after a reload). A pure map would silently drop those, leaving
      // the rest of the app unable to find a project it just created.
      return {
        ...state,
        projects: state.projects.some((project) => project.id === action.project.id)
          ? state.projects.map((project) =>
              project.id === action.project.id ? action.project : project
            )
          : [action.project, ...state.projects],
      };

    case 'projects/patch': {
      return {
        ...state,
        projects: state.projects.map((project) =>
          project.id === action.id ? { ...project, ...action.patch } : project
        ),
      };
    }

    case 'projects/remove': {
      const clipIds = new Set(
        state.clips.filter((clip) => clip.projectId === action.id).map((clip) => clip.id)
      );
      return {
        ...state,
        projects: state.projects.filter((project) => project.id !== action.id),
        clips: state.clips.filter((clip) => !clipIds.has(clip.id)),
        exports: state.exports.filter((item) => !clipIds.has(item.clipId)),
      };
    }

    case 'clips/setForProject':
      return {
        ...state,
        clips: [
          ...state.clips.filter((clip) => clip.projectId !== action.projectId),
          ...action.clips,
        ],
      };

    case 'clips/add':
      // Upsert, so a re-fetch of a clip already held replaces it in place
      // instead of leaving two rows with the same id in the selectors.
      return {
        ...state,
        clips: state.clips.some((clip) => clip.id === action.clip.id)
          ? state.clips.map((clip) => (clip.id === action.clip.id ? action.clip : clip))
          : [...state.clips, action.clip],
      };

    case 'clips/patch':
      return {
        ...state,
        clips: state.clips.map((clip) =>
          clip.id === action.id ? { ...clip, ...action.patch } : clip
        ),
      };

    case 'clips/patchMany': {
      const patches = new Map(action.patches.map((item) => [item.id, item.patch]));
      return {
        ...state,
        clips: state.clips.map((clip) =>
          patches.has(clip.id) ? { ...clip, ...patches.get(clip.id) } : clip
        ),
      };
    }

    case 'clips/setStatus': {
      const patches = action.ids.map((id) => ({ id, patch: { status: action.status } }));
      return reducer(state, { type: 'clips/patchMany', patches });
    }

    case 'exports/add':
      return { ...state, exports: [action.export, ...state.exports] };

    case 'exports/setAll':
      return { ...state, exports: action.exports };

    case 'exports/patch':
      return {
        ...state,
        exports: state.exports.map((item) =>
          item.id === action.id ? { ...item, ...action.patch } : item
        ),
      };

    case 'exports/remove':
      return { ...state, exports: state.exports.filter((item) => item.id !== action.id) };

    case 'notifications/push':
      return { ...state, notifications: [action.notification, ...state.notifications].slice(0, 50) };

    case 'notifications/readAll':
      return {
        ...state,
        notifications: state.notifications.map((notification) => ({ ...notification, read: true })),
      };

    case 'notifications/clear':
      return { ...state, notifications: [] };

    case 'settings/patch':
      return {
        ...state,
        settings: {
          ...state.settings,
          ...action.patch,
          profile: { ...state.settings.profile, ...(action.patch.profile ?? {}) },
          preferences: { ...state.settings.preferences, ...(action.patch.preferences ?? {}) },
          appearance: { ...state.settings.appearance, ...(action.patch.appearance ?? {}) },
        },
      };

    case 'app/reset':
      return { ...INITIAL_STATE, settings: action.patch?.settings ?? state.settings };

    default:
      return state;
  }
}

function init() {
  const settings = readPersistedState() ?? DEFAULT_SETTINGS;
  return { ...INITIAL_STATE, settings };
}

/* -------------------------------------------------------------------------- */
/*  Provider                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Owns the application state and keeps it in sync with the API.
 *
 * The backend is the source of truth for projects, clips and exports: they are
 * read from it on mount and after every mutation, and never written to
 * localStorage. Settings and notifications are client-side by nature and are
 * persisted.
 */
export function AppProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, null, init);

  // Notifications are pushed from async callbacks (job failures, API errors),
  // so they need a stable handle that does not re-create on every render.
  const notifyRef = useRef(null);
  const clipsRef = useRef({});
  const inFlightClips = useRef(new Map());

  const notify = useCallback(({ title, body, tone = NOTIFICATION_TONE.INFO }) => {
    dispatch({
      type: 'notifications/push',
      notification: {
        id: localId('ntf'),
        title,
        body,
        tone,
        read: false,
        at: new Date().toISOString(),
      },
    });
  }, []);

  useEffect(() => {
    notifyRef.current = notify;
  }, [notify]);

  // Debounced so typing in the settings form does not hammer localStorage.
  useEffect(() => {
    const timer = setTimeout(() => writePersistedState(state), 220);
    return () => clearTimeout(timer);
  }, [state]);

  /* --- Hydration ------------------------------------------------------ */

  const refreshProjects = useCallback(async () => {
    dispatch({ type: 'hydrate/start' });
    try {
      const projects = await projectService.listProjects();
      dispatch({ type: 'hydrate/success', projects });
      return projects;
    } catch (error) {
      dispatch({ type: 'hydrate/failure', error });
      throw error;
    }
  }, []);

  // Prune the `ensureClips` cache for projects the API no longer knows about,
  // otherwise a deleted-then-recreated id would serve stale clips forever.
  useEffect(() => {
    const known = new Set(state.projects.map((project) => project.id));
    for (const projectId of Object.keys(clipsRef.current)) {
      if (!known.has(projectId)) delete clipsRef.current[projectId];
    }
    for (const projectId of inFlightClips.current.keys()) {
      if (!known.has(projectId)) inFlightClips.current.delete(projectId);
    }
  }, [state.projects]);

  useEffect(() => {
    // A failed boot must not throw into the render tree; `loadError` surfaces it.
    refreshProjects().catch(() => {});
  }, [refreshProjects]);

  /** Fetch a project's clips and cache them for the selectors. */
  const loadClips = useCallback(async (projectId, { signal } = {}) => {
    const clips = await clipService.listClips(projectId, { signal });
    dispatch({ type: 'clips/setForProject', projectId, clips });
    return clips;
  }, []);

  /**
   * Load a project's clips unless they are already cached or on the way.
   *
   * Clips are a separate collection from projects, so boot hydration cannot
   * populate them. Any page that reads clips — project detail, the clip editor,
   * the dashboard's highlight feed — calls this instead of `loadClips`, which
   * keeps a re-render or a StrictMode double-invoke from re-fetching, and stops a
   * direct hit on a deep link like `/app/clips/{id}` from rendering an empty
   * library while the request is still in flight.
   */
  const ensureClips = useCallback(
    async (projectId) => {
      if (!projectId) return [];

      const cached = clipsRef.current[projectId];
      if (cached) return cached;
      if (inFlightClips.current.has(projectId)) return inFlightClips.current.get(projectId);

      const request = loadClips(projectId)
        .then((clips) => {
          clipsRef.current[projectId] = clips;
          return clips;
        })
        .finally(() => {
          inFlightClips.current.delete(projectId);
        });

      inFlightClips.current.set(projectId, request);
      return request;
    },
    [loadClips]
  );

  /* --- Projects ------------------------------------------------------- */

  /**
   * Create a project from an uploaded source.
   *
   * Only `uploadId` is required: the backend resolves the file name, size and
   * MIME type from the stored upload, so sending them from here would risk
   * describing the source differently from what was actually stored.
   *
   * @param {object} params
   * @param {string} params.uploadId   Handle from `uploadVideo`.
   * @param {string} [params.title]
   * @param {string} [params.fileName] Used only to derive a default title.
   * @returns {Promise<object>} The project as the backend now sees it.
   */
  const addProject = useCallback(async ({ uploadId, title, fileName } = {}) => {
    if (!uploadId) throw new Error('Cannot create a project without an uploaded file.');

    const project = await projectService.createProject({
      uploadId,
      title: title || fileName?.replace(/\.[^/.]+$/, '') || 'Untitled project',
    });

    dispatch({ type: 'projects/add', project });
    return project;
  }, []);

  /** Optimistic local patch, persisted to the API in the background. */
  const patchProject = useCallback(
    (id, patch) => {
      dispatch({ type: 'projects/patch', id, patch });

      // Only fields the API accepts are sent; derived fields like `progress`
      // are refreshed from the server on the next poll instead.
      const { title } = patch;
      if (title === undefined) return;

      projectService.updateProject(id, { title }).catch((error) => {
        notifyRef.current?.({
          title: 'Could not save that change',
          body: error.message,
          tone: NOTIFICATION_TONE.ERROR,
        });
      });
    },
    []
  );

  /** Merge a project record that came back from the API. */
  const replaceProject = useCallback((project) => {
    dispatch({ type: 'projects/replace', project });
  }, []);

  const removeProject = useCallback(
    async (id) => {
      await projectService.deleteProject(id);
      dispatch({ type: 'projects/remove', id });
    },
    []
  );

  /* --- Clips ---------------------------------------------------------- */

  const patchClip = useCallback((id, patch, { persist = true } = {}) => {
    dispatch({ type: 'clips/patch', id, patch });

    if (!persist) return;
    clipService.updateClip(id, patch).catch((error) => {
      notifyRef.current?.({
        title: 'Clip edit not saved',
        body: error.message,
        tone: NOTIFICATION_TONE.ERROR,
      });
    });
  }, []);

  const patchClips = useCallback((patches) => dispatch({ type: 'clips/patchMany', patches }), []);

  /**
   * Place a single server clip into the store.
   *
   * Used when a clip is reached by deep link, where no project-scoped fetch has
   * happened yet. The clip still needs to register in the `ensureClips` cache or
   * the next caller would fetch it again and clobber local edits.
   */
  const addClip = useCallback((clip) => {
    if (!clip?.id || !clip?.projectId) return;
    dispatch({ type: 'clips/add', clip });
    clipsRef.current[clip.projectId] = [
      ...(clipsRef.current[clip.projectId] ?? []).filter((existing) => existing.id !== clip.id),
      clip,
    ];
  }, []);

  const setClipStatus = useCallback(
    (ids, status) =>
      dispatch({ type: 'clips/setStatus', ids: Array.isArray(ids) ? ids : [ids], status }),
    []
  );

  const discardClip = useCallback(async (id) => {
    await clipService.deleteClip(id);
    dispatch({ type: 'clips/patch', id: id, patch: { status: 'discarded' } });
  }, []);

  /* --- Exports -------------------------------------------------------- */

  /**
   * Fetch the server's export history.
   *
   * Render jobs are created inside `ClipEditor` and only tracked in local state
   * there, so the Exports page would be empty after any reload without this.
   */
  const refreshExports = useCallback(async ({ projectId, signal } = {}) => {
    const exports = await clipService.listExports({ projectId, signal });
    dispatch({ type: 'exports/setAll', exports });
    return exports;
  }, []);

  const patchExport = useCallback((id, patch) => dispatch({ type: 'exports/patch', id, patch }), []);
  const removeExport = useCallback((id) => dispatch({ type: 'exports/remove', id }), []);

  /** Record a job queued this session so the list updates immediately. */
  const trackExport = useCallback((job) => {
    if (!job?.id) return job;
    dispatch({ type: 'exports/add', export: { createdAt: new Date().toISOString(), ...job } });
    return job;
  }, []);

  /* --- Notifications & settings --------------------------------------- */

  const markNotificationsRead = useCallback(() => dispatch({ type: 'notifications/readAll' }), []);
  const clearNotifications = useCallback(() => dispatch({ type: 'notifications/clear' }), []);

  const patchSettings = useCallback((patch) => dispatch({ type: 'settings/patch', patch }), []);

  const clearLocalData = useCallback(() => {
    try {
      localStorage?.removeItem(STORAGE_KEY);
    } catch {
      /* storage unavailable - state still resets */
    }
    dispatch({ type: 'app/reset', patch: { settings: DEFAULT_SETTINGS } });
  }, []);

  const value = useMemo(
    () => ({
      ...state,
      refreshProjects,
      loadClips,
      ensureClips,
      addProject,
      patchProject,
      replaceProject,
      removeProject,
      patchClip,
      patchClips,
      addClip,
      setClipStatus,
      discardClip,
      refreshExports,
      trackExport,
      patchExport,
      removeExport,
      notify,
      markNotificationsRead,
      clearNotifications,
      patchSettings,
      clearLocalData,
      unreadCount: state.notifications.filter((notification) => !notification.read).length,
    }),
    [
      state,
      refreshProjects,
      loadClips,
      ensureClips,
      addProject,
      patchProject,
      replaceProject,
      removeProject,
      patchClip,
      patchClips,
      addClip,
      setClipStatus,
      discardClip,
      refreshExports,
      trackExport,
      patchExport,
      removeExport,
      notify,
      markNotificationsRead,
      clearNotifications,
      patchSettings,
      clearLocalData,
    ]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}