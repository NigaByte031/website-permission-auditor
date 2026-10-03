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
 * Localization (chrome.i18n)
 * ==========================================================================
 * Every user-visible string lives in _locales/<lang>/messages.json and is
 * resolved through chrome.i18n.getMessage(), so the popup follows the
 * browser's UI language (English is the default locale; Persian and Arabic
 * are shipped alongside it).
 *
 *   t(key, subs)       localized text ($1..$9 substitutions supported)
 *   num(value)         a count rendered in the locale's own numerals
 *   localizeDom(root)  fills the declarative data-i18n* slots in the markup
 *
 * Messages that would need plural forms ship as a one/many pair of keys
 * (previewApplyOne / previewApplyMany, ...) because the popup picks between
 * them - English, Persian and Arabic do not agree on when a singular exists.
 */

/** Language Chrome resolved for the extension UI (e.g. "fa", "en-US"). */
const UI_LANG = (() => {
  try {
    return chrome.i18n?.getUILanguage?.() || 'en';
  } catch {
    return 'en';
  }
})();

/** Lower-cased primary subtag ("fa", "en") - drives script-level choices. */
const UI_LANG_BASE = UI_LANG.toLowerCase().split('-')[0];

/** Languages written right to left; these flip the whole popup layout. */
const RTL_LANGS = new Set(['ar', 'ckb', 'dv', 'fa', 'he', 'ps', 'ur', 'yi']);

/** True when the UI must be laid out right to left (Persian, Arabic, ...). */
const IS_RTL = RTL_LANGS.has(UI_LANG_BASE);

/**
 * Fetch one localized message. `subs` may be a string or an array of strings
 * matching the $1..$9 slots in the message. An unknown key returns the key
 * itself so a typo stays visible instead of blanking the interface.
 *
 * @param {string} key
 * @param {string|string[]} [subs]
 * @returns {string}
 */
function t(key, subs) {
  try {
    const msg =
      subs === undefined
        ? chrome.i18n.getMessage(key)
        : chrome.i18n.getMessage(key, subs);
    if (msg) return msg;
  } catch {
    /* chrome.i18n unavailable - fall back to the key */
  }
  return key;
}

/** Persian digits, indexed by their Western value. */
const FA_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];

/** Arabic-Indic digits, indexed by their Western value. */
const AR_DIGITS = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];

/**
 * Format a count using the numerals of the current locale (Persian reads
 * ۰۱۲۳, Arabic reads ٠١٢٣, every other shipped locale reads 0123).
 *
 * @param {number|string} value
 * @returns {string}
 */
function num(value) {
  const text = String(value);
  const digits = UI_LANG_BASE === 'fa' ? FA_DIGITS : UI_LANG_BASE === 'ar' ? AR_DIGITS : null;
  return digits ? text.replace(/[0-9]/g, (d) => digits[Number(d)]) : text;
}

/**
 * Fill every declarative translation slot under `root`:
 *   data-i18n              -> textContent
 *   data-i18n-title        -> title
 *   data-i18n-placeholder  -> placeholder
 *   data-i18n-aria         -> aria-label
 * `<template>` markup lives in a separate fragment, so those are localized
 * by passing template.content.
 *
 * @param {Document|DocumentFragment} [root]
 */
function localizeDom(root) {
  const scope = root ?? document;
  for (const node of scope.querySelectorAll('[data-i18n]')) {
    node.textContent = t(node.dataset.i18n);
  }
  for (const node of scope.querySelectorAll('[data-i18n-title]')) {
    node.title = t(node.dataset.i18nTitle);
  }
  for (const node of scope.querySelectorAll('[data-i18n-placeholder]')) {
    node.placeholder = t(node.dataset.i18nPlaceholder);
  }
  for (const node of scope.querySelectorAll('[data-i18n-aria]')) {
    node.setAttribute('aria-label', t(node.dataset.i18nAria));
  }
}

/* Stamp the document language/direction before the first paint, then fill
   the static markup and every <template> that rows are cloned from. */
document.documentElement.lang = UI_LANG;
if (IS_RTL) document.documentElement.dir = 'rtl';
localizeDom(document);
for (const tpl of document.querySelectorAll('template')) localizeDom(tpl.content);

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
  sliders: icon(
    '<path d="M3.6 7.2h9.4M18.4 7.2h2"/>' +
      '<path d="M3.6 16.8h2M11 16.8h9.4"/>' +
      '<circle cx="15.6" cy="7.2" r="2.4"/>' +
      '<circle cx="8.2" cy="16.8" r="2.4"/>'
  ),
  plus: icon('<path d="M12 5.4v13.2M5.4 12h13.2"/>'),

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
    title: t('catHardware'),
    icon: 'chip',
    items: [
      {
        cs: 'camera',
        label: t('permCamera'),
        icon: 'camera',
        detail: t('permCameraDetail'),
      },
      {
        cs: 'microphone',
        label: t('permMicrophone'),
        icon: 'microphone',
        detail: t('permMicrophoneDetail'),
      },
    ],
  },
  {
    id: 'location',
    title: t('catLocation'),
    icon: 'pin',
    items: [
      {
        cs: 'location',
        label: t('permGeolocation'),
        icon: 'pin',
        detail: t('permGeolocationDetail'),
      },
    ],
  },
  {
    id: 'notifications',
    title: t('catNotifications'),
    icon: 'bell',
    items: [
      {
        cs: 'notifications',
        label: t('permNotifications'),
        icon: 'bell',
        detail: t('permNotificationsDetail'),
      },
    ],
  },
  {
    id: 'data',
    title: t('catData'),
    icon: 'database',
    items: [
      {
        cs: 'clipboard',
        label: t('permClipboard'),
        icon: 'clipboard',
        detail: t('permClipboardDetail'),
      },
      {
        cs: 'cookies',
        label: t('permCookies'),
        icon: 'cookie',
        detail: t('permCookiesDetail'),
      },
      {
        cs: 'automaticDownloads',
        label: t('permDownloads'),
        icon: 'download',
        detail: t('permDownloadsDetail'),
      },
    ],
  },
  {
    id: 'host',
    title: t('catHost'),
    icon: 'globe',
    items: [
      {
        cs: 'javascript',
        label: t('permJavascript'),
        icon: 'code',
        detail: t('permJavascriptDetail'),
      },
      {
        cs: 'images',
        label: t('permImages'),
        icon: 'image',
        detail: t('permImagesDetail'),
      },
      {
        cs: 'sound',
        label: t('permSound'),
        icon: 'volume',
        detail: t('permSoundDetail'),
      },
      {
        cs: 'popups',
        label: t('permPopups'),
        icon: 'window',
        detail: t('permPopupsDetail'),
      },
    ],
  },
];

/** Every chrome.contentSettings key the audit queries. */
const CONTENT_SETTING_KEYS = [
  ...new Set(CATEGORIES.flatMap((c) => c.items.map((i) => i.cs))),
];

/** Lookup a row spec by its content-setting key (for labels/icons). */
const SPEC_BY_CS = new Map(
  CATEGORIES.flatMap((c) => c.items.map((i) => [i.cs, i]))
);

