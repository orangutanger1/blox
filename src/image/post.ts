import jpeg from 'jpeg-js';
import { decodePngRgba } from '../present/pixels.js';
import { encodePng } from '../present/square.js';

// Generated art → a game icon: transparent background, trimmed to the object,
// padded square, resized. Models that return RGBA keep their alpha; otherwise
// the plain background is flood-filled from the border only (a matte model or
// a global colour key also eats white fills inside the object).

export interface CutoutOptions {
  size: number; // output side, px
  tolerance?: number; // max per-channel distance from the background colour (default 24)
  margin?: number; // fraction of the side left empty around the object (default 0.06)
  trim?: boolean; // default true
}

interface Img {
  w: number;
  h: number;
  rgba: Uint8Array;
}

export function decodeAny(b: Buffer): Img {
  if (b[0] === 0x89 && b[1] === 0x50) {
    const p = decodePngRgba(b);
    if (!p) throw new Error('unreadable PNG');
    return { w: p.w, h: p.h, rgba: p.rgba };
  }
  const j = jpeg.decode(b, { useTArray: true, maxResolutionInMP: 64 });
  return { w: j.width, h: j.height, rgba: j.data };
}

function hasAlpha(img: Img): boolean {
  let n = 0;
  for (let i = 3; i < img.rgba.length; i += 4) if (img.rgba[i] < 250) n++;
  return n > (img.w * img.h) / 200;
}

function borderColour(img: Img): [number, number, number] {
  const ch: number[][] = [[], [], []];
  const take = (x: number, y: number) => {
    const o = (y * img.w + x) * 4;
    for (let c = 0; c < 3; c++) ch[c].push(img.rgba[o + c]);
  };
  for (let x = 0; x < img.w; x++) (take(x, 0), take(x, img.h - 1));
  for (let y = 0; y < img.h; y++) (take(0, y), take(img.w - 1, y));
  return ch.map((v) => v.sort((a, b) => a - b)[v.length >> 1]) as [number, number, number];
}

