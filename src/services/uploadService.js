/**
 * Upload API client.
 *
 * Large videos must not be pushed through a single JSON request, so the flow is
 * a resumable multipart upload:
 *
 *   1. POST /uploads                -> session descriptor + part URLs
 *   2. PUT  each part               -> direct, skipping the JSON layer
 *   3. POST /uploads/{id}/complete  -> server assembles the object
 *
 * Progress is reported per part because `fetch` cannot observe request-body
 * upload progress. `XMLHttpRequest.upload.onprogress` can, so the parts use XHR.
 */

import { post, get, resolveUrl, ApiError } from './api.js';

const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024; // 8 MB

/**
 * Open an upload session.
 * @returns {Promise<{uploadId: string, chunkSize: number, parts: Array<{url: string, partNumber: number}>}>}
 */
export async function createUploadSession(
  { fileName, fileSize, mimeType, checksum },
  { signal } = {}
) {
  return post('/uploads', { fileName, fileSize, mimeType, checksum }, { signal });
}

/** Ask the server to re-issue presigned URLs for parts that still need pushing. */
export async function refreshUploadParts(uploadId, partNumbers, { signal } = {}) {
  return post(`/uploads/${uploadId}/parts`, { partNumbers }, { signal });
}

/** Finalise the upload. Returns the stored asset descriptor. */
export async function completeUpload(uploadId, { signal } = {}) {
  return post(`/uploads/${uploadId}/complete`, {}, { signal });
}

/** Poll a session, e.g. after resuming an interrupted upload. */
export async function getUploadSession(uploadId, { signal } = {}) {
  return get(`/uploads/${uploadId}`, { signal });
}

/** Tell the server to discard a partially uploaded object. */
export async function abortUpload(uploadId, { signal } = {}) {
  return post(`/uploads/${uploadId}/abort`, {}, { signal });
}

/* -------------------------------------------------------------------------- */
/*  Browser-side transfer                                                      */
/* -------------------------------------------------------------------------- */

/**
 * PUT one part with byte-accurate progress.
 *
 * @param {string} url   Destination from the session descriptor. Already carries
 *                       `/api/v1`, so it goes through `resolveUrl`.
 * @param {Blob} blob    Part payload.
 * @param {(loaded: number) => void} onPartProgress
 * @param {AbortSignal} [signal]
 */
function putPart(url, blob, onPartProgress, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }

    const xhr = new XMLHttpRequest();
    xhr.open('PUT', resolveUrl(url), true);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onPartProgress(event.loaded);
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.getResponseHeader('ETag'));
      else reject(new ApiError(`Part upload failed with status ${xhr.status}.`, { status: xhr.status }));
    };

    xhr.onerror = () =>
      reject(new ApiError('Network error while uploading. Check your connection.', { code: 'network' }));

    xhr.onabort = () => reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));

    signal?.addEventListener('abort', () => xhr.abort(), { once: true });

    xhr.send(blob);
  });
}

/**
 * Upload a file in parallel parts, reporting 0–100 aggregate progress.
 *
 * @param {object} params
 * @param {File} params.file
 * @param {object} params.session         Output of `createUploadSession`.
 * @param {(percent: number, uploadedBytes: number) => void} [params.onProgress]
 * @param {number} [params.concurrency]   Parts in flight at once (default 3).
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<{parts: Array<{partNumber: number, etag: string}>}>}
 */
export async function uploadFileParts({ file, session, onProgress, concurrency = 3, signal }) {
  const parts = session?.parts ?? [];
  if (parts.length === 0) throw new ApiError('Upload session returned no parts.', { code: 'bad_session' });

  const chunkSize = session.chunkSize || DEFAULT_CHUNK_SIZE;
  const loadedByPart = new Map();
  let uploadedBytes = 0;

  const report = () => {
    const percent = file.size > 0 ? Math.min(100, (uploadedBytes / file.size) * 100) : 100;
    onProgress?.(Math.round(percent * 10) / 10, uploadedBytes);
  };

  const queue = [...parts];
  const completed = [];
  const inFlight = new Set();

  const runNext = async () => {
    const part = queue.shift();
    if (!part) return;

    const start = (part.partNumber - 1) * chunkSize;
    const blob = file.slice(start, Math.min(start + chunkSize, file.size));

    try {
      loadedByPart.set(part.partNumber, 0);
      const etag = await putPart(
        part.url,
        blob,
        (loaded) => {
          uploadedBytes += loaded - (loadedByPart.get(part.partNumber) ?? 0);
          loadedByPart.set(part.partNumber, loaded);
          report();
        },
        signal
      );
      uploadedBytes += blob.size - (loadedByPart.get(part.partNumber) ?? 0);
      loadedByPart.set(part.partNumber, blob.size);
      completed.push({ partNumber: part.partNumber, etag });
      report();
    } finally {
      inFlight.delete(part.partNumber);
    }
  };

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, parts.length)) }, async () => {
    while (queue.length > 0 && !signal?.aborted) {
      await runNext();
    }
  });

  await Promise.all(workers);

  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  }

  completed.sort((a, b) => a.partNumber - b.partNumber);
  report();
  return { parts: completed };
}

/**
 * Full browser-side upload: open session, transfer, finalise.
 *
 * @param {File} file
 * @param {object} [params]
 * @param {(state: object) => void} [params.onProgress]  Reports
 *   `{ phase, percent, uploadedBytes, totalBytes }` where phase is one of
 *   'session' | 'transferring' | 'finalising' | 'done'.
 * @returns {Promise<{asset: object, uploadId: string}>}
 */
export async function uploadVideo(file, { onProgress, signal, concurrency } = {}) {
  onProgress?.({ phase: 'session', percent: 0, uploadedBytes: 0, totalBytes: file.size });

  const session = await createUploadSession(
    { fileName: file.name, fileSize: file.size, mimeType: file.type },
    { signal }
  );

  const { parts } = await uploadFileParts({
    file,
    session,
    concurrency,
    signal,
    onProgress: (percent, uploadedBytes) =>
      onProgress?.({ phase: 'transferring', percent, uploadedBytes, totalBytes: file.size }),
  });

  onProgress?.({ phase: 'finalising', percent: 100, uploadedBytes: file.size, totalBytes: file.size });

  await completeUpload(session.uploadId, { signal });
  const asset = await getUploadSession(session.uploadId, { signal });

  onProgress?.({ phase: 'done', percent: 100, uploadedBytes: file.size, totalBytes: file.size });

  return { asset, uploadId: session.uploadId, parts };
}
