import { describe, it, expect } from 'vitest';
import { bridgeDenyReason, bridgeSource, mapBridgeLines, runLuauViaBridge } from '../src/studio/evalBridge.js';
import { runLuau } from '../src/studio/luau.js';
import { runLaneJob } from '../src/multiplayer/lane.js';
import { loadConfig } from '../src/config.js';
import type { StudioSession } from '../src/studio/session.js';

const port = () => 38000 + Math.floor(Math.random() * 2000);

// A fake plugin instance running in one DataModel context.
async function fakePlugin(p: number, ctx: string, respond: (job: Record<string, unknown>) => unknown): Promise<Record<string, unknown> | null> {
  for (let i = 0; i < 200; i++) {
    const r = await fetch(`http://127.0.0.1:${p}/lane/job?ctx=${ctx}`).catch(() => null);
    const job = r?.ok ? ((await r.json()) as Record<string, unknown>) : null;
    if (job?.id) {
      await fetch(`http://127.0.0.1:${p}/lane/result`, { method: 'POST', body: JSON.stringify(respond(job)) });
      return job;
    }
    await new Promise((res) => setTimeout(res, 10));
  }
  return null;
}

describe('bridgeDenyReason', () => {
  it.each([
    ['game:GetService("HttpService"):GetAsync("x")', /HTTP/],
    ['local h = game:HttpGet("x")', /HTTP/],
    ['loadstring("return 1")()', /dynamic code/],
    ['getfenv(1).x = 1', /dynamic code/],
    ['require(123456)', /asset id/],
    ['game:GetService("DataStoreService"):GetDataStore("x")', /persistent/],
    ['local n = "Http" game:GetService(n)', /non-literal/],
    ['game:GetService("Http" .. "Service")', /concatenated|HTTP/],
    ['game:FindService(("Ht").."tpService")', /non-literal/],
  ])('blocks %s', (code, why) => {
    expect(bridgeDenyReason(code)).toMatch(why);
  });
  it('allows ordinary probes that require game modules', () => {
    expect(bridgeDenyReason('local Eco = require(game.ReplicatedStorage.Shared.Economy)\nreturn Eco.price(3), game:GetService("Players"):GetPlayers()')).toBeNull();
  });
});

describe('bridgeSource', () => {
  it('maps bridge script line refs back to the user chunk', () => {
    const code = 'local a = 1\nerror("boom")';
    const { source, userLineOffset } = bridgeSource(code);
    const lines = source.split('\n');
    expect(lines[userLineOffset + 1]).toBe('error("boom")'); // user line 2 → source line offset+2 (1-based)
    expect(mapBridgeLines(`ServerScriptService.__BloxBridge.BloxEval:${userLineOffset + 2}: boom`, userLineOffset, 'probe', 2)).toBe('probe:2: boom');
    expect(mapBridgeLines(`Players.P.PlayerScripts.__BloxBridge.BloxEval:3: x`, userLineOffset, 'probe', 2)).toBe('<blox-wrapper>: x');
  });
  it('hands the result back through the Done event', () => {
    expect(bridgeSource('return 1').source).toMatch(/__done:FireServer\(__ok, __out\) else __done:Fire\(__ok, __out\) end\n$/);
  });
});

describe('lane context routing', () => {
  it('gives an eval job only to the plugin in the play server', async () => {
    const p = port();
    const job = runLaneJob({ kind: 'eval', context: 'client', source: 's', timeoutMs: 1000 }, { port: p, pickupMs: 3000, timeoutMs: 3000 });
    await new Promise((r) => setTimeout(r, 30));
    for (const q of ['', '?ctx=edit', '?ctx=client']) expect(await (await fetch(`http://127.0.0.1:${p}/lane/job${q}`)).json()).toEqual({});
    const got = await fakePlugin(p, 'play', (j) => ({ id: j.id, ok: true, result: 'r' }));
    expect(got).toMatchObject({ kind: 'eval', context: 'client', source: 's' });
    expect(await job).toEqual({ ok: true, result: 'r' });
  });
  it('multiplayer jobs go to edit pollers with the run token (no ctx = edit), never to play pollers', async () => {
    const p = port();
    const job = runLaneJob({ kind: 'multiplayer', clients: 2, token: 't' }, { port: p, pickupMs: 3000, timeoutMs: 3000 });
    await new Promise((r) => setTimeout(r, 30));
    expect(await (await fetch(`http://127.0.0.1:${p}/lane/job?ctx=play&mp=t`)).json()).toEqual({});
    const r = await fetch(`http://127.0.0.1:${p}/lane/job?mp=t`);
    const j = (await r.json()) as { id: string };
    await fetch(`http://127.0.0.1:${p}/lane/result`, { method: 'POST', body: JSON.stringify({ id: j.id, ok: true, result: 1 }) });
    expect(await job).toEqual({ ok: true, result: 1 });
  });
});

describe('runLuauViaBridge', () => {
  it('parses the envelope and maps error lines', async () => {
    const p = port();
    const { userLineOffset } = bridgeSource('x');
    const plugin = fakePlugin(p, 'play', (j) => ({
      id: j.id,
      ok: true,
      result: JSON.stringify({ ok: false, logs: [{ level: 'output', message: 'hi' }], error: { message: `ServerScriptService.__BloxBridge.BloxEval:${userLineOffset + 1}: nope` } }),
    }));
    const r = await runLuauViaBridge('error("nope")', 'server', { port: p, chunkName: 'serverCode' });
    await plugin;
    expect(r.ok).toBe(false);
    expect(r.error?.message).toBe('serverCode:1: nope');
    expect(r.logs).toEqual([{ level: 'output', message: 'hi' }]);
  });
  it('returns values', async () => {
    const p = port();
    const plugin = fakePlugin(p, 'play', (j) => ({ id: j.id, ok: true, result: JSON.stringify({ ok: true, n: 2, values: { v1: 3, v2: 'a' }, logs: [] }) }));
    const r = await runLuauViaBridge('return 3, "a"', 'client', { port: p });
    await plugin;
    expect(r).toMatchObject({ ok: true, values: [3, 'a'] });
  });
  it('refuses denied code without opening the lane', async () => {
    const r = await runLuauViaBridge('loadstring("x")', 'server', { port: port(), pickupMs: 50 });
    expect(r.error?.message).toMatch(/guardrail/);
  });
  it('explains a missing playtest/plugin', async () => {
    await expect(runLuauViaBridge('return 1', 'server', { port: port(), pickupMs: 100 })).rejects.toMatchObject({ code: 'wrong_mode', message: expect.stringMatching(/running playtest/) });
  });
});

describe('runLuau routing', () => {
  it('sends play contexts through the bridge only when the session opts in', async () => {
    const calls: string[] = [];
    const session = { evalBridge: true, call: async () => { calls.push('mcp'); return { content: [] }; } } as unknown as StudioSession;
    await expect(runLuau(session, 'return 1', 'server', { timeoutMs: 1000 })).rejects.toThrow(/dock plugin/);
    expect(calls).toEqual([]);
  }, 15_000);
  it('config defaults the bridge off', () => {
    expect(loadConfig('/nonexistent-dir').bridge.eval).toBe(false);
  });
});