function floodBackground(img: Img, tol: number): void {
  const { w, h, rgba } = img;
  const bg = borderColour(img);
  const diff = (i: number) => Math.max(Math.abs(rgba[i * 4] - bg[0]), Math.abs(rgba[i * 4 + 1] - bg[1]), Math.abs(rgba[i * 4 + 2] - bg[2]));
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (i: number) => {
    if (!seen[i] && diff(i) <= tol) {
      seen[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) (push(x), push((h - 1) * w + x));
  for (let y = 0; y < h; y++) (push(y * w), push(y * w + w - 1));
  while (stack.length) {
    const i = stack.pop()!;
    rgba[i * 4 + 3] = 0;
    const x = i % w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (i >= w) push(i - w);
    if (i < w * (h - 1)) push(i + w);
  }
  // Soften the edge: object pixels touching the background fade by how close they are to it.
  for (let i = 0; i < w * h; i++) {
    if (seen[i]) continue;
    const x = i % w;
    const touches = (x > 0 && seen[i - 1]) || (x < w - 1 && seen[i + 1]) || (i >= w && seen[i - w]) || (i < w * (h - 1) && seen[i + w]);
    if (touches) rgba[i * 4 + 3] = Math.min(255, Math.round((255 * diff(i)) / (2 * tol)));
  }
}

function crop(img: Img, x0: number, y0: number, x1: number, y1: number): Img {
  const w = x1 - x0, h = y1 - y0, out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) out.set(img.rgba.subarray(((y0 + y) * img.w + x0) * 4, ((y0 + y) * img.w + x1) * 4), y * w * 4);
  return { w, h, rgba: out };
}

function trimAlpha(img: Img): Img {
  let x0 = img.w, y0 = img.h, x1 = -1, y1 = -1;
  for (let y = 0; y < img.h; y++)
    for (let x = 0; x < img.w; x++)
      if (img.rgba[(y * img.w + x) * 4 + 3] > 16) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  return x1 < 0 ? img : crop(img, x0, y0, x1 + 1, y1 + 1);
}

// Centre on a transparent square canvas, then box-resample (premultiplied) to size.
function squareResize(img: Img, size: number, margin: number): Img {
  const side = Math.max(img.w, img.h) / (1 - 2 * margin);
  const ox = (side - img.w) / 2, oy = (side - img.h) / 2;
  const k = side / size;
  const out = new Uint8Array(size * size * 4);
  for (let Y = 0; Y < size; Y++)
    for (let X = 0; X < size; X++) {
      const sx0 = X * k - ox, sy0 = Y * k - oy;
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      const steps = Math.max(1, Math.ceil(k));
      for (let j = 0; j < steps; j++)
        for (let i = 0; i < steps; i++) {
          const sx = Math.floor(sx0 + ((i + 0.5) * k) / steps), sy = Math.floor(sy0 + ((j + 0.5) * k) / steps);
          n++;
          if (sx < 0 || sy < 0 || sx >= img.w || sy >= img.h) continue;
          const o = (sy * img.w + sx) * 4, al = img.rgba[o + 3];
          r += img.rgba[o] * al;
          g += img.rgba[o + 1] * al;
          b += img.rgba[o + 2] * al;
          a += al;
        }
      const o = (Y * size + X) * 4;
      if (a > 0) out.set([Math.round(r / a), Math.round(g / a), Math.round(b / a), Math.round(a / n)], o);
    }
  return { w: size, h: size, rgba: out };
}

export function cutout(buf: Buffer, o: CutoutOptions): Buffer {
  let img = decodeAny(buf);
  img = { ...img, rgba: new Uint8Array(img.rgba) };
  if (!hasAlpha(img)) floodBackground(img, o.tolerance ?? 24);
  if (o.trim !== false) img = trimAlpha(img);
  const out = squareResize(img, o.size, o.margin ?? 0.06);
  return encodePng(out.w, out.h, out.rgba);
}

// An asset sheet (one generated image, items laid out in a cols×rows grid) →
// one transparent PNG per cell, in reading order. Every opaque blob goes to the
// cell holding its centre, and a cell's crop is the union of its blobs: an item
// that spills over a cell line is kept whole, and loose bits (sparkles, a
// detached handle) stay with their item. Empty cells come back null.
export function sliceSheet(buf: Buffer, cols: number, rows: number, o: { tolerance?: number; minArea?: number } = {}): (Buffer | null)[] {
  let img = decodeAny(buf);
  img = { ...img, rgba: new Uint8Array(img.rgba) };
  if (!hasAlpha(img)) floodBackground(img, o.tolerance ?? 24);
  const { w, h, rgba } = img;
  const minArea = o.minArea ?? Math.max(4, Math.round((w * h) / 20000));
  const label = new Int32Array(w * h).fill(-1);
  const boxes: { x0: number; y0: number; x1: number; y1: number; sx: number; sy: number; n: number }[] = [];
  const solid = (i: number) => rgba[i * 4 + 3] > 16;
  for (let start = 0; start < w * h; start++) {
    if (label[start] !== -1 || !solid(start)) continue;
    const id = boxes.length;
    const b = { x0: w, y0: h, x1: -1, y1: -1, sx: 0, sy: 0, n: 0 };
    const stack = [start];
    label[start] = id;
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w, y = (i - x) / w;
      b.x0 = Math.min(b.x0, x), b.x1 = Math.max(b.x1, x), b.y0 = Math.min(b.y0, y), b.y1 = Math.max(b.y1, y);
      b.sx += x, b.sy += y, b.n++;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (label[j] === -1 && solid(j)) (label[j] = id), stack.push(j);
        }
    }
    boxes.push(b);
  }
  const cells: ({ x0: number; y0: number; x1: number; y1: number; ids: Set<number> } | null)[] = new Array(cols * rows).fill(null);
  boxes.forEach((b, id) => {
    if (b.n < minArea) return;
    const cx = Math.min(cols - 1, Math.floor((b.sx / b.n / w) * cols)), cy = Math.min(rows - 1, Math.floor((b.sy / b.n / h) * rows));
    const k = cy * cols + cx;
    const c = (cells[k] ??= { x0: w, y0: h, x1: -1, y1: -1, ids: new Set() });
    c.x0 = Math.min(c.x0, b.x0), c.y0 = Math.min(c.y0, b.y0), c.x1 = Math.max(c.x1, b.x1), c.y1 = Math.max(c.y1, b.y1);
    c.ids.add(id);
  });
  return cells.map((c) => {
    if (!c) return null;
    const out = crop(img, c.x0, c.y0, c.x1 + 1, c.y1 + 1);
    // keep only this cell's blobs: a neighbour poking into the box is cleared
    for (let y = 0; y < out.h; y++)
      for (let x = 0; x < out.w; x++) {
        const l = label[(c.y0 + y) * w + c.x0 + x];
        if (l !== -1 && !c.ids.has(l)) out.rgba[(y * out.w + x) * 4 + 3] = 0;
      }
    return encodePng(out.w, out.h, out.rgba);
  });
}
