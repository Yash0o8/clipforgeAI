/**
 * Clip API client.
 *
 *   GET   /projects/{projectId}/clips   list suggestions
 *   GET   /clips/{id}                   single clip with full transcript
 *   PATCH /clips/{id}                   persist editor changes
 *   POST  /projects/{id}/clips/generate re-run highlight detection
 *   POST  /clips/{id}/export            queue a render job
 *   GET   /exports/{jobId}              poll render progress
 *   POST  /exports/{jobId}/download     signed download URL
 */

import { get, post, patch } from './api.js';

/** @returns {Promise<Array>} */
export async function listClips(projectId, { signal } = {}) {
  const payload = await get(`/projects/${projectId}/clips`, { signal });
  return Array.isArray(payload) ? payload : (payload?.items ?? []);
}

/** @returns {Promise<object>} */
export async function getClip(clipId, { signal } = {}) {
  return get(`/clips/${clipId}`, { signal });
}

/**
 * Persist editor state.
 * @param {object} patch_ { title, startSec, endSec, aspectRatio, caption, export, status }
 *
 * `durationSec` is derived from `endSec - startSec` on the server, and the API
 * rejects unknown fields, so the client-side convenience field is dropped rather
 * than sent and bounced with a 422.
 */
export async function updateClip(clipId, patch_, { signal } = {}) {
  const { durationSec: _derived, ...accepted } = patch_ ?? {};
  return patch(`/clips/${clipId}`, accepted, { signal });
}

/** Delete a suggested clip the user chose to discard. */
export async function deleteClip(clipId, { signal } = {}) {
  return post(`/clips/${clipId}/discard`, {}, { signal });
}

/**
 * Kick off (or re-run) highlight detection.
 * @param {object} [options] { minDuration, maxDuration, targetCount }
 */
export async function generateClips(projectId, options = {}, { signal } = {}) {
  return post(`/projects/${projectId}/clips/generate`, options, { signal });
}

/**
 * Queue a render.
 * @param {object} settings { format, resolution, aspectRatio, captionPresetId, burnCaptions }
 * @returns {Promise<{jobId: string, status: string}>}
 */
export async function exportClip(clipId, settings, { signal } = {}) {
  return post(`/clips/${clipId}/export`, settings, { signal });
}

/** Poll a render job. */
export async function getExportJob(jobId, { signal } = {}) {
  return get(`/exports/${jobId}`, { signal });
}

/**
 * Export history, newest first. Optionally scoped to one project.
 *
 * The Exports page needs this on mount: jobs are otherwise only known to the
 * ClipEditor instance that queued them, so a reload would lose the list.
 *
 * @returns {Promise<object[]>}
 */
export async function listExports({ projectId, signal } = {}) {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
  return get(`/exports${query}`, { signal });
}

/** Cancel a queued or running render. */
export async function cancelExportJob(jobId, { signal } = {}) {
  return post(`/exports/${jobId}/cancel`, {}, { signal });
}

/**
 * Exchange a completed job for a time-limited download URL.
 * @returns {Promise<{url: string, expiresAt: string}>}
 */
export async function getDownloadUrl(jobId, { signal } = {}) {
  return post(`/exports/${jobId}/download`, {}, { signal });
}

/** Poll a processing job until it reaches a terminal state. */
export async function pollJob(jobId, { onTick, intervalMs = 1500, signal } = {}) {
  for (;;) {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    const job = await getExportJob(jobId, { signal });
    onTick?.(job);
    if (['complete', 'failed', 'pending_backend'].includes(job?.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
