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
 * @property {string}  icon      Emoji shown in the row glyph.
 * @property {string}  detail    What the setting covers.
 * @property {boolean} [revoke]  Show a revoke/reset action (default true).
 */

/** @type {Array<{id:string,title:string,icon:string,items:PermSpec[]}>} */
const CATEGORIES = [
  {
    id: 'hardware',
    title: 'Hardware',
    icon: '🎥',
    items: [
      {
        cs: 'camera',
        label: 'Camera',
        icon: '📷',
        detail: 'Use your camera to capture video.',
      },
      {
        cs: 'microphone',
        label: 'Microphone',
        icon: '🎤',
        detail: 'Use your microphone to capture audio.',
      },
    ],
  },
  {
    id: 'location',
    title: 'Location',
    icon: '📍',
    items: [
      {
        cs: 'location',
        label: 'Geolocation',
        icon: '🧭',
        detail: 'Read your physical location.',
      },
    ],
  },
  {
    id: 'notifications',
    title: 'Notifications',
    icon: '🔔',
    items: [
      {
        cs: 'notifications',
        label: 'Notifications',
        icon: '🔔',
        detail: 'Show desktop notifications.',
      },
    ],
  },
  {
    id: 'data',
    title: 'Data & Clipboard',
    icon: '🍪',
    items: [
      {
        cs: 'clipboard',
        label: 'Clipboard',
        icon: '📋',
        detail: 'Use advanced clipboard capabilities (read, custom writes).',
      },
      {
        cs: 'cookies',
        label: 'Cookies & site data',
        icon: '🍪',
        detail: 'Store cookies and other local data.',
      },
      {
        cs: 'automaticDownloads',
        label: 'Automatic downloads',
        icon: '⬇️',
        detail: 'Download multiple files without asking each time.',
      },
    ],
  },
  {
    id: 'host',
    title: 'Site Data / Host Access',
    icon: '🌐',
    items: [
      {
        cs: 'javascript',
        label: 'JavaScript',
        icon: '⚙️',
        detail: 'Run JavaScript on this site.',
      },
      {
        cs: 'images',
        label: 'Images',
        icon: '🖼️',
        detail: 'Load and display images.',
      },
      {
        cs: 'sound',
        label: 'Sound',
        icon: '🔊',
        detail: 'Play audio without being muted.',
      },
      {
        cs: 'popups',
        label: 'Pop-ups',
        icon: '🪟',
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
 * "Revoking" a setting means writing the default back for this origin via
 * set(), because ContentSetting.clear() only clears ALL rules of a type -
 * it has no per-origin form. Types whose default is 'ask' return to the
 * "ask every time" behavior, which is what users expect from "Revoke".
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
  siteUrl: document.getElementById('siteUrl'),
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
  glyph.textContent = spec.icon;
  glyph.classList.add(`perm__glyph--${info.cls}`);

  node.querySelector('.perm__name').textContent = spec.label;
  const value = node.querySelector('.perm__value');
  value.textContent = info.text;
  value.classList.add(`perm__value--${info.cls}`);
  node.querySelector('.perm__detail').textContent = spec.detail;

  // Action button: only when the current setting differs from Chrome's
  // default for that type (otherwise there is nothing to revoke) and the
  // spec allows it. For pseudo-keys like __host__ the button is wired to
  // chrome.permissions instead of contentSettings.
  const revokeTo = REVOCATION_DEFAULT[spec.cs];
  const differsFromDefault =
    revokeTo !== undefined && setting !== revokeTo && setting !== 'unknown';
  const isHostRow = spec.cs === '__host__';
  const revokeBtn = node.querySelector('.perm__revoke');
  if (isHostRow) {
    // Host access is revoked via chrome.permissions.remove (see resetSetting).
    revokeBtn.hidden = false;
    revokeBtn.textContent = 'Remove access';
    revokeBtn.addEventListener('click', () =>
      resetSetting(spec, target, revokeBtn)
    );
  } else if (spec.revoke !== false && differsFromDefault) {
    revokeBtn.hidden = false;
    revokeBtn.textContent = GRANTED_SETTINGS.has(setting)
      ? 'Revoke'
      : 'Reset to default';
    revokeBtn.addEventListener('click', () =>
      resetSetting(spec, target, revokeBtn)
    );
  }

  parent.appendChild(node);
}

/**
 * Write Chrome's default setting for this type back onto the origin, which
 * is the per-origin equivalent of "revoke". ContentSetting.clear() cannot be
 * used because it drops every rule of that type for every site.
 */
async function resetSetting(spec, target, button) {
  button.disabled = true;
  button.textContent = 'Working…';

  // Pseudo-key: adjust this extension's own host permission for the origin.
  // chrome.permissions wants match patterns, not bare origins.
  if (spec.cs === '__host__') {
    try {
      await chrome.permissions.remove({ origins: [target.pattern] });
    } catch (err) {
      console.warn('[auditor] permissions.remove failed', err);
      button.textContent = 'Failed - retry';
      button.disabled = false;
      return;
    }
    runAudit();
    return;
  }

  const ns = chrome.contentSettings?.[spec.cs];
  if (!ns?.set || REVOCATION_DEFAULT[spec.cs] === undefined) {
    button.hidden = true;
    return;
  }
  try {
    await ns.set({
      primaryPattern: target.pattern,
      setting: REVOCATION_DEFAULT[spec.cs],
    });
  } catch (err) {
    console.warn(`[auditor] set(${spec.cs}) failed`, err);
    button.textContent = 'Failed - retry';
    button.disabled = false;
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
  card.querySelector('.card__icon').textContent = cat.icon;
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
  el.categories.appendChild(card);
}

/**
 * Header badge + summary line once anything notable was found.
 */
function summarize(settings, hostInfo) {
  let granted = 0;
  let restricted = 0;
  for (const entry of settings.values()) {
    const s = entry?.setting;
    if (!s) continue;
    if (GRANTED_SETTINGS.has(s)) granted++;
    else if (s === 'block') restricted++;
  }
  if (hostInfo.hasAny) granted++;

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
 * Main audit flow
 * ========================================================================== */

async function runAudit() {
  // 1. Reset the UI to a clean loading state.
  el.categories.replaceChildren();
  el.allClear.hidden = true;
  el.notAuditable.hidden = true;
  el.summaryBadge.hidden = true;
  el.summaryText.textContent = '';
  el.siteName.textContent = 'Loading…';
  el.siteUrl.hidden = true;
  el.favicon.hidden = true;

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

  if (target.faviconUrl) {
    // Local lookup via the favicon API - no third-party request.
    el.favicon.src = target.faviconUrl;
    el.favicon.hidden = false;
    el.favicon.onerror = () => {
      el.favicon.hidden = true;
    };
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

  // 7. Extension host access card (only when a grant actually exists).
  if (hostInfo.hasAny) {
    renderCategory(
      {
        id: 'ext',
        title: 'Extension Host Access',
        icon: '🧩',
        items: [
          {
            cs: '__host__',
            label: 'This extension on this site',
            icon: '🧩',
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

  // 9. Summary: friendly "all clear" unless something notable was found.
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
}

/** Surface an unexpected failure in-band instead of a blank popup. */
function renderFatal(err) {
  el.siteName.textContent = 'Unable to audit';
  const banner = document.createElement('div');
  banner.className = 'error-banner';
  banner.textContent = err?.message ?? String(err);
  el.categories.appendChild(banner);
}

/* Footer link: open Chrome's site settings in a new tab. */
el.settingsLink.addEventListener('click', (e) => {
  e.preventDefault();
  const url = el.settingsLink.dataset.url;
  if (url) chrome.tabs.create({ url });
});

runAudit();
