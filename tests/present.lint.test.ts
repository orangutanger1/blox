import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { imageSize } from '../src/present/image.js';
import { lintPresentation, presentResults, formatPresentLint } from '../src/present/lint.js';
import type { Presentation, Shot } from '../src/present/schema.js';
import { makePng } from './helpers/png.js';

function png(w: number, h: number, salt = 0): Buffer {
  const b = Buffer.alloc(33 + salt);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
function jpeg(w: number, h: number): Buffer {
  // SOI, APP0 (len 4 + 2 bytes), SOF0 with height/width
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03]);
}

describe('imageSize', () => {
  it('reads PNG and JPEG headers', () => {
    expect(imageSize(png(1920, 1080))).toEqual({ w: 1920, h: 1080 });
    expect(imageSize(jpeg(1280, 720))).toEqual({ w: 1280, h: 720 });
    expect(imageSize(Buffer.from('nope'))).toBeNull();
  });
});

const cam = (x: number) => ({ position: [x, 5, 0] as [number, number, number], lookAt: [0, 3, -12] as [number, number, number] });
const THEMES = ['action', 'exploration', 'character', 'reward', 'social'] as const;
function project(shots: Partial<Shot>[] = [], files: Record<string, Buffer> = {}) {
  const p = mkdtempSync(join(tmpdir(), 'blox-present-'));
  mkdirSync(join(p, '.blox/artifacts/present'), { recursive: true });
  for (const [f, b] of Object.entries(files)) writeFileSync(join(p, f), b);
  const doc: Presentation = { version: 1, title: 'Carve A Snow Beast', description: '⭐ Welcome!\nHow to Play:\n🏃 Run', shots: shots as Shot[] };
  return { p, doc };
}
function goodShots(): { shots: Partial<Shot>[]; files: Record<string, Buffer> } {
  const files: Record<string, Buffer> = {};
  const shots: Partial<Shot>[] = THEMES.map((theme, i) => {
    const file = `.blox/artifacts/present/${theme}.png`;
    files[file] = scene(i);
    return { id: theme, kind: 'thumbnail', theme, camera: cam(i * 10), file, provenance: 'render' };
  });
  shots.push({ id: 'icon', kind: 'icon', theme: 'logo', camera: cam(99), overlay: { text: 'CARVE' } });
  return { shots, files };
}
// A real 160×90 picture per index: a dark and a light field split at a different place.
const DARKS = [[120, 20, 20], [20, 90, 30], [20, 30, 120], [90, 80, 10], [70, 20, 90]];
const LIGHTS = [[250, 220, 120], [200, 240, 250], [250, 200, 220], [210, 250, 200], [240, 240, 240]];
const split = (i: number, x: number, y: number) => x + (i % 2 ? 0.5 : -0.5) * y < 40 + i * 15;
function scene(i: number): Buffer {
  return makePng(160, 90, 2, (x, y) => (split(i, x, y) ? DARKS[i] : LIGHTS[i]));
}
const rules = (doc: Presentation, p: string) => lintPresentation(doc, p).map((f) => `${f.rule}:${f.severity}`);

