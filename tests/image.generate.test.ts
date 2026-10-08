import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodePng } from '../src/present/square.js';
import { generateImages, STYLES, type ImageBackend } from '../src/image/generate.js';
import { KaggleUnavailable } from '../src/image/kaggle.js';
import { loadManifest } from '../src/assets/manifest.js';
import { writeJson } from '../src/state/store.js';
import { releaseCheck } from '../src/release/check.js';

const png = () => { const rgba = new Uint8Array(40 * 40 * 4).fill(255); for (let i = 0; i < 400; i++) rgba.set([200, 20, 20, 255], (10 * 40 + 10 + (i % 20) + 40 * Math.floor(i / 20)) * 4); return encodePng(40, 40, rgba); };
const ok = (name: string): ImageBackend => ({ name: name as any, model: 'm', licence: name === 'kaggle-qwen' ? 'qwen-research' : 'apache-2.0', run: async (items) => items.map((i) => ({ file: i.file, seed: i.seed, data: png() })) });
const down: ImageBackend = { name: 'kaggle-qwen', model: 'Qwen-Image-2.1', licence: 'qwen-research', run: async () => { throw new KaggleUnavailable('quota'); } };
const proj = () => mkdtempSync(join(tmpdir(), 'blox-img-'));

describe('generateImages', () => {
  it('writes icons, records provenance with model, prompt, seed and licence', async () => {
    const P = proj();
    let seen: string[] = [];
    const b = ok('kaggle-qwen');
    const run = b.run;
    b.run = async (items, o) => { seen = items.map((i) => i.prompt); return run(items, o); };
    const r = await generateImages(P, { items: [{ name: 'coin', prompt: 'a gold coin' }] }, { backends: [b] });
    expect(existsSync(join(P, 'assets/icons/coin.png'))).toBe(true);
    expect(seen[0]).toContain('a gold coin');
    expect(seen[0]).toContain(STYLES.icon);
    const e = loadManifest(P).assets.find((a) => a.id === 'icon-coin')!;
    expect(e).toMatchObject({ kind: 'image', source: 'generated', licence: 'qwen-research', status: 'candidate', ref: { file: 'assets/icons/coin.png' } });
    expect(e.provenance).toMatchObject({ tool: 'blox image', model: 'm', backend: 'kaggle-qwen', prompt: 'a gold coin' });
    expect(typeof e.provenance.seed).toBe('number');
    expect(r.backend).toBe('kaggle-qwen');
  });
  it('falls back to the next backend when Kaggle is unavailable, and says so', async () => {
    const P = proj();
    const r = await generateImages(P, { items: [{ name: 'gem', prompt: 'a gem' }] }, { backends: [down, ok('cloudflare-flux')] });
    expect(r.backend).toBe('cloudflare-flux');
    expect(r.notes.join(' ')).toMatch(/kaggle-qwen unavailable.*quota/);
    expect(loadManifest(P).assets[0].licence).toBe('apache-2.0');
  });
  it('refuses to overwrite an existing icon unless asked', async () => {
    const P = proj();
    mkdirSync(join(P, 'assets/icons'), { recursive: true });
    writeFileSync(join(P, 'assets/icons/coin.png'), 'old');
    await expect(generateImages(P, { items: [{ name: 'coin', prompt: 'x' }] }, { backends: [ok('kaggle-qwen')] })).rejects.toThrow(/exists.*overwrite/);
  });
  it('rejects duplicate or unsafe names before running', async () => {
    await expect(generateImages(proj(), { items: [{ name: 'a', prompt: 'x' }, { name: 'a', prompt: 'y' }] }, { backends: [ok('kaggle-qwen')] })).rejects.toThrow(/duplicate/);
    await expect(generateImages(proj(), { items: [{ name: '../x', prompt: 'x' }] }, { backends: [ok('kaggle-qwen')] })).rejects.toThrow(/name/);
  });
});

