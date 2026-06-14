import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadImageFromFile, imageFromBytes, MAX_IMAGE_BYTES } from '../src/agent/imageInput.js';

// 1x1 transparent PNG.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const tmp: string[] = [];
function fixture(name: string, bytes: Buffer): string {
  const p = join(tmpdir(), `blox-img-${Date.now()}-${name}`);
  writeFileSync(p, bytes);
  tmp.push(p);
  return p;
}
afterEach(() => {
  for (const p of tmp.splice(0)) rmSync(p, { force: true });
});

describe('loadImageFromFile', () => {
  it('reads a png into base64 with the right media type', () => {
    const img = loadImageFromFile(fixture('a.png', PNG_1X1));
    expect(img.mediaType).toBe('image/png');
    expect(img.base64).toBe(PNG_1X1.toString('base64'));
  });

  it('maps .jpg and .jpeg to image/jpeg (extension-based)', () => {
    expect(loadImageFromFile(fixture('a.jpg', Buffer.from([1, 2, 3]))).mediaType).toBe('image/jpeg');
    expect(loadImageFromFile(fixture('a.jpeg', Buffer.from([1, 2, 3]))).mediaType).toBe('image/jpeg');
  });

  it('rejects an unsupported extension', () => {
    expect(() => loadImageFromFile(fixture('a.gif', Buffer.from([1])))).toThrow(/unsupported image type/);
  });

  it('rejects a missing file', () => {
    expect(() => loadImageFromFile(join(tmpdir(), 'does-not-exist.png'))).toThrow(/cannot read image/);
  });

  it('rejects an empty file', () => {
    expect(() => loadImageFromFile(fixture('e.png', Buffer.alloc(0)))).toThrow(/empty/);
  });

  it('rejects an oversize file', () => {
    expect(() => loadImageFromFile(fixture('big.png', Buffer.alloc(MAX_IMAGE_BYTES + 1)))).toThrow(/too large/);
  });
});

describe('imageFromBytes', () => {
  it('builds ImageInput from bytes + content-type', () => {
    const img = imageFromBytes('image/png', Buffer.from([1, 2, 3]));
    expect(img).toEqual({ mediaType: 'image/png', base64: Buffer.from([1, 2, 3]).toString('base64') });
  });

  it('rejects a non-image content-type', () => {
    expect(() => imageFromBytes('text/plain', Buffer.from([1]))).toThrow(/content-type/);
  });

  it('rejects empty and oversize bodies', () => {
    expect(() => imageFromBytes('image/png', Buffer.alloc(0))).toThrow(/empty/);
    expect(() => imageFromBytes('image/png', Buffer.alloc(MAX_IMAGE_BYTES + 1))).toThrow(/too large/);
  });
});