describe('lintPresentation', () => {
  it('a complete, rendered, varied set is clean', () => {
    const { shots, files } = goodShots();
    const { p, doc } = project(shots, files);
    expect(rules(doc, p)).toEqual([]);
  });
  it('title rules', () => {
    const { shots, files } = goodShots();
    const { p, doc } = project(shots, files);
    const t = (title: string) => rules({ ...doc, title }, p);
    expect(t('x'.repeat(51))).toEqual(['title-length:error']);
    expect(t('Roblox Pet Simulator')).toEqual(['title-roblox:error']);
    expect(t('[UPD] [🎃] Pets')).toEqual(['title-tags:error']);
    expect(t('[UPD] Pets')).toEqual([]);
    expect(t('STEAL A BRAINROT NOW')).toEqual(['title-caps:error']);
    expect(t('RIVALS')).toEqual([]);
  });
  it('description rules', () => {
    const { shots, files } = goodShots();
    const { p, doc } = project(shots, files);
    const d = (description: string) => rules({ ...doc, description }, p);
    expect(d('x'.repeat(1001))).toEqual(['desc-length:error']);
    expect(d('Join https://discord.gg/abc')).toEqual(['desc-links:error']);
    expect(d('Get FREE ROBUX here')).toEqual(['scam:error']);
    expect(d('The #1 best game')).toEqual(['claims:warn']);
    expect(d('Like the game for a FREE pet!')).toEqual(['engagement-bait:warn']);
    expect(d('🎉'.repeat(16))).toEqual(['emoji-spam:warn']);
    expect(d('So much blood and gore')).toEqual(['mature:warn']);
  });
  it('shot rules', () => {
    const { shots, files } = goodShots();
    // duplicate theme+camera, generated art, wrong aspect, duplicate file, missing icon
    shots[1] = { ...shots[1], theme: 'action', camera: shots[0].camera };
    shots[2] = { ...shots[2], provenance: 'generated' };
    files[shots[3].file!] = png(1000, 1000);
    files[shots[4].file!] = files[shots[0].file!];
    shots.pop();
    const { p, doc } = project(shots, files);
    // the 1000×1000 file is a header only: its pixels can't be checked (warn)
    expect(rules(doc, p).sort()).toEqual(['icon:error', 'thumb-aspect:error', 'thumb-blank:warn', 'thumb-duplicate:error', 'thumb-rendered:error', 'thumb-variety:error']);
  });
  it('pixel rules: blank, contrast, near-duplicate pictures, icon file', () => {
    const { shots, files } = goodShots();
    files[shots[0].file!] = makePng(160, 90, 2, () => [90, 90, 90]); // one flat colour
    files[shots[1].file!] = makePng(160, 90, 0, (x) => [110 + Math.round((36 * x) / 159)]); // murky: a gentle gradient
    files[shots[3].file!] = makePng(160, 90, 2, (x, y) => (split(2, x - 3, y) ? DARKS[2] : [245, 205, 215])); // scene(2), shifted 3 px
    shots[5] = { ...shots[5], file: '.blox/artifacts/present/icon.png', provenance: 'render' };
    files['.blox/artifacts/present/icon.png'] = makePng(160, 90, 2, () => [0, 0, 0]);
    const { p, doc } = project(shots, files);
    const f = lintPresentation(doc, p);
    expect(f.map((x) => `${x.rule}:${x.severity}:${x.where}`).sort()).toEqual([
      'thumb-blank:error:action', 'thumb-blank:error:icon', 'thumb-contrast:warn:exploration', 'thumb-similar:error:reward',
    ]);
    expect(f.find((x) => x.rule === 'thumb-similar')!.detail).toMatch(/character/);
  });
  it('counts and missing files', () => {
    const { p, doc } = project([{ id: 'a', kind: 'thumbnail', theme: 'action', camera: cam(0) }, { id: 'icon', kind: 'icon', theme: 'logo', camera: cam(9), overlay: { text: 'TOO MANY WORDS HERE' } }]);
    expect(rules(doc, p).sort()).toEqual(['icon:error', 'thumb-count:warn', 'thumb-rendered:error']);
    expect(rules({ ...doc, shots: [] }, p).sort()).toEqual(['icon:error', 'thumb-count:error']);
  });
  it('results + format', () => {
    const { p, doc } = project([]);
    const f = lintPresentation(doc, p);
    const r = presentResults(f);
    expect(r.find((x) => x.id === 'present:thumb-count')!.ok).toBe(false);
    expect(r.find((x) => x.id === 'present:title-length')!.ok).toBe(true);
    expect(formatPresentLint(f, r)).toMatch(/^present lint: \d+\/\d+ rules pass/);
  });
});
