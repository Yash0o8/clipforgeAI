/**
 * Project API client.
 *
 * Maps one-to-one onto the FastAPI resource that would back this app:
 *
 *   GET    /projects                 list, newest first
 *   GET    /projects/{id}            single project with stage detail
 *   POST   /projects                 create from an uploaded asset
 *   PATCH  /projects/{id}            update title / settings
 *   DELETE /projects/{id}            delete project and derived clips
 *   POST   /projects/{id}/process    enqueue the highlight pipeline
 *   POST   /projects/{id}/cancel     cancel a running job
 */

import { get, post, patch, del } from './api.js';

/** @returns {Promise<Array>} */
export async function listProjects({ status, signal } = {}) {
  const query = status ? `?status=${encodeURIComponent(status)}` : '';
  const payload = await get(`/projects${query}`, { signal });
  return Array.isArray(payload) ? payload : (payload?.items ?? []);
}

/** @returns {Promise<object>} */
export async function getProject(projectId, { signal } = {}) {
  return get(`/projects/${projectId}`, { signal });
}

/**
 * @param {object} payload
 * @param {string} payload.title
 * @param {number} payload.durationSec
 * @param {number} [payload.fileSize]
 * @param {string} [payload.fileName]
 */
export async function createProject(payload, { signal } = {}) {
  return post('/projects', payload, { signal });
}

/** @param {string} projectId @param {object} patch_ */
export async function updateProject(projectId, patch_, { signal } = {}) {
  return patch(`/projects/${projectId}`, patch_, { signal });
}

/** @returns {Promise<null>} */
export async function deleteProject(projectId, { signal } = {}) {
  return del(`/projects/${projectId}`, { signal });
}

/**
 * Enqueue the transcription + highlight pipeline.
 * The response is a job descriptor the client polls via clipService.getJob.
 */
export async function processProject(projectId, { signal } = {}) {
  return post(`/projects/${projectId}/process`, {}, { signal });
}

/** Cancel an in-flight job. */
export async function cancelProjectJob(projectId, { signal } = {}) {
  return post(`/projects/${projectId}/cancel`, {}, { signal });
}
