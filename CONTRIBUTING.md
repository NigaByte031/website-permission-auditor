# Contributing

Thanks for taking a look. This is a small, dependency-free extension, and the
goal is to keep it that way.

## Ground rules

1. **Stay offline.** The extension must never make a network request. `npm test`
   fails if runtime code calls `fetch`, `XMLHttpRequest`, `WebSocket`,
   `EventSource`, `sendBeacon` or `importScripts`.
2. **No new host permissions.** The absence of `host_permissions` is a feature:
   installing must not show the "read and change all your data" warning.
3. **No dependencies, no build step.** Vanilla ES2022 in the browser, plain
   JavaScript files shipped as-is. Anything that needs bundling is out of scope.
4. **No remote code.** Everything must live in this repository (also an MV3
   requirement).

## Getting started

```bash
git clone https://github.com/NigaByte031/website-permission-auditor.git
cd website-permission-auditor
npm test          # dependency-free validation (manifest, syntax, privacy)
```

There is nothing to install — `npm test` runs `scripts/validate.mjs`, which
uses only Node's standard library.

### Loading it in Chrome

1. Open `chrome://extensions` and enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. After changing `manifest.json`, click the extension's **Reload** button.
   Changes to `popup.html/css/js` are picked up by simply reopening the popup.

### Icons

`icons/icon*.png` are committed. Regenerate them with:

```bash
npm run icons          # or: node icons/generate-icons.mjs
node icons/generate-icons.mjs --all   # alternate "attention" artwork
```

## Code style

- Match the surrounding code: 2-space indent, single quotes, semicolons,
  trailing commas in multiline literals, `const` over `let`.
- Comment the *why*, not the *what*; JSDoc for functions with non-obvious
  contracts.
- Keep the popup accessible: real `<button>`s, `aria-expanded`/`aria-controls`
  for disclosures, visible `:focus-visible` rings, and state never conveyed by
  colour alone.
- Test UI changes in both light and dark mode, and at the popup's width
  (380 px).

## Commits and pull requests

- Write commit subjects in the imperative mood, describing the intent
  ("Hide empty cards while filtering", not "changes to popup.js").
- Keep the diff focused; separate refactors from behaviour changes.
- Run `npm test` before opening a PR, and fill in the PR checklist.
- Update `CHANGELOG.md` under `Unreleased` for anything user-visible.

## Reporting bugs and vulnerabilities

- Functional bugs: use the issue templates.
- Security issues: **do not** open a public issue — see
  [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contributions are licensed under the
[MIT License](LICENSE).
