/**
 * Icon generator for the Website Permission Auditor extension.
 *
 * Draws the "shield over a browser page" artwork on a Canvas2D-like pixel
 * buffer and encodes it directly into PNG files (no dependencies, no
 * headless browser needed). This is a DEV-TIME script only: run it once with
 * `node icons/generate-icons.mjs`, then ship the generated PNGs. Chrome never
 * executes this file.
 *
 *   node icons/generate-icons.mjs
 */

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const outDir = join(dirname(fileURLToPath(import.meta.url)));
mkdirSync(outDir, { recursive: true });

/** Little-endian CRC32 (PNG chunks require it). */
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, crc]);
}

/** Encode RGBA pixel data as a PNG file buffer. */
function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  // Raw scanlines, each prefixed with a "no filter" byte.
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0;
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a, b, t) => a + (b - a) * t;
/** Blend two color stops (both {r,g,b,a}) and interpolate alpha linearly. */
function mixColor(a, b, t) {
  return {
    r: Math.round(mix(a.r, b.r, t)),
    g: Math.round(mix(a.g, b.g, t)),
    b: Math.round(mix(a.b, b.b, t)),
    a: mix(a.a ?? 1, b.a ?? 1, t),
  };
}

/** Source-over compositing of one anti-aliased pixel. */
function setPx(data, w, x, y, c) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  if (xi < 0 || yi < 0 || xi >= w || yi >= w) return;
  const i = (yi * w + xi) * 4;
  const a = clamp01(c.a ?? 1);
  const dstA = data[i + 3] / 255;
  const outA = a + dstA * (1 - a);
  if (outA <= 0) return;
  data[i] = Math.round((c.r * a + data[i] * (1 - a)) / outA);
  data[i + 1] = Math.round((c.g * a + data[i + 1] * (1 - a)) / outA);
  data[i + 2] = Math.round((c.b * a + data[i + 2] * (1 - a)) / outA);
  data[i + 3] = Math.round(outA * 255);
}

/** Anti-aliased filled rectangle (float coords). */
function fillRect(d, w, x0, y0, x1, y1, c) {
  for (let y = Math.floor(y0); y <= y1; y++) {
    for (let x = Math.floor(x0); x <= x1; x++) {
      const aX = Math.min(1, x + 1, x1) - Math.max(x, x0);
      const aY = Math.min(1, y + 1, y1) - Math.max(y, y0);
      if (aX <= 0 || aY <= 0) continue;
      setPx(d, w, x, y, { ...c, a: c.a * aX * aY });
    }
  }
}

/** Anti-aliased filled disc. */
function disc(d, w, cx, cy, r, c) {
  const r2 = r * r;
  const inner2 = (r - 0.9) * (r - 0.9);
  for (let y = Math.floor(cy - r) - 1; y <= cy + r + 1; y++) {
    for (let x = Math.floor(cx - r) - 1; x <= cx + r + 1; x++) {
      const dist2 = (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2;
      let a = c.a;
      if (dist2 > inner2) a *= clamp01((r2 - dist2) / (r2 - inner2) + 0.001);
      if (a > 0) setPx(d, w, x, y, { ...c, a });
    }
  }
}

/** Anti-aliased ring (e.g. the shield's edge). */
function ring(d, w, cx, cy, rOuter, thick, c) {
  const rIn = rOuter - thick;
  for (let y = Math.floor(cy - rOuter) - 1; y <= cy + rOuter + 1; y++) {
    for (let x = Math.floor(cx - rOuter) - 1; x <= cx + rOuter + 1; x++) {
      const dist2 = (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2;
      const outer2 = rOuter * rOuter;
      const inner2 = rIn * rIn;
      if (dist2 <= outer2 && dist2 >= inner2) setPx(d, w, x, y, c);
    }
  }
}

/** Anti-aliased line drawn as stamped discs. */
function line(d, w, x0, y0, x1, y1, width, c) {
  const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 3) + 1;
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    disc(d, w, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, width / 2, c);
  }
}

/** Anti-aliased triangle via sign tests. */
function triangle(d, w, p1, p2, p3, c) {
  const minX = Math.min(p1[0], p2[0], p3[0]);
  const maxX = Math.max(p1[0], p2[0], p3[0]);
  const minY = Math.min(p1[1], p2[1], p3[1]);
  const maxY = Math.max(p1[1], p2[1], p3[1]);
  const sign = (a, b, p) => (p[0] - a[0]) * (b[1] - a[1]) - (b[0] - a[0]) * (p[1] - a[1]);
  for (let y = Math.floor(minY) - 1; y <= maxY + 1; y++) {
    for (let x = Math.floor(minX) - 1; x <= maxX + 1; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const d1 = sign(p1, p2, [px, py]);
      const d2 = sign(p2, p3, [px, py]);
      const d3 = sign(p3, p1, [px, py]);
      const neg = d1 < 0 || d2 < 0 || d3 < 0;
      const pos = d1 > 0 || d2 > 0 || d3 > 0;
      if (!(neg && pos)) setPx(d, w, x, y, c);
    }
  }
}