/**
 * chrome.contentSettings.<type>.get() resolves to { setting } where `setting`
 * is one of the values allowed for that type ('allow' | 'block' | 'ask' |
 * 'session_only'). Map each onto display text + a CSS status class.
 */
const SETTING_LABELS = {
  allow: { text: t('statusAllowed'), cls: 'ok' },
  block: { text: t('statusBlocked'), cls: 'deny' },
  ask: { text: t('statusAsk'), cls: 'warn' },
  session_only: { text: t('statusSession'), cls: 'warn' },
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

/*
 * One-click permission profiles.
 *
 * A preset decides a target value for the audited content settings:
 *   - `values[cs]` wins for any key it names.
 *   - `resetOthers: true` sends every other audited key back to its browser
 *     default (REVOCATION_DEFAULT), which is what makes "Balanced" a full
 *     undo of past grants rather than a partial one.
 *   - Keys with no decision are left exactly as they are.
 * The whole batch is recorded on the undo stack as one entry.
 *
 * @typedef {Object} Preset
 * @property {string}  id           Stable id (drives button styling).
 * @property {string}  label        Button text.
 * @property {string}  icon         Key into ICONS for the button glyph.
 * @property {string}  hint         Tooltip describing the profile.
 * @property {Object}  [values]     cs -> setting overrides.
 * @property {boolean} [resetOthers] Reset unnamed keys to their default.
 */

/** @type {Preset[]} */
const PRESETS = [
  {
    id: 'lockdown',
    label: t('presetLockdown'),
    icon: 'shield',
    hint: t('presetLockdownHint'),
    values: {
      camera: 'block',
      microphone: 'block',
      location: 'block',
      notifications: 'block',
      clipboard: 'block',
      automaticDownloads: 'block',
    },
  },
  {
    id: 'balanced',
    label: t('presetBalanced'),
    icon: 'sliders',
    hint: t('presetBalancedHint'),
    values: {},
    resetOthers: true,
  },
  {
    id: 'camera',
    label: t('presetAllowCamera'),
    icon: 'camera',
    hint: t('presetAllowCameraHint'),
    values: { camera: 'allow' },
    resetOthers: true,
  },
];

/* ==========================================================================
 * Custom presets (user-defined profiles, persisted)
 * ==========================================================================
 * Users build their own profile in the editor and it is stored in
 * chrome.storage.local, then rendered in the toolbar next to the built-ins.
 * Custom presets flow through the exact same preview + single-batch-undo path
 * as the built-in ones - they simply carry their own `values` map.
 */

const CUSTOM_PRESETS_KEY = 'customPresets';

/** @type {Preset[]} User-defined profiles, oldest first. */
let customPresets = [];

/**
 * Accept only well-formed stored entries (defends against hand-edited or
 * partially-written storage) and rebuild the runtime shape.
 */
function normalizeCustomPreset(entry) {
  if (!entry || typeof entry.label !== 'string' || typeof entry.values !== 'object') {
    return null;
  }
  const values = {};
  for (const [cs, val] of Object.entries(entry.values ?? {})) {
    if (typeof val === 'string' && SETTING_LABELS[val]) values[cs] = val;
  }
  const label =
    entry.label.slice(0, 24).trim() || t('customPresetDefault');
  return {
    id: typeof entry.id === 'string' && entry.id ? entry.id : `custom:${Date.now().toString(36)}`,
    label,
    icon: 'sliders',
    custom: true,
    hint: t('customPresetHint', label),
    values,
  };
}

/** Load the saved custom presets (best effort). */
async function loadCustomPresets() {
  try {
    const res = await chrome.storage?.local?.get?.(CUSTOM_PRESETS_KEY);
    const list = res?.[CUSTOM_PRESETS_KEY];
    customPresets = Array.isArray(list)
      ? list.map(normalizeCustomPreset).filter(Boolean)
      : [];
  } catch {
    customPresets = [];
  }
}

/** Persist the custom presets as plain data (best effort; fire-and-forget). */
function saveCustomPresets() {
  try {
    const stored = customPresets.map(({ id, label, values }) => ({
      id,
      label,
      values,
    }));
    const p = chrome.storage?.local?.set?.({ [CUSTOM_PRESETS_KEY]: stored });
    p?.catch?.(() => {});
  } catch {
    /* storage unavailable - custom presets last for this session only */
  }
}

/** Built-in profiles followed by the user's own. */
function allPresets() {
  return [...PRESETS, ...customPresets];
}

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

/* ==========================================================================
 * Theme preference (System / Light / Dark)
 * ==========================================================================
 * The palette follows the OS by default. The user can override it from the
 * header toggle, and the choice is persisted in chrome.storage.local so the
 * popup reopens the same way. There is no prefers-color-scheme media query in
 * the CSS: this code resolves the preference (including the OS, via
 * matchMedia) to a concrete light/dark value and stamps it on <html> as
 * data-theme, which is what the stylesheet keys its dark palette off.
 */

const THEME_KEY = 'themePreference';
const THEME_VALUES = ['system', 'light', 'dark'];

/** Live OS dark-mode query; also tells us when to repaint "system". */
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

/** The user's stored choice ('system' | 'light' | 'dark'). */
let themePreference = 'system';

/**
 * Resolve the preference to a concrete theme and paint it. "system" defers to
 * the OS; the explicit values win regardless of the OS.
 */
function applyTheme() {
  const resolved =
    themePreference === 'system'
      ? darkQuery.matches
        ? 'dark'
        : 'light'
      : themePreference;
  document.documentElement.dataset.theme = resolved;

  for (const btn of el.themeToggle.querySelectorAll('[data-theme-value]')) {
    const active = btn.dataset.themeValue === themePreference;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', String(active));
  }
}

/** Restore the saved preference (best effort; falls back to "system"). */
async function loadTheme() {
  let saved = 'system';
  try {
    const res = await chrome.storage?.local?.get?.(THEME_KEY);
    saved = res?.[THEME_KEY] ?? 'system';
  } catch {
    /* storage unavailable - stay on system */
  }
  themePreference = THEME_VALUES.includes(saved) ? saved : 'system';
  applyTheme();
}

/** Persist the current preference (best effort; fire-and-forget). */
function saveTheme() {
  try {
    const p = chrome.storage?.local?.set?.({ [THEME_KEY]: themePreference });
    p?.catch?.(() => {});
  } catch {
    /* storage unavailable - the choice still applies for this session */
  }
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
  actionsBar: document.getElementById('actionsBar'),
  undoBar: document.getElementById('undoBar'),
  undoText: document.getElementById('undoText'),
  undoBtn: document.getElementById('undoBtn'),
  resetSiteBtn: document.getElementById('resetSiteBtn'),
  presets: document.getElementById('presets'),
  presetsRow: document.getElementById('presetsRow'),
  presetExportBtn: document.getElementById('presetExportBtn'),
  presetImportBtn: document.getElementById('presetImportBtn'),
  presetImportInput: document.getElementById('presetImportInput'),
  presetIOText: document.getElementById('presetIOText'),
  presetImportReview: document.getElementById('presetImportReview'),
  presetImportReviewText: document.getElementById('presetImportReviewText'),
  presetImportReviewList: document.getElementById('presetImportReviewList'),
  presetImportReplaceBtn: document.getElementById('presetImportReplaceBtn'),
  presetImportSkipBtn: document.getElementById('presetImportSkipBtn'),
  presetImportCancelBtn: document.getElementById('presetImportCancelBtn'),
  presetPreview: document.getElementById('presetPreview'),
  presetEditor: document.getElementById('presetEditor'),
  presetName: document.getElementById('presetName'),
  presetEditorList: document.getElementById('presetEditorList'),
  presetSaveBtn: document.getElementById('presetSaveBtn'),
  presetCancelBtn: document.getElementById('presetCancelBtn'),
  versionChip: document.getElementById('versionChip'),
  siteUrl: document.getElementById('siteUrl'),
  siteInitial: document.getElementById('siteInitial'),
  favicon: document.getElementById('favicon'),
  summaryBadge: document.getElementById('summaryBadge'),
  summaryText: document.getElementById('summaryText'),
  themeToggle: document.getElementById('themeToggle'),
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
  const info = SETTING_LABELS[setting] ?? {
    text: t('statusUnknown'),
    cls: 'neutral',
  };

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

  // The value this row currently holds, captured as the "from" half of the
  // undo entry so every action can be reversed to exactly where it started.
  const currentValue = isHostRow ? (granted ? 'allow' : 'block') : setting;

  if (isHostRow) {
    // This extension's own host access: Enable asks for the origin, Disable
    // removes it (both handled by applySetting via chrome.permissions).
    allowBtn.disabled = granted;
    blockBtn.disabled = !granted;
    blockBtn.classList.toggle('is-active', !granted);
    allowBtn.addEventListener('click', () =>
      changeSetting(spec, target, currentValue, 'allow', allowBtn)
    );
    blockBtn.addEventListener('click', () =>
      changeSetting(spec, target, currentValue, 'block', blockBtn)
    );
  } else {
    allowBtn.disabled = !known;
    blockBtn.disabled = !known;
    allowBtn.addEventListener('click', () =>
      changeSetting(spec, target, currentValue, 'allow', allowBtn)
    );
    blockBtn.addEventListener('click', () =>
      changeSetting(spec, target, currentValue, 'block', blockBtn)
    );

    // Reset is offered only when the row can move back to its default and is
    // not already there.
    const dflt = REVOCATION_DEFAULT[spec.cs];
    resetBtn.hidden =
      spec.revoke === false || dflt === undefined || !known || setting === dflt;
    resetBtn.addEventListener('click', () =>
      changeSetting(spec, target, currentValue, dflt, resetBtn)
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
  if (value === undefined) return false;
  const label = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = t('working');
  }

  const fail = (err) => {
    console.warn(`[auditor] ${spec.cs}=${value} failed`, err);
    if (button) {
      button.textContent = t('failedRetry');
      button.disabled = false;
    }
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
      return false;
    }
    return true;
  }

  const ns = chrome.contentSettings?.[spec.cs];
  if (!ns?.set) {
    if (button) {
      button.textContent = label;
      button.disabled = false;
    }
    return false;
  }
  try {
    await ns.set({ primaryPattern: target.pattern, setting: value });
  } catch (err) {
    fail(err);
    return false;
  }
  return true;
}

/* ==========================================================================
 * Undo history + site-wide reset
 * ==========================================================================
 * Every change made from the popup lands on an in-memory stack, so the most
 * recent action (or a whole "Reset this site" batch) can be walked back. The
 * stack is scoped to the audited origin and dropped when the popup starts
 * auditing a different site.
 */

/** @type {Array<{label: string, ops: Array<{cs: string, from: string}>}>} */
let undoStack = [];
/** Origin the current undo stack belongs to. */
let undoOrigin = null;
/** Target + audited settings of the last render, reused by reset/undo. */
let activeTarget = null;
let activeSettings = null;

/** Human label for one applied change, shown in the undo bar. */
function changeLabel(spec, value) {
  if (spec.cs === '__host__') {
    return value === 'allow'
      ? t('labelGranted', spec.label)
      : t('labelRevoked', spec.label);
  }
  if (value === 'allow') return t('labelEnabled', spec.label);
  if (value === 'block') return t('labelDisabled', spec.label);
  return t('labelReset', spec.label);
}

/** Push a reversible entry onto the undo stack. */
function recordUndo(ops, label) {
  if (!ops.length) return;
  undoStack.push({ label, ops });
}

/** Repaint the undo bar for the current stack (hidden when empty). */
function renderUndoBar() {
  const entry = undoStack[undoStack.length - 1];
  el.undoBtn.disabled = false;
  el.undoBar.hidden = !entry;
  if (!entry) {
    el.undoText.textContent = '';
    return;
  }
  const more =
    undoStack.length > 1 ? t('undoMore', num(undoStack.length - 1)) : '';
  el.undoText.textContent = entry.label + more;
}

/** True when any audited row currently differs from its browser default. */
function canResetSite() {
  if (!activeSettings) return false;
  for (const [cs, entry] of activeSettings) {
    const s = entry?.setting;
    const dflt = REVOCATION_DEFAULT[cs];
    if (s && dflt !== undefined && s !== dflt) return true;
  }
  return false;
}

/** Apply one change, remember how to undo it, then re-audit. */
async function changeSetting(spec, target, fromValue, toValue, button) {
  const ok = await applySetting(spec, target, toValue, button);
  if (!ok) return;
  recordUndo([{ cs: spec.cs, from: fromValue }], changeLabel(spec, toValue));
  runAudit();
}

/** Walk back the most recent change (single row or a whole reset batch). */
async function undoLastChange() {
  const entry = undoStack.pop();
  if (!entry || !activeTarget) return;
  el.undoBtn.disabled = true;
  for (const op of [...entry.ops].reverse()) {
    await applySetting({ cs: op.cs }, activeTarget, op.from, null);
  }
  renderUndoBar();
  runAudit();
}

/** Return every audited row on this site to Chrome's default value. */
async function resetSiteToDefaults() {
  const target = activeTarget;
  if (!target || !activeSettings) return;

  const ops = [];
  for (const [cs, entry] of activeSettings) {
    const from = entry?.setting;
    const dflt = REVOCATION_DEFAULT[cs];
    if (!from || dflt === undefined || from === dflt) continue;
    ops.push({ cs, from });
  }
  if (!ops.length) return;

  el.resetSiteBtn.disabled = true;
  el.resetSiteBtn.textContent = t('resetting');
  for (const op of ops) {
    await applySetting({ cs: op.cs }, target, REVOCATION_DEFAULT[op.cs], null);
  }
  recordUndo(ops, t('allReset'));

  el.resetSiteBtn.textContent = t('resetSite');
  runAudit();
}

/* ==========================================================================
 * Site presets (one-click permission profiles)
 * ==========================================================================
 * Clicking a profile first opens a confirmation panel that lists the exact
 * rows the profile would change (label + current value -> new value). Nothing
 * is written until the user confirms. On confirm the whole batch is applied
 * in one pass and pushed onto the undo stack as a single entry - so a whole
 * profile is walked back with one Undo click.
 */

/** True while a preset batch is being written (guards double-clicks). */
let presetBusy = false;
/**
 * True once a real site has been audited. The profile *buttons* need a site
 * to apply to, but the editor and the backup controls do not - they stay
 * usable on chrome:// pages and before the first audit lands.
 */
let siteAuditable = false;
/** The profile currently awaiting confirmation, or null. */
let pendingPreset = null;
/** The ops shown in the open preview, applied verbatim on confirm. */
let pendingOps = [];
/** The button that opened the preview, so focus can return to it. */
let previewTrigger = null;
/** The button that opened the editor, so focus can return to it. */
let editorTrigger = null;
/** The single preset button that owns the toolbar's roving tab stop. */
let presetTabStop = null;

/**
 * Decide the target setting for one content-setting key under a profile.
 * @returns {string|undefined} value to write, or undefined to leave it alone.
 */
function presetTargetFor(preset, cs) {
  if (preset.values?.[cs] !== undefined) return preset.values[cs];
  if (preset.resetOthers) return REVOCATION_DEFAULT[cs];
  return undefined;
}

/** Reflect the busy state across the preset bar. */
function setPresetsBusy(busy) {
  presetBusy = busy;
  el.presets.classList.toggle('is-busy', busy);
  refreshPresetButtons();
}

/**
 * Recompute every control's disabled state from the two things that can gate
 * it: a batch in flight, and whether a site is audited to apply to. The
 * "New preset" button and the backup controls are never gated by the site,
 * so the profile editor stays usable without an audited tab.
 */
function refreshPresetButtons() {
  for (const btn of el.presetsRow.querySelectorAll('.preset')) {
    const isNew = btn.dataset.preset === '__new__';
    btn.disabled = presetBusy || (!isNew && !siteAuditable);
    btn.setAttribute('aria-busy', String(presetBusy));
  }
  el.presetExportBtn.disabled = presetBusy || customPresets.length === 0;
  el.presetImportBtn.disabled = presetBusy;
  // Disabling changes which buttons are focusable, so re-pick the tab stop.
  setPresetTabStop(presetTabStop);
}

/**
 * Roving tabindex: exactly one preset button stays in the Tab order (tabindex
 * 0) and the rest are removed (tabindex -1). Arrow keys then move that single
 * tab stop, so the whole toolbar is one Tab stop in the page's focus order.
 *
 * @param {HTMLElement|null} btn  Preferred button to own the tab stop.
 * @param {{focus?: boolean}} [options]
 */
function setPresetTabStop(btn, { focus = false } = {}) {
  const buttons = [...el.presetsRow.querySelectorAll('.preset')];
  const enabled = buttons.filter((b) => !b.disabled);
  const target = btn && enabled.includes(btn) ? btn : enabled[0] ?? null;
  presetTabStop = target;
  for (const b of buttons) b.tabIndex = b === target ? 0 : -1;
  if (focus && target) target.focus();
}

/**
 * Build the preset buttons (built-ins + user-defined) plus the "New preset"
 * action, from the single PRESETS/customPresets source of truth.
 *
 * Keyboard model: the row is a real ARIA toolbar. Only one button is in the
 * Tab order at a time (roving tabindex); Left/Right and Home/End move that
 * single tab stop between profiles, so the group is one Tab stop total. Each
 * button advertises the panel it controls via aria-controls/aria-expanded.
 * Called again whenever a custom preset is saved or deleted.
 */
function renderPresets() {
  el.presetsRow.replaceChildren();
  el.presetsRow.setAttribute('role', 'toolbar');
  el.presetsRow.setAttribute('aria-orientation', 'horizontal');
  el.presetsRow.setAttribute('aria-label', t('profilesToolbarLabel'));

  const frag = document.createDocumentFragment();

  for (const preset of allPresets()) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `preset preset--${preset.custom ? 'custom' : preset.id}`;
    btn.dataset.preset = preset.id;
    btn.title = preset.hint;
    btn.tabIndex = -1; // setPresetTabStop promotes exactly one back to 0
    btn.setAttribute('aria-controls', 'presetPreview');
    btn.setAttribute('aria-expanded', 'false');

    const glyph = document.createElement('span');
    glyph.className = 'preset__icon';
    glyph.innerHTML = ICONS[preset.icon] ?? ICONS.shield;

    const label = document.createElement('span');
    label.className = 'preset__label';
    label.textContent = preset.label;

    btn.append(glyph, label);
    btn.addEventListener('click', () => {
      setPresetTabStop(btn);
      applyPreset(preset, btn);
    });
    frag.appendChild(btn);
  }

  // "New preset" action lives at the end of the same toolbar.
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'preset preset--new';
  addBtn.dataset.preset = '__new__';
  addBtn.tabIndex = -1;
  addBtn.title = t('newPresetTitle');
  addBtn.setAttribute('aria-controls', 'presetEditor');
  addBtn.setAttribute('aria-expanded', 'false');

  const addGlyph = document.createElement('span');
  addGlyph.className = 'preset__icon';
  addGlyph.innerHTML = ICONS.plus;

  const addLabel = document.createElement('span');
  addLabel.className = 'preset__label';
  addLabel.textContent = t('newPreset');

  addBtn.append(addGlyph, addLabel);
  addBtn.addEventListener('click', () => {
    setPresetTabStop(addBtn);
    openPresetEditor(addBtn);
  });
  frag.appendChild(addBtn);

  el.presetsRow.appendChild(frag);
  refreshPresetButtons();
}

