/**
 * Website Permission Auditor - background service worker (MV3).
 *
 * The popup is fully self-contained; this worker adds one convenience:
 * a live toolbar badge for the active tab, so users get value without
 * opening the popup.
 *
 *   • "1"  (green) - the site has at least one explicitly granted
 *                    permission (allow / session_only) among the key types.
 *   • "!"  (red)   - nothing granted, but the site is restricted
 *                    (e.g. notifications blocked) - informational.
 *   • ""   (none)  - site is on browser defaults, or the tab is not a
 *                    regular website (chrome://, extension pages, ...).
 *
 * The worker is event-driven and stateless across suspends: MV3 may
 * terminate it at any time, so it simply re-derives everything from
 * chrome.tabs + chrome.contentSettings on every wake-up.
 */

'use strict';

/** Content types inspected for the badge (kept small on purpose). */
const BADGE_KEYS = ['camera', 'microphone', 'location', 'notifications'];

const BADGE_OK = { text: '1', color: '#1a7f37' };
const BADGE_RESTRICTED = { text: '!', color: '#b3261e' };

/** True for URLs we can meaningfully audit. */
function isAuditableUrl(url) {
  return /^(https?|file):/i.test(url ?? '');
}

/**
 * Compute the badge payload for a URL, or null for "no badge".
 * Each contentSettings query is individually guarded: a single unsupported
 * type (or a file:// URL the API rejects) must not break the rest.
 */
async function computeBadge(rawUrl) {
  if (!isAuditableUrl(rawUrl)) return null;

  let origin;
  try {
    origin = new URL(rawUrl).origin;
  } catch {
    return null;
  }

  const results = await Promise.all(
    BADGE_KEYS.map(async (key) => {
      try {
        return await chrome.contentSettings[key].get({ primaryUrl: origin });
      } catch {
        return null;
      }
    })
  );

  const settings = results.map((r) => r?.setting).filter(Boolean);
  const granted = settings.some(
    (s) => s === 'allow' || s === 'session_only'
  );
  const restricted = settings.some((s) => s === 'block');

  if (granted) return BADGE_OK;
  if (restricted) return BADGE_RESTRICTED;
  return null;
}

/** Apply a badge payload to one tab; empty text clears that tab's badge. */
async function updateBadge(tabId, rawUrl) {
  if (!chrome.action) return;
  let badge = null;
  try {
    badge = await computeBadge(rawUrl);
  } catch (err) {
    console.warn('[auditor] badge evaluation failed', err);
  }
  try {
    // Fully transparent background when there is no text to show.
    await chrome.action.setBadgeBackgroundColor({
      color: badge?.color ?? [0, 0, 0, 0],
      tabId,
    });
    await chrome.action.setBadgeText({ text: badge?.text ?? '', tabId });
  } catch {
    // The tab may have been closed before the call landed; safe to ignore.
  }
}

/** Id of the active tab in the last focused window (best effort). */
let activeTabId = null;

/** Re-evaluate the badge for whichever tab is currently active. */
async function refreshActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (!tab) return;
    activeTabId = tab.id;
    await updateBadge(tab.id, tab.url);
  } catch (err) {
    console.warn('[auditor] refreshActiveTab failed', err);
  }
}

chrome.tabs.onActivated.addListener(({ tabId }) => {
  activeTabId = tabId;
  chrome.tabs
    .get(tabId)
    .then((tab) => updateBadge(tabId, tab?.url))
    .catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tabId !== activeTabId) return;
  // React when the tab navigates somewhere new (or finishes loading).
  const url =
    changeInfo.url ?? (changeInfo.status === 'complete' ? tab?.url : undefined);
  if (url) updateBadge(tabId, url);
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  // WINDOW_ID_NONE fires when Chrome itself loses focus; skip that.
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  refreshActiveTab();
});

chrome.runtime.onStartup.addListener(refreshActiveTab);
chrome.runtime.onInstalled.addListener(refreshActiveTab);
