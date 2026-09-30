# Run doc — Website Permission Auditor preview

This project is a **Chrome extension** (vanilla HTML/CSS/JS, no package.json,
no build step). It cannot run as a normal web app because `popup.js` needs the
`chrome.*` extension namespace, so the preview uses a tiny dependency-free
Node static server plus a harness that renders the real popup in an iframe
with a mocked `chrome.*` API.

## Artifacts (already committed to the repo, nothing to copy)

- `tools/preview/preview-server.mjs` — static server (serves project root; `/` → harness)
- `tools/preview/preview.html` — harness page (380×620 popup frame + note + color-scheme toggle)
- `tools/preview/chrome-mock.js` — preview-only `chrome.*` mock (mixed permission
  states for `https://example.com`; Revoke buttons actually mutate the mock)

No env files exist to copy. If `icons/` were ever deleted, regenerate with
`node icons/generate-icons.mjs` (only affects the real extension, not the preview).

## Run the server

```
node tools/preview/preview-server.mjs 4173
```

Then open `http://127.0.0.1:4173/`. The iframe shows the real
`popup.html` + `popup.css` + `popup.js` running against the mock; refresh the
page after editing popup files. The iframe's "Open Chrome site settings" link
is a no-op, and its favicon request targets `chrome-extension://previewmock/`
so it always fails - the avatar then shows its letter fallback, which is the
behaviour under test rather than a harness bug.

### Start it detached (Windows)

To keep the server alive past the shell that launched it, start it with
PowerShell and use the pid it prints. `Start-Process` does not resolve shell
shims, so name the executable exactly (`node.exe`), and send stdout and stderr
to **different** files:

```
powershell -NoProfile -Command "(Start-Process -FilePath 'node.exe' -ArgumentList 'tools\preview\preview-server.mjs','4173' -WorkingDirectory '<repo>' -RedirectStandardOutput '<repo>\tools\preview\preview-<port>.log' -RedirectStandardError '<repo>\tools\preview\preview-<port>.log.err' -WindowStyle Hidden -PassThru).Id"
```

Confirm it survived with `powershell -NoProfile -Command "Get-Process -Id <pid>"`
before pointing a preview at `http://127.0.0.1:4173/`.

### Color-scheme toggle

The harness has **Auto / ☀ Light / 🌙 Dark** buttons above the frame. Forcing
`color-scheme` on the harness `<html>` makes the popup iframe resolve
`prefers-color-scheme` accordingly, so the popup's automatic dark mode can be
exercised without touching OS settings. **Auto** follows the OS again; the
choice persists in `localStorage` (`preview.colorMode`) across reloads.

To run the real extension instead: load this folder unpacked via
`chrome://extensions` (see README.md).

## Notes

- Port 4173 (default in the server); override as the CLI arg.
- Logs: `tools/preview/preview-<port>.log` (stdout) and `.log.err` (stderr)
  when started detached via `Start-Process -PassThru`.
