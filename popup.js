/**
 * Website Permission Auditor - popup logic.
 *
 * Everything here is vanilla ES2022+ and runs only in the popup's extension
 * context (no content scripts, no remote code, per MV3 CSP).
 *
 * Data sources
 * ------------
 * 1. chrome.contentSettings - per-origin content settings (camera, mic,
 *    geolocation, notifications, clipboard, ...). Stable for years and fully
 *    compatible with MV3.
 *    NOTE: this is the API the original spec referred to as
 *    "chrome.siteSettings". That namespace does NOT exist in any Chrome
 *    release (verified against Chromium source: no schema file, no entry in
 *    _api_features.json, no docs). "chrome.contentSettings" is the real,
 *    supported surface for querying per-site content settings, and the
 *    "contentSettings" manifest permission (not "siteSettings") is what
 *    unlocks it. See README.md for details.
 * 2. chrome.permissions     - host permissions this extension holds. In MV3,
 *    per-site "Allow on this site" grants from chrome://extensions are
 *    reported as granted host permissions, so we can surface them too.
 * 3. chrome.tabs            - to resolve the active tab's URL.
 * 4. chrome.favicon         - Chrome 104+: local, private favicon lookup via
 *    the chrome-extension://<id>/_favicon/ endpoint (no third-party requests).
 */

'use strict';

/* ==========================================================================
 * Data model
 * ==========================================================================
 * Each audit entry maps a chrome.contentSettings property (the string key
 * Chrome uses for that content type) to a user-facing row. `get()` resolves
 * the *effective* setting - including enterprise policy and browser defaults
 * - even when the extension itself never set a rule.
 */

/**
 * @typedef {Object} PermSpec
 * @property {string}  cs        chrome.contentSettings property name, or a
 *                               pseudo-key like "__host__".
 * @property {string}  label     Row label.
 * @property {string}  icon      Key into ICONS for the row glyph.
 * @property {string}  detail    What the setting covers.
 * @property {boolean} [revoke]  Show a revoke/reset action (default true).
 */

/* ==========================================================================
 * Icons
 * ==========================================================================
 * Hand-rolled 24x24 stroke icons (Lucide-ish geometry) instead of emoji, so
 * the popup renders identically on every platform and the line weight matches
 * the interface type. Everything inherits `currentColor`, which lets the
 * status classes tint a glyph by swapping one colour token.
 *
 * These are static, developer-authored strings - no user data is ever
 * interpolated into markup, so assigning them via innerHTML stays within
 * MV3's CSP and is safe.
 */

/** Wrap icon bodies in one consistent <svg> shell. */
const icon = (body) =>
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" ' +
  'aria-hidden="true" focusable="false">' +
  body +
  '</svg>';

