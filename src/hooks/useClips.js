import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from './useApp.js';
import {
  ASPECT_RATIO_MAP,
  CAPTION_PRESET_MAP,
  CLIP_LIMITS,
  CLIP_STATUS,
  PROJECT_STATUS,
} from '../utils/constants.js';
import { clamp, round } from '../utils/formatDuration.js';

/**
 * Clip discovery: filtering, searching and sorting for the Clips page.
 */
export function useClips({ projectId } = {}) {
  const { clips, projects, patchClip, patchClips, setClipStatus, discardClip, ensureClips } =
    useApp();

  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState('relevance');
  const [query, setQuery] = useState('');
  const [view, setView] = useState('grid');

  // Clips are a separate collection from projects, so nothing is loaded until a
  // page asks for it. Without this the library renders empty on a reload even
  // though the API holds finished clips.
  //
  // Scoped to one project this fetches just that project; unscoped it covers
  // every ready project, since the API has no cross-project clip listing.
  const readyProjectIds = useMemo(
    () => projects.filter((p) => p.status === PROJECT_STATUS.READY).map((p) => p.id),
    [projects]
  );

  useEffect(() => {
    const targets = projectId ? [projectId] : readyProjectIds;
    for (const id of targets) ensureClips(id).catch(() => {});
  }, [projectId, readyProjectIds, ensureClips]);

  /** Scope to one project when a project id is supplied. */
  const scoped = useMemo(
    () => (projectId ? clips.filter((clip) => clip.projectId === projectId) : clips),
    [clips, projectId]
  );

  /** Counts per filter tab, computed against the project scope. */
  const counts = useMemo(() => {
    const base = { all: scoped.length };
    for (const key of [CLIP_STATUS.SELECTED, CLIP_STATUS.EDITED, CLIP_STATUS.EXPORTED]) {
      base[key] = scoped.filter((clip) => clip.status === key).length;
    }
    return base;
  }, [scoped]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();

    const result = scoped.filter((clip) => {
      if (filter !== 'all' && clip.status !== filter) return false;
      if (!needle) return true;
      return (
        clip.title?.toLowerCase().includes(needle) ||
        clip.hook?.toLowerCase().includes(needle) ||
        clip.caption?.text?.toLowerCase().includes(needle)
      );
    });

    const sorted = [...result];
    switch (sort) {
      case 'duration':
        sorted.sort((a, b) => b.durationSec - a.durationSec);
        break;
      case 'recent':
        sorted.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        break;
      case 'relevance':
      default:
        sorted.sort((a, b) => b.score - a.score);
        break;
    }
    return sorted;
  }, [scoped, filter, sort, query]);

  const projectMap = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects]
  );

  const getClip = useCallback((id) => clips.find((clip) => clip.id === id) ?? null, [clips]);

  /** Clips whose source project still exists — guards against orphan rows. */
  const getProjectForClip = useCallback(
    (clip) => (clip ? projectMap.get(clip.projectId) ?? null : null),
    [projectMap]
  );

  const toggleSelect = useCallback(
    (id) => {
      const clip = clips.find((item) => item.id === id);
      if (!clip) return;
      const next = clip.status === CLIP_STATUS.SELECTED ? CLIP_STATUS.SUGGESTED : CLIP_STATUS.SELECTED;
      setClipStatus([id], next);
    },
    [clips, setClipStatus]
  );

  /** Bulk action for the grid: select or discard every visible clip. */
  const applyToVisible = useCallback(
    (action) => {
      const ids = filtered.map((clip) => clip.id);
      if (ids.length === 0) return;
      if (action === 'select') setClipStatus(ids, CLIP_STATUS.SELECTED);
      if (action === 'deselect') setClipStatus(ids, CLIP_STATUS.SUGGESTED);
      if (action === 'remove') {
        // Fire-and-forget: one failure should not abort the rest of the batch.
        ids.forEach((id) => discardClip(id).catch(() => {}));
      }
    },
    [filtered, setClipStatus, discardClip]
  );

  return {
    clips: filtered,
    allClips: scoped,
    counts,
    filter,
    setFilter,
    sort,
    setSort,
    query,
    setQuery,
    view,
    setView,
    getClip,
    getProjectForClip,
    toggleSelect,
    applyToVisible,
    patchClip,
    patchClips,
  };
}

/** Render settings applied to every new clip. */
export const DEFAULT_EXPORT_SETTINGS = {
  format: 'mp4',
  resolution: '1080x1920',
  burnCaptions: true,
  lastExportedAt: null,
};

/** Build an editable draft from a persisted clip. */
function toDraft(clip) {
  return {
    title: clip.title,
    startSec: clip.startSec,
    endSec: clip.endSec,
    aspectRatio: clip.aspectRatio,
    caption: { ...clip.caption },
    export: { ...DEFAULT_EXPORT_SETTINGS, ...(clip.export ?? {}) },
  };
}

/**
 * Editor state for a single clip.
 *
 * Holds a local draft so the user can abandon edits, validates the trim window
 * against the project's real runtime, and resolves the effective caption preset
 * so the preview and the controls can never disagree.
 *
 * The draft is seeded once from the persisted clip. Callers must render this
 * hook's owner with `key={clipId}` so switching clips remounts with a fresh
 * draft rather than relying on an effect to reset state.
 */
