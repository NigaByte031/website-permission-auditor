# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 1.1.x | ✅ |
| 1.0.x | ✅ |
| < 1.0 | ❌ |

The extension ships from this repository's tagged releases; only the latest
release is supported.

## Reporting a vulnerability

Please report privately through GitHub's
[security advisories](https://github.com/NigaByte031/website-permission-auditor/security/advisories/new)
rather than a public issue.

A useful report includes:

- the affected version (popup footer shows it),
- your Chrome version and OS,
- the site or scenario that triggers it,
- and, when possible, a minimal reproduction.

You can expect an acknowledgement as soon as the maintainer sees the report. If
the issue is confirmed, it will be fixed and released with credit to the
reporter, unless you prefer to stay anonymous.

## Scope

In scope:

- Permission state being misreported (e.g. "Allowed" while the site is blocked).
- The **Enable** / **Disable** / **Reset** actions changing settings for a
  site other than the one shown.
- Any code path that could transmit data off the device — the extension is
  designed to make **no network requests**, and CI enforces that statically.
- Any way to make the popup or service worker execute remotely supplied code.
- Privilege escalation through the popup's message/URL handling.

Out of scope:

- Chrome's own permission UI, enterprise policy behaviour, or settings changed
  outside this extension.
- Sites asking for permissions in ways you find annoying.
- Issues that require an already-compromised browser profile or a malicious
  extension with broader permissions.

## Design guarantees you can verify

1. No `host_permissions` — the extension cannot read page content.
2. No network calls in `popup.js` / `background.js` (checked by `npm test`).
3. The only storage key is `collapsedCategories` (a UI preference) in
   `chrome.storage.local`.
4. No content scripts, no remote code, no `eval` of remote strings.

See [PRIVACY.md](PRIVACY.md) for the full data-handling statement.
