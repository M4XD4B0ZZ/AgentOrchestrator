#!/usr/bin/env node
/**
 * One-off icon generator for the dashboard PWA shell.
 *
 * NOT part of the build chain. The build copies `src/dashboard/ui/*.png` as
 * committed artwork; it never re-creates it. This script exists only so the
 * two PNGs it wrote once are reproducible and reviewable, not so they get
 * regenerated on every build. Run it manually, then commit its output:
 *
 *   node scripts/one-off/make-icons.mjs
 *
 * It uses only `node:zlib` (to deflate the raw scanlines, which is what a PNG
 * IDAT chunk carries) and `node:fs` — no image or PNG-encoding dependency.
 * Each icon is a flat two-tone square: a solid background field with a
 * lighter inset square, matching the dark shell tokens in `app.css`.
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'dashboard', 'ui');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** CRC-32 over a byte sequence, computed with the standard PNG polynomial. */
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** One PNG chunk: 4-byte length, 4-byte type, the data, then its CRC-32. */
function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

/**
 * Renders one flat RGB square icon: `bg` fills the frame, `inset` fills a
 * centred square covering the middle 60% of each side.
 */
function renderIcon(size, bg, inset) {
  const insetStart = Math.round(size * 0.2);
  const insetEnd = size - insetStart;
  const rowBytes = 1 + size * 3; // filter-type byte + RGB per pixel
  const raw = Buffer.alloc(rowBytes * size);
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * rowBytes;
    raw[rowStart] = 0; // filter type 0: none
    const inY = y >= insetStart && y < insetEnd;
    for (let x = 0; x < size; x += 1) {
      const inX = x >= insetStart && x < insetEnd;
      const colour = inX && inY ? inset : bg;
      const pixelStart = rowStart + 1 + x * 3;
      raw[pixelStart] = colour[0];
      raw[pixelStart + 1] = colour[1];
      raw[pixelStart + 2] = colour[2];
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour (RGB)
  ihdr[10] = 0; // compression method
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace method

  const idat = deflateSync(raw);

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Dark background field, lighter inset — the same two tones as the shell's
// dark-mode `:root` tokens (`--bg` and `--accent`) in app.css.
const BACKGROUND = [0x10, 0x12, 0x14];
const INSET = [0x4d, 0xa3, 0xff];

for (const size of [192, 512]) {
  const bytes = renderIcon(size, BACKGROUND, INSET);
  const path = join(UI_DIR, `icon-${String(size)}.png`);
  writeFileSync(path, bytes);
  console.log(`wrote ${path} (${String(bytes.length)} bytes)`);
}
