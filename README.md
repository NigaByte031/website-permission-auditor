# Website Permission Auditor

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-4285F4?logo=googlechrome&logoColor=white)](#compatibility)
[![Chrome 104+](https://img.shields.io/badge/Chrome-104%2B-4285F4?logo=googlechrome&logoColor=white)](#compatibility)
[![Network requests: none](https://img.shields.io/badge/network%20requests-none-2ea043)](PRIVACY.md)
[![Dependencies: none](https://img.shields.io/badge/dependencies-none-2ea043)](package.json)

A privacy-focused Chrome extension (Manifest V3) that audits **the site in the
active tab** and reports which capabilities it has been granted: camera,
microphone, geolocation, notifications, clipboard, cookies, pop-ups,
JavaScript, images, sound and automatic downloads — plus the host permissions
this extension itself holds for the site.

Everything runs locally. The popup makes **no network requests** and stores
nothing but one UI preference.

<!-- prettier-ignore -->
| | |
|---|---|
| **Get it** | Load the folder unpacked — see [Install](#install) |
| **Requires** | Chrome/Edge 104+ (Manifest V3) |
| **Footprint** | No dependencies, no build step, no remote code |
| **Docs** | [Privacy](PRIVACY.md) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md) |

## Table of contents

- [Features](#features)
- [Install](#install)
- [How the audit works](#how-the-audit-works)
- [The "chrome.siteSettings" question](#the-chromesitesettings-question)
- [Enable/disable/reset semantics](#enabledisablereset-semantics)
- [Manifest permissions and why](#manifest-permissions-and-why)
- [Privacy](#privacy)
- [Compatibility](#compatibility)
- [Project layout](#project-layout)
- [Development](#development)
- [Manual test checklist](#manual-test-checklist)
- [Notes and limits](#notes-and-limits)
- [License](#license)

## Features

- **Effective, not guessed.** Every row is queried through
  `chrome.contentSettings`, so it reflects browser defaults and enterprise
  policy even when no rule was ever set for the site.
- **Honest states.** Allowed / Ask (default) / Blocked / Allowed (this
  session) shown as tinted chips with a leading glyph, so status never depends
  on colour alone.
- **Act on what you see.** Every row carries *Enable* / *Disable* buttons —
  plus *Reset* when the row differs from Chrome's default — so a permission can
  be changed, scoped to that origin, without leaving the popup.
- **At-a-glance tally.** The header summarises the audit as
  *granted / blocked / on-ask* counts next to the summary badge, with a
  proportional meter bar above them.
- **Scannable at scale.** A live filter narrows rows as you type, hides empty
  cards and shows `matched/total` counts.
- **Remembers your layout.** Collapsible category cards persist their
  collapsed/expanded state in `chrome.storage.local`.
- **Quiet background signal.** The toolbar badge flags sites with granted
  permissions (green `1`) or restricted ones (red `!`) without opening the
  popup.
- **No install scare.** No `host_permissions`, so Chrome shows no "read and
  change all your data" warning.
- **Light and dark.** The whole UI is themed with CSS custom properties and
  follows the OS via `prefers-color-scheme`.

## Install

There is no build step and no release artifact required:

1. (Only if `icons/` is empty) run `node icons/generate-icons.mjs`.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and select this folder.

After editing `manifest.json`, press **Reload** on the extension card; edits to
`popup.html/css/js` just need the popup reopened.

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
- A filter bar above the cards narrows the rows live as you type: each row
  carries a lowercase search haystack (category title + label + effective
  value + description), non-matching rows and cards with no matches are
  hidden, matching cards expand for the duration of the search, and the count
  pill switches to `matched/total`. The query is popup-local and never
  persisted.
- The header carries a live tally of the audit — granted / blocked / default
  — and every row shows a tinted status chip with a leading glyph
  (✓ allowed, ? ask, ✕ blocked) so state reads without relying on color
  alone. A shimmer skeleton covers the first paint, and the header gains a
  shadow once content scrolls beneath it.
- Rows are interactive. *Enable* / *Disable* write the matching value for the
  origin and *Reset* writes the type's documented default, all through
  `chrome.contentSettings.<type>.set()`, then the popup re-audits so every chip
  reflects the new effective state. The `__host__` row drives
  `chrome.permissions.request()` / `.remove()` instead. All glyphs are inline
  SVG that inherit `currentColor`, so the UI looks identical on every platform
  and a status class can tint a glyph by swapping one colour token.

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

## Enable/disable/reset semantics

`ContentSetting.clear()` only clears **all** rules of a type for every site —
it has no per-origin form — so the row actions write values per origin through
`set({ primaryPattern: "https://example.com/*", setting })`:

- **Enable** writes `allow`; **Disable** writes `block`.
- **Reset** — shown only when the row differs from Chrome's default — writes
  that documented default back onto the origin: `ask` for camera, microphone,
  location, notifications, clipboard and automatic downloads; `allow` for
  cookies, JavaScript, images and sound; `block` for pop-ups.
- The `__host__` row has no contentSetting of its own: there **Enable** calls
  `chrome.permissions.request({ origins: [...] })` and **Disable** calls
  `chrome.permissions.remove({ origins: [...] })`.

The button matching a row's current state is highlighted (and mirrored in
`aria-pressed`), so each row reads as a toggle. A write that Chrome refuses is
surfaced as "Failed - retry" on the button plus a console warning.

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

## Privacy

The extension sends nothing anywhere and reads no page content. The only
persisted value is the collapsed-card map in `chrome.storage.local`.

- Full statement: [PRIVACY.md](PRIVACY.md)
- Enforced by tooling: `npm test` fails if runtime code calls `fetch`,
  `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon` or
  `importScripts`.

## Compatibility

| Browser | Status |
|---|---|
| Chrome / Chromium 104+ | ✅ Supported |
| Edge 104+ | ✅ Expected to work (same extension APIs) |
| Chrome < 104 | ❌ `favicon` API unavailable |
| Firefox | ❌ Not targeted (uses `chrome.*` MV3 APIs) |

## Project layout

```
manifest.json            MV3 manifest (permissions, action, service worker)
popup.html               Semantic popup markup (templates for cards/rows)
popup.css                Card-based UI, CSS variables, automatic dark mode
popup.js                 Audit logic + rendering + live row filter (ES2022+)
background.js            Service worker: live toolbar badge for the active tab
icons/
  generate-icons.mjs     Dev-time icon generator (add --all for an alternate
                         orange "attention" artwork)
  icon16.png icon48.png icon128.png   Generated toolbar/store icons
scripts/
  validate.mjs           Dependency-free checks run by `npm test` and CI
tools/preview/
  preview-server.mjs     Dependency-free static server for the popup preview
  preview.html           Harness page that frames the real popup
  chrome-mock.js         Preview-only chrome.* mock (mixed permission states)
  run.md                 How to run and use the preview
.github/
  workflows/ci.yml       Validate on every push and pull request
  workflows/release.yml  Zip the extension and publish a release on v* tags
```

## Development

```bash
npm test     # validate manifest, JS syntax, popup assets and the offline guarantee
npm run icons  # regenerate the toolbar/store icons
```

To iterate on the UI without loading the extension into Chrome, run
`node tools/preview/preview-server.mjs 4173` and open `http://127.0.0.1:4173/`; the
harness frames the real `popup.html` / `popup.css` / `popup.js` against a mocked
`chrome.*` API with mixed permission states. See [`tools/preview/run.md`](tools/preview/run.md).

`npm test` needs no installation: there are no dependencies, and
`scripts/validate.mjs` uses only Node's standard library. Releases are cut by
pushing a tag that matches `manifest.json` (`v1.1.0`); the release workflow
validates, packages a store-ready zip and attaches it to the GitHub release.

Conventions and PR expectations live in [CONTRIBUTING.md](CONTRIBUTING.md).

## Manual test checklist

- Regular site: rows show Allowed / Ask (default) / Blocked correctly.
- Grant a permission (e.g. camera on a test site) → badge shows green `1`,
  the row highlights *Disable* and offers *Reset*; clicking *Disable* turns the
  row Blocked (badge flips to red `!`), and *Reset* returns it to
  "Ask (default)".
- Block a type globally (`chrome://settings/content/cookies` → "Don't allow
  sites to use cookies") → popup shows Blocked rows; badge shows red `!`.
- `chrome://settings`, the Chrome Web Store, `about:blank`, DevTools windows →
  "Nothing to audit here" notice, no badge.
- OS light/dark mode → popup follows automatically via `prefers-color-scheme`.
- Collapse a category card → chevron rotates and the body animates shut;
  close and reopen the popup (or reload) → the same cards are still collapsed.
- Type in the filter box → rows narrow instantly, empty cards disappear, the
  count pill shows `matched/total`, and a "No permissions match …" line
  appears when nothing hits; clearing the box (✕ or Esc) restores every row
  and the previously collapsed cards.

## Notes and limits

- `chrome.contentSettings` getters reject `chrome://` and other internal
  schemes; those tabs are filtered before any query.
- Enterprise-managed browsers may prevent `set()`; failures surface as
  "Failed - retry" on the button and a console warning.
- The badge inspects the four key types (camera, mic, location,
  notifications) to keep service-worker wake-ups cheap; the popup always
  audits the full list.
- The audit reports what the browser stores per origin. It cannot see what a
  site does with a permission after you grant it in a page dialog, and it does
  not observe third-party iframes individually.

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md)
and the [Code of Conduct](CODE_OF_CONDUCT.md). Security reports should go
through the private channel described in [SECURITY.md](SECURITY.md).

## License

Released under the [MIT License](LICENSE) © 2026 Mohammad Yazdani.

You are free to use, modify and redistribute this project — including
commercially — provided the copyright notice and permission notice are
retained in all copies or substantial portions of the software.
