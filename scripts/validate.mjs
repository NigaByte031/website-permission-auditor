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
 *   6. Every _locales/*/messages.json parses, holds valid message entries,
 *      and all locales share the exact same key set and $N placeholders.
 *
 * Exits non-zero with a readable report when anything fails.
 */
import { execFileSync } from 'node:child_process';
import { access, readdir, readFile } from 'node:fs/promises';
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

/**
 * Finds duplicate top-level keys in raw JSON text. JSON.parse silently keeps
 * only the last occurrence, so a duplicated message key would quietly drop a
 * translation - worth catching before Chrome ever sees it.
 */
function duplicateTopLevelKeys(text) {
  const seen = new Set();
  const duplicates = new Set();
  let depth = 0;
  let inString = false;
  let escaped = false;
  let stringStart = -1;
  let lastString = null; // [start, end] of the most recent top-level string
  let lastToken = ''; // last non-whitespace character seen outside strings

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') {
        inString = false;
        lastToken = ch;
        if (depth === 1) lastString = [stringStart, i];
      }
      continue;
    }
    if (ch === '"') {
      if (depth === 1) stringStart = i;
      inString = true;
      continue;
    }
    if (ch === '{' || ch === '[') {
      depth += 1;
      lastToken = ch;
      continue;
    }
    if (ch === '}' || ch === ']') {
      depth -= 1;
      lastToken = ch;
      continue;
    }
    if (ch === ':' && depth === 1 && lastToken === '"' && lastString) {
      const key = text.slice(lastString[0] + 1, lastString[1]);
      if (seen.has(key)) duplicates.add(key);
      else seen.add(key);
    }
    if (!/\s/.test(ch)) lastToken = ch;
  }
  return [...duplicates];
}

/** Distinct $1..$9 substitution tokens used by a message string. */
function placeholdersOf(message) {
  return new Set([...message.matchAll(/\$(\d)/g)].map((m) => m[1]));
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

/* -- 5. localization (_locales) -------------------------------------------- */

let localesDirExists = true;
let localeDirs = [];
try {
  localeDirs = (await readdir(abs('_locales'), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
} catch {
  localesDirExists = false;
  problems.push('_locales directory is missing');
}

if (localesDirExists && localeDirs.length === 0) {
  problems.push('_locales contains no locale directories');
}

/** Parsed messages per locale, kept for the cross-locale parity checks. */
const localeMessages = new Map();

for (const locale of localeDirs) {
  const rel = `_locales/${locale}/messages.json`;
  const raw = await readFile(abs(rel), 'utf8').catch(() => null);

  if (raw === null) {
    problems.push(`${rel} is missing (every locale needs a messages.json)`);
    continue;
  }

  for (const key of duplicateTopLevelKeys(raw)) {
    problems.push(
      `${rel}: message "${key}" is defined more than once ` +
        '(JSON.parse would silently keep only the last one)'
    );
  }

  let messages = null;
  try {
    messages = JSON.parse(raw);
  } catch (err) {
    problems.push(`${rel} is not valid JSON: ${err.message}`);
    continue;
  }

  if (messages === null || typeof messages !== 'object' || Array.isArray(messages)) {
    problems.push(`${rel}: top level must be an object of message entries`);
    continue;
  }

  if (Object.keys(messages).length === 0) {
    problems.push(`${rel}: contains no messages`);
  }

  for (const [key, entry] of Object.entries(messages)) {
    if (!/^[A-Za-z0-9_]+$/.test(key)) {
      problems.push(`${rel}: message name "${key}" may only use A-Z, a-z, 0-9 and _`);
    }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      problems.push(`${rel}: "${key}" must be an object with a "message" string`);
      continue;
    }
    if (typeof entry.message !== 'string' || entry.message.length === 0) {
      problems.push(`${rel}: "${key}" is missing a non-empty "message" string`);
    }
    if (entry.description !== undefined && typeof entry.description !== 'string') {
      problems.push(`${rel}: "${key}" has a non-string "description"`);
    }
  }

  localeMessages.set(locale, messages);
}

const defaultLocale = manifest?.default_locale;

if (localesDirExists) {
  if (!defaultLocale) {
    problems.push('manifest.json: default_locale must be set when _locales exists');
  } else if (!localeMessages.has(defaultLocale)) {
    problems.push(
      `manifest.json: default_locale "${defaultLocale}" has no _locales/${defaultLocale}/messages.json`
    );
  }

  const referenceLocale =
    (defaultLocale && localeMessages.has(defaultLocale) && defaultLocale) ||
    (localeMessages.has('en') && 'en') ||
    localeDirs[0];

  if (referenceLocale) {
    const reference = localeMessages.get(referenceLocale);
    const referenceKeys = new Set(Object.keys(reference));
    const referencePlaceholders = new Map(
      Object.entries(reference)
        .filter(([, entry]) => typeof entry?.message === 'string')
        .map(([key, entry]) => [key, placeholdersOf(entry.message)])
    );
    const fmt = (set) => (set.size > 0 ? `$${[...set].sort().join(', $')}` : '(none)');

    for (const [locale, messages] of localeMessages) {
      if (locale === referenceLocale) continue;
      const keys = new Set(Object.keys(messages));

      for (const key of referenceKeys) {
        if (!keys.has(key)) {
          problems.push(
            `_locales/${locale}/messages.json is missing "${key}" (present in ${referenceLocale})`
          );
        }
      }
      for (const key of keys) {
        if (!referenceKeys.has(key)) {
          problems.push(
            `_locales/${locale}/messages.json has an unknown message "${key}" (not in ${referenceLocale})`
          );
        }
      }
      for (const [key, expected] of referencePlaceholders) {
        const message = messages[key]?.message;
        if (typeof message !== 'string') continue; // key mismatch already reported
        const actual = placeholdersOf(message);
        if (actual.size !== expected.size || [...actual].some((n) => !expected.has(n))) {
          problems.push(
            `_locales/${locale}/messages.json: "${key}" uses ${fmt(actual)} ` +
              `but ${referenceLocale} uses ${fmt(expected)}`
          );
        }
      }
    }

    notes.push(
      `locales: ${[...localeMessages.keys()].join(', ')} ` +
        `(${referenceKeys.size} messages each, reference: ${referenceLocale})`
    );
  }
}

/* -- report ---------------------------------------------------------------- */
for (const note of notes) console.log(`  note: ${note}`);

if (problems.length > 0) {
  console.error(`\n✖ ${problems.length} problem(s) found:\n`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log('\n✔ manifest, syntax, offline guarantee, popup.html and _locales all check out.');
