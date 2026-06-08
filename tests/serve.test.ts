import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { rojoServePort, serveUrl, ensureServe, stopServe, registerServeTeardown, type ServeHandle, type ServeSpawnFn } from '../src/sync/serve.js';
import type { FetchFn } from '../src/sync/serveCheck.js';

describe('rojoServePort', () => {
  it('defaults to 34872', () => {
    const prev = process.env.BLOX_ROJO_SERVE_PORT;
    delete process.env.BLOX_ROJO_SERVE_PORT;
    try { expect(rojoServePort()).toBe(34872); }
    finally { if (prev !== undefined) process.env.BLOX_ROJO_SERVE_PORT = prev; }
  });

  it('honors BLOX_ROJO_SERVE_PORT', () => {
    const prev = process.env.BLOX_ROJO_SERVE_PORT;
    process.env.BLOX_ROJO_SERVE_PORT = '40000';
    try { expect(rojoServePort()).toBe(40000); }
    finally { if (prev === undefined) delete process.env.BLOX_ROJO_SERVE_PORT; else process.env.BLOX_ROJO_SERVE_PORT = prev; }
  });
});

describe('serveUrl', () => {
  it('builds a localhost url from the port', () => {
    const prev = process.env.BLOX_ROJO_SERVE_URL;
    delete process.env.BLOX_ROJO_SERVE_URL;
    try { expect(serveUrl(40000)).toBe('http://localhost:40000'); }
    finally { if (prev !== undefined) process.env.BLOX_ROJO_SERVE_URL = prev; }
  });

  it('honors BLOX_ROJO_SERVE_URL override regardless of port', () => {
    const prev = process.env.BLOX_ROJO_SERVE_URL;
    process.env.BLOX_ROJO_SERVE_URL = 'http://172.30.12.182:34872';
    try { expect(serveUrl(40000)).toBe('http://172.30.12.182:34872'); }
    finally { if (prev === undefined) delete process.env.BLOX_ROJO_SERVE_URL; else process.env.BLOX_ROJO_SERVE_URL = prev; }
  });
});

const okBody = { projectName: 'blox-fixture', protocolVersion: 4, serverVersion: '7.6.1' };
const reachable: FetchFn = async () => ({ ok: true, status: 200, json: async () => okBody });
const down: FetchFn = async () => { throw new Error('ECONNREFUSED'); };
const noSleep = async () => {};

function fakeHandle(): ServeHandle & { killed: boolean } {
  let resolveExit!: (code: number) => void;
  const h: any = {
    pid: 4242,
    killed: false,
    kill() { h.killed = true; resolveExit(0); },
    exited: new Promise<number>((r) => { resolveExit = r; }),
  };
  return h;
}

describe('ensureServe', () => {
  it('reuses a reachable serve without spawning', async () => {
    let spawned = false;
    const spawn: ServeSpawnFn = () => { spawned = true; return fakeHandle(); };
    const s = await ensureServe('/proj', { fetch: reachable, spawn, sleep: noSleep });
    expect(s.mode).toBe('reused');
    expect(s.handle).toBeNull();
    expect(spawned).toBe(false);
  });

  it('spawns and returns once the new serve becomes reachable', async () => {
    const handle = fakeHandle();
    const spawn: ServeSpawnFn = () => handle;
    let calls = 0;
    const flaky: FetchFn = async () => {
      calls++;
      if (calls < 3) throw new Error('ECONNREFUSED');
      return { ok: true, status: 200, json: async () => okBody };
    };
    const s = await ensureServe('/proj', { fetch: flaky, spawn, sleep: noSleep, attempts: 10, delayMs: 1 });
    expect(s.mode).toBe('spawned');
    expect(s.handle).toBe(handle);
  });

  it('throws if the child exits before becoming reachable', async () => {
    const handle = fakeHandle();
    const spawn: ServeSpawnFn = () => { handle.kill(); return handle; }; // exits immediately
    await expect(
      ensureServe('/proj', { fetch: down, spawn, sleep: noSleep, attempts: 5, delayMs: 1 }),
    ).rejects.toThrow(/exited/);
  });

  it('throws and kills the child if it never becomes reachable', async () => {
    const handle = fakeHandle();
    const spawn: ServeSpawnFn = () => handle;
    await expect(
      ensureServe('/proj', { fetch: down, spawn, sleep: noSleep, attempts: 3, delayMs: 1 }),
    ).rejects.toThrow(/did not become reachable/);
    expect(handle.killed).toBe(true);
  });
});

describe('stopServe', () => {
  it('kills and awaits a spawned session', async () => {
    const handle = fakeHandle();
    await stopServe({ mode: 'spawned', url: 'u', port: 1, handle });
    expect(handle.killed).toBe(true);
  });

  it('is a no-op for a reused session', async () => {
    await expect(stopServe({ mode: 'reused', url: 'u', port: 1, handle: null })).resolves.toBeUndefined();
  });
});

describe('registerServeTeardown', () => {
  it('kills the spawned child and exits on SIGINT', () => {
    const handle = fakeHandle();
    const proc = new EventEmitter();
    let exitCode: number | undefined;
    registerServeTeardown(
      { mode: 'spawned', url: 'u', port: 1, handle },
      { proc, exit: (c) => { exitCode = c; } },
    );
    proc.emit('SIGINT');
    expect(handle.killed).toBe(true);
    expect(exitCode).toBe(130);
  });

  it('kills the spawned child on process exit (no exit() call)', () => {
    const handle = fakeHandle();
    const proc = new EventEmitter();
    let exitCalled = false;
    registerServeTeardown(
      { mode: 'spawned', url: 'u', port: 1, handle },
      { proc, exit: () => { exitCalled = true; } },
    );
    proc.emit('exit');
    expect(handle.killed).toBe(true);
    expect(exitCalled).toBe(false);
  });

  it('registers nothing for a reused session', () => {
    const proc = new EventEmitter();
    registerServeTeardown({ mode: 'reused', url: 'u', port: 1, handle: null }, { proc, exit: () => {} });
    expect(proc.listenerCount('SIGINT')).toBe(0);
    expect(proc.listenerCount('exit')).toBe(0);
  });
});