/** Keep the roving tab stop in sync with wherever focus actually lands. */
function onPresetsRowFocusIn(event) {
  const btn = event.target.closest?.('.preset');
  if (btn) setPresetTabStop(btn);
}

/** Move the toolbar's single tab stop among the enabled buttons. */
function onPresetsRowKeydown(event) {
  const step = { ArrowRight: 1, ArrowLeft: -1 };
  const isHome = event.key === 'Home';
  const isEnd = event.key === 'End';
  if (!(event.key in step) && !isHome && !isEnd) return;

  const buttons = [
    ...el.presetsRow.querySelectorAll('.preset:not(:disabled)'),
  ];
  if (buttons.length < 2) return;
  const index = buttons.indexOf(document.activeElement);
  if (index === -1) return;

  event.preventDefault();
  const last = buttons.length - 1;
  const next = isHome
    ? 0
    : isEnd
      ? last
      : (index + step[event.key] + buttons.length) % buttons.length;
  // Move focus and hand the roving tab stop to the same button.
  setPresetTabStop(buttons[next], { focus: true });
}

/** Mark exactly one preset button as expanded (or none when null). */
function setPresetExpanded(activeBtn) {
  for (const btn of el.presetsRow.querySelectorAll('.preset')) {
    btn.setAttribute('aria-expanded', String(btn === activeBtn));
  }
}

