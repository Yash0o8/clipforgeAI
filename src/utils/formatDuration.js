/**
 * Time formatting helpers.
 *
 * Timestamps are stored as fractional seconds (numbers) throughout the app.
 * `clip.startSec`, `clip.endSec` etc. Everything here converts to display form.
 */

/** Guard against NaN / negative / absurd values reaching the UI. */
function safeSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

/**
 * Compact duration: `45`, `1:05`, `12:04`, `1:02:03`.
 * Used for clip lengths and project runtimes.
 */
export function formatDuration(seconds) {
  const total = Math.floor(safeSeconds(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  const pad = (n) => String(n).padStart(2, '0');
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(secs)}`;
  if (minutes > 0) return `${minutes}:${pad(secs)}`;
  return `${secs}`;
}

/** Same as `formatDuration` but always `MM:SS`, used for timeline scrubbers. */
export function formatClock(seconds) {
  const total = Math.floor(safeSeconds(seconds));
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/** `1m 12s` — friendlier for stats cards and metadata rows. */
export function formatDurationLong(seconds) {
  const total = Math.floor(safeSeconds(seconds));
  if (total < 60) return `${total}s`;

  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  const parts = [];
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (secs && !hours) parts.push(`${secs}s`);
  return parts.join(' ');
}

/** `12:04 - 12:42` for a clip range, with an em dash for null durations. */
export function formatTimeRange(startSec, endSec) {
  return `${formatDuration(startSec)} \u2013 ${formatDuration(endSec)}`;
}

/**
 * Human label for a clip length in the 15–60 s sweet spot.
 * Short clips read as "punchy", long ones as "in-depth".
 */
export function describeClipLength(seconds) {
  const total = safeSeconds(seconds);
  if (total < 20) return 'Punchy';
  if (total <= 45) return 'Sweet spot';
  if (total <= 60) return 'Standard';
  return 'In-depth';
}

/** Bytes to `148 MB`. Uses decimal units, matching how OS file sizes read. */
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exp = Math.min(Math.floor(Math.log10(n) / 3), units.length - 1);
  const value = n / 1000 ** exp;
  const decimals = exp === 0 ? 0 : value < 10 ? 1 : 0;

  return `${value.toFixed(decimals)} ${units[exp]}`;
}

/** Seconds of runtime to `4.2 hrs`, for the processing-minutes stat. */
export function formatHours(seconds) {
  const total = safeSeconds(seconds);
  const hours = total / 3600;
  if (hours < 1) return `${Math.round(total / 60)} min`;
  if (hours < 10) return `${hours.toFixed(1)} hrs`;
  return `${Math.round(hours)} hrs`;
}

/** ISO string -> `3 Oct 2026`. Falls back to the raw string if unparseable. */
export function formatDate(isoString) {
  if (!isoString) return '—';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return String(isoString);

  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** ISO string -> `3 Oct, 14:20`. */
export function formatDateTime(isoString) {
  if (!isoString) return '—';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return String(isoString);

  return date.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** ISO string -> `2h ago`, `3d ago`, `just now`. */
export function formatRelativeTime(isoString) {
  if (!isoString) return '—';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return String(isoString);

  const diffMs = Date.now() - date.getTime();
  const minutes = Math.round(diffMs / 60000);

  if (Math.abs(minutes) < 1) return 'just now';
  if (Math.abs(minutes) < 60) return `${Math.abs(minutes)}m ago`;

  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return `${Math.abs(hours)}h ago`;

  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return `${Math.abs(days)}d ago`;

  const months = Math.round(days / 30);
  if (Math.abs(months) < 12) return `${Math.abs(months)}mo ago`;

  return formatDate(isoString);
}

/** Seconds remaining -> `about 40s`, used by the processing screen. */
export function formatEta(seconds) {
  const total = Math.max(0, Math.ceil(safeSeconds(seconds)));
  if (total < 60) return `about ${total}s`;
  const minutes = Math.ceil(total / 60);
  return `about ${minutes} min`;
}

/** Clamp a number into a range. */
export function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(Math.max(n, min), max);
}

/** Round to `decimals` places, avoiding float drift like 12.300000000000001. */
export function round(value, decimals = 1) {
  const factor = 10 ** decimals;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}