/**
 * Draw one icon. Geometry is authored on a 48px canvas and multiplied by
 * `scale` so the three sizes stay proportional.
 */
function drawIcon(size, colors) {
  const s = size / 48;
  const w = size;
  const px = new Uint8Array(w * w * 4);
  const d = { set: (x, y, c) => setPx(px, w, x, y, c) };

  // 1. Rounded backdrop (the "browser page"), clipped to the canvas.
  const bgCx = 24 * s;
  const bgCy = 24 * s;
  const bgR = 22 * s;
  const gradFrom = Math.max(0, bgCy - bgR);
  const gradTo = bgCy + bgR;
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const dist2 = (x + 0.5 - bgCx) ** 2 + (y + 0.5 - bgCy) ** 2;
      const r2 = bgR * bgR;
      const inner2 = (bgR - 0.9) * (bgR - 0.9);
      if (dist2 > r2) continue;
      let a = 1;
      if (dist2 > inner2) a = clamp01((r2 - dist2) / (r2 - inner2) + 0.001);
      const t = clamp01((y + 0.5 - gradFrom) / (gradTo - gradFrom));
      const c = mixColor(colors.bg1, colors.bg2, t);
      setPx(px, w, x, y, { ...c, a });
    }
  }
  // Faint horizontal "content rows" left and right of the shield.
  const rowC = colors.row;
  for (const ry of [10.5, 15.5, 20.5]) {
    line(d.set, w, 7.5 * s, ry * s, 15.5 * s, ry * s, 2.6 * s, rowC);
    line(d.set, w, 32.5 * s, ry * s, 40.5 * s, ry * s, 2.6 * s, rowC);
  }

  // 2. Shield body: a disc plus a triangular tip below its equator.
  const cx = 24 * s;
  const cy = 21 * s;
  const r = 20 * s;
  const tip = 19 * s;
  disc(d.set, w, cx, cy, r, colors.shield);
  triangle(
    d.set,
    w,
    [cx - r, cy],
    [cx + r, cy],
    [cx, cy + tip],
    colors.shield
  );
  // Edge highlight + glossy top-to-bottom shading on the shield.
  ring(d.set, w, cx, cy, r, 1.4 * s, colors.shieldEdge);
  for (let y = Math.floor(cy - r); y <= cy + tip; y++) {
    const t = clamp01((y + 0.5 - (cy - r)) / (tip + r));
    const c = mixColor(colors.glossA, colors.glossB, t);
    // Cheap shading: repaint a horizontal slice of the shield with alpha.
    const halfWidth = t < 0.5 ? r : r * (1 - (t - 0.5) * 2);
    fillRect(d.set, w, cx - halfWidth, y, cx + halfWidth, y + 1, { ...c, a: c.a * 0.5 });
  }

  // 3. White check mark, sized up slightly on the smallest icon.
  const checkW = Math.max(4.4 * s, 2);
  line(d.set, w, cx - 6.4 * s, cy + 0.8 * s, cx - 1.4 * s, cy + 6.2 * s, checkW, colors.check);
  line(d.set, w, cx - 1.4 * s, cy + 6.2 * s, cx + 7 * s, cy - 4.6 * s, checkW, colors.check);

  return encodePng(size, size, Buffer.from(px.buffer));
}

/** Color schemes per status. The manifest ships the "clear" variant. */
const schemes = {
  clear: {
    bg1: { r: 34, g: 197, b: 94 },
    bg2: { r: 21, g: 128, b: 61 },
    row: { r: 255, g: 255, b: 255, a: 0.35 },
    shield: { r: 255, g: 255, b: 255 },
    shieldEdge: { r: 255, g: 255, b: 255, a: 0.85 },
    glossA: { r: 255, g: 255, b: 255, a: 0.22 },
    glossB: { r: 16, g: 42, b: 28, a: 0.14 },
    check: { r: 22, g: 140, b: 70 },
  },
  attention: {
    bg1: { r: 255, g: 171, b: 64 },
    bg2: { r: 234, g: 110, b: 10 },
    row: { r: 255, g: 255, b: 255, a: 0.35 },
    shield: { r: 255, g: 255, b: 255 },
    shieldEdge: { r: 255, g: 255, b: 255, a: 0.85 },
    glossA: { r: 255, g: 255, b: 255, a: 0.22 },
    glossB: { r: 66, g: 32, b: 4, a: 0.16 },
    check: { r: 240, g: 120, b: 20 },
  },
};

// The "clear" scheme ships in the manifest. Pass --all to also write the
// alternate "attention" artwork (not referenced by the manifest).
const writeAll = process.argv.includes('--all');
for (const [name, colors] of Object.entries(schemes)) {
  if (name !== 'clear' && !writeAll) continue;
  for (const size of [16, 48, 128]) {
    const fileName = name === 'clear' ? `icon${size}.png` : `${name}-${size}.png`;
    const file = join(outDir, fileName);
    writeFileSync(file, drawIcon(size, colors));
    console.log(`wrote ${file}`);
  }
}

console.log("Done. Generate-time only - the extension loads the PNGs.");
