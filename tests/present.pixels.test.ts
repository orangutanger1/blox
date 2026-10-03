import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { makePng } from './helpers/png.js';
import { deflateSync } from 'node:zlib';
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

describe('decoder robustness (review 2026-10-03)', () => {
  const close = (a: Float32Array, b: Float32Array) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
  it('restart markers: same picture as without them', () => {
    const a = decodeJpegDc(fx('rst.jpg'))!;
    const b = decodeJpegDc(fx('norst.jpg'))!;
    expect([a.w, a.h]).toEqual([b.w, b.h]);
    expect(close(a.luma, b.luma)).toBeLessThan(4);
  });
  it('4:4:4 odd size and grayscale decode', () => {
    const c = decodeJpegDc(fx('odd444.jpg'))!;
    expect([c.w, c.h]).toEqual([5, 4]);
    expect(c.rgb[0]).toBeLessThan(40); // top-left dark red/green
    const g = decodeJpegDc(fx('gray.jpg'))!;
    expect([g.w, g.h]).toEqual([5, 4]);
    expect(g.luma[g.w - 1]).toBeGreaterThan(g.luma[0]);
  });
  const patchSof = (mut: (b: Buffer, sof: number) => void) => {
    const b = Buffer.from(fx('flat.jpg'));
    mut(b, b.indexOf(Buffer.from([0xff, 0xc0])));
    return b;
  };
  it('sampling factor 0 → null, quickly', () => {
    const t0 = Date.now();
    expect(decodeJpegDc(patchSof((b, i) => (b[i + 11] = 0x00)))).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
  });
  it('huge declared size → null, quickly', () => {
    const t0 = Date.now();
    expect(decodeJpegDc(patchSof((b, i) => (b.writeUInt16BE(30000, i + 5), b.writeUInt16BE(30000, i + 7))))).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
  });
  it('truncated scan → null', () => {
    const b = fx('gradient.jpg');
    expect(decodeJpegDc(b.subarray(0, b.indexOf(Buffer.from([0xff, 0xda])) + 40))).toBeNull();
  });
  it('malformed PNGs return null instead of throwing; inflate is bounded', () => {
    const good = makePng(16, 16, 0, () => [9]);
    const shortIhdr = Buffer.from(good);
    shortIhdr.writeUInt32BE(2, 8);
    expect(() => decodePng(shortIhdr)).not.toThrow();
    expect(decodePng(shortIhdr)).toBeNull();
    // 16×16 header, but the IDAT inflates to 50 MB
    const bomb = makePng(16, 16, 0, () => [9]);
    const i = bomb.indexOf('IDAT');
    const z = deflateSync(Buffer.alloc(50 * 1024 * 1024));
    const len = Buffer.alloc(4);
    len.writeUInt32BE(z.length);
    const bad = Buffer.concat([bomb.subarray(0, i - 4), len, Buffer.from('IDAT'), z, Buffer.alloc(4), bomb.subarray(bomb.indexOf('IEND') - 4)]);
    expect(decodePng(bad)).toBeNull();
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

describe('decoders against independent encoders (blox)', () => {
  // The scene make-pillow-fixtures.py draws: x/y gradients, a noisy blue.
  const expected = (bx: number, by: number) => {
    const sum = [0, 0, 0];
    for (let y = by * 8; y < by * 8 + 8; y++) for (let x = bx * 8; x < bx * 8 + 8; x++) {
      sum[0] += Math.trunc((255 * x) / 63);
      sum[1] += Math.trunc((255 * y) / 47);
      sum[2] += (x * 37 + y * 91) % 256;
    }
    return sum.map((v) => v / 64);
  };
  for (const f of ['pillow-filters.png', 'ffmpeg-up.png', 'ffmpeg-avg.png', 'ffmpeg-paeth.png']) {
    it(`${f}: every 8×8 block matches the drawn colours`, () => {
      const img = decodePng(fx(f))!;
      expect([img.w, img.h]).toEqual([8, 6]);
      for (let by = 0; by < 6; by++) for (let bx = 0; bx < 8; bx++) {
        const want = expected(bx, by);
        for (let c = 0; c < 3; c++) expect(img.rgb[(by * 8 + bx) * 3 + c]).toBeCloseTo(want[c], 3);
      }
    });
  }
  it('an Adobe RGB JPEG (transform 0) is read as RGB, not YCbCr', () => {
    const img = decodeJpegDc(fx('adobergb.jpg'))!;
    const want = [Math.trunc((255 * 3.5) / 63), Math.trunc((255 * 3.5) / 47), 128];
    for (let c = 0; c < 3; c++) expect(Math.abs(img.rgb[c] - want[c])).toBeLessThan(8);
  });
  it('fill bytes (FF FF …) before a marker are skipped', () => {
    const b = fx('flat.jpg');
    const at = b.indexOf(Buffer.from([0xff, 0xdb]));
    const padded = Buffer.concat([b.subarray(0, at), Buffer.from([0xff, 0xff, 0xff]), b.subarray(at)]);
    expect(pixelStats(decodeJpegDc(padded)!).mean).toBeCloseTo(pixelStats(decodeJpegDc(b)!).mean, 5);
  });
  it('stats of an empty image are zeros, not NaN', () => {
    expect(pixelStats({ w: 0, h: 0, luma: new Float32Array(0), rgb: new Float32Array(0) })).toEqual({ mean: 0, std: 0, p5: 0, p95: 0 });
  });
});
