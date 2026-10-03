import { inflateSync } from 'node:zlib';

// Small decoded images for pixel checks on store thumbnails, with no image
// library: PNG through node:zlib, baseline JPEG by DC coefficients only (each
// 8×8 block's mean, so an exact 1/8-scale image without any IDCT).

export interface SmallImage {
  w: number;
  h: number;
  luma: Float32Array; // 0..255, row-major
  rgb: Float32Array; // 0..255, 3 per pixel
}

const SCALE = 8;
// Store art is at most 1920×1080; anything far bigger is a malformed or hostile header.
const MAX_SIDE = 8192;

function fromRgb(w: number, h: number, rgb: Float32Array): SmallImage {
  const luma = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) luma[i] = 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2];
  return { w, h, luma, rgb };
}

// ---- PNG ----------------------------------------------------------------

export function decodePng(b: Buffer): SmallImage | null {
  try {
    return png(b);
  } catch {
    return null;
  }
}

function png(b: Buffer): SmallImage | null {
  if (b.length < 33 || b.readUInt32BE(0) !== 0x89504e47) return null;
  let i = 8;
  let w = 0, h = 0, depth = 0, type = -1, interlace = 0;
  let palette: Buffer | null = null;
  const idat: Buffer[] = [];
  while (i + 8 <= b.length) {
    const len = b.readUInt32BE(i);
    const kind = b.toString('ascii', i + 4, i + 8);
    const data = b.subarray(i + 8, i + 8 + len);
    if (kind === 'IHDR') {
      if (data.length < 13) return null;
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      depth = data[8];
      type = data[9];
      interlace = data[12];
    } else if (kind === 'PLTE') palette = data;
    else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    i += 12 + len;
  }
  const ch = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[type];
  if (!ch || depth !== 8 || interlace !== 0 || !w || !h || w > MAX_SIDE || h > MAX_SIDE || (type === 3 && !palette)) return null;
  const stride = w * ch;
  // Bounded: a tiny IDAT must not inflate past what the header declares.
  const raw = inflateSync(Buffer.concat(idat), { maxOutputLength: h * (stride + 1) });
  if (raw.length < h * (stride + 1)) return null;
  const sw = Math.ceil(w / SCALE), sh = Math.ceil(h / SCALE);
  const sum = new Float64Array(sw * sh * 3);
  const cnt = new Float64Array(sw * sh);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? row[x - ch] : 0;
      const up = prev[x];
      const c = x >= ch ? prev[x - ch] : 0;
      let pred = 0;
      if (f === 1) pred = a;
      else if (f === 2) pred = up;
      else if (f === 3) pred = (a + up) >> 1;
      else if (f === 4) {
        const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      } else if (f !== 0) return null;
      row[x] = (src[x] + pred) & 255;
    }
    prev = row;
    const sy = Math.floor(y / SCALE);
    for (let x = 0; x < w; x++) {
      const o = x * ch;
      let r: number, g: number, bl: number;
      if (type === 3) {
        const p = row[o] * 3;
        if (p + 2 >= palette!.length) return null;
        [r, g, bl] = [palette![p], palette![p + 1], palette![p + 2]];
      } else if (ch <= 2) r = g = bl = row[o];
      else [r, g, bl] = [row[o], row[o + 1], row[o + 2]];
      const k = sy * sw + Math.floor(x / SCALE);
      sum[k * 3] += r;
      sum[k * 3 + 1] += g;
      sum[k * 3 + 2] += bl;
      cnt[k]++;
    }
  }
  const rgb = new Float32Array(sw * sh * 3);
  for (let k = 0; k < sw * sh; k++) for (let c = 0; c < 3; c++) rgb[k * 3 + c] = sum[k * 3 + c] / cnt[k];
  return fromRgb(sw, sh, rgb);
}

// ---- JPEG (baseline / extended sequential Huffman, DC only) --------------

interface Huff {
  lookup: Map<number, number>; // (length << 16) | code → symbol
}
function buildHuff(counts: Uint8Array, symbols: Uint8Array): Huff {
  const lookup = new Map<number, number>();
  let code = 0, k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let n = 0; n < counts[len - 1]; n++) lookup.set((len << 16) | code++, symbols[k++]);
    code <<= 1;
  }
  return { lookup };
}

export function decodeJpegDc(b: Buffer): SmallImage | null {
  try {
    return jpegDc(b);
  } catch {
    return null;
  }
}

