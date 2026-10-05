/**
 * Client-side validation for uploaded media.
 *
 * This is a UX affordance, not a security boundary. A real deployment must
 * re-validate type, size and content (magic bytes, codec) server-side before
 * touching FFmpeg.
 */

const DEFAULT_ACCEPTED = ['mp4', 'mov', 'webm', 'm4v'];

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

function readAcceptedTypes() {
  const configured = import.meta.env?.VITE_ACCEPTED_VIDEO_TYPES;
  if (!configured) return DEFAULT_ACCEPTED;
  const parsed = String(configured)
    .split(',')
    .map((value) => value.trim().replace(/^\./, '').toLowerCase())
    .filter(Boolean);
  return parsed.length ? parsed : DEFAULT_ACCEPTED;
}

function readMaxBytes() {
  const megabytes = Number(import.meta.env?.VITE_MAX_UPLOAD_MB);
  if (!Number.isFinite(megabytes) || megabytes <= 0) return DEFAULT_MAX_BYTES;
  return megabytes * 1024 * 1024;
}

/** Accepted extensions, lower-case, without dots. */
export const ACCEPTED_EXTENSIONS = readAcceptedTypes();

/** Max upload size in bytes. */
export const MAX_UPLOAD_BYTES = readMaxBytes();

/** Value for the dropzone's `accept` attribute. */
export const ACCEPT_ATTRIBUTE = ACCEPTED_EXTENSIONS.map((ext) => `.${ext}`).join(',');

/** Lower-case extension without the dot, or `''` when there is none. */
export function getExtension(fileName = '') {
  const name = String(fileName);
  const index = name.lastIndexOf('.');
  if (index === -1 || index === name.length - 1) return '';
  return name.slice(index + 1).toLowerCase();
}

/** Strip the extension for display: `podcast-ep-12.mp4` -> `podcast-ep-12`. */
export function getBaseName(fileName = '') {
  const name = String(fileName);
  const index = name.lastIndexOf('.');
  return index <= 0 ? name : name.slice(0, index);
}

/** `video/mp4` -> `MP4`. Falls back to the extension when MIME is generic. */
export function getFormatLabel(file) {
  const mime = file?.type || '';
  const subtype = mime.split('/')[1];
  if (subtype && !subtype.includes('x-')) return subtype.toUpperCase();
  const ext = getExtension(file?.name);
  return ext ? ext.toUpperCase() : 'Unknown';
}

/** True when the extension is one we accept. */
export function isAcceptedVideoFile(file) {
  if (!file) return false;
  return ACCEPTED_EXTENSIONS.includes(getExtension(file.name));
}

/**
 * Validate a single file.
 *
 * @param {File} file
 * @returns {{ valid: boolean, error: string|null, code: string|null }}
 */
export function validateVideoFile(file) {
  if (!file) {
    return { valid: false, error: 'No file selected.', code: 'missing' };
  }

  const extension = getExtension(file.name);

  if (!extension) {
    return {
      valid: false,
      error: `"${file.name}" has no file extension.`,
      code: 'no-extension',
    };
  }

  if (!ACCEPTED_EXTENSIONS.includes(extension)) {
    return {
      valid: false,
      error: `Unsupported format .${extension}. Accepted formats: ${ACCEPTED_EXTENSIONS.map((e) => e.toUpperCase()).join(', ')}.`,
      code: 'unsupported-type',
    };
  }

  if (file.size === 0) {
    return { valid: false, error: `"${file.name}" is empty (0 bytes).`, code: 'empty' };
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    const limitGb = (MAX_UPLOAD_BYTES / 1024 ** 3).toFixed(1);
    return {
      valid: false,
      error: `"${file.name}" exceeds the ${limitGb} GB upload limit.`,
      code: 'too-large',
    };
  }

  return { valid: true, error: null, code: null };
}

/**
 * Validate a drop, which may contain several files.
 * Returns every result so the UI can show per-file errors.
 */
export function validateVideoFiles(fileList) {
  const files = Array.from(fileList ?? []);
  if (files.length === 0) {
    return [{ file: null, valid: false, error: 'No files were dropped.', code: 'missing' }];
  }
  return files.map((file) => ({ file, ...validateVideoFile(file) }));
}

/**
 * Read intrinsic video metadata (duration, dimensions) via a detached
 * `<video>` element. Resolves with nulls if the browser cannot decode the file,
 * because codec support varies and a failure here must not block the upload.
 *
 * @param {File} file
 * @returns {Promise<{ durationSec: number|null, width: number|null, height: number|null }>}
 */
export function readVideoMetadata(file) {
  return new Promise((resolve) => {
    const fallback = { durationSec: null, width: null, height: null };
    if (!file || typeof URL === 'undefined') {
      resolve(fallback);
      return;
    }

    const url = URL.createObjectURL(file);
    const video = document.createElement('video');

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeAttribute('src');
      video.load?.();
      URL.revokeObjectURL(url);
      resolve(result);
    };

    // Never leave the UI waiting on a codec the browser refuses to parse.
    const timer = setTimeout(() => finish(fallback), 8000);

    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;

    video.onloadedmetadata = () => {
      const rawDuration = video.duration;
      // `Infinity` happens with some streamed/fragmented files.
      const durationSec =
        Number.isFinite(rawDuration) && rawDuration > 0 ? Math.round(rawDuration) : null;
      finish({
        durationSec,
        width: video.videoWidth || null,
        height: video.videoHeight || null,
      });
    };

    video.onerror = () => finish(fallback);
    video.src = url;
  });
}
