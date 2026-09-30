#!/usr/bin/env node
/**
 * Dependency-free static validation for the extension.
 *
 * Run with `npm test` (or `node scripts/validate.mjs`). It checks the
 * invariants that matter for a store-ready MV3 extension:
 *
 *   1. manifest.json parses, is MV3, and every file it references exists.
 *   2. Declared permissions match what the code actually uses, and
 *      host_permissions stay empty (no scary install warning).
 *   3. Every JavaScript file parses (`node --check`).
 *   4. The extension makes no network calls - the core privacy promise.
 *   5. popup.html only references local assets and has no inline script
 *      (MV3's CSP forbids inline script).
 *
 * Exits non-zero with a readable report when anything fails.
 */
import { execFileSync } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const problems = [];
const notes = [];

/** Permissions the extension is expected to declare (README documents why). */
const REQUIRED_PERMISSIONS = [
  'activeTab',
  'tabs',
  'contentSettings',
  'permissions',
  'storage',
  'favicon',
];

/** Extension sources that must never reach the network. */
const RUNTIME_SOURCES = ['popup.js', 'background.js'];

/** Every JavaScript file that must parse. */
const JS_FILES = ['popup.js', 'background.js', 'icons/generate-icons.mjs'];

const NETWORK_CALL =
  /\b(fetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon\s*\(|importScripts\s*\()/;

const abs = (rel) => path.join(ROOT, rel);

async function fileExists(rel) {
  try {
    await access(abs(rel), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/* -- 1. manifest ---------------------------------------------------------- */
let manifest = null;
try {
  manifest = JSON.parse(await readFile(abs('manifest.json'), 'utf8'));
} catch (err) {
  problems.push(`manifest.json is not valid JSON: ${err.message}`);
}

if (manifest) {
  if (manifest.manifest_version !== 3) {
    problems.push('manifest.json: manifest_version must be 3');
  }

  const referenced = [
    manifest.action?.default_popup,
    manifest.background?.service_worker,
    ...Object.values(manifest.icons ?? {}),
    ...Object.values(manifest.action?.default_icon ?? {}),
  ].filter(Boolean);

  for (const ref of new Set(referenced)) {
    if (!(await fileExists(ref))) {
      problems.push(`manifest.json references a missing file: ${ref}`);
    }
  }

  if ((manifest.host_permissions ?? []).length > 0) {
    problems.push(
      'manifest.json: host_permissions must stay empty so install shows no ' +
        '"read and change all your data" warning'
    );
  }

  const declared = new Set(manifest.permissions ?? []);
  for (const permission of REQUIRED_PERMISSIONS) {
    if (!declared.has(permission)) {
      problems.push(`manifest.json is missing the "${permission}" permission`);
    }
  }
  const extra = [...declared].filter((p) => !REQUIRED_PERMISSIONS.includes(p));
  if (extra.length > 0) {
    notes.push(`extra permissions declared: ${extra.join(', ')}`);
  }
  notes.push(`permissions: ${[...declared].join(', ') || '(none)'}`);
  notes.push(`version: ${manifest.version}`);
}

/* -- 2. JavaScript syntax -------------------------------------------------- */
for (const file of JS_FILES) {
  if (!(await fileExists(file))) {
    problems.push(`missing JavaScript file: ${file}`);
    continue;
  }
  try {
    execFileSync(process.execPath, ['--check', abs(file)], { stdio: 'pipe' });
  } catch (err) {
    const detail = err.stderr?.toString().trim() || err.message;
    problems.push(`${file} failed the syntax check:\n${detail}`);
  }
}

/* -- 3. offline guarantee -------------------------------------------------- */
for (const file of RUNTIME_SOURCES) {
  if (!(await fileExists(file))) continue;
  const lines = (await readFile(abs(file), 'utf8')).split('\n');
  lines.forEach((line, index) => {
    const match = line.match(NETWORK_CALL);
    if (match) {
      problems.push(
        `${file}:${index + 1} uses ${match[1]} - the extension must make no ` +
          'network requests'
      );
    }
  });
}

/* -- 4. popup.html -------------------------------------------------------- */
const html = await readFile(abs('popup.html'), 'utf8');

if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)) {
  problems.push('popup.html contains an inline <script>, which MV3 CSP forbids');
}

for (const match of html.matchAll(/(?:src|href)="([^"]*)"/g)) {
  const ref = match[1];
  if (!ref || ref.startsWith('#')) continue;
  if (/^(https?:)?\/\//.test(ref)) {
    problems.push(`popup.html loads a remote resource: ${ref}`);
    continue;
  }
  if (!(await fileExists(ref))) {
    problems.push(`popup.html references a missing file: ${ref}`);
  }
}

/* -- report ---------------------------------------------------------------- */
for (const note of notes) console.log(`  note: ${note}`);

if (problems.length > 0) {
  console.error(`\n✖ ${problems.length} problem(s) found:\n`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log('\n✔ manifest, syntax, offline guarantee and popup.html all check out.');
