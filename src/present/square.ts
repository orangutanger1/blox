import { deflateSync, crc32 } from 'node:zlib';
import jpeg from 'jpeg-js';
import { decodePngFull } from './pixels.js';

// Roblox experience icons are square (512×512); Studio captures the viewport
// (16:9). Centre-crop the capture to a square, box-resize it, encode a PNG.

export const ICON_SIZE = 512;

export function squareIconFromCapture(buf: Buffer, size = ICON_SIZE): Buffer {
  if (buf.readUInt32BE(0) === 0x89504e47) {
    const img = decodePngFull(buf);
    if (!img) throw new Error('icon capture: unreadable PNG');
    const rgba = new Uint8Array(img.w * img.h * 4);
    for (let k = 0; k < img.w * img.h; k++) {
      rgba[k * 4] = img.rgb[k * 3];
      rgba[k * 4 + 1] = img.rgb[k * 3 + 1];
      rgba[k * 4 + 2] = img.rgb[k * 3 + 2];
      rgba[k * 4 + 3] = 255;
    }
    return squareIcon(img.w, img.h, rgba, size);
  }
  const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 512 });
  return squareIcon(img.width, img.height, img.data, size);
}

export function squareIcon(w: number, h: number, rgba: Uint8Array, size = ICON_SIZE): Buffer {
  const side = Math.min(w, h);
  const x0 = Math.floor((w - side) / 2);
  const y0 = Math.floor((h - side) / 2);
  const out = new Uint8Array(size * size * 4);
  const scale = side / size;
  for (let y = 0; y < size; y++) {
    const sy0 = y0 + Math.floor(y * scale);
    const sy1 = Math.max(sy0 + 1, y0 + Math.floor((y + 1) * scale));
    for (let x = 0; x < size; x++) {
      const sx0 = x0 + Math.floor(x * scale);
      const sx1 = Math.max(sx0 + 1, x0 + Math.floor((x + 1) * scale));
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * w + sx) * 4;
          r += rgba[i];
          g += rgba[i + 1];
          b += rgba[i + 2];
          n++;
        }
      }
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = 255;
    }
  }
  return encodePng(size, size, out);
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export function encodePng(w: number, h: number, rgba: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
