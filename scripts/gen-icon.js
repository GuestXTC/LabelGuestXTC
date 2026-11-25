/*
 * Generate the LabelGuestXTC app icon (original, no third-party assets).
 * Design "option 2": rounded green square + white label outline + text lines.
 * Renders at 4x supersampling for clean edges, writes multi-size PNGs and a
 * Windows ICO container (ICO entries can embed raw PNG data).
 */
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const OUT_DIR = path.join(__dirname, '..', 'assets', 'icon');
fs.mkdirSync(OUT_DIR, { recursive: true });

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const BG = [29, 158, 117];      // #1D9E75 green
const WHITE = [255, 255, 255];
const SS = 4;                    // supersample factor

// Signed distance-ish helpers, all in normalized 0..1 coordinates.
function roundedRectSDF(x, y, x0, y0, x1, y1, r) {
  // returns <=0 inside; approximate via simple test (anti-alias by coverage)
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
function coverage(sd, px) { // sd in normalized units, px = 1 pixel in normalized units
  return Math.max(0, Math.min(1, 0.5 - sd / px));
}

function makePNG(size) {
  const n = size * SS;
  const px = 1 / n;
  const png = new PNG({ width: n, height: n });
  // Background: transparent buffer, rounded square drawn below.
  for (let yy = 0; yy < n; yy++) {
    for (let xx = 0; xx < n; xx++) {
      const i = (yy * n + xx) * 4;
      png.data[i] = 0; png.data[i + 1] = 0; png.data[i + 2] = 0; png.data[i + 3] = 0;
    }
  }
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

  // 1) rounded square background, radius 0.20, inset small margin
  const M = 0.02;
  for (let yy = 0; yy < n; yy++) {
    const y = (yy + 0.5) / n;
    for (let xx = 0; xx < n; xx++) {
      const x = (xx + 0.5) / n;
      const sd = roundedRectSDF(x, y, M, M, 1 - M, 1 - M, 0.20);
      const a = coverage(sd, px);
      if (a > 0) blend(xx, yy, BG, a);
    }
  }

  // 2) white label outline: rounded rect stroke. Draw as ring using SDF diff.
  const strokeW = 0.055; // normalized
  for (let yy = 0; yy < n; yy++) {
    const y = (yy + 0.5) / n;
    for (let xx = 0; xx < n; xx++) {
      const x = (xx + 0.5) / n;
      const outer = roundedRectSDF(x, y, 0.19, 0.25, 0.81, 0.75, 0.055);
      const inner = roundedRectSDF(x, y, 0.19 + strokeW, 0.25 + strokeW, 0.81 - strokeW, 0.75 - strokeW, 0.02);
      // ring = inside outer AND outside inner
      const ring = Math.max(outer, -inner);
      const a = coverage(ring, px);
      if (a > 0) blend(xx, yy, WHITE, a);
    }
  }

  // 3) three white text lines inside the label
  const lines = [
    { x0: 0.30, x1: 0.70, y0: 0.36, y1: 0.40 },
    { x0: 0.30, x1: 0.70, y0: 0.47, y1: 0.51 },
    { x0: 0.30, x1: 0.58, y0: 0.58, y1: 0.62 }
  ];
  for (const L of lines) {
    for (let yy = 0; yy < n; yy++) {
      const y = (yy + 0.5) / n;
      if (y < L.y0 - px || y > L.y1 + px) continue;
      for (let xx = 0; xx < n; xx++) {
        const x = (xx + 0.5) / n;
        const sx = Math.max(L.x0 - x, 0, x - L.x1);
        const sy = Math.max(L.y0 - y, 0, y - L.y1);
        const sd = Math.hypot(sx, sy);
        const a = coverage(sd, px);
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

// Write PNGs, collect buffers for ICO.
const entries = [];
for (const size of SIZES) {
  const png = makePNG(size);
  const buf = PNG.sync.write(png, { colorType: 6 });
  const file = path.join(OUT_DIR, `icon-${size}.png`);
  fs.writeFileSync(file, buf);
  entries.push({ size, buf });
  console.log(`PNG ${size}x${size}: ${buf.length} bytes`);
}

// Build ICO: header (6 bytes) + directory entries (16 bytes each) + image data.
const icoHeader = Buffer.alloc(6);
icoHeader.writeUInt16LE(0, 0);       // reserved
icoHeader.writeUInt16LE(1, 2);       // type: icon
icoHeader.writeUInt16LE(entries.length, 4);
const dir = Buffer.alloc(16 * entries.length);
let offset = 6 + 16 * entries.length;
entries.forEach((e, i) => {
  const d = i * 16;
  dir[d] = e.size >= 256 ? 0 : e.size;      // width (0 means 256)
  dir[d + 1] = e.size >= 256 ? 0 : e.size;  // height
  dir[d + 2] = 0;                            // palette
  dir[d + 3] = 0;                            // reserved
  dir.writeUInt16LE(1, d + 4);               // color planes
  dir.writeUInt16LE(32, d + 6);              // bits per pixel
  dir.writeUInt32LE(e.buf.length, d + 8);    // size of image data
  dir.writeUInt32LE(offset, d + 12);         // offset
  offset += e.buf.length;
});
const ico = Buffer.concat([icoHeader, dir, ...entries.map(e => e.buf)]);
const icoPath = path.join(OUT_DIR, 'icon.ico');
fs.writeFileSync(icoPath, ico);
console.log(`ICO: ${icoPath} (${ico.length} bytes)`);