function jpegDc(b: Buffer): SmallImage | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  const qt: number[][] = [];
  const hts = new Map<number, Huff>(); // (class << 4) | id
  let frame: { w: number; h: number; comps: { id: number; h: number; v: number; tq: number }[] } | null = null;
  let restart = 0;
  // Adobe APP14 transform 0 (or components named R, G, B): the three
  // components are RGB already, not YCbCr.
  let adobeTransform = -1;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m === 0xff) {
      i++; // a fill byte before the marker
      continue;
    }
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) {
      i += 2;
      continue;
    }
    if (m === 0xd9) return null;
    const len = b.readUInt16BE(i + 2);
    const seg = b.subarray(i + 4, i + 2 + len);
    if (m === 0xdb) {
      let p = 0;
      while (p < seg.length) {
        const pq = seg[p] >> 4, tq = seg[p] & 15;
        const q: number[] = [];
        for (let k = 0; k < 64; k++) q.push(pq ? seg.readUInt16BE(p + 1 + 2 * k) : seg[p + 1 + k]);
        qt[tq] = q;
        p += 1 + (pq ? 128 : 64);
      }
    } else if (m === 0xc4) {
      let p = 0;
      while (p < seg.length) {
        const tc = seg[p] >> 4, th = seg[p] & 15;
        const counts = seg.subarray(p + 1, p + 17);
        const total = counts.reduce((s, x) => s + x, 0);
        hts.set((tc << 4) | th, buildHuff(counts, seg.subarray(p + 17, p + 17 + total)));
        p += 17 + total;
      }
    } else if (m === 0xc0 || m === 0xc1) {
      if (seg[0] !== 8) return null;
      const n = seg[5];
      if (n !== 1 && n !== 3) return null; // grey or YCbCr; CMYK is not handled
      const comps = [];
      for (let k = 0; k < n; k++) comps.push({ id: seg[6 + 3 * k], h: seg[7 + 3 * k] >> 4, v: seg[7 + 3 * k] & 15, tq: seg[8 + 3 * k] });
      if (comps.some((c) => c.h < 1 || c.h > 4 || c.v < 1 || c.v > 4)) return null;
      frame = { h: seg.readUInt16BE(1), w: seg.readUInt16BE(3), comps };
      if (!frame.w || !frame.h || frame.w > MAX_SIDE || frame.h > MAX_SIDE) return null;
    } else if (m >= 0xc2 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return null; // progressive, lossless, arithmetic: not supported
    } else if (m === 0xdd) {
      restart = seg.readUInt16BE(0);
    } else if (m === 0xee) {
      if (seg.length >= 12 && seg.toString('ascii', 0, 5) === 'Adobe') adobeTransform = seg[11];
    } else if (m === 0xda) {
      if (!frame) return null;
      const ns = seg[0];
      const scan: { ci: number; dc: Huff; ac: Huff }[] = [];
      for (let k = 0; k < ns; k++) {
        const ci = frame.comps.findIndex((c) => c.id === seg[1 + 2 * k]);
        const t = seg[2 + 2 * k];
        const dc = hts.get(t >> 4), ac = hts.get(16 | (t & 15));
        if (ci < 0 || !dc || !ac) return null;
        scan.push({ ci, dc, ac });
      }
      // Only a full interleaved scan (or a one-component image) is handled.
      if (ns !== frame.comps.length) return null;
      const rgbComps = frame.comps.length === 3 && (adobeTransform === 0 || (adobeTransform < 0 && frame.comps.map((c) => c.id).join() === '82,71,66'));
      return decodeScan(b, i + 2 + len, frame, scan, qt, restart, rgbComps);
    }
    i += 2 + len;
  }
  return null;
}