/** Return focus to a button if it is still in the document. */
function restoreFocus(node) {
  if (node && node.isConnected) node.focus();
}

/** Human row label for a content-setting key (falls back to the key). */
function specFor(cs) {
  return SPEC_BY_CS.get(cs) ?? { label: cs, icon: 'dot' };
}

/**
 * Resolve the exact set of writes a profile would make against the current
 * audit. Only keys that actually change are included, so the preview and the
 * applied batch describe the same rows.
 * @returns {Array<{cs: string, from: string, to: string}>}
 */
function computePresetOps(preset) {
  const ops = [];
  if (!activeSettings) return ops;
  for (const [cs, entry] of activeSettings) {
    if (cs === '__host__') continue; // preset scope is content settings only
    const from = entry?.setting;
    const to = presetTargetFor(preset, cs);
    if (!from || to === undefined || from === to) continue;
    ops.push({ cs, from, to });
  }
  return ops;
}

/** Build one "Name: from -> to" preview row. */
function renderPreviewRow(op) {
  const spec = specFor(op.cs);
  const li = document.createElement('li');
  li.className = 'preset-preview__item';

  const glyph = document.createElement('span');
  glyph.className = 'preset-preview__glyph';
  glyph.innerHTML = ICONS[spec.icon] ?? ICONS.dot;

  const name = document.createElement('span');
  name.className = 'preset-preview__name';
  name.textContent = spec.label;

  const flow = document.createElement('span');
  flow.className = 'preset-preview__flow';

  const fromInfo = SETTING_LABELS[op.from] ?? { text: op.from, cls: 'neutral' };
  const toInfo = SETTING_LABELS[op.to] ?? { text: op.to, cls: 'neutral' };

  // The arrow is decorative; give the flow an explicit spoken form so screen
  // readers hear "Ask (default) to Blocked" rather than two loose words.
  flow.setAttribute(
    'aria-label',
    t('previewFlowLabel', [fromInfo.text, toInfo.text])
  );

  const from = document.createElement('span');
  from.className = 'preset-preview__from';
  from.textContent = fromInfo.text;

  const arrow = document.createElement('span');
  arrow.className = 'preset-preview__arrow';
  arrow.setAttribute('aria-hidden', 'true');
  // The row mirrors with the layout, so the arrow has to point the other way.
  arrow.textContent = IS_RTL ? '\u2190' : '\u2192';

  const to = document.createElement('span');
  to.className = `preset-preview__to preset-preview__to--${toInfo.cls}`;
  to.textContent = toInfo.text;

  flow.append(from, arrow, to);
  li.append(glyph, name, flow);
  return li;
}

