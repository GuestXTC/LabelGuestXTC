/*
 * Generate the LabelGuestXTC app icon (original, no third-party assets).
 * Design "option 4": rounded black square + white perforated label with text.
 * Renders at 4x supersampling for clean edges, writes multi-size PNGs and a
 * Windows ICO container (ICO entries can embed raw PNG data).
 */
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const OUT_DIR = path.join(__dirname, '..', 'assets', 'icon');
fs.mkdirSync(OUT_DIR, { recursive: true });

const SIZES = [16, 24, 32, 48, 64, 128, 256, 512];
const BG = [44, 44, 42];        // #2C2C2A black
const WHITE = [255, 255, 255];
const SS = 4;                    // supersample factor

const U = 1 / 88;
// Label box: x 34..70, y 20..68, radius 4, stroke 4.5px
const BOX = { x0: 34 * U, y0: 20 * U, x1: 70 * U, y1: 68 * U, r: 4 * U, hw: 2.25 * U };
// Two perforation holes on the left (centers + radius)
const HOLES = [{ cx: 24 * U, cy: 30 * U, r: 6 * U }, { cx: 24 * U, cy: 58 * U, r: 6 * U }];
// Three text lines inside the box
const LINES = [
  { x0: 42 * U, x1: 62 * U, y: 34 * U, hw: 1.8 * U },
  { x0: 42 * U, x1: 62 * U, y: 44 * U, hw: 1.8 * U },
  { x0: 42 * U, x1: 54 * U, y: 54 * U, hw: 1.8 * U }
];

function roundedRectSDF(x, y, x0, y0, x1, y1, r) {
  const cx = Math.max(x0 + r, Math.min(x, x1 - r));
  const cy = Math.max(y0 + r, Math.min(y, y1 - r));
  const dx = x - cx, dy = y - cy;
  if (x >= x0 && x <= x1 && y >= y0 && y <= y1) {
    if ((x < x0 + r || x > x1 - r) && (y < y0 + r || y > y1 - r)) {
      return Math.hypot(dx, dy) - r;
    }
    return -Math.min(x - x0, x1 - x, y - y0, y1 - y);
  }
  return Math.hypot(dx, dy) - r;
}
function coverage(sd, px) {
  return Math.max(0, Math.min(1, 0.5 - sd / px));
}

