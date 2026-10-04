import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';

// Unpack a .zip with Node alone (no unzip binary on native Windows): read the
// central directory, inflate stored/deflated entries. Entries that would land
// outside `dir` (zip-slip) or use other methods are skipped and reported.
export function unzipTo(buf: Buffer, dir: string, maxBytes = 500 * 1024 * 1024): { files: string[]; skipped: string[] } {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory record)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files: string[] = [];
  const skipped: string[] = [];
  let total = 0;
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip central directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    const rel = normalize(name).replace(/^([/\\])+/, '');
    if (rel.startsWith('..') || rel.includes(`${sep}..${sep}`) || /^[a-zA-Z]:/.test(rel)) {
      skipped.push(`${name} (outside the folder)`);
      continue;
    }
    if (method !== 0 && method !== 8) {
      skipped.push(`${name} (compression method ${method})`);
      continue;
    }
    total += usize;
    if (total > maxBytes) throw new Error(`zip unpacks to more than ${Math.round(maxBytes / 1e6)} MB`);
    const ln = buf.readUInt16LE(local + 26);
    const lx = buf.readUInt16LE(local + 28);
    const start = local + 30 + ln + lx;
    const raw = buf.subarray(start, start + csize);
    const data = method === 0 ? raw : inflateRawSync(raw);
    const out = join(dir, rel);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, data);
    files.push(rel);
  }
  return { files, skipped };
}