describe('image cache', () => {
  const counting = (name: string) => { const b = ok(name); const run = b.run; const calls: string[][] = []; b.run = async (items, o) => { calls.push(items.map((i) => i.file)); return run(items, o); }; return { b, calls }; };
  it('reuses a cached image for the same prompt, style, size and backend; only misses go to the backend', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'blox-imgcache-'));
    const { b, calls } = counting('kaggle-qwen');
    await generateImages(proj(), { items: [{ name: 'coin', prompt: 'a gold coin' }] }, { backends: [b], cacheDir });
    const P = proj();
    const r = await generateImages(P, { items: [{ name: 'coin', prompt: 'a gold coin' }, { name: 'gem', prompt: 'a gem' }] }, { backends: [b], cacheDir });
    expect(calls).toEqual([['coin.png'], ['gem.png']]);
    expect(r.written.map((w) => w.name).sort()).toEqual(['coin', 'gem']);
    expect(r.cached).toEqual(['coin']);
    expect(existsSync(join(P, 'assets/icons/coin.png'))).toBe(true);
    expect(loadManifest(P).assets.find((a) => a.id === 'icon-coin')!.provenance).toMatchObject({ backend: 'kaggle-qwen', prompt: 'a gold coin' });
  });
  it('all hits: no backend run at all; a different size, style or fresh:true misses', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'blox-imgcache-'));
    const { b, calls } = counting('kaggle-qwen');
    const one = { items: [{ name: 'coin', prompt: 'a gold coin' }] };
    await generateImages(proj(), one, { backends: [b], cacheDir });
    await generateImages(proj(), one, { backends: [b], cacheDir });
    expect(calls).toHaveLength(1);
    await generateImages(proj(), { ...one, size: 256 }, { backends: [b], cacheDir });
    await generateImages(proj(), { ...one, style: 'badge' }, { backends: [b], cacheDir });
    await generateImages(proj(), { ...one, fresh: true }, { backends: [b], cacheDir });
    expect(calls).toHaveLength(4);
  });
  it('a hit from a fallback backend counts; an explicit seed is part of the key', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'blox-imgcache-'));
    const flux = counting('cloudflare-flux');
    await generateImages(proj(), { items: [{ name: 'gem', prompt: 'a gem' }] }, { backends: [down, flux.b], cacheDir });
    const q = counting('kaggle-qwen');
    const r = await generateImages(proj(), { items: [{ name: 'gem', prompt: 'a gem' }] }, { backends: [q.b, flux.b], cacheDir });
    expect(q.calls).toHaveLength(0);
    expect(r.backend).toBe('cloudflare-flux');
    await generateImages(proj(), { items: [{ name: 'gem', prompt: 'a gem', seed: 7 }] }, { backends: [q.b], cacheDir });
    expect(q.calls).toHaveLength(1);
  });
});

describe('release licence gate', () => {
  it('fails when a monetized game uses a non-commercial generated asset', () => {
    const P = proj();
    writeFileSync(join(P, 'blox.config.json'), JSON.stringify({ monetized: true }));
    writeJson(P, 'assets.json', { version: 1, assets: [{ id: 'icon-coin', kind: 'image', source: 'generated', licence: 'qwen-research', ref: { file: 'assets/icons/coin.png' }, provenance: { tool: 'blox image', createdAt: 'x' }, status: 'approved', uploaded: { assetId: 5, imageId: 6, operation: 'o', at: 'x' } }] });
    const g = releaseCheck(P).gates.find((x) => x.id === 'licence')!;
    expect(g.status).toBe('fail');
    expect(g.detail).toMatch(/icon-coin.*non-commercial/);
  });
  it('passes when the game is not monetized', () => {
    const P = proj();
    writeJson(P, 'assets.json', { version: 1, assets: [{ id: 'icon-coin', kind: 'image', source: 'generated', licence: 'qwen-research', ref: {}, provenance: { tool: 'blox image', createdAt: 'x' }, status: 'approved', uploaded: { assetId: 5, operation: 'o', at: 'x' } }] });
    expect(releaseCheck(P).gates.find((x) => x.id === 'licence')!.status).not.toBe('fail');
  });
});
