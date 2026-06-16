// tests/daemon.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createController, type RunFn } from '../src/panel/daemon.js';

const models = { provider: 'openrouter', models: ['google/gemini-2.5-pro'], current: 'google/gemini-2.5-pro' };
const server = () => ({ setRunId: vi.fn() });

describe('createController', () => {
  it('launches when idle and flips to running, then back to idle when the run resolves', async () => {
    let release!: () => void;
    const run: RunFn = () => new Promise<void>((r) => { release = r; });
    const srv = server();
    const c = createController(srv as never, { listModels: () => models, run, newRunId: () => 'run-1' });

    expect(c.state()).toBe('idle');
    const r = c.launch('build a frame', 'google/gemini-2.5-pro');
    expect(r).toEqual({ ok: true, runId: 'run-1' });
    expect(srv.setRunId).toHaveBeenCalledWith('run-1');
    expect(c.state()).toBe('running');

    release();
    await new Promise((res) => setTimeout(res, 0));
    expect(c.state()).toBe('idle');
  });

  it('rejects a second launch while running (409)', () => {
    const run: RunFn = () => new Promise<void>(() => {});
    const c = createController(server() as never, { listModels: () => models, run, newRunId: () => 'x' });
    c.launch('a', 'google/gemini-2.5-pro');
    expect(c.launch('b', 'google/gemini-2.5-pro')).toEqual({ ok: false, status: 409, error: 'a run is already in progress' });
  });

  it('rejects an unknown model (400)', () => {
    const run: RunFn = vi.fn(() => Promise.resolve());
    const c = createController(server() as never, { listModels: () => models, run });
    const r = c.launch('a', 'mistral/whatever');
    expect(r).toEqual({ ok: false, status: 400, error: 'unknown model: mistral/whatever' });
    expect(run).not.toHaveBeenCalled();
  });

  it('returns to idle even when the run rejects', async () => {
    const run: RunFn = () => Promise.reject(new Error('boom'));
    const c = createController(server() as never, { listModels: () => models, run, newRunId: () => 'x' });
    c.launch('a', 'google/gemini-2.5-pro');
    await new Promise((res) => setTimeout(res, 0));
    expect(c.state()).toBe('idle');
  });

  it('cancel() aborts the active run and returns ok; no-ops when idle', () => {
    let captured!: AbortController;
    const run: RunFn = (_p, _s, _r, ac) => {
      captured = ac;
      return new Promise<void>(() => {}); // never settles — stays running
    };
    const c = createController(server() as never, { listModels: () => models, run, newRunId: () => 'x' });

    expect(c.cancel()).toEqual({ ok: false }); // nothing running yet
    c.launch('a', 'google/gemini-2.5-pro');
    expect(captured.signal.aborted).toBe(false);
    expect(c.cancel()).toEqual({ ok: true });
    expect(captured.signal.aborted).toBe(true);
  });
});
