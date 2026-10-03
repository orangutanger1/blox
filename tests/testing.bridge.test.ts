import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LuauResult } from '../src/studio/luau.js';

const bridge = vi.hoisted(() => ({ impl: null as null | ((code: string, ctx: string) => Promise<LuauResult>), calls: [] as { code: string; ctx: string }[] }));
vi.mock('../src/studio/evalBridge.js', async (orig) => ({
  ...(await orig<typeof import('../src/studio/evalBridge.js')>()),
  runLuauViaBridge: (code: string, ctx: string) => {
    bridge.calls.push({ code, ctx });
    return bridge.impl!(code, ctx);
  },
}));

import { formatTestRun, runTests } from '../src/testing/runner.js';
import { StudioError, StudioSession } from '../src/studio/session.js';
import { fakeStudio, type FakeStudio } from './fakeStudio.js';

const ok = (v: unknown): LuauResult => ({ ok: true, values: [v], logs: [], durationMs: 1 });
const results = (file: string, ctx: string) => ({ results: [{ file, name: `${ctx} works`, status: 'pass', ms: 1 }], fileErrors: [] });

function project(specs: Record<string, string>): string {
  const p = mkdtempSync(join(tmpdir(), 'blox-btest-'));
  mkdirSync(join(p, 'tests'));
  for (const [f, s] of Object.entries(specs)) writeFileSync(join(p, 'tests', f), s);
  return p;
}
const SPECS = {
  'a.spec.luau': '-- @context server\ntest("server works", function() end)\n',
  'b.spec.luau': '-- @context client\ntest("client works", function() end)\n',
};

// Fake Studio: play state, multi_edit, and the host marker reads the injection path polls.
function studio(evalBridge: boolean): { session: StudioSession; f: FakeStudio } {
  const env = (v: unknown) => JSON.stringify({ ok: true, n: 1, values: { v1: v }, logs: [] });
  const f = fakeStudio({
    luau: (code, dm) => {
      const m = /BLOXTEST:([0-9a-f]+):(server|client):/.exec(code);
      if (m) return `1/1:${JSON.stringify(results(m[2] === 'server' ? 'tests/a.spec.luau' : 'tests/b.spec.luau', m[2]))}`;
      if (code.includes('GetPlayers()') && dm === 'Server') return env(1);
      if (code.includes('HumanoidRootPart') && dm === 'Client') return env(true);
      if (code.includes('GetLogHistory')) return env([]);
      return env('ok');
    },
    tools: { multi_edit: () => 'ok' },
  });
  return { session: new StudioSession({ launch: { command: 'x', args: [] }, connector: async () => f.client, sleep: async () => {}, attachTimeoutMs: 0, evalBridge }), f };
}

beforeEach(() => {
  bridge.calls.length = 0;
  bridge.impl = async (code, ctx) => {
    if (code.includes('__SPECFNS')) return ok(results(ctx === 'server' ? 'tests/a.spec.luau' : 'tests/b.spec.luau', ctx));
    return ok(null);
  };
});

describe('runTests through the eval bridge', () => {
  it('runs play specs through the bridge: no injected hosts', async () => {
    const { session, f } = studio(true);
    const r = await runTests(session, project(SPECS), { testTimeoutSec: 1 });
    expect(r.ok).toBe(true);
    expect(r.passed).toBe(2);
    expect(r.via).toBe('bridge');
    expect(f.calls.some((c) => c.name === 'multi_edit')).toBe(false);
    expect(bridge.calls.filter((c) => c.code.includes('__SPECFNS')).map((c) => c.ctx)).toEqual(['server', 'client']);
    expect(formatTestRun(r)).toMatch(/play specs ran through the eval bridge/);
  });

  it('readiness and logs use the MCP thread, never the bridge', async () => {
    const { session } = studio(true);
    await runTests(session, project(SPECS), { testTimeoutSec: 1 });
    expect(bridge.calls.every((c) => c.code.includes('__SPECFNS'))).toBe(true);
  });

  it('a spec the bridge guardrail refuses sends the run to injected hosts', async () => {
    const { session, f } = studio(true);
    const r = await runTests(session, project({ ...SPECS, 'a.spec.luau': '-- @context server\nlocal _ = "DataStoreService"\ntest("server works", function() end)\n' }), { testTimeoutSec: 1 });
    expect(r.via).toBe('hosts');
    expect(r.notes?.join(' ')).toMatch(/persistent stores/);
    expect(f.calls.some((c) => c.name === 'multi_edit')).toBe(true);
    expect(bridge.calls).toEqual([]);
    expect(r.passed).toBe(2);
  });

  it('a bridge failure falls back to injected hosts with a note', async () => {
    bridge.impl = async () => {
      throw new StudioError('wrong_mode', 'eval bridge: no plugin picked up the job');
    };
    const { session, f } = studio(true);
    const r = await runTests(session, project(SPECS), { testTimeoutSec: 1 });
    expect(r.via).toBe('hosts');
    expect(r.notes?.join(' ')).toMatch(/no plugin picked up/);
    expect(f.calls.some((c) => c.name === 'multi_edit')).toBe(true);
    expect(r.passed).toBe(2);
  });

  it('bridge off: injected hosts as before, no note', async () => {
    const { session } = studio(false);
    const r = await runTests(session, project(SPECS), { testTimeoutSec: 1 });
    expect(r.via).toBe('hosts');
    expect(r.notes ?? []).toEqual([]);
    expect(bridge.calls).toEqual([]);
  });
});
