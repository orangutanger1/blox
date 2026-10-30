import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodePng } from '../src/present/square.js';
import { decodePngRgba } from '../src/present/pixels.js';
import { imageInput, kieRun, kieUpload, withRefsModel, type Fetch } from '../src/image/kie.js';
import { sliceSheet } from '../src/image/post.js';
import { aspectFor, generateSheet, gridFor, runModel, sheetPrompt } from '../src/image/sheet.js';
import { loadManifest } from '../src/assets/manifest.js';
import type { ImageBackend } from '../src/image/generate.js';

const KEY = 'sk-test-secret';
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
// A scripted kie.ai: createTask → recordInfo states in order → result download.
function fakeKie(states: Record<string, unknown>[], o: { create?: Record<string, unknown> } = {}) {
  const calls: { url: string; body?: any }[] = [];
  const f: Fetch = async (url, init) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
    if (url.endsWith('/api/v1/jobs/createTask')) return json(o.create ?? { code: 200, msg: 'success', data: { taskId: 't1', recordId: 't1' } });
    if (url.includes('/recordInfo')) return json(states.shift());
    if (url.includes('/api/file-base64-upload')) return json({ code: 200, success: true, data: { downloadUrl: 'https://tempfile.kie/ref.png' } });
    if (url.startsWith('https://cdn.kie/')) return new Response(Buffer.from('PNGDATA'), { status: 200 });
    throw new Error(`unexpected ${url}`);
  };
  return { f, calls, opts: { fetch: f, key: KEY, sleep: async () => {} } };
}
const done = (urls: string[]) => ({ code: 200, data: { state: 'success', creditsConsumed: 6, response: { resultUrls: urls } } });

describe('kie client', () => {
  it('creates a task, polls until success, returns urls and credits', async () => {
    const k = fakeKie([{ code: 200, data: { state: 'waiting' } }, { code: 429, msg: 'slow down' }, { code: 200, data: { state: 'generating' } }, done(['https://cdn.kie/a.png'])]);
    const seen: string[] = [];
    const r = await kieRun('gpt-image-2-text-to-image', { prompt: 'x' }, { ...k.opts, onStatus: (s) => seen.push(s) });
    expect(r).toMatchObject({ taskId: 't1', urls: ['https://cdn.kie/a.png'], credits: 6 });
    expect(k.calls[0].body).toEqual({ model: 'gpt-image-2-text-to-image', input: { prompt: 'x' } });
    expect(seen).toEqual(['waiting', 'generating', 'success']);
  });
  it('a fail state throws the reason; a non-200 code in a 200 body throws, without the key', async () => {
    await expect(kieRun('m', {}, fakeKie([{ code: 200, data: { state: 'fail', failMsg: 'nsfw filter' } }]).opts)).rejects.toThrow(/m failed: nsfw filter/);
    await expect(kieRun('m', {}, fakeKie([], { create: { code: 402, msg: `bad key ${KEY}` } }).opts)).rejects.toThrow(/402 bad key <key> \(out of credits/);
  });
  it('gives up after the timeout', async () => {
    const k = fakeKie(Array.from({ length: 50 }, () => ({ code: 200, data: { state: 'queuing' } })));
    await expect(kieRun('m', {}, { ...k.opts, timeoutSec: -1 })).rejects.toThrow(/no result after/);
  });
  it('no key → a clear error', async () => {
    const prev = process.env.KIE_API_KEY;
    delete process.env.KIE_API_KEY;
    try {
      await expect(kieRun('m', {}, { fetch: fakeKie([]).f })).rejects.toThrow(/set KIE_API_KEY/);
    } finally {
      if (prev !== undefined) process.env.KIE_API_KEY = prev;
    }
  });
  it('uploads a local file as base64 to the upload host', async () => {
    const d = mkdtempSync(join(tmpdir(), 'blox-kie-'));
    writeFileSync(join(d, 'r.png'), 'abc');
    const k = fakeKie([]);
    expect(await kieUpload(join(d, 'r.png'), k.opts)).toBe('https://tempfile.kie/ref.png');
    expect(k.calls[0].url).toBe('https://kieai.redpandaai.co/api/file-base64-upload');
    expect(k.calls[0].body).toMatchObject({ base64Data: `data:image/png;base64,${Buffer.from('abc').toString('base64')}`, fileName: 'r.png' });
  });
  it('builds each model family its own input fields', () => {
    expect(imageInput('gpt-image-2-image-to-image', 'p', { refs: ['u'], transparent: true })).toEqual({ prompt: 'p', aspect_ratio: '1:1', resolution: '1K', background: 'transparent', input_urls: ['u'] });
    expect(imageInput('nano-banana-2-1', 'p', { refs: ['u'], aspect: '16:9' })).toEqual({ prompt: 'p', aspect_ratio: '16:9', resolution: '1K', output_format: 'png', image_input: ['u'] });
    expect(imageInput('other/model', 'p', { extra: { steps: 4 } })).toEqual({ prompt: 'p', aspect_ratio: '1:1', steps: 4 });
    expect(withRefsModel('gpt-image-2-text-to-image')).toBe('gpt-image-2-image-to-image');
    expect(withRefsModel('nano-banana-2-1')).toBe('nano-banana-2-1');
  });
});

// A W×H transparent canvas with filled rectangles [x, y, w, h, r, g, b].
function canvas(W: number, H: number, rects: number[][], bg?: [number, number, number]): Buffer {
  const rgba = new Uint8Array(W * H * 4);
  if (bg) for (let i = 0; i < W * H; i++) rgba.set([...bg, 255], i * 4);
  for (const [x, y, w, h, r, g, b] of rects) for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) rgba.set([r, g, b, 255], (j * W + i) * 4);
  return encodePng(W, H, rgba);
}
const size = (b: Buffer | null) => { const p = decodePngRgba(b!)!; return [p.w, p.h]; };

