/**
 * HTTP client.
 *
 * This module is the single seam between the frontend and the FastAPI backend.
 * Every request goes through `http()`, which resolves the base URL, applies a
 * timeout, handles JSON and normalises errors into `ApiError`.
 */

const ENV = import.meta.env ?? {};

export const API_PREFIX = String(ENV.VITE_API_PREFIX ?? '/api/v1').replace(/\/+$/, '') || '/api/v1';
export const API_TIMEOUT_MS = Number(ENV.VITE_API_TIMEOUT) || 120000;

const RAW_BASE_URL = String(ENV.VITE_API_BASE_URL ?? '').trim();

/**
 * Split the configured base into an origin and the API prefix.
 *
 * `VITE_API_BASE_URL` is written both ways in the wild — `http://host:8000` and
 * `http://host:8000/api/v1` — and treating the second as a bare origin is what
 * produces `/api/v1/api/v1/uploads/...`. Resolving it once here means a
 * misconfigured value fails loudly in one place instead of 404ing everywhere.
 */
const splitBaseUrl = (raw) => {
  const trimmed = raw.replace(/\/+$/, '');
  if (!trimmed) return '';
  return trimmed.endsWith(API_PREFIX) ? trimmed.slice(0, -API_PREFIX.length) : trimmed;
};

/** Origin (and optional path prefix) with no trailing slash. Empty = same origin. */
export const API_BASE_URL = splitBaseUrl(RAW_BASE_URL);

export { splitBaseUrl };

/**
 * Paths the backend serves outside `API_PREFIX`.
 *
 * `app.include_router(media_router)` has no prefix, so `/media/...` is a
 * server-rooted path. Prefixing it would 404, and `objectUrl` is exactly that
 * shape.
 */
const SERVER_ROOTED = new Set(['media', 'health', 'docs', 'openapi.json', 'redoc']);

/** True when the API lives on a different origin, so CORS applies. */
export const IS_CROSS_ORIGIN = Boolean(API_BASE_URL) && !/^https?:\/\//i.test(location.origin ?? '');

/**
 * Resolve any URL the backend hands us into something fetchable.
 *
 * The backend returns fully-rooted paths that already carry the prefix, for
 * example `/api/v1/uploads/upl_1/parts/2` and `/api/v1/media/prj_1`. Those must
 * not be prefixed a second time, and they must be sent to the API origin rather
 * than to the Vite dev server that served this page.
 *
 * `base`/`prefix` are overridable so the resolution rules can be tested without
 * a bundler or a live `.env`.
 */
export function resolveUrl(path, { base = API_BASE_URL, prefix = API_PREFIX } = {}) {
  const raw = String(path ?? '');
  if (!raw) return raw;

  // Already absolute, or a local object we must not touch.
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return raw;

  const clean = raw.replace(/^\/+/, '');
  const bare = prefix.replace(/^\/+/, '');

  // Already-prefixed: point it at the API origin without adding the prefix again.
  if (bare && (clean === bare || clean.startsWith(`${bare}/`))) {
    return `${base}/${clean}`;
  }

  // Rooted at the server, not at the API. `/media/{projectId}` is mounted
  // outside `api_prefix` on purpose, so prefixing it yields a 404 — this is the
  // URL on `<video src>` for the uploaded source.
  if (SERVER_ROOTED.has(clean.split('/')[0])) {
    return `${base}/${clean}`;
  }

  // A bare API path such as `/projects` or `projects`.
  return `${base}${prefix}/${clean}`;
}

/** Full URL for an API path. Accepts `/projects` or `projects`. */
export function buildUrl(path) {
  return resolveUrl(path);
}

/* -------------------------------------------------------------------------- */
/*  Errors                                                                     */
/* -------------------------------------------------------------------------- */

/** Normalised error so UI code never inspects raw Response objects. */
export class ApiError extends Error {
  constructor(message, { status = 0, code = 'unknown', details = null, cause } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    if (cause) this.cause = cause;
  }

  /** True when retrying the same request could plausibly succeed. */
  get isRetryable() {
    return this.code === 'network' || this.code === 'timeout' || this.status >= 500;
  }

  /** True when the caller should send the user to the login flow. */
  get isAuthError() {
    return this.status === 401 || this.status === 403;
  }
}

function messageForStatus(status, payload) {
  if (payload?.detail) {
    // FastAPI validation errors arrive as an array of {loc, msg, type}.
    if (Array.isArray(payload.detail)) {
      return payload.detail.map((item) => item?.msg ?? String(item)).join(' ');
    }
    if (typeof payload.detail === 'string') return payload.detail;
  }
  if (payload?.message) return String(payload.message);

  const byStatus = {
    400: 'That request was rejected as invalid.',
    401: 'Your session has expired. Sign in again to continue.',
    403: 'You do not have access to this resource.',
    404: 'That resource no longer exists.',
    409: 'That conflicts with the current state of the project.',
    413: 'That file is too large to upload.',
    422: 'Some of the submitted values were rejected.',
    429: 'Too many requests. Please slow down.',
  };
  return byStatus[status] ?? `Request failed with status ${status}.`;
}

