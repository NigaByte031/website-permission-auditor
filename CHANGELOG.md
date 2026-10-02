# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Arabic (`ar`) locale: a complete `_locales/ar/messages.json` mirroring the
  English and Persian key set. Arabic joins Persian as a right-to-left
  language, so the popup mirrors its layout and renders counts in
  Arabic-Indic numerals (`٠١٢٣`).
- A **Supported languages** section in the README documenting the shipped
  locales, their text direction and numerals, and how to add a new language.

### Changed

- `popup.js` digit formatting and localisation notes now cover Arabic
  alongside Persian.

## [1.1.0] - 2026-10-01

### Added

- Per-row **Enable** / **Disable** actions that write `allow` / `block` for the
  audited origin through `chrome.contentSettings`, plus a **Reset** action that
  restores Chrome's documented default for the type. Rows now read as toggles:
  the active state is highlighted and mirrored in `aria-pressed`.
- The host-access row can now **grant** this extension's access to the origin
  via `chrome.permissions.request()`, not just remove it.
- Header redesign: a site avatar that falls back to a letter tile until the
  favicon decodes, and a proportional granted/blocked/on-ask meter above the
  tally.
- Hand-rolled inline SVG icons for every category and row, replacing platform
  emoji so the UI renders identically everywhere and inherits the status tint.
- Local preview harness (`tools/preview/`) that frames the real popup against a
  mocked `chrome.*` API, so the UI can be iterated on without loading the
  extension into Chrome.

### Changed

- Documentation updated for the new row actions: README semantics section,
  privacy and security statements.

## [1.0.0] - 2026-09-30

### Added

- Per-site audit of camera, microphone, geolocation, notifications, clipboard,
  cookies, JavaScript, images, sound, pop-ups and automatic downloads via
  `chrome.contentSettings`, which resolves the *effective* setting for an
  origin — including browser defaults and enterprise policy.
- Host-permission reporting for the audited origin via `chrome.permissions`.
- Per-origin **Revoke**, which writes Chrome's documented default back onto the
  origin, plus a deep link into `chrome://settings/content/siteDetails`.
- Live toolbar badge driven by a stateless MV3 service worker.
- Collapsible category cards with the collapsed/expanded map persisted in
  `chrome.storage.local`.
- Live filter bar for the permission rows, with `matched/total` counts, empty
  cards hidden and an explicit "no matches" state.
- Popup UI: aurora accent strip, frosted glass header and footer, tinted
  status chips with leading glyphs, an at-a-glance granted/blocked/default
  tally, a loading skeleton and automatic light/dark theming.
- An explanatory notice for non-auditable targets (`chrome://`, `about:`,
  DevTools, extension pages).
- Documentation: README with the permission rationale, `PRIVACY.md`,
  `SECURITY.md`, `CONTRIBUTING.md`, a manual test checklist and an MIT license.
- Tooling: dependency-free `npm test` validation (`scripts/validate.mjs`) that
  enforces the manifest, syntax, popup assets and the offline guarantee, plus
  CI and tag-driven release workflows.

[Unreleased]: https://github.com/NigaByte031/website-permission-auditor/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/NigaByte031/website-permission-auditor/releases/tag/v1.1.0
[1.0.0]: https://github.com/NigaByte031/website-permission-auditor/releases/tag/v1.0.0
