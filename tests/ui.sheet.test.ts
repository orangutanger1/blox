import { describe, expect, it } from 'vitest';
import jpeg from 'jpeg-js';
import { composeSheet, cropJpeg } from '../src/ui/sheet.js';

function solid(w: number, h: number, rgb: [number, number, number]): Buffer {
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([...rgb, 255], i * 4);
  return Buffer.from(jpeg.encode({ data, width: w, height: h }, 95).data);
}
const px = (b: Buffer, x: number, y: number) => {
  const d = jpeg.decode(b, { useTArray: true });
  const i = (y * d.width + x) * 4;
  return [d.data[i], d.data[i + 1], d.data[i + 2]];
};
const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) < 12);

describe('contact sheet', () => {
  it('crops a rect out of a capture', () => {
    const c = cropJpeg(solid(100, 60, [200, 30, 30]), { x: 10, y: 5, w: 40, h: 20 });
    const d = jpeg.decode(c!, { useTArray: true });
    expect([d.width, d.height]).toEqual([40, 20]);
  });
  it('lays cells out in a grid at one height, keeping colours, grey for missing', () => {
    const red = solid(80, 40, [220, 20, 20]);
    const blue = solid(40, 80, [20, 20, 220]);
    const sheet = composeSheet([[red, blue], [null, red]], 100);
    const d = jpeg.decode(sheet, { useTArray: true });
    expect(d.height).toBeGreaterThanOrEqual(200);
    expect(near(px(sheet, 20 + 8, 50 + 8), [220, 20, 20])).toBe(true);
    const grey = px(sheet, 30, 100 + 8 + 8 + 50);
    expect(Math.abs(grey[0] - grey[2]) < 12 && grey[0] < 90).toBe(true);
  });
});

describe('image size caps', () => {
  it('a sheet wider than 1600 px shrinks its cells to fit', () => {
    const wide = solid(160, 90, [40, 160, 40]);
    const sheet = composeSheet([[wide, wide, wide, wide]], 300); // natural ≈ 2170 px
    const d = jpeg.decode(sheet, { useTArray: true });
    expect(d.width).toBeLessThanOrEqual(1600);
    expect(d.width).toBeGreaterThan(1500);
    expect(near(px(sheet, d.width - 20, Math.floor(d.height / 2)), [40, 160, 40])).toBe(true); // last cell not cut off
  });
  it('shrinkJpeg keeps small images and scales big ones to maxW', async () => {
    const { shrinkJpeg } = await import('../src/ui/sheet.js');
    const small = solid(400, 200, [200, 30, 30]);
    expect(shrinkJpeg(small, 1280)).toBe(small);
    const big = shrinkJpeg(solid(2560, 1440, [200, 30, 30]), 1280);
    const d = jpeg.decode(big, { useTArray: true });
    expect([d.width, d.height]).toEqual([1280, 720]);
    expect(near(px(big, 640, 360), [200, 30, 30])).toBe(true);
  });
});
