/**
 * Zero-friction demo: paste a YouTube URL on the landing page and get a clip
 * without creating an account.
 *
 * This lives in the service layer so the landing page does not need to duplicate
 * Upload's ingest polling. The same device id used here is sent on every later
 * export, which is how free-tier credits are tracked.
 */

import { sleep } from './api.js';
import { getDeviceId } from './billingService.js';
import { getProject, ingestYoutube, processProject } from './projectService.js';

/**
 * Ingest, wait for the media to be probed, then enqueue processing.
 * @param {string} url YouTube watch/share URL
 * @param {object} [options]
 * @param {(message: string) => void} [options.onStatus] progress label callback
 * @returns {Promise<object>} the queued project
 */
export async function startYoutubeDemo(url, { onStatus } = {}) {
  const ingest = await ingestYoutube({
    url,
    title: url,
    presetId: 'podcast',
    settings: { renderMode: 'podcast', captionPreset: 'clean' },
  });

  let project = await getProject(ingest.projectId);
  for (let attempt = 0; attempt < 120; attempt += 1) {
    onStatus?.(
      project?.status === 'failed' ? 'Download failed' : 'Downloading and preparing your video…'
    );
    if (project?.status === 'failed') throw new Error(project.error || 'YouTube ingest failed.');
    if (project?.assetPath || project?.objectUrl || project?.hasLocalSource) break;
    await sleep(1500);
    project = await getProject(ingest.projectId);
  }
  if (!project?.hasLocalSource && !project?.objectUrl && !project?.assetPath) {
    throw new Error('The demo video did not finish downloading. Try another link.');
  }

  onStatus?.('Finding the best moments…');
  await processProject(project.id, { deviceId: getDeviceId() });
  return project;
}
