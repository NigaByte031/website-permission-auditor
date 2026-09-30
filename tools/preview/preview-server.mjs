#!/usr/bin/env node
/**
 * Static preview server for the Website Permission Auditor popup.
 *
 * Usage: node tools/preview/preview-server.mjs [port]
 * Serves the project root (the extension folder) and maps "/" to
 * ./tools/preview/preview.html - a harness that loads the real popup.html/
 * popup.css/popup.js with a mocked chrome.* namespace.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const HARNESS = join(ROOT, 'tools/preview', 'preview.html');
const PORT = Number(process.argv[2] ?? process.env.PORT ?? 4173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = decodeURIComponent(url.pathname);

    // "/" and "/preview" show the harness; anything else is served from ROOT.
    let filePath =
      pathname === '/' || pathname === '/preview'
        ? HARNESS
        : join(ROOT, normalize(pathname));

    // The chrome mock lives in tools/preview/ but must be fetchable from the page.
    if (pathname === '/chrome-mock.js') {
      filePath = join(ROOT, 'tools/preview', 'chrome-mock.js');
    }

    // Path traversal guard.
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch (err) {
    res.writeHead(err?.code === 'ENOENT' ? 404 : 500, {
      'Content-Type': 'text/plain; charset=utf-8',
    });
    res.end(err?.code === 'ENOENT' ? 'Not found' : `Server error: ${err}`);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Preview server running at http://127.0.0.1:${PORT}/`);
});