function decodeScan(
  b: Buffer,
  start: number,
  frame: { w: number; h: number; comps: { id: number; h: number; v: number; tq: number }[] },
  scan: { ci: number; dc: Huff; ac: Huff }[],
  qt: number[][],
  restart: number,
  rgbComps = false,
): SmallImage | null {
  let pos = start, bitBuf = 0, bitCnt = 0, marker = false;
  const readBit = (): number => {
    if (bitCnt === 0) {
      // Needing bits past a marker or the end of the file means the data is broken.
      if (marker || pos >= b.length) throw new Error('truncated scan');
      let x = b[pos++];
      if (x === 0xff) {
        const nx = b[pos];
        if (nx === 0x00) pos++;
        else {
          marker = true;
          pos--;
          x = 0;
        }
      }
      bitBuf = x;
      bitCnt = 8;
    }
    bitCnt--;
    return (bitBuf >> bitCnt) & 1;
  };
  const decode = (t: Huff): number => {
    let code = 0;
    for (let len = 1; len <= 16; len++) {
      code = (code << 1) | readBit();
      const s = t.lookup.get((len << 16) | code);
      if (s !== undefined) return s;
    }
    throw new Error('bad huffman code');
  };
  const receive = (s: number): number => {
    let v = 0;
    for (let k = 0; k < s; k++) v = (v << 1) | readBit();
    return v < 1 << (s - 1) ? v - (1 << s) + 1 : v;
  };
  const comps = frame.comps;
  const hmax = Math.max(...comps.map((c) => c.h)), vmax = Math.max(...comps.map((c) => c.v));
  const single = comps.length === 1;
  const mcuX = single ? Math.ceil(frame.w / 8) : Math.ceil(frame.w / (8 * hmax));
  const mcuY = single ? Math.ceil(frame.h / 8) : Math.ceil(frame.h / (8 * vmax));
  const grids = comps.map((c) => {
    const bw = single ? mcuX : mcuX * c.h, bh = single ? mcuY : mcuY * c.v;
    return { bw, bh, dc: new Float32Array(bw * bh) };
  });
  const pred = new Array(comps.length).fill(0);
  let mcus = 0;
  for (let my = 0; my < mcuY; my++) {
    for (let mx = 0; mx < mcuX; mx++) {
      if (restart && mcus > 0 && mcus % restart === 0) {
        // Byte-align (the rest of the byte is padding), step over the RSTn
        // marker (fill bytes may precede it), reset the predictors.
        bitCnt = 0;
        while (pos + 1 < b.length && !(b[pos] === 0xff && b[pos + 1] >= 0xd0 && b[pos + 1] <= 0xd7)) pos++;
        if (pos + 1 >= b.length) throw new Error('missing restart marker');
        pos += 2;
        marker = false;
        pred.fill(0);
      }
      for (const s of scan) {
        const c = comps[s.ci];
        const hs = single ? 1 : c.h, vs = single ? 1 : c.v;
        for (let v = 0; v < vs; v++) {
          for (let h = 0; h < hs; h++) {
            const t = decode(s.dc);
            pred[s.ci] += t ? receive(t) : 0;
            for (let k = 1; k < 64; ) {
              const rs = decode(s.ac);
              const r = rs >> 4, sz = rs & 15;
              if (sz === 0) {
                if (r !== 15) break;
                k += 16;
              } else {
                k += r;
                receive(sz);
                k++;
              }
            }
            const g = grids[s.ci];
            const bx = mx * hs + h, by = my * vs + v;
            g.dc[by * g.bw + bx] = (pred[s.ci] * qt[c.tq][0]) / 8 + 128;
          }
        }
      }
      mcus++;
    }
  }
  const w = Math.ceil(frame.w / 8), h = Math.ceil(frame.h / 8);
  const at = (ci: number, x: number, y: number): number => {
    const c = comps[ci], g = grids[ci];
    const gx = Math.min(g.bw - 1, Math.floor((x * (single ? 1 : c.h)) / hmax));
    const gy = Math.min(g.bh - 1, Math.floor((y * (single ? 1 : c.v)) / vmax));
    return g.dc[gy * g.bw + gx];
  };
  const rgb = new Float32Array(w * h * 3);
  const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = (y * w + x) * 3;
      const Y = at(0, x, y);
      if (rgbComps) {
        rgb[k] = clamp(Y);
        rgb[k + 1] = clamp(at(1, x, y));
        rgb[k + 2] = clamp(at(2, x, y));
      } else if (comps.length >= 3) {
        const cb = at(1, x, y) - 128, cr = at(2, x, y) - 128;
        rgb[k] = clamp(Y + 1.402 * cr);
        rgb[k + 1] = clamp(Y - 0.344136 * cb - 0.714136 * cr);
        rgb[k + 2] = clamp(Y + 1.772 * cb);
      } else rgb[k] = rgb[k + 1] = rgb[k + 2] = clamp(Y);
    }
  }
  return fromRgb(w, h, rgb);
}

export function decodeSmall(b: Buffer): SmallImage | null {
  if (b.length >= 4 && b.readUInt32BE(0) === 0x89504e47) return decodePng(b);
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xd8) return decodeJpegDc(b);
  return null;
}

// ---- statistics ----------------------------------------------------------

export function pixelStats(img: SmallImage): { mean: number; std: number; p5: number; p95: number } {
  const n = img.luma.length;
  if (n === 0) return { mean: 0, std: 0, p5: 0, p95: 0 };
  let s = 0;
  for (const v of img.luma) s += v;
  const mean = s / n;
  let q = 0;
  for (const v of img.luma) q += (v - mean) ** 2;
  const sorted = Float32Array.from(img.luma).sort();
  const pct = (p: number) => sorted[Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))))];
  return { mean, std: Math.sqrt(q / n), p5: pct(0.05), p95: pct(0.95) };
}

const GRID_W = 16, GRID_H = 9;

// 16×9 box-averaged colour grid (0..255, 3 per cell): a tiny fingerprint for
// "same picture" checks that survives re-encoding and small changes.
export function colourGrid(img: SmallImage): Float64Array {
  const g = new Float64Array(GRID_W * GRID_H * 3);
  const cnt = new Float64Array(GRID_W * GRID_H);
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const k = Math.min(GRID_H - 1, Math.floor((y * GRID_H) / img.h)) * GRID_W + Math.min(GRID_W - 1, Math.floor((x * GRID_W) / img.w));
      for (let c = 0; c < 3; c++) g[k * 3 + c] += img.rgb[(y * img.w + x) * 3 + c];
      cnt[k]++;
    }
  }
  for (let i = 0; i < g.length; i++) g[i] = cnt[Math.floor(i / 3)] ? g[i] / cnt[Math.floor(i / 3)] : 0;
  return g;
}

// Mean absolute difference of two colour grids (0..255). Live 2026-10-03:
// distinct store shots of one place differ by 24-58; re-renders of one shot
// by a few.
export function gridDiff(a: Float64Array, b: Float64Array): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  return d / a.length;
}