describe('sliceSheet', () => {
  it('cuts a 3×2 grid in reading order; empty cells are null', () => {
    const W = 300, H = 200;
    const sheet = canvas(W, H, [[20, 20, 40, 30, 255, 0, 0], [130, 30, 20, 20, 0, 255, 0], [220, 20, 50, 50, 0, 0, 255], [20, 120, 30, 40, 9, 9, 9], [120, 120, 40, 40, 200, 200, 0]]);
    const p = sliceSheet(sheet, 3, 2);
    expect(p.map((x) => (x ? size(x) : null))).toEqual([[40, 30], [20, 20], [50, 50], [30, 40], [40, 40], null]);
  });
  it('keeps an item that spills over a cell line whole, with its loose bits; a neighbour poking into the box is cleared', () => {
    // item 1: body 10..110 (crosses x=100 into cell 2's column) + a detached sparkle at 5,5
    const sheet = canvas(200, 100, [[10, 30, 100, 40, 255, 0, 0], [5, 5, 4, 4, 255, 255, 0], [150, 20, 30, 60, 0, 0, 255]]);
    const [a, b] = sliceSheet(sheet, 2, 1);
    expect(size(a)).toEqual([105, 65]);
    expect(size(b)).toEqual([30, 60]);
  });
  it('works on an opaque white background (flood from the border)', () => {
    const p = sliceSheet(canvas(200, 100, [[20, 20, 40, 40, 200, 0, 0], [120, 20, 50, 30, 0, 0, 200]], [255, 255, 255]), 2, 1);
    expect(p.map(size)).toEqual([[40, 40], [50, 30]]);
  });
});

