# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/NigaByte031/website-permission-auditor/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/NigaByte031/website-permission-auditor/releases/tag/v1.0.0
