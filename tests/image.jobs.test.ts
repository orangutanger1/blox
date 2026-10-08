import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodePng } from '../src/present/square.js';
import { startImageJob, readImageJob, listImageJobs, imageEta } from '../src/image/jobs.js';
import type { ImageBackend } from '../src/image/generate.js';

const png = () => { const rgba = new Uint8Array(40 * 40 * 4).fill(255); for (let i = 0; i < 400; i++) rgba.set([200, 20, 20, 255], (10 * 40 + 10 + (i % 20) + 40 * Math.floor(i / 20)) * 4); return encodePng(40, 40, rgba); };
const slow = (gate: Promise<void>): ImageBackend => ({ name: 'kaggle-qwen', model: 'm', licence: 'qwen-research', run: async (items, o) => { o.onStatus?.('running'); await gate; return items.map((i) => ({ file: i.file, seed: i.seed, data: png() })); } });
const proj = () => mkdtempSync(join(tmpdir(), 'blox-imgjob-'));

describe('image jobs', () => {
  it('starts at once with an id and ETA, reports progress, then the written files', async () => {
    const P = proj();
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const j = startImageJob(P, { items: [{ name: 'coin', prompt: 'a coin' }, { name: 'gem', prompt: 'a gem' }] }, { backends: [slow(gate)], cacheDir: null });
    expect(j.id).toMatch(/^img-/);
    expect(j.etaSec).toBe(imageEta('kaggle-qwen', 2));
    await new Promise((r) => setTimeout(r, 10));
    expect(readImageJob(P, j.id)).toMatchObject({ status: 'running', progress: 'kaggle-qwen: running', items: ['coin', 'gem'] });
    open();
    await j.done;
    const done = readImageJob(P, j.id)!;
    expect(done.status).toBe('done');
    expect(done.result!.written.map((w) => w.file)).toEqual(['assets/icons/coin.png', 'assets/icons/gem.png']);
    expect(listImageJobs(P).map((x) => x.id)).toEqual([j.id]);
  });
  it('a backend error ends the job failed with the message', async () => {
    const P = proj();
    const bad: ImageBackend = { name: 'cloudflare-flux', model: 'f', licence: 'apache-2.0', run: async () => { throw new Error('boom'); } };
    const j = startImageJob(P, { items: [{ name: 'coin', prompt: 'a coin' }] }, { backends: [bad], cacheDir: null });
    await j.done;
    expect(readImageJob(P, j.id)).toMatchObject({ status: 'failed', error: 'boom' });
  });
  it('bad input fails at once, before a job starts', () => {
    expect(() => startImageJob(proj(), { items: [{ name: '../x', prompt: 'x' }] }, { backends: [], cacheDir: null })).toThrow(/name/);
  });
  it('a running job whose process is gone reads as lost', async () => {
    const P = proj();
    let open!: () => void;
    const j = startImageJob(P, { items: [{ name: 'coin', prompt: 'a coin' }] }, { backends: [slow(new Promise<void>((r) => (open = r)))], cacheDir: null, pid: 2 ** 22 + 12345 });
    expect(readImageJob(P, j.id)!.status).toBe('lost');
    open();
    await j.done;
  });
});

describe('image tool: async generate + status', () => {
  it('generate returns a job at once; status {job} gives progress, then the files and images', async () => {
    const { imageTool, imageToolDeps } = await import('../src/image/tool.js');
    const P = proj();
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    imageToolDeps.backends = () => [slow(gate)];
    imageToolDeps.cacheDir = () => null;
    const ctx = { projectPath: P } as any;
    const r = await imageTool({ action: 'generate', items: [{ name: 'coin', prompt: 'a coin' }] }, ctx);
    const id = /img-[\w-]+/.exec(r.text)![0];
    expect(r.text).toMatch(/image \{action:"status", job:"img-/);
    expect(r.text).toMatch(/about 11 min/);
    const s1 = await imageTool({ action: 'status', job: id }, ctx);
    expect(s1.text).toMatch(/running/);
    open();
    await imageToolDeps.lastJob;
    const s2 = await imageTool({ action: 'status', job: id }, ctx);
    expect(s2.text).toMatch(/assets\/icons\/coin\.png/);
    expect(s2.images).toHaveLength(1);
    expect(s2.isError).toBeFalsy();
  });
  it('wait:true blocks and returns the files like before', async () => {
    const { imageTool, imageToolDeps } = await import('../src/image/tool.js');
    imageToolDeps.backends = () => [slow(Promise.resolve())];
    imageToolDeps.cacheDir = () => null;
    const r = await imageTool({ action: 'generate', wait: true, items: [{ name: 'gem', prompt: 'a gem' }] }, { projectPath: proj() } as any);
    expect(r.text).toMatch(/1 written/);
  });
});
