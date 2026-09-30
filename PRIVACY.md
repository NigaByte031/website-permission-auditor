# Privacy

Website Permission Auditor is built so that **nothing about your browsing
leaves your device**. This document states exactly what the extension touches.

## Short version

- No analytics, no telemetry, no crash reporting, no accounts.
- No network requests of any kind: the extension never calls `fetch`,
  `XMLHttpRequest`, `WebSocket` or `sendBeacon`. CI enforces this with a static
  check (`npm test`).
- No remote code. Everything shipped is in this repository.
- The only thing stored on disk is a small UI preference (below), and it never
  leaves your browser profile.

## What is read

When you click the toolbar icon, the popup reads:

| Data | Why | Leaves the device? |
|---|---|---|
| The active tab's URL (origin) | To know which site to audit | No |
| `chrome.contentSettings` values for that origin | To report the effective permission state | No |
| This extension's own host permissions for that origin | To report extension access | No |
| A favicon for the origin, via Chrome's local `favicon` API endpoint | Cosmetic — the header icon | No (resolved locally by Chrome) |

The service worker additionally observes `tabs.onActivated`, `tabs.onUpdated`
and `windows.onFocusChanged` so the toolbar badge can stay accurate. It reads
only the URL of the active tab at that moment.

## What is stored

One key in `chrome.storage.local`:

```json
{ "collapsedCategories": { "hardware": true } }
```

This records which category cards you collapsed, so the popup reopens the way
you left it. It contains no URLs, no history and no identifiers. Removing the
extension removes it.

## What is never done

- No page content is read: there are no content scripts and no `host_permissions`.
- No history, bookmarks, downloads, tabs-from-other-windows or form data is read.
- Nothing is sent anywhere — there is no server component.
- No permissions are changed without your click; the **Revoke** button is the
  only write path, and it applies to the site currently shown in the popup.

## Permissions and why they are needed

The rationale for every manifest permission — including why the extension does
**not** ask for host permissions — is documented in the
[README](README.md#manifest-permissions-and-why).

## Verifying these claims

1. Run `npm test` — it fails the build if any runtime source calls a network API.
2. Search the sources for `fetch`, `XMLHttpRequest`, `chrome.storage` and
   `chrome.permissions`.
3. Load the extension unpacked and watch the DevTools network panel of the
   popup's inspector — it stays empty.
