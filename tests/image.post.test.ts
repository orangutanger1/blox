import { describe, expect, it } from 'vitest';
import jpeg from 'jpeg-js';
import { encodePng } from '../src/present/square.js';
import { decodePngRgba } from '../src/present/pixels.js';
import { cutout } from '../src/image/post.js';

// 100x100: white background, red disc r=30 at the centre, a white dot r=4 inside it.
function disc(alpha = false): { w: number; h: number; rgba: Uint8Array } {
  const w = 100, h = 100, rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const d = Math.hypot(x - 50, y - 50);
      const c = d < 4 ? [255, 255, 255] : d < 30 ? [220, 30, 30] : [255, 255, 255];
      rgba.set([...c, alpha && d >= 30 ? 0 : 255], (y * w + x) * 4);
    }
  return { w, h, rgba };
}
const at = (img: { w: number; rgba: Uint8Array }, x: number, y: number) => Array.from(img.rgba.subarray((y * img.w + x) * 4, (y * img.w + x) * 4 + 4));

describe('cutout', () => {
  it('removes the border-connected white but keeps white inside the object', () => {
    const d = disc();
    const out = decodePngRgba(cutout(encodePng(d.w, d.h, d.rgba), { size: 64 }))!;
    expect([out.w, out.h]).toEqual([64, 64]);
    expect(at(out, 1, 1)[3]).toBe(0); // background gone
    expect(at(out, 32, 32)[3]).toBe(255); // inner white dot kept
    expect(at(out, 32, 32)[0]).toBeGreaterThan(200);
    expect(at(out, 32, 12)[0]).toBeGreaterThan(150); // red disc kept
  });
  it('trims to the object then pads to a square with a margin', () => {
    const d = disc();
    const out = decodePngRgba(cutout(encodePng(d.w, d.h, d.rgba), { size: 64, margin: 0 }))!;
    expect(at(out, 32, 0)[3]).toBe(255); // disc touches the top edge after trim
  });
  it('keeps an image that already has alpha as it is', () => {
    const d = disc(true);
    for (let i = 0; i < 4; i++) d.rgba[(50 * 100 + 50) * 4 + 3] = 255;
    const out = decodePngRgba(cutout(encodePng(d.w, d.h, d.rgba), { size: 100, margin: 0, trim: false }))!;
    expect(at(out, 1, 1)[3]).toBe(0);
    expect(at(out, 50, 50)).toEqual([255, 255, 255, 255]);
  });
  it('reads JPEG (the Flux backend)', () => {
    const d = disc();
    const j = Buffer.from(jpeg.encode({ data: d.rgba, width: d.w, height: d.h }, 95).data);
    const out = decodePngRgba(cutout(j, { size: 32 }))!;
    expect(out.w).toBe(32);
    expect(at(out, 0, 0)[3]).toBe(0);
  });
});
