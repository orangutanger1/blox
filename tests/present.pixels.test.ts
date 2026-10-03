import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { colourGrid, decodeJpegDc, decodePng, decodeSmall, gridDiff, pixelStats } from '../src/present/pixels.js';

const fx = (n: string) => readFileSync(new URL(`./fixtures/present/${n}`, import.meta.url));

// Minimal PNG encoder for tests: 8-bit, one filter type for every row.
function crc32(b: Buffer): number {
  let c = ~0;
  for (const x of b) {
    c ^= x;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function makePng(w: number, h: number, colorType: 0 | 2 | 4 | 6, px: (x: number, y: number) => number[], filter = 0): Buffer {
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  const raw: number[] = [];
  let prev = new Array(w * ch).fill(0);
  for (let y = 0; y < h; y++) {
    const row: number[] = [];
    for (let x = 0; x < w; x++) row.push(...px(x, y).slice(0, ch));
    raw.push(filter);
    for (let i = 0; i < row.length; i++) {
      const a = i >= ch ? row[i - ch] : 0;
      const b = prev[i];
      const c = i >= ch ? prev[i - ch] : 0;
      const p = a + b - c;
      const pr = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      const pred = [0, a, b, (a + b) >> 1, pr][filter];
      raw.push((row[i] - pred) & 255);
    }
    prev = row;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from(raw))), chunk('IEND', Buffer.alloc(0))]);
}

describe('decodeJpegDc (baseline, 4:2:0 fixtures made by Blender)', () => {
  it('flat grey → 1/8 scale, mean ~128, no spread', () => {
    const img = decodeJpegDc(fx('flat.jpg'))!;
    expect([img.w, img.h]).toEqual([8, 6]);
    const s = pixelStats(img);
    expect(s.mean).toBeGreaterThan(122);
    expect(s.mean).toBeLessThan(134);
    expect(s.std).toBeLessThan(2);
  });
  it('gradient: dark left, bright right, wide spread', () => {
    const img = decodeJpegDc(fx('gradient.jpg'))!;
    expect(img.luma[0]).toBeLessThan(40);
    expect(img.luma[img.w - 1]).toBeGreaterThan(215);
    expect(pixelStats(img).std).toBeGreaterThan(60);
  });
  it('split: red left, blue right (chroma upsampled)', () => {
    const img = decodeJpegDc(fx('split.jpg'))!;
    const at = (x: number) => [img.rgb[x * 3], img.rgb[x * 3 + 1], img.rgb[x * 3 + 2]];
    const [r0, g0, b0] = at(0);
    const [r1, g1, b1] = at(img.w - 1);
    expect(r0).toBeGreaterThan(200);
    expect(Math.max(g0, b0)).toBeLessThan(60);
    expect(b1).toBeGreaterThan(200);
    expect(Math.max(r1, g1)).toBeLessThan(60);
  });
  it('refuses a progressive JPEG and garbage', () => {
    const b = Buffer.from(fx('flat.jpg'));
    const i = b.indexOf(Buffer.from([0xff, 0xc0]));
    b[i + 1] = 0xc2;
    expect(decodeJpegDc(b)).toBeNull();
    expect(decodeJpegDc(Buffer.from([0xff, 0xd8, 0x00]))).toBeNull();
  });
});

describe('decodePng', () => {
  it('decodes every filter type and colour type, downscaled about 8×', () => {
    for (const filter of [0, 1, 2, 3, 4]) {
      const png = makePng(32, 16, 2, (x) => [x * 8, 255 - x * 8, 100], filter);
      const img = decodePng(png)!;
      expect([img.w, img.h]).toEqual([4, 2]);
      expect(img.rgb[0]).toBeCloseTo(28, 0); // mean of x*8 over x 0..7
      expect(img.rgb[2]).toBeCloseTo(100, 0);
    }
    expect(decodePng(makePng(16, 16, 0, () => [200]))!.luma[0]).toBeCloseTo(200, 0);
    expect(decodePng(makePng(16, 16, 4, () => [50, 255]))!.luma[0]).toBeCloseTo(50, 0);
    expect(decodePng(makePng(16, 16, 6, () => [0, 0, 255, 255]))!.rgb[2]).toBeCloseTo(255, 0);
  });
  it('decodeSmall dispatches on magic bytes', () => {
    expect(decodeSmall(makePng(8, 8, 0, () => [9]))!.luma[0]).toBeCloseTo(9, 0);
    expect(decodeSmall(fx('flat.jpg'))!.w).toBe(8);
    expect(decodeSmall(Buffer.from('nope'))).toBeNull();
  });
});

describe('colourGrid / gridDiff', () => {
  it('near-identical images differ little, different ones a lot', () => {
    const a = decodePng(makePng(160, 90, 2, (x, y) => (((x >> 4) + (y >> 4)) % 2 ? [230, 200, 40] : [20, 60, 200])))!;
    const b = decodePng(makePng(160, 90, 2, (x, y) => (((x >> 4) + (y >> 4)) % 2 ? [226, 204, 44] : [24, 58, 196])))!;
    const c = decodePng(makePng(160, 90, 2, (x) => (x < 80 ? [20, 60, 200] : [230, 200, 40])))!;
    expect(colourGrid(a).length).toBe(16 * 9 * 3);
    expect(gridDiff(colourGrid(a), colourGrid(b))).toBeLessThan(5);
    expect(gridDiff(colourGrid(a), colourGrid(c))).toBeGreaterThan(40);
  });
});
