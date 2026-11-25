import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from './useApp.js';
import {
  NOTIFICATION_TONE,
  PROJECT_STATUS,
  PROCESSING_STAGES,
  STAGE_KEYS,
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

/** Parse an ISO timestamp without throwing on a missing/odd value. */
function parseTime(value) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Drives the real transcription + highlight pipeline.
 *
 * `POST /projects/{id}/process` hands the work to a worker thread and returns
 * immediately; the job resource is then polled until it reaches a terminal
 * status. Every number this hook renders comes from the server's own progress
 * contract (`progress` 0-100 plus the five `stages`), so what the user sees
 * during a long transcription is the actual state rather than an animation.
 *
 * Transcription sub-progress is persisted by the worker into the project row,
 * which is why this hook can show "43 / 103 min processed" instead of freezing
 * at the stage boundary for an hour.
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
  const [lastUpdatedAt, setLastUpdatedAt] = useState(null);

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

  const currentStageKey = stages[stageIndex]?.key ?? STAGE_KEYS.UPLOAD;

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
        setLastUpdatedAt(fresh.updatedAt ?? null);
        // The worker owns the clock. Using its start time keeps elapsed/ETA
        // correct even when the user reloads this page mid-transcription.
        const serverStart = parseTime(fresh.processingStartedAt) ?? startedAtRef.current;
        if (serverStart) {
          setElapsedSec(Math.max(0, Math.round((Date.now() - serverStart) / 1000)));
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
    setLastUpdatedAt(null);
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
  const transcription = project?.transcription ?? {};
  const transcriptProgress = Math.min(100, Math.max(0, Number(transcription.progress ?? 0)));
  const processedSec = Math.max(0, Number(transcription.processedSec ?? 0));
  const sourceDurationSec = Math.max(0, Number(project?.durationSec ?? 0));
  const transcriptActive = status === PROJECT_STATUS.PROCESSING && currentStageKey === STAGE_KEYS.TRANSCRIPT;

  /**
   * Remaining time, estimated for the stage that is actually running.
   *
   * Transcription is measured in *media seconds processed*, not overall job
   * percent — using overall progress would produce a wildly optimistic ETA
   * because upload and audio finish almost instantly. A range is shown rather
   * than a single number because CPU speed varies.
   */
  const eta = useMemo(() => {
    if (!isRunning || elapsedSec <= 0 || status !== PROJECT_STATUS.PROCESSING) return null;

    if (transcriptActive && processedSec > 1 && sourceDurationSec > processedSec) {
      const rate = processedSec / elapsedSec;
      if (rate <= 0) return null;
      const remaining = (sourceDurationSec - processedSec) / rate;
      return {
        seconds: Math.round(remaining),
        lowSec: Math.round(remaining * 0.8),
        highSec: Math.round(remaining * 1.35),
        basis: 'transcript',
      };
    }

    if (progress <= 0) return null;
    const ratePerSec = progress / elapsedSec;
    if (ratePerSec <= 0) return null;
    const remaining = (100 - progress) / ratePerSec;
    return {
      seconds: Math.round(remaining),
      lowSec: Math.round(remaining * 0.8),
      highSec: Math.round(remaining * 1.35),
      basis: 'overall',
    };
  }, [isRunning, elapsedSec, progress, status, transcriptActive, processedSec, sourceDurationSec]);

  const lastUpdateAgeSec = useMemo(() => {
    const updated = parseTime(lastUpdatedAt ?? project?.updatedAt);
    if (!updated) return null;
    return Math.max(0, Math.round((Date.now() - updated) / 1000));
  }, [lastUpdatedAt, project?.updatedAt]);

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
    etaSec: eta?.seconds ?? null,
    eta,
    isRunning,
    transcription: {
      ...transcription,
      progress: transcriptProgress,
      processedSec,
      active: transcriptActive,
    },
    sourceDurationSec,
    lastUpdateAgeSec,
    /** Marked processing but not currently polling — needs a resume. */
    needsResume: status === PROJECT_STATUS.PROCESSING && !isRunning,
    canRetry: status === PROJECT_STATUS.FAILED || status === PROJECT_STATUS.CANCELLED,
    canCancel: status === PROJECT_STATUS.PROCESSING,
    start,
    cancel,
    retry,
  };
}
