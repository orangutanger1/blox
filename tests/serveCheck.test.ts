import { describe, it, expect } from 'vitest';
import { checkRojoServe, rojoServeUrl, formatServeCheck, type FetchFn } from '../src/sync/serveCheck.js';

const okBody = { projectName: 'blox-fixture', protocolVersion: 4, serverVersion: '7.6.1' };
const okFetch: FetchFn = async () => ({ ok: true, status: 200, json: async () => okBody });

describe('checkRojoServe', () => {
  it('reports reachable with project info on 2xx + JSON', async () => {
    const r = await checkRojoServe('http://localhost:34872', okFetch);
    expect(r.reachable).toBe(true);
    expect(r.projectName).toBe('blox-fixture');
    expect(r.protocolVersion).toBe(4);
    expect(r.detail).toMatch(/blox-fixture/);
  });

  it('hits the /api/rojo endpoint of the given url', async () => {
    let seen = '';
    const spy: FetchFn = async (url) => { seen = url; return { ok: true, status: 200, json: async () => okBody }; };
    await checkRojoServe('http://localhost:34872/', spy);
    expect(seen).toBe('http://localhost:34872/api/rojo');
  });

  it('reports unreachable when fetch throws', async () => {
    const r = await checkRojoServe('http://localhost:34872', async () => { throw new Error('ECONNREFUSED'); });
    expect(r.reachable).toBe(false);
    expect(r.detail).toMatch(/ECONNREFUSED/);
  });

  it('reports unreachable on non-2xx', async () => {
    const r = await checkRojoServe('http://localhost:34872', async () => ({ ok: false, status: 404, json: async () => ({}) }));
    expect(r.reachable).toBe(false);
    expect(r.detail).toMatch(/404/);
  });

  it('reports unreachable on bad json', async () => {
    const r = await checkRojoServe('http://localhost:34872', async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } }));
    expect(r.reachable).toBe(false);
  });
});

describe('rojoServeUrl', () => {
  it('defaults to localhost:34872', () => {
    const prev = process.env.BLOX_ROJO_SERVE_URL;
    delete process.env.BLOX_ROJO_SERVE_URL;
    try { expect(rojoServeUrl()).toBe('http://localhost:34872'); }
    finally { if (prev !== undefined) process.env.BLOX_ROJO_SERVE_URL = prev; }
  });

  it('honors BLOX_ROJO_SERVE_URL', () => {
    const prev = process.env.BLOX_ROJO_SERVE_URL;
    process.env.BLOX_ROJO_SERVE_URL = 'http://172.30.12.182:34872';
    try { expect(rojoServeUrl()).toBe('http://172.30.12.182:34872'); }
    finally { if (prev === undefined) delete process.env.BLOX_ROJO_SERVE_URL; else process.env.BLOX_ROJO_SERVE_URL = prev; }
  });
});

describe('formatServeCheck', () => {
  it('renders reachable distinctly from not', () => {
    expect(formatServeCheck({ reachable: true, url: 'http://localhost:34872', projectName: 'blox-fixture', detail: 'ok' })).toMatch(/SERVE REACHABLE/);
    expect(formatServeCheck({ reachable: false, url: 'http://localhost:34872', detail: 'down' })).toMatch(/NO SERVE/);
  });
});