describe('image sheet', () => {
  it('grid + aspect + prompt', () => {
    expect(gridFor(6)).toEqual({ cols: 3, rows: 2 });
    expect(gridFor(4)).toEqual({ cols: 2, rows: 2 });
    expect(gridFor(5, 5)).toEqual({ cols: 5, rows: 1 });
    expect(aspectFor(3, 2)).toBe('3:2');
    expect(aspectFor(5, 1)).toBe('2:1');
    expect(sheetPrompt([{ name: 'a', prompt: 'a coin' }, { name: 'b', prompt: 'a gem' }], 2, 1, 'flat')).toMatch(/2 columns and 1 rows.*1\. a coin; 2\. a gem.*Style for every asset: flat/);
  });
  it('one generation → sheet file + one recorded icon per cell; an empty cell fails by name', async () => {
    const P = mkdtempSync(join(tmpdir(), 'blox-sheet-'));
    let aspect: string | undefined, prompts = 0;
    const be: ImageBackend = { name: 'gpt-image-2-text-to-image', model: 'gpt (kie.ai)', licence: 'ai-output', run: async (items, o) => { prompts += items.length; aspect = o.aspect; return [{ file: items[0].file, data: canvas(300, 200, [[20, 20, 40, 40, 255, 0, 0], [120, 20, 40, 40, 0, 255, 0], [220, 20, 40, 40, 0, 0, 255], [20, 120, 40, 40, 9, 9, 9]]) }]; } };
    const items = ['coin', 'gem', 'bone', 'key', 'star'].map((n) => ({ name: n, prompt: `a ${n}` }));
    const cacheDir = mkdtempSync(join(tmpdir(), 'blox-sheetcache-'));
    const r = await generateSheet(P, { name: 'loot', items, size: 64 }, { backends: [be], cacheDir });
    expect(prompts).toBe(1);
    expect(aspect).toBe('3:2');
    expect(existsSync(join(P, 'assets/sheets/loot.png'))).toBe(true);
    expect(r.written.map((w) => w.name)).toEqual(['coin', 'gem', 'bone', 'key']);
    expect(r.failed).toEqual([{ name: 'star', error: expect.stringMatching(/cell 5 came back empty/) }]);
    expect(size(readFileSync(join(P, 'assets/icons/coin.png')))).toEqual([64, 64]);
    expect(loadManifest(P).assets.find((a) => a.id === 'icon-gem')!.provenance).toMatchObject({ sheet: 'assets/sheets/loot.png', cell: 2, prompt: 'a gem' });
    // same sheet again: from the cache, no generation
    const r2 = await generateSheet(mkdtempSync(join(tmpdir(), 'blox-sheet-')), { name: 'loot', items, size: 64 }, { backends: [be], cacheDir });
    expect(prompts).toBe(1);
    expect(r2.cached).toEqual(['loot']);
  });
  it('rejects too few/many items and bad names before generating', async () => {
    const P = mkdtempSync(join(tmpdir(), 'blox-sheet-'));
    await expect(generateSheet(P, { name: 'x', items: [{ name: 'a', prompt: 'a' }] }, { backends: [] })).rejects.toThrow(/2–16 items/);
    await expect(generateSheet(P, { name: 'Bad Name', items: [] }, { backends: [] })).rejects.toThrow(/sheet name/);
  });
});

describe('image run', () => {
  it('uploads project files named in the input, downloads every result to assets/media', async () => {
    const P = mkdtempSync(join(tmpdir(), 'blox-run-'));
    mkdirSync(join(P, 'assets/icons'), { recursive: true });
    writeFileSync(join(P, 'assets/icons/dog.png'), 'png');
    const k = fakeKie([done(['https://cdn.kie/v/out.mp4'])]);
    const r = await runModel(P, { model: 'kling/v2-1-image-to-video', name: 'dog-run', input: { prompt: 'the dog runs', image_url: 'assets/icons/dog.png', duration: '5' } }, k.opts);
    expect(k.calls.find((c) => c.url.endsWith('/createTask'))!.body.input).toEqual({ prompt: 'the dog runs', image_url: 'https://tempfile.kie/ref.png', duration: '5' });
    expect(r.files).toEqual(['assets/media/dog-run.mp4']);
    expect(readFileSync(join(P, 'assets/media/dog-run.mp4'), 'utf8')).toBe('PNGDATA');
  });
});