/**
 * Close the confirmation panel and forget the pending profile.
 * @param {{restoreFocus?: boolean}} [options]
 */
function closePresetPreview(options = {}) {
  const trigger = previewTrigger;
  pendingPreset = null;
  pendingOps = [];
  previewTrigger = null;
  setPresetExpanded(null);
  el.presetPreview.hidden = true;
  el.presetPreview.replaceChildren();
  if (options.restoreFocus) restoreFocus(trigger);
}

/**
 * Open the confirmation panel for a profile: show what would change (or that
 * nothing would) and let the user apply or cancel. Focus moves into the
 * panel so the batch is announced and Tab reaches Apply / Cancel next.
 * @param {Preset} preset
 * @param {HTMLElement|null} [trigger] Button that opened the preview.
 */
function applyPreset(preset, trigger = null) {
  if (presetBusy || !activeSettings) return;
  closePresetEditor();

  const ops = computePresetOps(preset);
  pendingPreset = preset;
  pendingOps = ops;
  previewTrigger = trigger ?? document.activeElement;
  setPresetExpanded(trigger);

  const panel = el.presetPreview;
  panel.replaceChildren();

  const title = document.createElement('p');
  title.className = 'preset-preview__title';
  const name = document.createElement('strong');
  name.textContent = preset.label;
  title.append(name);

  const actions = document.createElement('div');
  actions.className = 'preset-preview__actions';

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'preset-preview__cancel';
  cancel.textContent = ops.length ? t('presetCancel') : t('close');
  cancel.addEventListener('click', () => closePresetPreview({ restoreFocus: true }));

  if (ops.length) {
    title.append(
      ops.length === 1
        ? t('previewChangeOne')
        : t('previewChangeMany', num(ops.length))
    );

    const list = document.createElement('ul');
    list.className = 'preset-preview__list';
    for (const op of ops) list.appendChild(renderPreviewRow(op));

    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'preset-preview__apply';
    confirm.textContent =
      ops.length === 1
        ? t('previewApplyOne')
        : t('previewApplyMany', num(ops.length));
    confirm.addEventListener('click', commitPreset);

    actions.append(confirm, cancel);

    // Custom profiles can be removed from right here, where the user can see
    // exactly what the profile does before deleting it.
    if (preset.custom) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'preset-preview__delete';
      del.textContent = t('presetDelete');
      del.addEventListener('click', () => deleteCustomPreset(preset));
      actions.append(del);
    }

    panel.append(title, list, actions);
  } else {
    title.append(t('previewNothing'));
    actions.append(cancel);
    panel.append(title, actions);
  }

  panel.hidden = false;
  // Move focus onto the panel so screen readers announce the batch and the
  // next Tab lands on Apply (or Close) inside the panel.
  panel.focus();
}

/**
 * Close the preview from the keyboard (Escape) and hand focus back to the
 * button that opened it, so the user is never stranded after the panel
 * disappears.
 */
function onPresetPreviewKeydown(event) {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  closePresetPreview({ restoreFocus: true });
}

/** Write the previewed batch and record it as one undoable entry. */
async function commitPreset() {
  const preset = pendingPreset;
  const target = activeTarget;
  const ops = pendingOps;
  const trigger = previewTrigger;
  closePresetPreview();
  if (presetBusy || !preset || !target || !ops.length) return;

  setPresetsBusy(true);

  // Apply each op; only record the ones that really landed so Undo never
  // tries to walk back a change that failed.
  const applied = [];
  for (const op of ops) {
    const ok = await applySetting({ cs: op.cs }, target, op.to, null);
    if (ok) applied.push({ cs: op.cs, from: op.from });
  }

  if (applied.length) {
    recordUndo(
      applied,
      applied.length === 1
        ? t('presetAppliedOne', preset.label)
        : t('presetAppliedMany', [preset.label, num(applied.length)])
    );
  }

  setPresetsBusy(false);
  await runAudit();
  // The audit re-rendered the rows; return focus to the preset the user used.
  restoreFocus(trigger);
}

/* ==========================================================================
 * Custom preset editor
 * ==========================================================================
 * The editor builds a name + per-permission target map, saves it through the
 * custom-preset store, then re-renders the toolbar so the new profile sits
 * beside the built-ins. It follows the same focus conventions as the preview
 * panel: focus moves in on open, Escape closes and restores focus.
 */

/**
 * Build the editor's per-permission rows.
 *
 * Every auditable key is listed, whether or not it resolved on the current
 * page: the editor is independent of the active tab, so a complete profile
 * can be authored on a chrome:// page or before any audit runs. Rows are
 * prefilled from the current site's effective setting when there is one.
 */
