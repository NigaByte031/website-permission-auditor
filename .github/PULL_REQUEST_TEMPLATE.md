## What changed

<!-- One or two sentences. Link the issue this closes, if any. -->

## Why

<!-- The motivation: what was wrong, or what the new capability enables. -->

## Checklist

- [ ] `npm test` passes locally (manifest, syntax, offline guard, popup assets)
- [ ] No network calls (`fetch`, `XMLHttpRequest`, `WebSocket`, …) were added
- [ ] No new host permissions were added to `manifest.json`
- [ ] New manifest permissions — if any — are justified in the README table
- [ ] The UI still works in light **and** dark mode (`prefers-color-scheme`)
- [ ] Keyboard paths were considered (the popup is fully operable without a mouse)
- [ ] `CHANGELOG.md` has an entry under `Unreleased` for user-visible changes
- [ ] Docs (`README.md`, `SECURITY.md`, `PRIVACY.md`) were updated if behaviour changed

## How it was tested

<!-- Load unpacked steps, the site you audited, and what you observed. -->
