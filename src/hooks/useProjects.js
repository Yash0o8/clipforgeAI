import { useCallback, useMemo } from 'react';
import { useApp } from './useApp.js';
import { PROJECT_STATUS } from '../utils/constants.js';

/**
 * Project selectors.
 *
 * Reads the API-backed store held by `AppProvider` and derives the views the
 * pages need. Mutations are the provider's async actions, so a failure surfaces
 * as a rejected promise the caller can report rather than a silent no-op.
 */
export function useProjects() {
  const {
    projects,
    clips,
    isLoading,
    loadError,
    refreshProjects,
    loadClips,
    addProject,
    patchProject,
    removeProject,
  } = useApp();

  /** Clips grouped by `projectId` for cheap lookups on list screens. */
  const clipsByProject = useMemo(() => {
    const map = new Map();
    for (const clip of clips) {
      if (!map.has(clip.projectId)) map.set(clip.projectId, []);
      map.get(clip.projectId).push(clip);
    }
    return map;
  }, [clips]);

  const getProject = useCallback(
    (id) => projects.find((project) => project.id === id) ?? null,
    [projects]
  );

  const getClipsForProject = useCallback(
    (id) => clipsByProject.get(id) ?? [],
    [clipsByProject]
  );

  const clipCountFor = useCallback(
    (id) => (clipsByProject.get(id) ?? []).length,
    [clipsByProject]
  );

  /* --- Derived lists -------------------------------------------------- */

  const readyProjects = useMemo(
    () => projects.filter((project) => project.status === PROJECT_STATUS.READY),
    [projects]
  );

  const activeProjects = useMemo(
    () =>
      projects.filter(
        (project) =>
          project.status === PROJECT_STATUS.UPLOADING ||
          project.status === PROJECT_STATUS.PROCESSING
      ),
    [projects]
  );

  const recentProjects = useMemo(
    () =>
      [...projects].sort(
        (a, b) => new Date(b.updatedAt ?? b.createdAt) - new Date(a.updatedAt ?? a.createdAt)
      ),
    [projects]
  );

  /** Aggregate numbers for the dashboard stat cards. */
  const stats = useMemo(() => {
    const processingSeconds = projects
      .filter((project) => project.status !== PROJECT_STATUS.CANCELLED)
      .reduce((sum, project) => sum + (project.durationSec ?? 0), 0);

    const scores = clips.map((clip) => clip.score).filter(Number.isFinite);
    const avgScore = scores.length
      ? Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length)
      : 0;

    return {
      totalProjects: projects.length,
      clipsGenerated: clips.length,
      processingSeconds,
      exportsCompleted: clips.filter((clip) => clip.status === 'exported').length,
      avgScore,
      readyProjects: readyProjects.length,
      activeProjects: activeProjects.length,
    };
  }, [projects, clips, readyProjects.length, activeProjects.length]);

  return {
    projects,
    clips,
    isLoading,
    loadError,
    recentProjects,
    readyProjects,
    activeProjects,
    clipsByProject,
    stats,
    refreshProjects,
    getProject,
    getClipsForProject,
    clipCountFor,
    loadClips,
    addProject,
    patchProject,
    removeProject,
  };
}
