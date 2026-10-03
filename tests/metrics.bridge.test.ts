import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
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

import { botProgram, runMetrics } from '../src/metrics/run.js';
import { StudioError, StudioSession } from '../src/studio/session.js';
import { fakeStudio, type FakeStudio } from './fakeStudio.js';

const DUMP = JSON.stringify({ elapsed: 10, players: { '1': { joinedAt: 0, steps: {} } }, events: [], samples: [{ t: 1, memMb: 100, stats: {} }, { t: 9, memMb: 100, stats: {} }] });
const ok = (v: unknown): LuauResult => ({ ok: true, values: [v], logs: [], durationMs: 1 });

let serverLogs: unknown[] = [];
function studio(evalBridge: boolean): { session: StudioSession; f: FakeStudio } {
  const env = (v: unknown) => JSON.stringify({ ok: true, n: 1, values: { v1: v }, logs: [] });
  const f = fakeStudio({
    luau: (code, dm) => {
      if (code.includes('GetPlayers()') && dm === 'Server') return env(1);
      if (code.includes('HumanoidRootPart') && dm === 'Client') return env(true);
      if (code.includes('GetLogHistory')) return env(dm === 'Server' ? serverLogs : []);
      if (code.includes('BloxTelemetryDump')) return env(DUMP);
      return env('ok');
    },
    tools: { multi_edit: () => 'ok' },
  });
  return { session: new StudioSession({ launch: { command: 'x', args: [] }, connector: async () => f.client, sleep: async () => {}, attachTimeoutMs: 0, evalBridge }), f };
}
const run = (session: StudioSession, seconds = 10) =>
  runMetrics(session, mkdtempSync(join(tmpdir(), 'blox-mb-')), null, { mode: 'soak', seconds, bot: 'walk', sleep: async () => {} });

beforeEach(() => {
  serverLogs = [];
  bridge.calls.length = 0;
  bridge.impl = async (code) => ok(code.includes('BloxTelemetryDump') ? DUMP : true);
});

describe('metrics bot through the eval bridge', () => {
  it('blocking bot program waits for the bot instead of spawning it', () => {
    const p = botProgram('/p', 'walk', 5, { blocking: true });
    expect(p).not.toContain('task.spawn');
    expect(p).toContain('pcall(__bot, player, deadline)');
    expect(botProgram('/p', 'walk', 5)).toContain('task.spawn');
  });

  it('runs the bot through the bridge: no injected BloxBotHost', async () => {
    const { session, f } = studio(true);
    const r = await run(session);
    expect(f.calls.some((c) => c.name === 'multi_edit')).toBe(false);
    const bot = bridge.calls.find((c) => c.code.includes('__bot'))!;
    expect(bot.ctx).toBe('server');
    expect(bot.code).not.toContain('task.spawn');
    expect(r.notes.join(' ')).toMatch(/bot ran through the eval bridge/);
    expect(r.results.find((x) => x.id === 'soak:telemetry')).toBeUndefined();
  });

  it('a run longer than the bridge limit injects the bot as before', async () => {
    const { session, f } = studio(true);
    const r = await run(session, 300);
    expect(f.calls.some((c) => c.name === 'multi_edit')).toBe(true);
    expect(bridge.calls.some((c) => c.code.includes('__bot'))).toBe(false);
    expect(r.notes.join(' ')).toMatch(/bridge not used.*120s/);
  });

  it('a bridge failure falls back to the injected bot', async () => {
    bridge.impl = async () => {
      throw new StudioError('wrong_mode', 'eval bridge: no plugin picked up the job');
    };
    const { session, f } = studio(true);
    const r = await run(session);
    expect(f.calls.some((c) => c.name === 'multi_edit')).toBe(true);
    expect(r.notes.join(' ')).toMatch(/eval bridge failed.*no plugin picked up/);
  });

  it('an idle bot with no plugin still reads the telemetry on the MCP thread', async () => {
    bridge.impl = async () => {
      throw new StudioError('wrong_mode', 'eval bridge: no plugin picked up the job');
    };
    const { session, f } = studio(true);
    const r = await runMetrics(session, mkdtempSync(join(tmpdir(), 'blox-mb-')), null, { mode: 'soak', seconds: 10, bot: 'idle', sleep: async () => {} });
    expect(f.calls.some((c) => c.name === 'execute_luau' && String(c.args.code).includes('BloxTelemetryDump'))).toBe(true);
    expect(r.notes.join(' ')).not.toMatch(/telemetry/i);
  });

  it('HTTP-disabled errors while the bridge holds HTTP off are not the game\'s errors', async () => {
    serverLogs = [
      { level: 'error', message: 'Http requests are not enabled. Enable via game settings', t: 1e12 },
      { level: 'error', message: 'Workspace.Lava: attempt to index nil', t: 1e12 },
    ];
    const { session } = studio(true);
    const r = await run(session);
    expect(r.results.find((x) => x.id === 'soak:errors')).toMatchObject({ actual: 1 });
    expect(r.notes.join(' ')).toMatch(/1 HTTP error\(s\) ignored/);
  });

  it('a bot failure that is not the bridge propagates', async () => {
    bridge.impl = async (code) => {
      if (code.includes('__bot')) throw new Error('kaboom');
      return ok(DUMP);
    };
    const { session } = studio(true);
    await expect(run(session)).rejects.toThrow(/kaboom/);
  });

  it('bridge off: injected bot, no bridge note', async () => {
    const { session, f } = studio(false);
    const r = await run(session);
    expect(f.calls.some((c) => c.name === 'multi_edit')).toBe(true);
    expect(r.notes.join(' ')).not.toMatch(/bridge/);
  });
});
