import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addAsset, approveAsset, loadManifest, saveManifest } from '../src/assets/manifest.js';
import { uploadAsset } from '../src/assets/upload.js';
import { OpenCloud, type FetchLike } from '../src/opencloud/client.js';

function project(approve = true, creator = true) {
  const p = mkdtempSync(join(tmpdir(), 'blox-up-'));
  writeFileSync(join(p, 'rock.fbx'), 'FBXDATA');
  addAsset(p, { id: 'rock', kind: 'mesh', source: 'external', licence: 'owned', ref: { file: 'rock.fbx' }, provenance: { tool: 'meshy', createdAt: 'x' } });
  if (creator) saveManifest(p, { ...loadManifest(p), creator: { userId: 42 } });
  if (approve) approveAsset(p, 'rock');
  return p;
}

function fakeFetch(log: { url: string; method?: string; headers?: Record<string, string>; body?: unknown }[]): FetchLike {
  let polls = 0;
  return async (url, init) => {
    log.push({ url, method: init?.method, headers: init?.headers, body: init?.body });
    const json = (v: unknown, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(v) });
    if (url.endsWith('/assets/v1/assets')) return json({ path: 'operations/op1', done: false });
    if (url.endsWith('/assets/v1/operations/op1')) return json(++polls < 2 ? { path: 'operations/op1', done: false } : { path: 'operations/op1', done: true, response: { assetId: '9876' } });
    return json({ message: 'nope' }, 404);
  };
}

describe('uploadAsset gates', () => {
  it('refuses unapproved assets, explains the CLI approval', async () => {
    await expect(uploadAsset(project(false), 'rock', { confirm: true })).rejects.toThrow(/blox asset approve rock/);
  });
  it('needs a creator', async () => {
    await expect(uploadAsset(project(true, false), 'rock')).rejects.toThrow(/creator/);
  });
  it('without confirm it is a dry run that sends nothing', async () => {
    const log: never[] = [];
    const r = await uploadAsset(project(), 'rock', { client: new OpenCloud({ apiKey: 'k', fetch: fakeFetch(log) }) });
    expect(r).toMatchObject({ dryRun: true, plan: { assetType: 'Model', contentType: 'model/fbx', creator: { userId: 42 } } });
    expect(log).toHaveLength(0);
  });
  it('without a key (and no client) it explains how to get one', async () => {
    const old = process.env.ROBLOX_OPEN_CLOUD_KEY;
    delete process.env.ROBLOX_OPEN_CLOUD_KEY;
    await expect(uploadAsset(project(), 'rock', { confirm: true })).rejects.toThrow(/ROBLOX_OPEN_CLOUD_KEY/);
    if (old) process.env.ROBLOX_OPEN_CLOUD_KEY = old;
  });
});

describe('uploadAsset (fake Open Cloud)', () => {
  it('posts multipart with the key, polls the operation and records the asset id', async () => {
    const p = project();
    const log: { url: string; method?: string; headers?: Record<string, string>; body?: unknown }[] = [];
    const r = await uploadAsset(p, 'rock', { confirm: true, client: new OpenCloud({ apiKey: 'test-key', fetch: fakeFetch(log) }), sleep: async () => {} });
    expect(r).toEqual({ dryRun: false, assetId: 9876, operation: 'operations/op1' });
    expect(log[0]).toMatchObject({ url: 'https://apis.roblox.com/assets/v1/assets', method: 'POST', headers: { 'x-api-key': 'test-key' } });
    const form = log[0].body as FormData;
    expect(JSON.parse(String(form.get('request')))).toMatchObject({ assetType: 'Model', creationContext: { creator: { userId: '42' } } });
    expect((form.get('fileContent') as Blob).size).toBe(7);
    expect(loadManifest(p).assets[0]).toMatchObject({ uploaded: { assetId: 9876 }, ref: { assetId: 9876 } });
  });
  it('surfaces API errors', async () => {
    const p = project();
    const bad: FetchLike = async () => ({ ok: false, status: 403, text: async () => JSON.stringify({ message: 'Forbidden: key lacks asset:write' }) });
    await expect(uploadAsset(p, 'rock', { confirm: true, client: new OpenCloud({ apiKey: 'k', fetch: bad }) })).rejects.toThrow(/403: Forbidden: key lacks asset:write/);
  });
});
