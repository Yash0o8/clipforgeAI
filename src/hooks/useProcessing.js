import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from './useApp.js';
import {
  NOTIFICATION_TONE,
  PROJECT_STATUS,
  PROCESSING_STAGES,
} from '../utils/constants.js';
import * as projectService from '../services/projectService.js';
import { sleep } from '../services/api.js';

/** Poll interval while a job is running. Transcription is the slow stage. */
const POLL_MS = 1200;

/** Fallback stage weights, used only until the server reports its own. */
const FALLBACK_WEIGHT = (() => {
  const total = PROCESSING_STAGES.reduce((sum, stage) => sum + stage.weight, 0);
  let running = 0;
  return PROCESSING_STAGES.map((stage) => {
    running += stage.weight / total;
    return running;
  });
})();

/** Statuses that mean the pipeline has stopped moving. */
const TERMINAL = new Set([PROJECT_STATUS.READY, PROJECT_STATUS.FAILED, PROJECT_STATUS.CANCELLED]);

/**
 * Drives the real transcription + highlight pipeline.
 *
 * `POST /projects/{id}/process` hands the work to a worker thread and returns
 * immediately; the job resource is then polled until it reaches a terminal
 * status. Every number this hook renders comes from the server's own progress
 * contract (`progress` 0-100 plus the five `stages`), so what the user sees
 * during a long transcription is the actual state rather than an animation.
 *
 * Polling stops on unmount and whenever the job reaches a terminal state, and
 * `cancel` asks the worker to stop rather than merely hiding the progress bar.
 */
