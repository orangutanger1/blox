import { describe, it, expect } from 'vitest';
import { runLaneJob } from '../src/multiplayer/lane.js';

const port = () => 36000 + Math.floor(Math.random() * 2000);

// A fake dock plugin: polls for the job, then posts a result.
async function fakePlugin(p: number, respond: (job: { id: string; clients: number }) => unknown, delayMs = 20): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const r = await fetch(`http://127.0.0.1:${p}/lane/job`).catch(() => null);
    const job = r?.ok ? ((await r.json()) as { id?: string; clients: number }) : null;
    if (job?.id) {
      await new Promise((res) => setTimeout(res, delayMs));
      await fetch(`http://127.0.0.1:${p}/lane/result`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(respond(job as { id: string; clients: number })) });
      return;
    }
    await new Promise((res) => setTimeout(res, 10));
  }
}

describe('runLaneJob', () => {
  it('hands the job to the plugin once and resolves with its result', async () => {
    const p = port();
    const plugin = fakePlugin(p, (job) => ({ id: job.id, ok: true, result: `ran ${job.clients}` }));
    const r = await runLaneJob({ kind: 'multiplayer', clients: 3 }, { port: p, pickupMs: 2000, timeoutMs: 5000 });
    await plugin;
    expect(r).toEqual({ ok: true, result: 'ran 3' });
    // server is closed afterwards
    expect(await fetch(`http://127.0.0.1:${p}/lane/job`).then(() => 'open', () => 'closed')).toBe('closed');
  });
  it('a second poll gets no job while one is running', async () => {
    const p = port();
    const job = runLaneJob({ kind: 'multiplayer', clients: 2 }, { port: p, pickupMs: 2000, timeoutMs: 5000 });
    let first: { id?: string } = {};
    for (let i = 0; i < 50 && !first.id; i++) {
      first = await fetch(`http://127.0.0.1:${p}/lane/job`).then((r) => r.json() as Promise<{ id?: string }>, () => ({}));
      if (!first.id) await new Promise((res) => setTimeout(res, 10));
    }
    const second = (await (await fetch(`http://127.0.0.1:${p}/lane/job`)).json()) as { id?: string };
    expect(first.id).toBeTruthy();
    expect(second.id).toBeUndefined();
    await fetch(`http://127.0.0.1:${p}/lane/result`, { method: 'POST', body: JSON.stringify({ id: first.id, ok: false, error: 'boom' }) });
    expect(await job).toEqual({ ok: false, error: 'boom' });
  });
  it('rejects results for another job id', async () => {
    const p = port();
    const plugin = fakePlugin(p, () => ({ id: 'wrong', ok: true, result: 1 }));
    await expect(runLaneJob({ kind: 'multiplayer', clients: 2 }, { port: p, pickupMs: 2000, timeoutMs: 300 })).rejects.toThrow(/timed out/);
    await plugin;
  });
  it('explains when no plugin picks the job up', async () => {
    await expect(runLaneJob({ kind: 'multiplayer', clients: 2 }, { port: port(), pickupMs: 100, timeoutMs: 1000 })).rejects.toThrow(/dock plugin did not pick up/);
  });
  it('port in use is a readable error', async () => {
    const p = port();
    const a = runLaneJob({ kind: 'multiplayer', clients: 2 }, { port: p, pickupMs: 300, timeoutMs: 1000 }).catch((e) => e);
    await new Promise((res) => setTimeout(res, 50));
    await expect(runLaneJob({ kind: 'multiplayer', clients: 2 }, { port: p, pickupMs: 100, timeoutMs: 1000 })).rejects.toThrow(/in use/);
    await a;
  });
});