function renderPresetEditorList() {
  el.presetEditorList.replaceChildren();

  const frag = document.createDocumentFragment();
  for (const cs of CONTENT_SETTING_KEYS) {
    const spec = specFor(cs);

    const li = document.createElement('li');
    li.className = 'preset-editor__item';

    const name = document.createElement('span');
    name.className = 'preset-editor__item-name';
    name.textContent = spec.label;

    const select = document.createElement('select');
    select.className = 'preset-editor__select';
    select.dataset.cs = cs;
    select.setAttribute('aria-label', t('editorTarget', spec.label));

    const options = [
      ['', t('optDefault')],
      ['allow', t('optAllow')],
      ['block', t('optBlock')],
    ];
    // Only ask-capable types accept 'ask'; offering it for cookies or scripts
    // would produce an invalid write.
    if (REVOCATION_DEFAULT[cs] === 'ask') options.push(['ask', t('optAsk')]);

    for (const [value, text] of options) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = text;
      select.appendChild(opt);
    }

    // Prefill from the audited site when there is one; otherwise start on
    // "Default" so a profile can be authored without any site open.
    const entry = activeSettings?.get(cs) ?? null;
    const current = entry?.setting === 'session_only' ? 'allow' : entry?.setting;
    select.value = options.some(([v]) => v === current) ? current : '';

    li.append(name, select);
    frag.appendChild(li);
  }
  el.presetEditorList.appendChild(frag);
}

/** Open the editor, closing any open preview first. */
function openPresetEditor(trigger) {
  if (presetBusy) return;
  closePresetPreview();
  editorTrigger = trigger ?? document.activeElement;
  setPresetExpanded(trigger);
  renderPresetEditorList();
  el.presetName.value = '';
  el.presetEditor.hidden = false;
  el.presetName.focus();
}

/** Close the editor and forget the in-progress profile. */
function closePresetEditor(options = {}) {
  const trigger = editorTrigger;
  editorTrigger = null;
  setPresetExpanded(null);
  el.presetEditor.hidden = true;
  el.presetEditorList.replaceChildren();
  if (options.restoreFocus) restoreFocus(trigger);
}

/** Read the editor and append the profile to the saved custom presets. */
function savePresetFromEditor() {
  if (presetBusy) return;

  const values = {};
  for (const select of el.presetEditorList.querySelectorAll(
    '.preset-editor__select'
  )) {
    if (select.value) values[select.dataset.cs] = select.value;
  }

  const label =
    (el.presetName.value ?? '').trim().slice(0, 24) || t('customPresetDefault');
  const preset = {
    id: `custom:${Date.now().toString(36)}`,
    label,
    icon: 'sliders',
    custom: true,
    hint: t('customPresetHint', label),
    values,
  };

  customPresets.push(preset);
  saveCustomPresets();
  closePresetEditor();
  renderPresets();

  // Hand focus (and the tab stop) to the profile just created.
  const btn = el.presetsRow.querySelector(
    `.preset[data-preset="${preset.id}"]`
  );
  setPresetTabStop(btn, { focus: Boolean(btn) });
}

/** Remove a custom profile, re-render the toolbar, and re-home focus. */
function deleteCustomPreset(preset) {
  if (!preset?.custom) return;
  customPresets = customPresets.filter((p) => p.id !== preset.id);
  saveCustomPresets();
  closePresetPreview();
  renderPresets();
  setPresetTabStop(el.presetsRow.querySelector('.preset'), { focus: true });
}

/* ==========================================================================
 * Profile backup (export / import JSON)
 * ==========================================================================
 * Custom profiles live only in chrome.storage.local, so clearing site data
 * would silently drop them. Export writes them to a JSON file the user owns;
 * import merges a file back in. Both use only local browser APIs - a Blob and
 * a file input - so the extension still makes no network request.
 */

/** Marker written by export so an imported file can be recognised as ours. */
const PRESET_EXPORT_TYPE = 'website-permission-auditor/presets';
const PRESET_EXPORT_VERSION = 1;

/** Show feedback for an import/export attempt (empty text clears it). */
function showPresetIO(text, state) {
  el.presetIOText.textContent = text;
  el.presetIOText.dataset.state = state;
}