/** Category + row glyphs, keyed by the `icon` field of a spec. */
const ICONS = {
  // Categories
  chip: icon(
    '<rect x="7.5" y="7.5" width="9" height="9" rx="2.4"/>' +
      '<path d="M10 3.2v4.3M14 3.2v4.3M10 16.5v4.3M14 16.5v4.3M3.2 10h4.3M3.2 14h4.3M16.5 10h4.3M16.5 14h4.3"/>'
  ),
  pin: icon(
    '<path d="M12 21.4c3.9-4.1 6.8-7.5 6.8-10.8a6.8 6.8 0 1 0-13.6 0c0 3.3 2.9 6.7 6.8 10.8Z"/>' +
      '<circle cx="12" cy="10.2" r="2.6"/>'
  ),
  bell: icon(
    '<path d="M18 9.2a6 6 0 0 0-12 0c0 4.6-1.7 6.2-2.3 6.8a.7.7 0 0 0 .5 1.2h15.6a.7.7 0 0 0 .5-1.2c-.6-.6-2.3-2.2-2.3-6.8Z"/>' +
      '<path d="M10 20.1a2.2 2.2 0 0 0 4 0"/>'
  ),
  database: icon(
    '<ellipse cx="12" cy="6" rx="7.4" ry="3.2"/>' +
      '<path d="M4.6 6v12c0 1.8 3.3 3.2 7.4 3.2s7.4-1.4 7.4-3.2V6"/>' +
      '<path d="M4.6 12c0 1.8 3.3 3.2 7.4 3.2s7.4-1.4 7.4-3.2"/>'
  ),
  globe: icon(
    '<circle cx="12" cy="12" r="9.2"/>' +
      '<path d="M2.8 12h18.4"/>' +
      '<path d="M12 2.8c2.6 2.6 4 5.7 4 9.2s-1.4 6.6-4 9.2c-2.6-2.6-4-5.7-4-9.2s1.4-6.6 4-9.2Z"/>'
  ),
  link: icon(
    '<path d="M9.6 14.4a4.1 4.1 0 0 1 0-5.8l2.9-2.9a4.1 4.1 0 0 1 5.8 5.8l-1.4 1.4"/>' +
      '<path d="M14.4 9.6a4.1 4.1 0 0 1 0 5.8l-2.9 2.9a4.1 4.1 0 0 1-5.8-5.8l1.4-1.4"/>'
  ),

  // Rows
  camera: icon(
    '<rect x="2.6" y="6.6" width="18.8" height="13" rx="3.4"/>' +
      '<circle cx="12" cy="13.1" r="3.5"/>' +
      '<path d="M9 6.6 10.1 3.9h3.8l1.1 2.7"/>'
  ),
  microphone: icon(
    '<rect x="9" y="2.6" width="6" height="10.8" rx="3"/>' +
      '<path d="M5.6 11.4a6.4 6.4 0 0 0 12.8 0"/>' +
      '<path d="M12 17.8v3.6"/>'
  ),
  clipboard: icon(
    '<rect x="4.6" y="4.2" width="14.8" height="17.4" rx="3.4"/>' +
      '<path d="M9 4.2V3.1A1.3 1.3 0 0 1 10.3 1.8h3.4A1.3 1.3 0 0 1 15 3.1v1.1"/>' +
      '<path d="M8.6 11.4h6.8M8.6 15.4h4.6"/>'
  ),
  cookie: icon(
    '<path d="M12 2.6a9.4 9.4 0 1 0 9.4 9.4 4.3 4.3 0 0 1-5.2-5.2A4.6 4.6 0 0 1 12 2.6Z"/>' +
      '<circle cx="9" cy="9.6" r="1"/>' +
      '<circle cx="14.4" cy="14.4" r="1"/>' +
      '<circle cx="9.6" cy="15" r="1"/>'
  ),
  download: icon(
    '<path d="M12 3.4v11"/>' +
      '<path d="m7.8 10.3 4.2 4.2 4.2-4.2"/>' +
      '<path d="M4 20.2h16"/>'
  ),
  code: icon(
    '<path d="m9.2 8-4.4 4 4.4 4"/>' + '<path d="m14.8 8 4.4 4-4.4 4"/>'
  ),
  image: icon(
    '<rect x="3" y="4.6" width="18" height="14.8" rx="3.4"/>' +
      '<circle cx="8.6" cy="10" r="1.6"/>' +
      '<path d="M3.6 17.6 8 13.2a1.9 1.9 0 0 1 2.7 0l3.1 3.1"/>' +
      '<path d="m13.6 15.4 1.5-1.5a1.9 1.9 0 0 1 2.7 0l2.4 2.4"/>'
  ),
  volume: icon(
    '<path d="M11.6 4.4 7 8.2H3.6v7.6H7l4.6 3.8V4.4Z"/>' +
      '<path d="M15.8 9.2a4.2 4.2 0 0 1 0 5.6"/>' +
      '<path d="M18.6 6.4a8 8 0 0 1 0 11.2"/>'
  ),
  window: icon(
    '<rect x="3" y="4.6" width="18" height="14.8" rx="3.4"/>' +
      '<path d="M3 9.6h18"/>' +
      '<path d="M6.6 7.1h.01M9.6 7.1h.01"/>'
  ),

  // Fallbacks
  shield: icon(
    '<path d="M12 2.6 4.8 5.6v6c0 4.9 3 8.6 7.2 9.9 4.2-1.3 7.2-5 7.2-9.9v-6L12 2.6Z"/>' +
      '<path d="m8.8 11.9 2.3 2.3 4.3-4.6"/>'
  ),
  dot: icon('<circle cx="12" cy="12" r="3.4"/>'),
};

