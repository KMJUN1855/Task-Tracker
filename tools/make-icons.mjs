/**
 * Generates the app icons as PNGs.
 *
 * iOS ignores SVG for apple-touch-icon, so real rasters are needed - and this
 * project has no build step and no image dependencies, so they are encoded here
 * with nothing but node:zlib. Run with: npm run icons
 *
 * The mark is a stopwatch: a ring, a crown button, and a hand at 2 o'clock, in
 * the app's running-yellow on the app's background. Everything stays inside 62%
 * of the width so a maskable (circular) crop cannot clip it.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BG = [0x14, 0x16, 0x1a];
const FG = [0xf2, 0xc1, 0x4e];

/* ------------------------------------------------------------- PNG output */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  // One filter byte (0 = none) in front of every scanline.
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ----------------------------------------------------------------- the mark */

/** Coverage of the mark at a point in centred coordinates (-1..1). */
function markAt(x, y) {
  const r = Math.hypot(x, y);

  // Ring.
  if (r >= 0.44 && r <= 0.53) return 1;

  // Crown button on top.
  if (y <= -0.52 && y >= -0.62 && Math.abs(x) <= 0.075) return 1;

  // Hand, from the centre towards 2 o'clock.
  const angle = -Math.PI / 4;
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  const along = x * ux + y * uy;
  const across = Math.abs(x * uy - y * ux);
  if (along >= 0 && along <= 0.34 && across <= 0.028) return 1;

  // Hub.
  if (r <= 0.055) return 1;

  return 0;
}

function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const samples = 3; // 3x3 supersampling, so the curves are not jagged

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let hits = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const x = ((px + (sx + 0.5) / samples) / size) * 2 - 1;
          const y = ((py + (sy + 0.5) / samples) / size) * 2 - 1;
          hits += markAt(x, y);
        }
      }
      const alpha = hits / (samples * samples);
      const offset = (py * size + px) * 4;
      for (let c = 0; c < 3; c += 1) {
        rgba[offset + c] = Math.round(BG[c] * (1 - alpha) + FG[c] * alpha);
      }
      rgba[offset + 3] = 255; // opaque: iOS composites touch icons on white
    }
  }
  return encodePng(size, size, rgba);
}

const outDir = fileURLToPath(new URL('../public/icons/', import.meta.url));
mkdirSync(outDir, { recursive: true });

for (const size of [180, 192, 512]) {
  const png = renderIcon(size);
  writeFileSync(new URL(`icon-${size}.png`, `file://${outDir}`), png);
  console.log(`icon-${size}.png  ${png.length} bytes`);
}