function makePNG(size) {
  const n = size * SS;
  const px = 1 / n;
  const png = new PNG({ width: n, height: n });
  for (let i = 0; i < png.data.length; i++) png.data[i] = 0;

  const blend = (xx, yy, color, a) => {
    if (a <= 0) return;
    const i = (yy * n + xx) * 4;
    const prev = png.data[i + 3] / 255;
    const na = a + prev * (1 - a);
    if (na <= 0) return;
    for (let c = 0; c < 3; c++) {
      png.data[i + c] = Math.round((color[c] * a + png.data[i + c] * prev * (1 - a)) / na);
    }
    png.data[i + 3] = Math.round(na * 255);
  };

  // 1) rounded square background
  const M = 0.02;
  for (let yy = 0; yy < n; yy++) {
    const y = (yy + 0.5) / n;
    for (let xx = 0; xx < n; xx++) {
      const x = (xx + 0.5) / n;
      const a = coverage(roundedRectSDF(x, y, M, M, 1 - M, 1 - M, 0.20), px);
      if (a > 0) blend(xx, yy, BG, a);
    }
  }

  // 2) two white perforation holes (filled circles)
  for (let yy = 0; yy < n; yy++) {
    const y = (yy + 0.5) / n;
    for (let xx = 0; xx < n; xx++) {
      const x = (xx + 0.5) / n;
      for (const h of HOLES) {
        const d = Math.hypot(x - h.cx, y - h.cy) - h.r;
        const a = coverage(d, px);
        if (a > 0) blend(xx, yy, WHITE, a);
      }
    }
  }

  // 3) white label box outline (ring)
  for (let yy = 0; yy < n; yy++) {
    const y = (yy + 0.5) / n;
    for (let xx = 0; xx < n; xx++) {
      const x = (xx + 0.5) / n;
      const outer = roundedRectSDF(x, y, BOX.x0, BOX.y0, BOX.x1, BOX.y1, BOX.r);
      const inner = roundedRectSDF(x, y, BOX.x0 + BOX.hw * 2, BOX.y0 + BOX.hw * 2,
        BOX.x1 - BOX.hw * 2, BOX.y1 - BOX.hw * 2, Math.max(0.001, BOX.r - BOX.hw * 2));
      const ring = Math.max(outer, -inner);
      const a = coverage(ring, px);
      if (a > 0) blend(xx, yy, WHITE, a);
    }
  }

  // 4) three white text lines
  for (const L of LINES) {
    for (let yy = 0; yy < n; yy++) {
      const y = (yy + 0.5) / n;
      if (y < L.y - L.hw - px || y > L.y + L.hw + px) continue;
      for (let xx = 0; xx < n; xx++) {
        const x = (xx + 0.5) / n;
        const dx = Math.max(L.x0 - x, 0, x - L.x1);
        const dy = Math.max(Math.abs(y - L.y) - 0, 0);
        const d = Math.hypot(dx, dy) - L.hw;
        const a = coverage(d, px);
        if (a > 0) blend(xx, yy, WHITE, a);
      }
    }
  }

  // Downsample SSxSS -> size with box filter.
  const out = new PNG({ width: size, height: size });
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          const i = ((y * SS + dy) * n + (x * SS + dx)) * 4;
          const aa = png.data[i + 3] / 255;
          r += png.data[i] * aa; g += png.data[i + 1] * aa; b += png.data[i + 2] * aa; a += aa;
        }
      }
      const cnt = SS * SS;
      const oi = (y * size + x) * 4;
      if (a > 0) {
        out.data[oi] = Math.round(r / a);
        out.data[oi + 1] = Math.round(g / a);
        out.data[oi + 2] = Math.round(b / a);
        out.data[oi + 3] = Math.round((a / cnt) * 255);
      } else {
        out.data[oi] = 0; out.data[oi + 1] = 0; out.data[oi + 2] = 0; out.data[oi + 3] = 0;
      }
    }
  }
  return out;
}

const entries = [];
for (const size of SIZES) {
  const buf = PNG.sync.write(makePNG(size), { colorType: 6 });
  fs.writeFileSync(path.join(OUT_DIR, `icon-${size}.png`), buf);
  entries.push({ size, buf });
  console.log(`PNG ${size}x${size}: ${buf.length} bytes`);
}

// ICO directory entries must describe the ACTUAL embedded image size.
// A 512px PNG cannot be labeled as 256 (0) — that malformed entry makes
// Windows / electron-builder reject the whole ICO and fall back to the
// default Electron icon. Only include sizes <= 256 in the ICO.
const icoEntries = entries.filter(e => e.size <= 256);
const icoHeader = Buffer.alloc(6);
icoHeader.writeUInt16LE(0, 0);
icoHeader.writeUInt16LE(1, 2);
icoHeader.writeUInt16LE(icoEntries.length, 4);
const dir = Buffer.alloc(16 * icoEntries.length);
let offset = 6 + 16 * icoEntries.length;
icoEntries.forEach((e, i) => {
  const d = i * 16;
  dir[d] = e.size >= 256 ? 0 : e.size;      // 0 means 256 in ICO format
  dir[d + 1] = e.size >= 256 ? 0 : e.size;
  dir[d + 2] = 0;
  dir[d + 3] = 0;
  dir.writeUInt16LE(1, d + 4);
  dir.writeUInt16LE(32, d + 6);
  dir.writeUInt32LE(e.buf.length, d + 8);
  dir.writeUInt32LE(offset, d + 12);
  offset += e.buf.length;
});
const ico = Buffer.concat([icoHeader, dir, ...icoEntries.map(e => e.buf)]);
const icoPath = path.join(OUT_DIR, 'icon.ico');
fs.writeFileSync(icoPath, ico);
console.log(`ICO: ${icoPath} (${ico.length} bytes)`);