/** @type {Array<{id:string,title:string,icon:string,items:PermSpec[]}>} */
const CATEGORIES = [
  {
    id: 'hardware',
    title: 'Hardware',
    icon: 'chip',
    items: [
      {
        cs: 'camera',
        label: 'Camera',
        icon: 'camera',
        detail: 'Use your camera to capture video.',
      },
      {
        cs: 'microphone',
        label: 'Microphone',
        icon: 'microphone',
        detail: 'Use your microphone to capture audio.',
      },
    ],
  },
  {
    id: 'location',
    title: 'Location',
    icon: 'pin',
    items: [
      {
        cs: 'location',
        label: 'Geolocation',
        icon: 'pin',
        detail: 'Read your physical location.',
      },
    ],
  },
  {
    id: 'notifications',
    title: 'Notifications',
    icon: 'bell',
    items: [
      {
        cs: 'notifications',
        label: 'Notifications',
        icon: 'bell',
        detail: 'Show desktop notifications.',
      },
    ],
  },
  {
    id: 'data',
    title: 'Data & Clipboard',
    icon: 'database',
    items: [
      {
        cs: 'clipboard',
        label: 'Clipboard',
        icon: 'clipboard',
        detail: 'Use advanced clipboard capabilities (read, custom writes).',
      },
      {
        cs: 'cookies',
        label: 'Cookies & site data',
        icon: 'cookie',
        detail: 'Store cookies and other local data.',
      },
      {
        cs: 'automaticDownloads',
        label: 'Automatic downloads',
        icon: 'download',
        detail: 'Download multiple files without asking each time.',
      },
    ],
  },
  {
    id: 'host',
    title: 'Site Data / Host Access',
    icon: 'globe',
    items: [
      {
        cs: 'javascript',
        label: 'JavaScript',
        icon: 'code',
        detail: 'Run JavaScript on this site.',
      },
      {
        cs: 'images',
        label: 'Images',
        icon: 'image',
        detail: 'Load and display images.',
      },
      {
        cs: 'sound',
        label: 'Sound',
        icon: 'volume',
        detail: 'Play audio without being muted.',
      },
      {
        cs: 'popups',
        label: 'Pop-ups',
        icon: 'window',
        detail: 'Open new browser windows and tabs.',
      },
    ],
  },
];

/** Every chrome.contentSettings key the audit queries. */
const CONTENT_SETTING_KEYS = [
  ...new Set(CATEGORIES.flatMap((c) => c.items.map((i) => i.cs))),
];

/**
 * chrome.contentSettings.<type>.get() resolves to { setting } where `setting`
 * is one of the values allowed for that type ('allow' | 'block' | 'ask' |
 * 'session_only'). Map each onto display text + a CSS status class.
 */
const SETTING_LABELS = {
  allow: { text: 'Allowed', cls: 'ok' },
  block: { text: 'Blocked', cls: 'deny' },
  ask: { text: 'Ask (default)', cls: 'warn' },
  session_only: { text: 'Allowed (this session)', cls: 'warn' },
};

/** Settings that count as "permission granted" for the summary badge. */
const GRANTED_SETTINGS = new Set(['allow', 'session_only']);

/**
 * Chrome's built-in default for each content type (from the API schema).
 * "Resetting" a setting means writing the default back for this origin via
 * set(), because ContentSetting.clear() only clears ALL rules of a type -
 * it has no per-origin form. Types whose default is 'ask' return to the
 * "ask every time" behavior, which is what users expect from "Reset".
 */
const REVOCATION_DEFAULT = {
  camera: 'ask',
  microphone: 'ask',
  location: 'ask',
  notifications: 'ask',
  clipboard: 'ask',
  automaticDownloads: 'ask',
  cookies: 'allow',
  javascript: 'allow',
  images: 'allow',
  sound: 'allow',
  popups: 'block',
};

/* ==========================================================================
 * Small utilities
 * ========================================================================== */

/** Chrome APIs throw on bad input; wrap and return null instead. */
async function tryOrNull(promise) {
  try {
    return await promise;
  } catch {
    return null;
  }
}

/* ==========================================================================
 * Collapsible category state (chrome.storage.local)
 * ==========================================================================
 * Each category card can be collapsed; the collapsed/expanded map is kept
 * in chrome.storage.local so the popup reopens with the same layout.
 * Everything degrades to in-memory only if the API is unavailable.
 */

const COLLAPSE_KEY = 'collapsedCategories';

/** In-memory cache of { [categoryId]: boolean(collapsed) }. */
let collapsedState = {};

/** Load the collapsed map into the cache (best effort). */
async function loadCollapsedState() {
  try {
    const res = await chrome.storage?.local?.get?.(COLLAPSE_KEY);
    collapsedState = res?.[COLLAPSE_KEY] ?? {};
  } catch {
    collapsedState = {};
  }
}

/** Persist the collapsed map (best effort; fire-and-forget). */
function saveCollapsedState() {
  try {
    const p = chrome.storage?.local?.set?.({ [COLLAPSE_KEY]: collapsedState });
    p?.catch?.(() => {});
  } catch {
    /* storage unavailable - state stays in-memory only */
  }
}

/** Apply (or remove) the collapsed presentation of one card. */
function applyCollapsed(card, collapsed) {
  card.classList.toggle('card--collapsed', collapsed);
  card
    .querySelector('.card__head')
    ?.setAttribute('aria-expanded', String(!collapsed));
}

/**
 * Resolve one content setting. Getters accept a callback or return a promise
 * in MV3; awaiting covers both. A null result means "unknown" (API missing,
 * invalid URL, enterprise restriction) and is rendered as a neutral row.
 */
