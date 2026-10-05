#!/usr/bin/env node
/**
 * API URL resolution checks.
 *
 * The backend hands the client fully-rooted paths that already carry the API
 * prefix (`/api/v1/uploads/{id}/parts/1`, `/api/v1/media/{id}`). If those are
 * treated as bare API paths they become `/api/v1/api/v1/...` and every request
 * 404s — silently, because it looks like a normal request.
 *
 * `resolveUrl` takes explicit base/prefix so these rules can be exercised
 * without a bundler or a live `.env`.
 *
 * Run via `npm run verify`, or on its own: `node scripts/verifyApiUrls.mjs`.
 */

import { resolveUrl, splitBaseUrl } from '../src/services/api.js';

const failures = [];

function expectEqual(actual, expected, label) {
  if (actual !== expected) {
    failures.push(`${label}\n      expected: ${expected}\n      actual:   ${actual}`);
  }
}

/* --- splitBaseUrl: the base may or may not already include the prefix ----- */

const CASES = [
  // [configured base, expected origin]
  ['', ''],
  ['http://localhost:8000', 'http://localhost:8000'],
  ['http://localhost:8000/', 'http://localhost:8000'],
  ['http://localhost:8000/api/v1', 'http://localhost:8000'],
  ['http://localhost:8000/api/v1/', 'http://localhost:8000'],
  ['https://clipforge.example.com/api/v1', 'https://clipforge.example.com'],
  // A base with an unrelated path prefix (gateway mount) must be left alone.
  ['https://gw.example.com/clipforge', 'https://gw.example.com/clipforge'],
];

for (const [input, expected] of CASES) {
  expectEqual(splitBaseUrl(input), expected, `splitBaseUrl(${JSON.stringify(input)})`);
}

/* --- resolveUrl across the three ways the base can be configured ---------- */

const CONFIGS = [
  { label: 'origin only', base: 'http://localhost:8000' },
  { label: 'origin + prefix', base: 'http://localhost:8000', viaSplit: true },
  { label: 'same origin', base: '' },
];

for (const config of CONFIGS) {
  const base = config.viaSplit ? splitBaseUrl('http://localhost:8000/api/v1') : config.base;
  const prefix = '/api/v1';

  // Bare API path gets the prefix.
  expectEqual(resolveUrl('/projects', { base, prefix }), `${base}/api/v1/projects`, `${config.label}: bare path`);

  // Already-prefixed path must NOT be prefixed twice.
  expectEqual(
    resolveUrl('/api/v1/uploads/upl_1/parts/2', { base, prefix }),
    `${base}/api/v1/uploads/upl_1/parts/2`,
    `${config.label}: prefixed path`
  );

  // Backend media path.
  expectEqual(
    resolveUrl('/api/v1/media/prj_1', { base, prefix }),
    `${base}/api/v1/media/prj_1`,
    `${config.label}: media path`
  );

  // Tokenised download link.
  expectEqual(
    resolveUrl(`/api/v1/exports/exp_1/file?token=abc`, { base, prefix }),
    `${base}/api/v1/exports/exp_1/file?token=abc`,
    `${config.label}: download link`
  );

  // Absolute URLs pass through untouched.
  expectEqual(
    resolveUrl('https://cdn.example.com/x.mp4', { base, prefix }),
    'https://cdn.example.com/x.mp4',
    `${config.label}: absolute URL`
  );

  // Local object URLs must survive.
  expectEqual(resolveUrl('blob:http://localhost:5173/abc', { base, prefix }), 'blob:http://localhost:5173/abc', `${config.label}: blob URL`);

  // Query strings on bare paths survive the join.
  expectEqual(resolveUrl('/projects?status=ready', { base, prefix }), `${base}/api/v1/projects?status=ready`, `${config.label}: query string`);
}

/* --- The regression this file exists for ---------------------------------- */

const doubled = resolveUrl('/api/v1/media/prj_1', {
  base: splitBaseUrl('http://localhost:8000/api/v1'),
  prefix: '/api/v1',
});
if (doubled.includes('/api/v1/api/v1')) {
  failures.push(`double-prefix regression: ${doubled}`);
}

if (failures.length > 0) {
  console.error('API URL verification failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`API URL verification passed (${CASES.length} base forms, ${CONFIGS.length} configurations).`);