export function useClipEditor(clipId) {
  const { clips, patchClip, setClipStatus, projects } = useApp();

  const clip = useMemo(() => clips.find((item) => item.id === clipId) ?? null, [clips, clipId]);
  const project = useMemo(
    () => projects.find((item) => item.id === clip?.projectId) ?? null,
    [projects, clip?.projectId]
  );

  const [draft, setDraft] = useState(() => (clip ? toDraft(clip) : null));
  const [savedAt, setSavedAt] = useState(null);
  const [isDirty, setIsDirty] = useState(false);

  /** True when the draft differs from the persisted clip. */
  const dirty = isDirty && draft !== null;

  const update = useCallback((patch) => {
    setDraft((current) => (current ? { ...current, ...patch } : current));
    setIsDirty(true);
  }, []);

  /** Discard local changes by rebuilding the draft from the stored clip. */
  const revert = useCallback(() => {
    if (!clip) return;
    setDraft(toDraft(clip));
    setIsDirty(false);
  }, [clip]);

  /** Effective caption preset, merging any user overrides on top. */
  const preset = useMemo(() => {
    const base = CAPTION_PRESET_MAP[draft?.caption?.presetId ?? 'clean'] ?? CAPTION_PRESET_MAP.clean;
    return base;
  }, [draft?.caption?.presetId]);

  const aspect = useMemo(
    () => ASPECT_RATIO_MAP[draft?.aspectRatio ?? '9:16'] ?? ASPECT_RATIO_MAP['9:16'],
    [draft?.aspectRatio]
  );

  /**
   * Trim constraints derived from the source runtime.
   * `sourceDuration` falls back to a sensible window when unknown.
   */
  const bounds = useMemo(() => {
    const sourceDuration = project?.durationSec ?? Math.max(600, (clip?.endSec ?? 60) * 4);
    return {
      sourceDuration,
      minStart: 0,
      maxStart: Math.max(0, sourceDuration - CLIP_LIMITS.MIN_DURATION),
      minDuration: CLIP_LIMITS.MIN_DURATION,
      maxDuration: Math.min(CLIP_LIMITS.MAX_DURATION, sourceDuration),
    };
  }, [project?.durationSec, clip?.endSec]);

  /**
   * Re-derive start/end after a trim handle moves.
   * Keeps the window inside the source and honours min/max duration.
   */
  const setTrim = useCallback(
    (edge, value) => {
      setDraft((current) => {
        if (!current) return current;

        const snap = round(clamp(Number(value), bounds.minStart, bounds.sourceDuration), 2);
        let startSec = current.startSec;
        let endSec = current.endSec;

        if (edge === 'start') startSec = snap;
        else endSec = snap;

        // Do not let the handles cross.
        if (endSec - startSec < CLIP_LIMITS.MIN_DURATION) {
          if (edge === 'start') startSec = Math.max(bounds.minStart, endSec - CLIP_LIMITS.MIN_DURATION);
          else endSec = Math.min(bounds.sourceDuration, startSec + CLIP_LIMITS.MIN_DURATION);
        }

        // Respect the platform ceiling.
        if (endSec - startSec > CLIP_LIMITS.MAX_DURATION) {
          if (edge === 'start') startSec = Math.max(bounds.minStart, endSec - CLIP_LIMITS.MAX_DURATION);
          else endSec = Math.min(bounds.sourceDuration, startSec + CLIP_LIMITS.MAX_DURATION);
        }

        return { ...current, startSec, endSec };
      });
      setIsDirty(true);
    },
    [bounds.minStart, bounds.sourceDuration]
  );

  const setCaptionText = useCallback((text) => {
    setDraft((current) => (current ? { ...current, caption: { ...current.caption, text } } : current));
    setIsDirty(true);
  }, []);

  const setCaptionPreset = useCallback((presetId) => {
    setDraft((current) =>
      current ? { ...current, caption: { ...current.caption, presetId } } : current
    );
    setIsDirty(true);
  }, []);

  const setCaptionPosition = useCallback((position) => {
    setDraft((current) =>
      current ? { ...current, caption: { ...current.caption, position } } : current
    );
    setIsDirty(true);
  }, []);

  const setAspectRatio = useCallback((aspectRatio) => {
    setDraft((current) => (current ? { ...current, aspectRatio } : current));
    setIsDirty(true);
  }, []);

  const setTitle = useCallback((title) => {
    setDraft((current) => (current ? { ...current, title } : current));
    setIsDirty(true);
  }, []);

  const setExportSettings = useCallback((patch) => {
    setDraft((current) =>
      current ? { ...current, export: { ...current.export, ...patch } } : current
    );
    setIsDirty(true);
  }, []);

  /** Persist the draft. Any real change marks the clip `edited`. */
  const save = useCallback(() => {
    if (!draft || !clip) return null;

    const durationSec = round(draft.endSec - draft.startSec, 2);
    const patch = {
      title: draft.title.trim() || clip.title,
      startSec: round(draft.startSec, 2),
      endSec: round(draft.endSec, 2),
      durationSec,
      aspectRatio: draft.aspectRatio,
      caption: { ...draft.caption },
      export: { ...draft.export },
      // An edit supersedes any export that was made from the old settings.
      status: CLIP_STATUS.EDITED,
    };

    patchClip(clip.id, patch);
    setSavedAt(new Date().toISOString());
    setIsDirty(false);
    return { ...clip, ...patch };
  }, [draft, clip, patchClip]);

  /** A clip is exportable once its project has finished processing. */
  const canExport = project?.status === PROJECT_STATUS.READY;

  return {
    clip,
    project,
    draft,
    preset,
    aspect,
    bounds,
    isDirty: dirty,
    savedAt,
    canExport,
    revert,
    save,
    update,
    setTrim,
    setTitle,
    setCaptionText,
    setCaptionPreset,
    setAspectRatio,
    setCaptionPosition,
    setExportSettings,
    setClipStatus,
  };
}