async function getSetting(ns, primaryUrl) {
  if (!ns?.get) return null;
  return tryOrNull(ns.get({ primaryUrl }));
}

/** Host pattern meaning "every http(s) site" for chrome.permissions. */
const ALL_URLS_PATTERN = '*://' + '*/*';

/** True for URLs we can meaningfully audit. */
function isAuditableUrl(url) {
  return /^(https?|file):/i.test(url ?? '');
}

/** Hostname (or path, for file:) formatted for display. */
function prettyUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'file:' ? u.pathname : u.host;
  } catch {
    return url;
  }
}

/**
 * Normalize a page URL into { origin, primaryUrl, pattern, faviconUrl }.
 * - For http(s): the origin identifies the site for settings, patterns and
 *   favicons; get() is called with the origin (it resolves patterns itself).
 * - For file: the scheme has no origin, so the full URL is the primary URL
 *   and the wildcard pattern 'file:///*' is used for revocation.
 */
function resolveTarget(rawUrl) {
  const url = new URL(rawUrl);
  if (url.protocol === 'file:') {
    return {
      origin: 'file://',
      primaryUrl: rawUrl,
      pattern: 'file:///*',
      faviconUrl: null,
    };
  }
  const origin = url.origin;
  return {
    origin,
    primaryUrl: origin,
    pattern: `${origin}/*`,
    faviconUrl: chrome.runtime.getURL(
      `_favicon/?pageUrl=${encodeURIComponent(origin)}&size=32`
    ),
  };
}

/* ==========================================================================
 * Active tab resolution (with retry for mid-navigation popups)
 * ========================================================================== */

/** Active tab of the last focused window. */
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  return tab ?? null;
}

/**
 * The user may click the toolbar icon while the tab is still navigating
 * (tab.url may be empty). Retry briefly before falling back.
 */