export function useProcessing(projectId) {
  const { projects, replaceProject, loadClips, refreshProjects, notify } = useApp();

  const project = useMemo(
    () => projects.find((item) => item.id === projectId) ?? null,
    [projects, projectId]
  );

  const [progress, setProgress] = useState(project?.progress ?? 0);
  const [isRunning, setIsRunning] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [error, setError] = useState(project?.error ?? null);

  // Set while a poll loop owns the network conversation, so cancel can stop it.
  const abortRef = useRef(null);
  const startedAtRef = useRef(null);

  /** Stop any running poll loop and mark the hook idle. */
  const stopPolling = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsRunning(false);
  }, []);

  /* --- Stage view ----------------------------------------------------- */

  const stages = useMemo(() => {
    const fromServer = project?.stages;
    if (Array.isArray(fromServer) && fromServer.length > 0) {
      // Trust the server: it knows which stage is actually running.
      return PROCESSING_STAGES.map((stage) => {
        const match = fromServer.find((item) => item.key === stage.key);
        return {
          ...stage,
          progress: Math.round(match?.progress ?? 0),
          status:
            match?.status ??
            ((match?.progress ?? 0) >= 100 ? 'done' : (match?.progress ?? 0) > 0 ? 'active' : 'idle'),
        };
      });
    }

    const stageIndex = (() => {
      const found = FALLBACK_WEIGHT.findIndex((edge) => progress / 100 <= edge);
      return found === -1 ? PROCESSING_STAGES.length - 1 : found;
    })();

    return PROCESSING_STAGES.map((stage, index) => {
      const edge = FALLBACK_WEIGHT[index] * 100;
      const previousEdge = index === 0 ? 0 : FALLBACK_WEIGHT[index - 1] * 100;
      const done = progress >= edge - 0.001;
      const isCurrent = index === stageIndex && !done;
      const stageProgress = done
        ? 100
        : isCurrent
          ? Math.min(100, Math.max(0, ((progress - previousEdge) / (edge - previousEdge)) * 100))
          : 0;
      return {
        ...stage,
        progress: Math.round(stageProgress),
        status: done ? 'done' : isCurrent ? 'active' : 'idle',
      };
    });
  }, [project?.stages, progress]);

  const stageIndex = useMemo(
    () => Math.max(0, stages.findIndex((stage) => stage.status === 'active')),
    [stages]
  );

  /* --- Poll loop ------------------------------------------------------ */

  const poll = useCallback(async () => {
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;

    setIsRunning(true);

    try {
      for (;;) {
        let fresh;
        try {
          fresh = await projectService.getProject(projectId, { signal, timeout: 180000 });
        } catch {
          if (signal.aborted) return;
          // Transient poll failure; retry without surfacing error immediately
          await sleep(POLL_MS * 2, signal);
          continue;
        }
        replaceProject(fresh);

        setProgress(Number(fresh.progress ?? 0));
        if (startedAtRef.current) {
          setElapsedSec(Math.max(0, Math.round((Date.now() - startedAtRef.current) / 1000)));
        }

        if (fresh.status === PROJECT_STATUS.READY) {
          // Clips are created server-side as the last stage, so fetch them now.
          loadClips(projectId).catch(() => {});
          notify({
            title: 'Clips ready',
            body: `${fresh.title ?? 'Your project'} is ready to edit.`,
            tone: NOTIFICATION_TONE.SUCCESS,
          });
          return;
        }

        if (fresh.status === PROJECT_STATUS.FAILED) {
          const reason = fresh.error ?? 'Processing stopped before finishing. You can retry.';
          setError(reason);
          notify({ title: 'Processing failed', body: reason, tone: NOTIFICATION_TONE.ERROR });
          return;
        }

        if (TERMINAL.has(fresh.status)) return;

        await sleep(POLL_MS, signal);
      }
    } catch (err) {
      // A cancelled loop is expected; anything else is worth surfacing.
      if (signal.aborted) return;
      setError(err.message ?? 'Lost contact with the ClipForge API.');
      notify({
        title: 'Processing stopped',
        body: err.message ?? 'Lost contact with the ClipForge API.',
        tone: NOTIFICATION_TONE.ERROR,
      });
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setIsRunning(false);
    }
  }, [projectId, replaceProject, loadClips, notify]);

  // Never leave a poll running past unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  /* --- Actions -------------------------------------------------------- */

  /** Enqueue the pipeline and begin polling. */
  const start = useCallback(async () => {
    if (!projectId) return;

    abortRef.current?.abort();
    setError(null);
    setProgress(0);
    setElapsedSec(0);
    startedAtRef.current = Date.now();

    try {
      await projectService.processProject(projectId, { timeout: 120000 });
      await poll();
    } catch (err) {
      setError(err.message ?? 'Could not start processing.');
      notify({
        title: 'Processing failed',
        body: err.message ?? 'Could not start processing.',
        tone: NOTIFICATION_TONE.ERROR,
      });
    }
  }, [projectId, poll, notify]);

  /** Ask the worker to stop and wind the poll loop down. */
  const cancel = useCallback(async () => {
    stopPolling();
    setElapsedSec(0);

    try {
      await projectService.cancelProjectJob(projectId, { timeout: 60000 });
    } catch {
      // The job may have finished between the click and the request; the next
      // refresh settles it either way.
    }

    await refreshProjects().catch(() => {});
    notify({
      title: 'Processing cancelled',
      body: `${project?.title ?? 'Project'} was stopped. You can restart it any time.`,
      tone: NOTIFICATION_TONE.WARNING,
    });
  }, [projectId, project?.title, refreshProjects, notify, stopPolling]);

  /** Restart a failed or cancelled run from the top. */
  const retry = useCallback(() => {
    setError(null);
    return start();
  }, [start]);

  const status = project?.status ?? PROJECT_STATUS.DRAFT;

  /**
   * Remaining time, estimated from the rate observed so far.
   *
   * Before any progress lands there is nothing to extrapolate from, so the
   * estimate is null rather than a fabricated number.
   */
  const etaSec = useMemo(() => {
    if (!isRunning || progress <= 0 || elapsedSec <= 0) return null;
    const ratePerSec = progress / elapsedSec;
    if (ratePerSec <= 0) return null;
    return Math.max(0, Math.round((100 - progress) / ratePerSec));
  }, [isRunning, progress, elapsedSec]);

  /* --- Resume a job that was already running when the page loaded ------ */

  useEffect(() => {
    if (!project) return;
    if (status !== PROJECT_STATUS.PROCESSING) return;
    // A poll loop already owns this project, or we are mid-render of one.
    if (abortRef.current !== null || isRunning) return;

    startedAtRef.current = Date.now();
    poll();
  }, [project, status, isRunning, poll]);

  return {
    project,
    status,
    progress,
    stages,
    stageIndex,
    currentStage: PROCESSING_STAGES[stageIndex],
    error,
    elapsedSec,
    etaSec,
    isRunning,
    /** Marked processing but not currently polling — needs a resume. */
    needsResume: status === PROJECT_STATUS.PROCESSING && !isRunning,
    canRetry: status === PROJECT_STATUS.FAILED || status === PROJECT_STATUS.CANCELLED,
    canCancel: status === PROJECT_STATUS.PROCESSING,
    start,
    cancel,
    retry,
  };
}