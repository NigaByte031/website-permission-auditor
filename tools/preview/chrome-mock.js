/**
 * Preview-only mock of the chrome.* APIs used by popup.js.
 * Injected into the preview iframe before popup.js (served by
 * preview-server.mjs). NOT part of the extension build.
 *
 * Simulates a "mixed state" site so every status color is visible:
 * camera allowed, mic/location/clipboard/auto-downloads ask,
 * notifications + popups blocked, cookies/js/images allowed, sound ask.
 * Enable/Disable/Reset calls mutate SETTINGS, so the re-audit shows the
 * change immediately.
 */
'use strict';

const MOCK_ORIGIN = 'https://example.com';
const MOCK_TAB_URL = MOCK_ORIGIN + '/some/page';

/** Mutable per-type settings so Revoke -> re-audit shows real changes. */
const SETTINGS = {
  camera: 'allow',
  microphone: 'ask',
  location: 'ask',
  notifications: 'block',
  clipboard: 'ask',
  cookies: 'allow',
  automaticDownloads: 'ask',
  javascript: 'allow',
  images: 'allow',
  sound: 'ask',
  popups: 'block',
};

// Tiny chrome.storage.local backed by a plain object (persists across
// reloads within the preview page via localStorage).
const STORAGE_KEY = 'chrome-mock.storage.local';
const storageData = (() => {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
  } catch {
    return {};
  }
})();

window.chrome = {
  runtime: {
    getURL: (path) => 'chrome-extension://previewmock/' + path,
    getManifest: () => ({ version: '1.0.0' }),
  },
  storage: {
    local: {
      get: async (keys) => {
        if (keys == null) return { ...storageData };
        if (typeof keys === 'string') {
          return keys in storageData ? { [keys]: storageData[keys] } : {};
        }
        if (Array.isArray(keys)) {
          return Object.fromEntries(
            keys.filter((k) => k in storageData).map((k) => [k, storageData[k]])
          );
        }
        // Object form: defaults merged in.
        return Object.fromEntries(
          Object.entries(keys).map(([k, v]) => [k, k in storageData ? storageData[k] : v])
        );
      },
      set: async (items) => {
        Object.assign(storageData, items);
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(storageData));
        } catch {
          /* quota/private mode - in-memory only */
        }
      },
      remove: async (keys) => {
        for (const k of [].concat(keys)) delete storageData[k];
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(storageData));
        } catch {
          /* in-memory only */
        }
      },
      clear: async () => {
        for (const k of Object.keys(storageData)) delete storageData[k];
        try {
          localStorage.removeItem(STORAGE_KEY);
        } catch {
          /* in-memory only */
        }
      },
    },
  },
  tabs: {
    query: async () => [{ id: 1, url: MOCK_TAB_URL, title: 'Example page' }],
    create: async (opts) => console.log('[mock] tabs.create', opts),
  },
  contentSettings: Object.fromEntries(
    Object.keys(SETTINGS).map((key) => [
      key,
      {
        get: async ({ primaryUrl }) => {
          if (!primaryUrl || !/^(https?|file):/i.test(primaryUrl)) {
            throw new Error('invalid url: ' + primaryUrl);
          }
          return { setting: SETTINGS[key] };
        },
        set: async ({ setting }) => {
          SETTINGS[key] = setting;
          console.log(`[mock] contentSettings.${key}.set ->`, setting);
        },
        clear: async () => {},
      },
    ])
  ),
  permissions: {
    contains: async () => false,
    request: async (opts) => {
      console.log('[mock] permissions.request', opts);
      return true;
    },
    remove: async () => console.log('[mock] permissions.remove'),
  },
  favicon: {},
};
