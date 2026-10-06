import { describe, it, expect } from 'vitest';
import { assembleChunks, hostSource, normalizeHostPositions, pollResults, probeHostSource, PROBE_HOSTS, readMarkersLuau, runProbe } from '../src/testing/playHost.js';
import { testProgram } from '../src/testing/runner.js';
import type { StudioSession } from '../src/studio/session.js';

describe('playHost', () => {
  it('reassembles chunks in order and waits for all of them', () => {
    expect(assembleChunks('2/2:def\n1/2:abc')).toBe('abcdef');
    expect(assembleChunks('1/2:abc')).toBeNull();
    expect(assembleChunks('')).toBeNull();
  });

  it('decodes escaped backslashes and percents so quoted failure messages survive Studio output', () => {
    const json = assembleChunks('1/2:{"m":"expected %5C"x%5C", got %5C"1.00 \n2/2:2.00%5C" 100%25"}');
    expect(JSON.parse(json as string)).toEqual({ m: 'expected "x", got "1.00 2.00" 100%' });
  });

  it('hosts escape backslashes and percents before printing (Studio output drops \\"x\\" runs)', () => {
    for (const src of [hostSource('return 1', 'server', 'r'), probeHostSource('return 1', 'client', 'r')]) {
      expect(src).toContain('local json = escapeMarker(game:GetService("HttpService"):JSONEncode(out))');
    }
  });

  it('keeps program line N at host line N so spec positions map unchanged', () => {
    const { code } = testProgram([{ file: 'tests/a.spec.luau', context: 'server', source: 'test("x", function() end)\n' }], 5);
    const src = hostSource(code, 'server', 'abcd1234');
    const hostLines = src.split('\n');
    code.split('\n').forEach((l, i) => {
      if (i === 0) expect(hostLines[0].endsWith(l)).toBe(true);
      else expect(hostLines[i]).toBe(l);
    });
    expect(src).toContain('print("BLOXTEST:abcd1234:server:"');
  });

  it('client host waits for its own character, server host for a player', () => {
    expect(hostSource('return {}', 'client', 'r')).toContain('LocalPlayer');
    // specs start after the avatar finishes loading (late accessories shift the character)
    expect(hostSource('return {}', 'client', 'r')).toContain('HasAppearanceLoaded');
    expect(hostSource('return {}', 'server', 'r')).toContain('HasAppearanceLoaded');
    expect(hostSource('return {}', 'server', 'r')).toContain('GetPlayers');
  });

  it('rewrites host script positions to AssistantCommand positions', () => {
    expect(normalizeHostPositions('ServerScriptService.BloxTestHost:12: boom')).toBe('AssistantCommand:12: boom');
    expect(normalizeHostPositions('Players.Player1.PlayerScripts.BloxTestHostClient:7: x')).toBe('AssistantCommand:7: x');
  });

  it('marker reader filters on run id and context', () => {
    expect(readMarkersLuau('r1', 'client')).toContain('BLOXTEST:r1:client:');
  });

  it('polls the right datamodel until every chunk arrives', async () => {
    const seen: string[] = [];
    let n = 0;
    const session = {
      call: async (_: string, args: Record<string, unknown>) => {
        seen.push(String(args.datamodel_type));
        n++;
        return { content: [{ type: 'text', text: n < 2 ? '1/2:{"results":' : '1/2:{"results":\n2/2:[]}' }] };
      },
    } as unknown as StudioSession;
    const v = await pollResults(session, 'r', 'client', Date.now() + 10_000, async () => {});
    expect(v).toEqual({ results: [] });
    expect(seen).toEqual(['Client', 'Client']);
  });

  it('gives up at the deadline', async () => {
    const session = { call: async () => ({ content: [{ type: 'text', text: '' }] }) } as unknown as StudioSession;
    expect(await pollResults(session, 'r', 'server', Date.now() - 1, async () => {})).toBeNull();
  });
});

describe('probe hosts (playtest server_code/client_code as real scripts)', () => {
  it('inlines the probe on line 1, waits for the go attribute, and reports under its own tag', () => {
    const src = probeHostSource('return shared.X', 'server', 'r9');
    expect(src.split('\n')[0]).toBe('local function __blox_probe() return shared.X');
    expect(src).toContain('GetAttribute("BloxGo")');
    expect(src).toContain('BLOXTEST:r9:probe-server:');
    expect(PROBE_HOSTS.client.className).toBe('LocalScript');
  });

  it('triggers, then reads the probe result back and maps host positions', async () => {
    const calls: { code: string; dm: string }[] = [];
    const session = {
      call: async (_: string, args: Record<string, unknown>) => {
        calls.push({ code: String(args.code), dm: String(args.datamodel_type) });
        if (String(args.code).includes('BloxGo')) return { content: [{ type: 'text', text: 'ok' }] };
        return { content: [{ type: 'text', text: '1/1:{"ok":false,"error":"ServerScriptService.BloxProbeHost:3: boom"}' }] };
      },
    } as unknown as StudioSession;
    const r = await runProbe(session, 'server', 'r9', Date.now() + 5000, async () => {});
    expect(calls[0].code).toContain('SetAttribute("BloxGo", true)');
    expect(calls.every((c) => c.dm === 'Server')).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.error?.message).toBe('serverCode:3: boom');
  });

  it('returns serialized values on success and an error at the deadline', async () => {
    const ok = { call: async (_: string, a: Record<string, unknown>) => ({ content: [{ type: 'text', text: String(a.code).includes('BloxGo') ? 'ok' : '1/1:{"ok":true,"values":[6,"Workspace.Dogs"]}' }] }) } as unknown as StudioSession;
    expect((await runProbe(ok, 'client', 'r', Date.now() + 5000, async () => {})).values).toEqual([6, 'Workspace.Dogs']);
    const never = { call: async () => ({ content: [{ type: 'text', text: '' }] }) } as unknown as StudioSession;
    const r = await runProbe(never, 'server', 'r', Date.now() - 1, async () => {});
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/no result/);
  });
});

describe('probe marker reader', () => {
  it('sends Luau that keeps the newline escape inside the string literal', async () => {
    const codes: string[] = [];
    const session = { call: async (_: string, a: Record<string, unknown>) => { codes.push(String(a.code)); return { content: [{ type: 'text', text: String(a.code).includes('BloxGo') ? 'ok' : '1/1:{"ok":true,"values":[]}' }] }; } } as unknown as StudioSession;
    await runProbe(session, 'server', 'r', Date.now() + 1000, async () => {});
    expect(codes[1]).toContain('table.concat(out, "\\n")');
  });
});
