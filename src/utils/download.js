/**
 * Client-side file generation.
 *
 * These are the exports that genuinely work in the browser today: caption and
 * transcript sidecars built from data already in state, plus a JSON snapshot of
 * the clip's settings. Video rendering is not here on purpose — it needs FFmpeg
 * on a server, and faking a file would be worse than an honest job record.
 */

import { formatClock } from './formatDuration.js';

/** `00:01:02,500` — SRT requires a comma before milliseconds. */
function srtTimestamp(seconds) {
  const clamped = Math.max(0, seconds);
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const secs = Math.floor(clamped % 60);
  const millis = Math.round((clamped - Math.floor(clamped)) * 1000);

  const pad = (value, length = 2) => String(value).padStart(length, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)},${pad(millis, 3)}`;
}

/** Seconds to `00:01:02.500` for WebVTT. */
function vttTimestamp(seconds) {
  const clamped = Math.max(0, seconds);
  const pad = (value, length = 2) => String(value).padStart(length, '0');
  const millis = Math.round((clamped - Math.floor(clamped)) * 1000);
  return `${pad(Math.floor(clamped / 3600))}:${pad(Math.floor((clamped % 3600) / 60))}:${pad(
    Math.floor(clamped % 60)
  )}.${pad(millis, 3)}`;
}

/**
 * Trigger a download from an in-memory string.
 * `URL.createObjectURL` is revoked on the next tick so the link never leaks.
 */
function downloadText(text, filename, mimeType) {
  const blob = new Blob([text], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();

  // Revoking synchronously can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Make a filename safe for every filesystem. */
export function slugify(value, fallback = 'clip') {
  const slug = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || fallback;
}

/** Build an SRT caption track, either from the single caption or per sentence. */
export function buildSrt(clip) {
  const caption = clip?.caption ?? {};
  const text = (caption.text ?? '').trim();

  if (text) {
    return [
      '1',
      `${srtTimestamp(caption.startSec ?? clip.startSec)} --> ${srtTimestamp(
        caption.endSec ?? clip.endSec
      )}`,
      text,
      '',
    ].join('\n');
  }

  // Fall back to one cue per transcript line so the file is still useful.
  const cues = (clip?.transcript ?? [])
    .filter((segment) => segment.text)
    .map(
      (segment, index) =>
        [
          String(index + 1),
          `${srtTimestamp(segment.startSec)} --> ${srtTimestamp(segment.endSec)}`,
          segment.text,
          '',
        ].join('\n')
    );

  return cues.join('\n') || 'No caption data is available for this clip.\n';
}

/** Build a WebVTT track, for players that prefer it over SRT. */
export function buildVtt(clip) {
  const caption = clip?.caption ?? {};
  const text = (caption.text ?? '').trim();

  if (!text) return 'WEBVTT\n\n';

  return [
    'WEBVTT',
    '',
    `${vttTimestamp(caption.startSec ?? clip.startSec)} --> ${vttTimestamp(
      caption.endSec ?? clip.endSec
    )}`,
    text,
    '',
  ].join('\n');
}

/** Human-readable transcript with timecodes in the margin. */
export function buildTranscript(clip, project) {
  const lines = [
    `TRANSCRIPT — ${clip?.title ?? 'Untitled clip'}`,
    project?.title ? `Source: ${project.title}` : null,
    `Range: ${srtTimestamp(clip?.startSec ?? 0)} to ${srtTimestamp(clip?.endSec ?? 0)}`,
    '',
  ].filter((line) => line !== null);

  const segments = clip?.transcript ?? [];
  if (segments.length === 0) {
    lines.push('No transcript segments are available for this clip.');
    return lines.join('\n');
  }

  for (const segment of segments) {
    const timecode = `[${formatClock(segment.startSec)}]`;
    lines.push(`${timecode} ${segment.text}`);
  }

  return lines.join('\n');
}

/** Snapshot of everything needed to re-render this clip on a backend. */
export function buildClipManifest(clip, project, exportSettings) {
  return {
    schema: 'clipforge/clip-manifest@1',
    generatedAt: new Date().toISOString(),
    clip: {
      id: clip?.id ?? null,
      title: clip?.title ?? null,
      hook: clip?.hook ?? null,
      score: clip?.score ?? null,
      aspectRatio: clip?.aspectRatio ?? null,
      startSec: clip?.startSec ?? null,
      endSec: clip?.endSec ?? null,
      durationSec: clip?.durationSec ?? null,
      caption: clip?.caption ?? null,
      transcript: clip?.transcript ?? [],
      editedAt: clip?.editedAt ?? null,
    },
    source: project
      ? {
          id: project.id,
          title: project.title,
          originalName: project.originalName,
          durationSec: project.durationSec,
          width: project.width,
          height: project.height,
          sizeBytes: project.sizeBytes,
          mimeType: project.mimeType,
        }
      : null,
    render: exportSettings ?? null,
    // Stated explicitly so a consumer never assumes a renderable path exists.
    note: 'Source media must be re-supplied; blob URLs are session-only.',
  };
}

/** Download the clip's SRT caption track. */
export function downloadCaptions(clip, format = 'srt') {
  const name = `${slugify(clip?.title)}.${format}`;
  downloadText(format === 'vtt' ? buildVtt(clip) : buildSrt(clip), name, 'text/plain');
  return name;
}

/** Download the plain-text transcript. */
export function downloadTranscript(clip, project) {
  const name = `${slugify(clip?.title)}-transcript.txt`;
  downloadText(buildTranscript(clip, project), name, 'text/plain');
  return name;
}

/** Download the JSON settings manifest. */
export function downloadClipManifest(clip, project, exportSettings) {
  const name = `${slugify(clip?.title)}-manifest.json`;
  downloadText(
    JSON.stringify(buildClipManifest(clip, project, exportSettings), null, 2),
    name,
    'application/json'
  );
  return name;
}

/** Download arbitrary data as pretty-printed JSON. */
export function downloadJson(data, filename) {
  const name = `${slugify(filename, 'export')}.json`;
  downloadText(JSON.stringify(data, null, 2), name, 'application/json');
  return name;
}

/** Download the full library as a JSON backup. */
export function downloadLibraryBackup(state) {
  return downloadJson(
    { schema: 'clipforge/backup@1', exportedAt: new Date().toISOString(), ...state },
    'clipforge-backup'
  );
}