async function getActiveTabWithRetry(attempts = 3, delayMs = 150) {
  for (let i = 0; i < attempts; i++) {
    const tab = await getActiveTab();
    if (tab?.url) return tab;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return getActiveTab();
}

/* ==========================================================================
 * Auditors
 * ========================================================================== */

/**
 * Query every tracked content setting for one target.
 * @returns {Promise<Map<string, {setting: string} | null>>}
 */
async function auditContentSettings(primaryUrl) {
  const results = new Map();
  await Promise.all(
    CONTENT_SETTING_KEYS.map(async (key) => {
      const ns = chrome.contentSettings?.[key];
      results.set(key, await getSetting(ns, primaryUrl));
    })
  );
  return results;
}

/**
 * Which host permissions does this extension hold for the site?
 * - origins [pattern]      -> per-site or wildcard grant covers this site.
 * - a wildcard scheme/host pattern -> broad host access.
 * Under MV3, "allow on this site" toggles from chrome://extensions show up
 * here, so this reflects real content-script access. (This extension itself
 * declares no host permissions, so the card stays hidden in practice; the
 * logic is generic so the audit stays truthful if permissions change.)
 */
async function auditHostPermissions(pattern) {
  const [hasOrigin, hasAllUrls] = await Promise.all([
    tryOrNull(chrome.permissions.contains({ origins: [pattern] })),
    tryOrNull(chrome.permissions.contains({ origins: [ALL_URLS_PATTERN] })),
  ]);
  const hasAny = Boolean(hasOrigin);
  return { hasAny, allUrls: Boolean(hasAllUrls), originOnly: hasAny && !hasAllUrls };
}

/* ==========================================================================
 * Rendering
 * ========================================================================== */

const el = {
  siteName: document.getElementById('siteName'),
  searchBar: document.getElementById('searchBar'),
  search: document.getElementById('permSearch'),
  searchClear: document.getElementById('searchClear'),
  noResults: document.getElementById('noResults'),
  statStrip: document.getElementById('statStrip'),
  statGranted: document.getElementById('statGranted'),
  statBlocked: document.getElementById('statBlocked'),
  statDefault: document.getElementById('statDefault'),
  meter: document.getElementById('meter'),
  meterGranted: document.getElementById('meterGranted'),
  meterBlocked: document.getElementById('meterBlocked'),
  meterDefault: document.getElementById('meterDefault'),
  skeleton: document.getElementById('skeleton'),
  versionChip: document.getElementById('versionChip'),
  siteUrl: document.getElementById('siteUrl'),
  siteInitial: document.getElementById('siteInitial'),
  favicon: document.getElementById('favicon'),
  summaryBadge: document.getElementById('summaryBadge'),
  summaryText: document.getElementById('summaryText'),
  categories: document.getElementById('categories'),
  allClear: document.getElementById('allClear'),
  notAuditable: document.getElementById('notAuditable'),
  notAuditableReason: document.getElementById('notAuditableReason'),
  settingsLink: document.getElementById('chromeSettingsLink'),
  tplCategory: document.getElementById('tpl-category'),
  tplItem: document.getElementById('tpl-item'),
};

/* ==========================================================================
 * Site avatar
 * ==========================================================================
 * The favicon endpoint resolves asynchronously and may fail (no icon, cache
 * miss, unsupported scheme), so a letter tile sits underneath from the first
 * paint and only steps aside once a real image has decoded.
 */

/** Swap the avatar to the letter fallback for a hostname/label. */
function showInitial(label) {
  const letter = (label ?? '').match(/[a-z0-9]/i)?.[0];
  el.siteInitial.textContent = letter ? letter.toUpperCase() : '\u00b7';
  el.siteInitial.hidden = false;
  el.favicon.hidden = true;
}

/** Hide the letter tile once the favicon has painted. */
el.favicon.addEventListener('load', () => {
  // A hidden <img> still fires `load` with an empty src in some Chrome
  // builds; only trust a load that produced intrinsic dimensions.
  if (!el.favicon.naturalWidth) return;
  el.favicon.hidden = false;
  el.siteInitial.hidden = true;
});

el.favicon.addEventListener('error', () => {
  el.favicon.hidden = true;
  el.siteInitial.hidden = false;
});

/**
 * Build one permission row.
 * @param {HTMLElement} parent   List to append into.
 * @param {PermSpec} spec        What this row describes.
 * @param {string} setting       Effective setting value ('allow', ...).
 * @param {{pattern: string, origin: string}} target
 */
function renderPermItem(parent, spec, setting, target) {
  const node = el.tplItem.content.firstElementChild.cloneNode(true);
  const info = SETTING_LABELS[setting] ?? { text: 'Unknown', cls: 'neutral' };

  const glyph = node.querySelector('.perm__glyph');
  glyph.innerHTML = ICONS[spec.icon] ?? ICONS.dot;
  glyph.classList.add(`perm__glyph--${info.cls}`);

  node.querySelector('.perm__name').textContent = spec.label;
  const value = node.querySelector('.perm__value');
  value.textContent = info.text;
  value.classList.add(`perm__value--${info.cls}`);
  node.querySelector('.perm__detail').textContent = spec.detail;

  // Action controls: "Enable" writes allow, "Disable" writes block, and
  // "Reset" restores Chrome's default for the type. The button matching the
  // current state is highlighted (is-active + aria-pressed) so each row
  // doubles as a toggle, not just a status readout. For pseudo-keys like
  // __host__ the buttons drive chrome.permissions instead of contentSettings.
  const isHostRow = spec.cs === '__host__';
  const known = setting !== 'unknown';
  const granted = GRANTED_SETTINGS.has(setting);
  const blocked = setting === 'block';

  const allowBtn = node.querySelector('[data-action="allow"]');
  const blockBtn = node.querySelector('[data-action="block"]');
  const resetBtn = node.querySelector('[data-action="reset"]');

  allowBtn.setAttribute('aria-pressed', String(granted));
  blockBtn.setAttribute('aria-pressed', String(blocked));
  allowBtn.classList.toggle('is-active', granted);
  blockBtn.classList.toggle('is-active', blocked);

  if (isHostRow) {
    // This extension's own host access: Enable asks for the origin, Disable
    // removes it (both handled by applySetting via chrome.permissions).
    allowBtn.disabled = granted;
    blockBtn.disabled = !granted;
    blockBtn.classList.toggle('is-active', !granted);
    allowBtn.addEventListener('click', () =>
      applySetting(spec, target, 'allow', allowBtn)
    );
    blockBtn.addEventListener('click', () =>
      applySetting(spec, target, 'block', blockBtn)
    );
  } else {
    allowBtn.disabled = !known;
    blockBtn.disabled = !known;
    allowBtn.addEventListener('click', () =>
      applySetting(spec, target, 'allow', allowBtn)
    );
    blockBtn.addEventListener('click', () =>
      applySetting(spec, target, 'block', blockBtn)
    );

    // Reset is offered only when the row can move back to its default and is
    // not already there.
    const dflt = REVOCATION_DEFAULT[spec.cs];
    resetBtn.hidden =
      spec.revoke === false || dflt === undefined || !known || setting === dflt;
    resetBtn.addEventListener('click', () =>
      applySetting(spec, target, dflt, resetBtn)
    );
  }

  // Haystack for the live filter: label + effective value + description.
  node.dataset.search = [spec.label, info.text, spec.detail]
    .join(' ')
    .toLowerCase();

  parent.appendChild(node);
}

/**
 * Apply a new state to one permission row, then re-audit.
 *
 * `value` is a contentSettings setting ('allow' | 'block' | 'ask' |
 * 'session_only'); for the __host__ pseudo-key it means grant ('allow') or
 * remove ('block') this extension's own host permission.
 * ContentSetting.clear() is intentionally never used: it drops every rule of
 * a type for every site, whereas writing back a value is per-origin.
 */
async function applySetting(spec, target, value, button) {
  if (value === undefined) return;
  button.disabled = true;
  const label = button.textContent;
  button.textContent = 'Working…';

  const fail = (err) => {
    console.warn(`[auditor] ${spec.cs}=${value} failed`, err);
    button.textContent = 'Failed - retry';
    button.disabled = false;
  };

  // Pseudo-key: adjust this extension's own host permission for the origin.
  // chrome.permissions wants match patterns, not bare origins, and request()
  // must originate from this user gesture (the click that got us here).
  if (spec.cs === '__host__') {
    try {
      if (value === 'allow') {
        const ok = await chrome.permissions.request({
          origins: [target.pattern],
        });
        if (!ok) throw new Error('permission not granted');
      } else {
        await chrome.permissions.remove({ origins: [target.pattern] });
      }
    } catch (err) {
      fail(err);
      return;
    }
    runAudit();
    return;
  }

  const ns = chrome.contentSettings?.[spec.cs];
  if (!ns?.set) {
    button.textContent = label;
    button.disabled = false;
    return;
  }
  try {
    await ns.set({ primaryPattern: target.pattern, setting: value });
  } catch (err) {
    fail(err);
    return;
  }
  runAudit(); // re-query so the UI reflects the new effective settings
}

/**
 * Build one category card, skipping types with no resolvable data.
 * The header is a toggle button: it collapses/expands the card body and
 * the state is persisted per category id in chrome.storage.local.
 */
function renderCategory(cat, target, settings) {
  const items = cat.items.filter((item) => settings.get(item.cs) !== null);
  if (items.length === 0) return;

  const card = el.tplCategory.content.firstElementChild.cloneNode(true);
  card.dataset.cardId = cat.id;
  card.dataset.total = String(items.length);
  card.querySelector('.card__icon').innerHTML = ICONS[cat.icon] ?? ICONS.dot;
  card.querySelector('.card__title').textContent = cat.title;

  const head = card.querySelector('.card__head');
  const list = card.querySelector('.card__list');
  const listId = `card-list-${cat.id}`;
  list.id = listId;
  head.setAttribute('aria-controls', listId);
  card.querySelector('.card__count').textContent = String(items.length);

  // Restore the saved collapsed state, then persist every toggle.
  applyCollapsed(card, Boolean(collapsedState[cat.id]));
  head.addEventListener('click', () => {
    const collapsed = !card.classList.contains('card--collapsed');
    applyCollapsed(card, collapsed);
    collapsedState[cat.id] = collapsed;
    saveCollapsedState();
  });

  for (const spec of items) {
    const setting = settings.get(spec.cs)?.setting ?? 'unknown';
    renderPermItem(list, spec, setting, target);
  }

  // Prefix each row's haystack with its category title so the filter can
  // match words like "hardware" or "clipboard" as well as row labels.
  for (const row of list.children) {
    row.dataset.search = `${cat.title} ${row.dataset.search}`.toLowerCase();
  }

  el.categories.appendChild(card);
}

/**
 * Bucket every audited setting into the three header tallies:
 * granted (allow / session_only), blocked, and default (ask / everything
 * else that resolved). Unknown rows are ignored so the tally stays honest.
 */
function tallySettings(settings, hostInfo) {
  let granted = 0;
  let blocked = 0;
  let dflt = 0;
  for (const entry of settings.values()) {
    const s = entry?.setting;
    if (!s || s === 'unknown') continue;
    if (GRANTED_SETTINGS.has(s)) granted++;
    else if (s === 'block') blocked++;
    else dflt++;
  }
  if (hostInfo.hasAny) granted++;
  return { granted, blocked, dflt };
}

/**
 * Paint the at-a-glance tally and its proportional meter.
 *
 * Each meter segment is a flex item whose grow factor is the raw count, so
 * the bar stays correct for any total without percentage math. Segments with
 * a zero count are hidden outright, which also removes their flex gap.
 */
function renderStats({ granted, blocked, dflt }) {
  const total = granted + blocked + dflt;
  el.statGranted.textContent = String(granted);
  el.statBlocked.textContent = String(blocked);
  el.statDefault.textContent = String(dflt);
  el.statStrip.hidden = total === 0;
  el.meter.hidden = total === 0;

  const segments = [
    [el.meterGranted, granted],
    [el.meterBlocked, blocked],
    [el.meterDefault, dflt],
  ];
  for (const [node, count] of segments) {
    node.style.flexGrow = String(count);
    node.hidden = count === 0;
  }
}

/**
 * Header badge + summary line once anything notable was found.
 */
function summarize(settings, hostInfo) {
  const { granted } = tallySettings(settings, hostInfo);

  const badge = el.summaryBadge;
  if (granted > 0) {
    badge.textContent = `${granted} granted`;
    badge.className = 'badge badge--ok';
  } else {
    badge.textContent = 'Restricted';
    badge.className = 'badge badge--deny';
  }
  badge.hidden = false;

  el.summaryText.textContent =
    granted > 0
      ? 'This site has permissions beyond the browser default. Review them below.'
      : 'No special access granted; some capabilities are blocked on this site.';
}

/* ==========================================================================
 * Live filter (popup-local; the query itself is never persisted)
 * ==========================================================================
 * Filtering is pure DOM work: rows that do not match get the hidden
 * attribute, cards whose rows all fail are hidden, and matching cards are
 * shown expanded for the duration of the search (their saved collapse state
 * is restored as soon as the query is cleared).
 */

/** Current query, normalized to lowercase/trimmed. */
let filterQuery = '';

/** Normalize user input for case-insensitive substring matching. */
function normalizeQuery(value) {
  return (value ?? '').trim().toLowerCase();
}

/**
 * Apply the current query to every rendered card.
 * @returns {{visibleCards: number, matches: number}}
 */
function applyFilter(rawQuery) {
  filterQuery = normalizeQuery(rawQuery);
  const searching = filterQuery.length > 0;
  let visibleCards = 0;
  let matches = 0;

  for (const card of el.categories.querySelectorAll('.card')) {
    const total = Number(card.dataset.total ?? 0);
    let cardMatches = 0;

    for (const row of card.querySelectorAll('.perm')) {
      const hit = !searching || row.dataset.search.includes(filterQuery);
      row.hidden = !hit;
      if (hit) cardMatches++;
    }

    card.hidden = cardMatches === 0;
    if (cardMatches > 0) visibleCards++;
    matches += cardMatches;

    // Searching temporarily expands hits; clearing restores the saved state.
    const collapsed = searching
      ? false
      : Boolean(collapsedState[card.dataset.cardId]);
    applyCollapsed(card, collapsed);

    const count = card.querySelector('.card__count');
    if (count) {
      count.textContent = searching
        ? `${cardMatches}/${total}`
        : String(total);
    }
  }

  el.searchClear.hidden = !searching;
  const nothingFound = searching && visibleCards === 0;
  el.noResults.hidden = !nothingFound;
  if (nothingFound) {
    el.noResults.textContent = `No permissions match \u201c${rawQuery.trim()}\u201d.`;
  }

  return { visibleCards, matches };
}

/* ==========================================================================
 * Main audit flow
 * ========================================================================== */

async function runAudit() {
  // 1. Reset the UI to a clean loading state.
  el.categories.replaceChildren();
  el.allClear.hidden = true;
  el.notAuditable.hidden = true;
  el.summaryBadge.hidden = true;
  el.summaryText.textContent = '';
  el.searchBar.hidden = true;
  el.noResults.hidden = true;
  el.statStrip.hidden = true;
  el.meter.hidden = true;
  el.siteName.textContent = 'Loading…';
  el.siteUrl.hidden = true;
  // Empty avatar tile while loading (the letter lands with the target).
  el.favicon.hidden = true;
  el.siteInitial.hidden = false;
  el.siteInitial.textContent = '';

  // 2. API sanity check (guards against future Chrome changes / side-loads).
  if (!chrome.contentSettings) {
    renderFatal(
      new Error(
        'chrome.contentSettings is unavailable in this browser. ' +
          'The auditor requires a Chromium-based browser.'
      )
    );
    return;
  }

  // 2.5 Restore saved UI state (collapsed category cards) before rendering.
  await loadCollapsedState();

  // 3. Resolve the active tab.
  let tab;
  try {
    tab = await getActiveTabWithRetry();
  } catch (err) {
    renderFatal(err);
    return;
  }
  const url = tab?.url ?? '';

  // 4. Edge cases: chrome://, edge://, extension pages, new tab, devtools…
  if (!isAuditableUrl(url)) {
    const isExtensionPage = /^(chrome-extension|about|devtools|view-source):/i.test(
      url
    );
    el.siteName.textContent = isExtensionPage
      ? 'Extension or browser page'
      : prettyUrl(url) || 'Browser page';
    el.notAuditableReason.textContent = isExtensionPage
      ? 'This tab is an extension or browser page, so it has no per-site permissions to audit.'
      : 'This tab is not a regular website, so it has no per-site permissions to audit.';
    showInitial(el.siteName.textContent);
    el.skeleton.hidden = true;
    el.notAuditable.hidden = false;
    return;
  }

  // 5. Web (or file) page: normalize the target and audit it.
  let target;
  try {
    target = resolveTarget(url);
  } catch (err) {
    renderFatal(err);
    return;
  }

  el.siteName.textContent = prettyUrl(url);
  el.siteUrl.textContent = target.origin;
  el.siteUrl.hidden = false;
  showInitial(prettyUrl(url));

  if (target.faviconUrl) {
    // Local lookup via the favicon API - no third-party request. The letter
    // tile covers the gap until the image decodes (and forever if it fails).
    el.favicon.src = target.faviconUrl;
    // Re-auditing the same origin reuses the cached image, which fires no
    // new `load` event - so adopt an already-resolved favicon directly.
    if (el.favicon.complete && el.favicon.naturalWidth > 0) {
      el.favicon.hidden = false;
      el.siteInitial.hidden = true;
    }
  }

  // Deep link into Chrome's per-site settings page for this origin.
  el.settingsLink.dataset.url =
    target.origin === 'file://'
      ? 'chrome://settings/content/siteDetails?site=file://'
      : `chrome://settings/content/siteDetails?site=${encodeURIComponent(target.origin)}`;

  // 6. Run both audits in parallel.
  const [settings, hostInfo] = await Promise.all([
    auditContentSettings(target.primaryUrl),
    auditHostPermissions(target.pattern),
  ]);

  // 6.5 First real paint: the skeleton has done its job.
  el.skeleton.hidden = true;

  // 7. Extension host access card (only when a grant actually exists).
  if (hostInfo.hasAny) {
    renderCategory(
      {
        id: 'ext',
        title: 'Extension Host Access',
        icon: 'link',
        items: [
          {
            cs: '__host__',
            label: 'This extension on this site',
            icon: 'link',
            detail: hostInfo.allUrls
              ? 'This extension has broad host access (declared in its manifest).'
              : 'This extension may access this site (granted via chrome://extensions).',
          },
        ],
      },
      target,
      new Map([['__host__', { setting: 'allow' }]])
    );
  }

  // 8. Render the data categories.
  for (const cat of CATEGORIES) renderCategory(cat, target, settings);

  // 9. Header tally + summary: friendly "all clear" unless something
  //    notable was found (the tally is shown either way).
  renderStats(tallySettings(settings, hostInfo));

  const anyGranted = [...settings.values()].some(
    (e) => e?.setting && GRANTED_SETTINGS.has(e.setting)
  );
  const anyRestricted = [...settings.values()].some(
    (e) => e?.setting === 'block'
  );
  if (!anyGranted && !anyRestricted && !hostInfo.hasAny) {
    el.allClear.hidden = false; // friendly hero; category cards stay below
  } else {
    summarize(settings, hostInfo);
  }

  // 10. Show the filter bar only when there is something to filter, then
  //     re-apply whatever is in the box (a revoke re-renders every row).
  el.searchBar.hidden = el.categories.querySelector('.card') === null;
  applyFilter(el.search.value);
}

/** Surface an unexpected failure in-band instead of a blank popup. */
function renderFatal(err) {
  el.skeleton.hidden = true;
  el.siteName.textContent = 'Unable to audit';
  const banner = document.createElement('div');
  banner.className = 'error-banner';
  banner.textContent = err?.message ?? String(err);
  el.categories.appendChild(banner);
}

/* Footer: show the running extension version, when available. */
const version = chrome.runtime?.getManifest?.()?.version;
if (version) {
  el.versionChip.textContent = `v${version}`;
  el.versionChip.hidden = false;
}

/* Header gets a shadow once content scrolls underneath it. */
function syncScrollShadow() {
  document.body.classList.toggle('is-scrolled', window.scrollY > 2);
}
window.addEventListener('scroll', syncScrollShadow, { passive: true });
syncScrollShadow();

/* Filter bar: live filtering as the user types (Esc clears natively too). */
el.search.addEventListener('input', () => applyFilter(el.search.value));
el.search.addEventListener('search', () => applyFilter(el.search.value));
el.search.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && el.search.value) {
    el.search.value = '';
    applyFilter('');
  }
});
el.searchClear.addEventListener('click', () => {
  el.search.value = '';
  applyFilter('');
  el.search.focus();
});

/* Footer link: open Chrome's site settings in a new tab. */
el.settingsLink.addEventListener('click', (e) => {
  e.preventDefault();
  const url = el.settingsLink.dataset.url;
  if (url) chrome.tabs.create({ url });
});

runAudit();
