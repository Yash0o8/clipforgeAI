#!/usr/bin/env node
/**
 * Module graph check.
 *
 * Resolves every relative import in `src/` against the filesystem and flags
 * anything that points at a file that does not exist. This catches the class of
 * breakage that hides from `vite build`: a module that imports a file deleted
 * during a refactor only fails when some unrelated code path stops tree-shaking
 * past it, which can be many releases later.
 *
 * Also guards against resurrecting removed fixtures.
 *
 * Run via `npm run verify`, or on its own: `node scripts/verifyRoutes.mjs`.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const srcDir = join(root, 'src');

/** Candidate extensions, in resolution order, plus the index-file convention. */
const EXTENSIONS = ['.js', '.jsx', '.mjs', '.json'];

const problems = [];
const checked = new Map();

/** Recursively collect every source file under `src/`. */
async function collect(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await collect(full, out);
    else if (/\.(jsx?|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const exists = async (path) => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

/** Resolve one relative specifier the way a bundler would. */
async function resolveSpecifier(specifier, fromFile) {
  const base = resolve(dirname(fromFile), specifier);

  if (await exists(base)) return base;

  for (const extension of EXTENSIONS) {
    if (await exists(base + extension)) return base + extension;
  }

  // `./thing` may mean `./thing/index.jsx`.
  if (await exists(join(base, `index${'.jsx'}`))) return join(base, 'index.jsx');

  return null;
}

// Matches `import ... from 'x'`, `export ... from 'x'` and bare `import 'x'`.
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\b[^;\n]*?from\s*['"]([^'"]+)['"]/g;
const BARE_IMPORT_RE = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;

const files = await collect(srcDir);

for (const file of files) {
  const rel = relative(root, file).replace(/\\/g, '/');
  const text = await readFile(file, 'utf8');

  const specifiers = new Set();
  for (const re of [IMPORT_RE, BARE_IMPORT_RE]) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(text)) !== null) specifiers.add(match[1]);
  }

  for (const specifier of specifiers) {
    // Bare package specifiers resolve through node_modules; nothing to check.
    if (!specifier.startsWith('.')) continue;

    if (checked.has(specifier + rel)) continue;
    checked.set(specifier + rel, true);

    const target = await resolveSpecifier(specifier, file);
    if (!target) {
      problems.push(`${rel}: cannot resolve "${specifier}"`);
    }
  }
}

/** Removed fixtures must not reappear in an import path. */
const REMOVED = ['data/demoProjects', 'data/demoClips', 'data/dashboardStats', 'DemoNotice'];

for (const file of files) {
  const rel = relative(root, file).replace(/\\/g, '/');
  const text = await readFile(file, 'utf8');
  for (const needle of REMOVED) {
    if (new RegExp(`from\\s*['"][^'"]*${needle}`).test(text)) {
      problems.push(`${rel}: still imports removed module "${needle}"`);
    }
  }
}

/** Every page must export something the router can reference. */
const pagesDir = join(srcDir, 'pages');
for (const entry of await readdir(pagesDir, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.jsx')) continue;
  const rel = relative(root, join(pagesDir, entry.name)).replace(/\\/g, '/');
  const text = await readFile(join(pagesDir, entry.name), 'utf8');
  if (!/export\s+(?:const|function)\s+[A-Z]/.test(text) && !/export\s+default/.test(text)) {
    problems.push(`${rel}: exports no component, so the router cannot reference it`);
  }
}

if (problems.length > 0) {
  console.error('Route verification failed:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`Route verification passed (${files.length} source files resolved).`);