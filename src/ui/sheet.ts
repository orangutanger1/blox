import jpeg from 'jpeg-js';
import { decodePngRgba } from '../present/pixels.js';

// Contact sheets from Studio captures (JPEG): crop the device rect out of each
// capture, then lay the crops out in a grid — one row per state, one column per
// device, every cell scaled to the same height — so the agent judges all of
// them in one image.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Rgba {
  w: number;
  h: number;
  data: Uint8Array;
}

const GAP = 8;
const BG = 28;
const MISSING = 60;
const MAX_SIDE = 8192;

function decode(b: Buffer): Rgba | null {
  if (b[0] === 0x89 && b[1] === 0x50) {
    const p = decodePngRgba(b);
    return p ? { w: p.w, h: p.h, data: p.rgba } : null;
  }
  try {
    const d = jpeg.decode(b, { useTArray: true, maxResolutionInMP: 64 });
    return { w: d.width, h: d.height, data: d.data };
  } catch {
    return null;
  }
}

const encode = (img: Rgba, quality = 88) => Buffer.from(jpeg.encode({ data: img.data, width: img.w, height: img.h }, quality).data);

// r in capture pixels, or in viewport units when `viewport` (its width) is given:
// Studio's capture size need not match the viewport size Luau reports.
export function cropJpeg(b: Buffer, rect: Rect, viewport?: number): Buffer | null {
  const src = decode(b);
  if (!src) return null;
  const f = viewport ? src.w / viewport : 1;
  const r = { x: rect.x * f, y: rect.y * f, w: rect.w * f, h: rect.h * f };
  const x0 = Math.max(0, Math.floor(r.x));
  const y0 = Math.max(0, Math.floor(r.y));
  const w = Math.min(src.w - x0, Math.round(r.w));
  const h = Math.min(src.h - y0, Math.round(r.h));
  if (w <= 0 || h <= 0) return null;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) data.set(src.data.subarray(((y0 + y) * src.w + x0) * 4, ((y0 + y) * src.w + x0 + w) * 4), y * w * 4);
  return encode({ w, h, data });
}

// rows[r][c]: a JPEG or null (capture failed: a grey cell). cellH: cell height in px.
export function composeSheet(rows: (Buffer | null)[][], cellH = 360): Buffer {
  const imgs = rows.map((row) => row.map((b) => (b ? decode(b) : null)));
  const cols = Math.max(1, ...imgs.map((r) => r.length));
  const colW = Array.from({ length: cols }, (_, c) => {
    const ws = imgs.map((r) => r[c]).filter((x): x is Rgba => !!x).map((x) => Math.round((x.w * cellH) / x.h));
    return ws.length ? Math.max(...ws) : Math.round((cellH * 16) / 9);
  });
  const W = Math.min(MAX_SIDE, GAP + colW.reduce((a, w) => a + w + GAP, 0));
  const H = Math.min(MAX_SIDE, GAP + rows.length * (cellH + GAP));
  const out = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) out.set([BG, BG, BG, 255], i * 4);
  let y = GAP;
  for (const row of imgs) {
    let x = GAP;
    for (let c = 0; c < cols; c++) {
      const img = row[c];
      const w = img ? Math.round((img.w * cellH) / img.h) : colW[c];
      for (let dy = 0; dy < cellH && y + dy < H; dy++)
        for (let dx = 0; dx < w && x + dx < W; dx++) {
          const o = ((y + dy) * W + x + dx) * 4;
          if (!img) {
            out.set([MISSING, MISSING, MISSING, 255], o);
            continue;
          }
          const sx = Math.min(img.w - 1, Math.floor((dx * img.w) / w));
          const sy = Math.min(img.h - 1, Math.floor((dy * img.h) / cellH));
          out.set(img.data.subarray((sy * img.w + sx) * 4, (sy * img.w + sx) * 4 + 4), o);
        }
      x += colW[c] + GAP;
    }
    y += cellH + GAP;
  }
  return encode({ w: W, h: H, data: out });
}
