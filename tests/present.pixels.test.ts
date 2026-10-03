import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { makePng } from './helpers/png.js';
import { colourGrid, decodeJpegDc, decodePng, decodeSmall, gridDiff, pixelStats } from '../src/present/pixels.js';

const fx = (n: string) => readFileSync(new URL(`./fixtures/present/${n}`, import.meta.url));

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