/* -------------------------------------------------------------------------- */
/*  Core request                                                              */
/* -------------------------------------------------------------------------- */

let authToken = null;

/** Register a bearer token once auth exists. Safe to call with null to clear. */
export function setAuthToken(token) {
  authToken = token ?? null;
}

/**
 * Perform a JSON API request.
 *
 * @param {string} path
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {unknown} [options.body]     Serialised as JSON unless FormData.
 * @param {AbortSignal} [options.signal]
 * @param {Record<string,string>} [options.headers]
 * @param {number} [options.timeout]
 */
export async function http(path, options = {}) {
  const { method = 'GET', body, signal, headers = {}, timeout = API_TIMEOUT_MS } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('Timeout', 'TimeoutError')), timeout);

  // Forward caller cancellation into our controller.
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;
  const requestHeaders = { Accept: 'application/json', ...headers };
  if (body !== undefined && !isFormData) requestHeaders['Content-Type'] = 'application/json';
  if (authToken) requestHeaders.Authorization = `Bearer ${authToken}`;

  let response;
  try {
    response = await fetch(buildUrl(path), {
      method,
      headers: requestHeaders,
      body: body === undefined ? undefined : isFormData ? body : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (cause) {
    if (cause?.name === 'TimeoutError' || controller.signal.reason?.name === 'TimeoutError') {
      throw new ApiError(`Request timed out after ${Math.round(timeout / 1000)}s.`, {
        code: 'timeout',
        cause,
      });
    }
    if (signal?.aborted) throw cause;
    throw new ApiError('Could not reach the ClipForge API. Check your connection.', {
      code: 'network',
      cause,
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }

  // 204 and HEAD carry no body.
  if (response.status === 204 || method === 'HEAD') return null;

  const contentType = response.headers.get('content-type') ?? '';
  const isJson = contentType.includes('application/json');
  const payload = isJson ? await response.json().catch(() => null) : await response.text();

  if (!response.ok) {
    throw new ApiError(messageForStatus(response.status, isJson ? payload : null), {
      status: response.status,
      code: isJson ? (payload?.code ?? 'http_error') : 'http_error',
      details: isJson ? payload : { body: payload },
    });
  }

  return payload;
}

export const get = (path, options) => http(path, { ...options, method: 'GET' });
export const post = (path, body, options) => http(path, { ...options, method: 'POST', body });
export const patch = (path, body, options) => http(path, { ...options, method: 'PATCH', body });
export const put = (path, body, options) => http(path, { ...options, method: 'PUT', body });
export const del = (path, options) => http(path, { ...options, method: 'DELETE' });

/* -------------------------------------------------------------------------- */
/*  Binary transfers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * `fetch` a resolved URL that returns bytes rather than JSON.
 *
 * Needed for rendered media: the project `objectUrl` and export download links
 * are paths the backend builds itself, so they must go through `resolveUrl`
 * instead of being treated as API paths.
 */
export async function fetchBlob(url, { signal, timeout = 120000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('Timeout', 'TimeoutError')), timeout);
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const response = await fetch(resolveUrl(url), {
      signal: controller.signal,
      headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
    });
    if (!response.ok) {
      throw new ApiError(`Could not download that file (status ${response.status}).`, {
        status: response.status,
        details: { url },
      });
    }
    return await response.blob();
  } catch (cause) {
    if (cause instanceof ApiError) throw cause;
    throw new ApiError('The download could not reach the ClipForge API.', { code: 'network', cause });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

/**
 * Save a backend file to the user's downloads.
 *
 * Fetched through a blob rather than a plain anchor because the export link is
 * tokenised and may point at another origin, where the `download` attribute is
 * ignored and the file would open in a tab instead of saving.
 */
export async function downloadFile(url, filename, options = {}) {
  const blob = await fetchBlob(url, options);
  const objectUrl = URL.createObjectURL(blob);

  try {
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename || 'clipforge-export.mp4';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // Revoke on the next tick so the click has been dispatched.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
  }

  return blob.size;
}

/** Monotonic id generator for client-only records such as toasts and alerts. */
let idCounter = 0;
export function localId(prefix = 'id') {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}`;
}

/**
 * Abortable delay, used between job polls.
 *
 * Rejects with the signal's reason when aborted so a caller can distinguish
 * "stopped on purpose" from a real failure.
 */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