/** Download the saved custom profiles as a JSON file. */
function exportCustomPresets() {
  if (!customPresets.length) return;

  const payload = {
    type: PRESET_EXPORT_TYPE,
    version: PRESET_EXPORT_VERSION,
    presets: customPresets.map(({ label, values }) => ({ label, values })),
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'permission-profiles.json';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoke on the next tick so the download has had a chance to start.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** An import held while the user reviews duplicate labels, or null. */
let pendingImport = null;

/** Case/space-insensitive key used to compare two profile labels. */
function presetLabelKey(label) {
  return String(label ?? '').trim().toLocaleLowerCase();
}

/** A collision-proof id for a profile that is being added (never overwrites). */
function freshCustomPresetId() {
  return `custom:${Date.now().toString(36)}:${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

/** Append profiles with fresh ids, re-render the toolbar, and focus the last. */
function appendCustomPresets(list) {
  for (const preset of list) preset.id = freshCustomPresetId();
  customPresets.push(...list);
  saveCustomPresets();
  renderPresets();
  // Focus the newest profile so the import is visible and keyboard-reachable.
  setPresetTabStop(
    el.presetsRow.querySelector(`.preset[data-preset="${list.at(-1).id}"]`) ??
      null,
    { focus: true }
  );
  refreshPresetButtons();
}

/** Report an import outcome, distinguishing pure adds from replacements. */
function reportPresetImport(added, replaced) {
  if (replaced > 0 && added > 0) {
    showPresetIO(t('presetsImportMixed', [num(added), num(replaced)]), 'ok');
    return;
  }
  if (replaced > 0) {
    showPresetIO(
      replaced === 1
        ? t('presetsImportReplacedOne')
        : t('presetsImportReplacedMany', num(replaced)),
      'ok'
    );
    return;
  }
  showPresetIO(
    added === 1 ? t('presetsImportOne') : t('presetsImportMany', num(added)),
    'ok'
  );
}

/** Hide the duplicate review panel and forget any held import. */
function clearPresetImportReview() {
  pendingImport = null;
  el.presetImportReview.hidden = true;
  el.presetImportReviewList?.replaceChildren();
}

/** Human label for a target value, falling back to "not set" for none. */
function presetValueText(value) {
  if (value === undefined) return t('presetsImportUnset');
  return SETTING_LABELS[value]?.text ?? value;
}

/**
 * Compare a saved profile against an incoming one, row by row. Every key
 * either profile names is listed so a value present on only one side is not
 * missed, and each row carries `changed` so the two columns can highlight the
 * values that actually differ. A profile that resets unnamed keys contributes
 * a trailing marker row, itself flagged when only one side resets.
 *
 * @param {Preset} saved
 * @param {Preset} incoming
 * @returns {Array<{savedText: string, incomingText: string, tone: 'set'|'reset',
 *   changed: boolean}>}
 */
function buildPresetDiff(saved, incoming) {
  const keys = new Set([
    ...Object.keys(saved.values ?? {}),
    ...Object.keys(incoming.values ?? {}),
  ]);

  const rows = [];
  for (const cs of keys) {
    const spec = specFor(cs);
    const savedVal = presetTargetFor(saved, cs);
    const incomingVal = presetTargetFor(incoming, cs);
    rows.push({
      savedText: `${spec.label}: ${presetValueText(savedVal)}`,
      incomingText: `${spec.label}: ${presetValueText(incomingVal)}`,
      tone: 'set',
      changed: savedVal !== incomingVal,
    });
  }

  if (saved.resetOthers || incoming.resetOthers) {
    const marker = t('presetsImportResetsOthers');
    rows.push({
      savedText: marker,
      incomingText: marker,
      tone: 'reset',
      changed: Boolean(saved.resetOthers) !== Boolean(incoming.resetOthers),
    });
  }

  // Nothing named on either side: show one neutral row instead of a blank.
  if (!rows.length) {
    const empty = t('presetsImportNoValues');
    rows.push({
      savedText: empty,
      incomingText: empty,
      tone: 'reset',
      changed: false,
    });
  }

  return rows;
}

/**
 * Render the review breakdown: one block per clashing label, with the saved
 * profile on the left and the incoming one on the right. Rows whose values
 * differ are highlighted so the differences read at a glance, and each block
 * carries a count of how many values differ.
 * @param {Array<{saved: Preset, incoming: Preset}>} collisions
 */
function renderPresetImportReviewList(collisions) {
  const host = el.presetImportReviewList;
  if (!host) return;
  host.replaceChildren();

  const frag = document.createDocumentFragment();
  for (const { saved, incoming } of collisions) {
    const block = document.createElement('div');
    block.className = 'presets__review-entry';

    const rows = buildPresetDiff(saved, incoming);
    const changedCount = rows.filter((row) => row.changed).length;

    const head = document.createElement('div');
    head.className = 'presets__review-name-row';

    const name = document.createElement('span');
    name.className = 'presets__review-name';
    name.textContent = saved.label;
    head.appendChild(name);

    // A quick count makes "how different are these?" answerable without
    // scanning both columns.
    if (changedCount) {
      const badge = document.createElement('span');
      badge.className = 'presets__review-diff-count';
      badge.textContent = t('presetsImportDiffers', num(changedCount));
      head.appendChild(badge);
    }
    block.appendChild(head);

    const diff = document.createElement('div');
    diff.className = 'presets__review-diff';
    diff.append(
      buildReviewSide(t('presetsImportSavedColumn'), rows, 'saved'),
      buildReviewSide(t('presetsImportIncomingColumn'), rows, 'incoming')
    );
    block.appendChild(diff);

    frag.appendChild(block);
  }
  host.appendChild(frag);
}

/** Build one side (saved / incoming) of a review diff block. */
function buildReviewSide(title, rows, side) {
  const container = document.createElement('div');
  container.className = 'presets__review-side';

  const heading = document.createElement('span');
  heading.className = 'presets__review-side-title';
  heading.textContent = title;
  container.appendChild(heading);

  const list = document.createElement('ul');
  list.className = 'presets__review-values';
  for (const row of rows) {
    const li = document.createElement('li');
    li.className =
      `presets__review-value presets__review-value--${row.tone}` +
      (row.changed ? ' is-changed' : '');
    li.textContent = side === 'saved' ? row.savedText : row.incomingText;
    list.appendChild(li);
  }
  container.appendChild(list);
  return container;
}

/**
 * Merge custom profiles from parsed JSON. Accepts either a bare array or an
 * export object ({ presets: [...] }). Profiles whose label already exists are
 * not written yet: the whole import is held and a review panel asks the user
 * to replace the matches or keep both. A fresh id is always assigned, so
 * importing never silently overwrites and hand-edited ids cannot collide.
 *
 * @returns {{ok: boolean, count: number, pending?: boolean,
 *   duplicates?: number, reason?: 'invalid'|'empty'}}
 */
function importCustomPresets(data) {
  const list = Array.isArray(data)
    ? data
    : Array.isArray(data?.presets)
      ? data.presets
      : null;
  if (!list) return { ok: false, count: 0, reason: 'invalid' };

  const incoming = list.map(normalizeCustomPreset).filter(Boolean);
  if (!incoming.length) return { ok: false, count: 0, reason: 'empty' };

  // Split incoming profiles into clashes with a saved label and truly new
  // ones. Labels already seen inside the file also count as clashes, so two
  // entries named the same are not both appended unnoticed.
  const savedByLabel = new Map(
    customPresets.map((p) => [presetLabelKey(p.label), p])
  );
  const seenLabels = new Set(savedByLabel.keys());
  const fresh = [];
  const duplicates = [];
  // Each clash keeps both sides so the review can show the value differences.
  const collisions = [];
  for (const preset of incoming) {
    const key = presetLabelKey(preset.label);
    if (seenLabels.has(key)) {
      duplicates.push(preset);
      collisions.push({ saved: savedByLabel.get(key) ?? preset, incoming: preset });
    } else {
      fresh.push(preset);
      seenLabels.add(key);
    }
  }

  if (!duplicates.length) {
    appendCustomPresets(incoming);
    return { ok: true, count: incoming.length };
  }

  // Hold the import; nothing is written until the user chooses.
  clearPresetImportReview();
  pendingImport = { incoming, fresh, duplicates };
  el.presetImportReviewText.textContent =
    duplicates.length === 1
      ? t('presetsImportDuplicatesOne')
      : t('presetsImportDuplicatesMany', num(duplicates.length));
  renderPresetImportReviewList(collisions);
  el.presetImportReview.hidden = false;
  el.presetImportReplaceBtn.focus?.();
  return { ok: true, count: incoming.length, pending: true, duplicates: duplicates.length };
}

/**
 * Apply the held import. `replace` overwrites the matching saved profiles in
 * place (keeping their id and toolbar position); otherwise every imported
 * profile is appended alongside the existing one.
 */
function resolvePresetImport(replace) {
  if (!pendingImport) return;
  const { incoming, fresh, duplicates } = pendingImport;
  clearPresetImportReview();

  if (replace) {
    const byLabel = new Map(
      duplicates.map((p) => [presetLabelKey(p.label), p])
    );
    customPresets = customPresets.map((saved) => {
      const match = byLabel.get(presetLabelKey(saved.label));
      return match ? { ...match, id: saved.id } : saved;
    });
    if (fresh.length) appendCustomPresets(fresh);
    else {
      saveCustomPresets();
      renderPresets();
      refreshPresetButtons();
      setPresetTabStop(el.presetsRow.querySelector('.preset'), { focus: false });
    }
    reportPresetImport(fresh.length, duplicates.length);
    return;
  }

  appendCustomPresets(incoming);
  reportPresetImport(incoming.length, 0);
}

/** Read the chosen file and merge its profiles (never throws). */
async function handlePresetImportFile(file) {
  if (!file) return;

  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    clearPresetImportReview();
    showPresetIO(t('presetsImportInvalid'), 'error');
    return;
  }

  const result = importCustomPresets(data);
  if (!result.ok) {
    clearPresetImportReview();
    showPresetIO(
      t(result.reason === 'empty' ? 'presetsImportNone' : 'presetsImportInvalid'),
      'error'
    );
    return;
  }
  // A held import shows its own review panel instead of a status line.
  if (result.pending) {
    showPresetIO('', '');
    return;
  }
  reportPresetImport(result.count, 0);
}

/** Editor keyboard: Escape closes, Enter in the name field saves. */
function onPresetEditorKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    closePresetEditor({ restoreFocus: true });
    return;
  }
  if (event.key === 'Enter' && event.target === el.presetName) {
    event.preventDefault();
    savePresetFromEditor();
  }
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
  card.querySelector('.card__count').textContent = num(items.length);

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
  el.statGranted.textContent = num(granted);
  el.statBlocked.textContent = num(blocked);
  el.statDefault.textContent = num(dflt);
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
    badge.textContent = t('badgeGranted', num(granted));
    badge.className = 'badge badge--ok';
  } else {
    badge.textContent = t('badgeRestricted');
    badge.className = 'badge badge--deny';
  }
  badge.hidden = false;

  el.summaryText.textContent =
    granted > 0 ? t('summaryExtra') : t('summaryNone');
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
        ? `${num(cardMatches)}/${num(total)}`
        : num(total);
    }
  }

  el.searchClear.hidden = !searching;
  const nothingFound = searching && visibleCards === 0;
  el.noResults.hidden = !nothingFound;
  if (nothingFound) {
    el.noResults.textContent = t('noResults', rawQuery.trim());
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
  el.presets.hidden = true;
  // A fresh audit invalidates any open preset preview or editor.
  closePresetPreview();
  closePresetEditor();
  el.actionsBar.hidden = true;
  el.undoBar.hidden = true;
  el.noResults.hidden = true;
  el.statStrip.hidden = true;
  el.meter.hidden = true;
  el.siteName.textContent = t('loading');
  el.siteUrl.hidden = true;
  // Empty avatar tile while loading (the letter lands with the target).
  el.favicon.hidden = true;
  el.siteInitial.hidden = false;
  el.siteInitial.textContent = '';

  // 2. API sanity check (guards against future Chrome changes / side-loads).
  if (!chrome.contentSettings) {
    renderFatal(new Error(t('errorNoContentSettings')));
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
      ? t('extensionPageName')
      : prettyUrl(url) || t('browserPageName');
    el.notAuditableReason.textContent = isExtensionPage
      ? t('notAuditableExt')
      : t('notAuditableOther');
    showInitial(el.siteName.textContent);
    el.skeleton.hidden = true;
    el.notAuditable.hidden = false;
    // No site to apply a profile to, but the editor and its backup controls
    // stay available so profiles can still be authored, imported or exported.
    siteAuditable = false;
    el.presets.hidden = false;
    refreshPresetButtons();
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

  // Undo history is per-origin: moving to a new site starts a fresh stack.
  activeTarget = target;
  if (target.origin !== undoOrigin) {
    undoOrigin = target.origin;
    undoStack = [];
  }

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
  activeSettings = settings;

  // 6.5 First real paint: the skeleton has done its job.
  el.skeleton.hidden = true;

  // 7. Extension host access card (only when a grant actually exists).
  if (hostInfo.hasAny) {
    renderCategory(
      {
        id: 'ext',
        title: t('catExtHost'),
        icon: 'link',
        items: [
          {
            cs: '__host__',
            label: t('hostPermLabel'),
            icon: 'link',
            detail: hostInfo.allUrls
              ? t('hostPermBroad')
              : t('hostPermGranted'),
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

  // 10. Show the filter bar and site actions only when there is something to
  //     act on, then re-apply whatever is in the box (a revoke re-renders
  //     every row).
  const hasCards = el.categories.querySelector('.card') !== null;
  el.searchBar.hidden = !hasCards;
  // The profile card stays visible even for a site with no rows: its editor
  // and backup controls are independent of the audited tab.
  siteAuditable = true;
  el.presets.hidden = false;
  el.actionsBar.hidden = !hasCards;
  el.resetSiteBtn.disabled = !canResetSite();
  setPresetsBusy(false);
  renderUndoBar();
  applyFilter(el.search.value);
}

/** Surface an unexpected failure in-band instead of a blank popup. */
function renderFatal(err) {
  el.skeleton.hidden = true;
  el.siteName.textContent = t('unableToAudit');
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

/* Site actions: walk back the last change, or reset every row at once. */
el.undoBtn.addEventListener('click', undoLastChange);
el.resetSiteBtn.addEventListener('click', resetSiteToDefaults);

/* Preset bar keyboard support: arrow-key navigation between profiles and
   Escape to dismiss an open preview and return focus to its button. */
el.presetsRow.addEventListener('keydown', onPresetsRowKeydown);
el.presetsRow.addEventListener('focusin', onPresetsRowFocusIn);
el.presetPreview.addEventListener('keydown', onPresetPreviewKeydown);

/* Custom preset editor: save/cancel, Escape to dismiss, Enter to save. */
el.presetEditor.addEventListener('keydown', onPresetEditorKeydown);  el.presetSaveBtn.addEventListener('click', savePresetFromEditor);
  el.presetCancelBtn.addEventListener('click', () =>
    closePresetEditor({ restoreFocus: true })
  );

/* Profile backup: download the saved profiles, or merge them back in. */
el.presetExportBtn.addEventListener('click', () => {
  showPresetIO('', '');
  exportCustomPresets();
});
el.presetImportBtn.addEventListener('click', () => {
  // A new pick supersedes any previous review that was left open.
  clearPresetImportReview();
  showPresetIO('', '');
  el.presetImportInput.click();
});
el.presetImportInput.addEventListener('change', async () => {
  const [file] = el.presetImportInput.files ?? [];
  // Reset first so picking the same file again still fires `change`.
  el.presetImportInput.value = '';
  await handlePresetImportFile(file);
});

/* Duplicate review: replace the matches, keep both, or abandon the import. */
el.presetImportReplaceBtn.addEventListener('click', () =>
  resolvePresetImport(true)
);
el.presetImportSkipBtn.addEventListener('click', () => resolvePresetImport(false));
el.presetImportCancelBtn.addEventListener('click', () => {
  clearPresetImportReview();
  showPresetIO('', '');
});

/* Footer link: open Chrome's site settings in a new tab. */
el.settingsLink.addEventListener('click', (e) => {
  e.preventDefault();
  const url = el.settingsLink.dataset.url;
  if (url) chrome.tabs.create({ url });
});

/* Theme toggle: pick System / Light / Dark (persisted across popup opens). */
el.themeToggle.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-theme-value]');
  if (!btn) return;
  themePreference = btn.dataset.themeValue;
  applyTheme();
  saveTheme();
});

/* While following the system, react to the OS flipping light/dark. */
darkQuery.addEventListener('change', () => {
  if (themePreference === 'system') applyTheme();
});

/* Paint the theme before the first frame (from the OS hint), then refine it
   once the stored preference loads. */
applyTheme();
loadTheme();

/* Restore saved custom presets, then build the bar and audit the tab. */
loadCustomPresets().then(() => {
  renderPresets();
  runAudit();
});
