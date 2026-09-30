# Website Permission Auditor (Manifest V3)

A privacy-focused Chrome extension that audits **the site in the active tab**
and reports which capabilities it has been granted: camera, microphone,
geolocation, notifications, clipboard, cookies, pop-ups, JavaScript, images,
sound and automatic downloads — plus the host permissions this extension
itself holds for the site.

Everything runs locally. The popup makes **no network requests** (favicons are
resolved through Chrome's local `favicon` API endpoint) and stores nothing.

## Project layout

```
manifest.json            MV3 manifest (permissions, action, service worker)
popup.html               Semantic popup markup (templates for cards/rows)
popup.css                Card-based UI, CSS variables, automatic dark mode
popup.js                 Audit logic + rendering (vanilla ES2022+)
background.js            Service worker: live toolbar badge for the active tab
icons/
  generate-icons.mjs     Dev-time icon generator (node icons/generate-icons.mjs;
                         add --all for an alternate orange "attention" artwork)
  icon16.png icon48.png icon128.png   Generated toolbar/store icons
```

## Loading the extension

1. (Only if icons are missing) run `node icons/generate-icons.mjs`.
2. Open `chrome://extensions`, enable **Developer mode**.
3. Click **Load unpacked** and select this folder.

## How the audit works

- `chrome.tabs.query({ active: true, lastFocusedWindow: true })` resolves the
  active tab. A short retry loop covers clicks during navigation.
- For every tracked content type the popup calls
  `chrome.contentSettings.<type>.get({ primaryUrl: origin })`, which resolves
  the **effective** setting for that origin — including enterprise policy and
  browser defaults — even when no rule was ever set for the site. All queries
  run in parallel; a single failure renders as "Unknown" instead of breaking
  the audit.
- `chrome.permissions.contains({ origins: [...] })` reports whether this
  extension holds host access for the origin (per-site grants from
  `chrome://extensions` surface here too).
- Non-auditable targets (`chrome://`, `edge://`, `chrome-extension://`,
  `devtools://`, `view-source:`, `about:`) show an explanatory notice instead.
- Category cards are collapsible: the card header is a real toggle button
  (keyboard accessible, `aria-expanded`/`aria-controls` wired) with an
  animated chevron and a row-count pill. Collapsed state is stored per
  category id in `chrome.storage.local` (`collapsedCategories`) and restored
  on the next popup open; it degrades to in-memory only if storage fails.

## The "chrome.siteSettings" question

The original specification asked for `chrome.siteSettings` (claimed to be
"introduced in Chrome 113+"). **That namespace does not exist in Chromium.**
Verified against the Chromium source tree:

- There is no `site_settings.json` / `site_settings.webidl` extension API
  schema under `chrome/common/extensions/api/` or `extensions/common/api/`.
- `_api_features.json` (both chrome-side and extensions-side) has no
  `siteSettings` entry in any Chrome version, so the API can never be
  feature-detected at runtime.
- The developer docs contain no `siteSettings` reference page.

The real, supported surface for per-site content settings is
[`chrome.contentSettings`](https://developer.chrome.com/docs/extensions/reference/api/contentSettings)
— stable for years, fully compatible with MV3, and exactly what the
specification described: query (and change) camera, microphone, geolocation,
notifications, clipboard, cookies and more on a per-origin basis. It is
unlocked by the `"contentSettings"` manifest permission. This extension
therefore uses `chrome.contentSettings` and keeps a runtime guard so it
degrades gracefully (error banner, not a crash) if the API is ever missing.

### Revoke/reset semantics

`ContentSetting.clear()` only clears **all** rules of a type for every site —
it has no per-origin form — so "Revoke" here writes Chrome's documented
default for that type back onto the origin via `set()`
(`primaryPattern: "https://example.com/*"`): `ask` for camera, microphone,
location, notifications, clipboard and automatic downloads; `allow` for
cookies, JavaScript, images and sound; `block` for pop-ups. The button only
appears when the current setting differs from that default.

## Manifest permissions and why

| Permission | Why it is needed |
|---|---|
| `activeTab` | Read the active tab's URL after the user invokes the popup. |
| `tabs` | Fallback URL access + `tabs.onActivated/onUpdated` for the badge. |
| `contentSettings` | Query per-origin content settings (`chrome.contentSettings`). |
| `permissions` | Inspect this extension's own host permissions (`chrome.permissions`). |
| `storage` | Remember which category cards the user collapsed (`chrome.storage.local`). |
| `favicon` | Chrome 104+ local favicon lookup for the header (`chrome://favicon2`-class data without WebUI access). |

No `host_permissions` are declared, so installing triggers no "read and
change all your data" warning. `"minimum_chrome_version": "104"` reflects the
`favicon` API requirement.

## Manual test checklist

- Regular site: rows show Allowed / Ask (default) / Blocked correctly.
- Grant a permission (e.g. camera on a test site) → badge shows green `1`,
  popup shows "Revoke" for that row; clicking it returns the row to
  "Ask (default)".
- Block a type globally (`chrome://settings/content/cookies` → "Don't allow
  sites to use cookies") → popup shows Blocked rows; badge shows red `!`.
- `chrome://settings`, the Chrome Web Store, `about:blank`, DevTools windows →
  "Nothing to audit here" notice, no badge.
- OS light/dark mode → popup follows automatically via `prefers-color-scheme`.
- Collapse a category card → chevron rotates and the body animates shut;
  close and reopen the popup (or reload) → the same cards are still collapsed.

## Notes and limits

- `chrome.contentSettings` getters reject `chrome://` and other internal
  schemes; those tabs are filtered before any query.
- Enterprise-managed browsers may prevent `set()`; failures surface as
  "Failed - retry" on the button and a console warning.
- The badge inspects the four key types (camera, mic, location,
  notifications) to keep service-worker wake-ups cheap; the popup always
  audits the full list.
