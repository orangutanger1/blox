import { describe, it, expect } from 'vitest';
import { assembleChunks, hostSource, normalizeHostPositions, pollResults, readMarkersLuau } from '../src/testing/playHost.js';
import { testProgram } from '../src/testing/runner.js';
import type { StudioSession } from '../src/studio/session.js';

describe('playHost', () => {
  it('reassembles chunks in order and waits for all of them', () => {
    expect(assembleChunks('2/2:def\n1/2:abc')).toBe('abcdef');
    expect(assembleChunks('1/2:abc')).toBeNull();
    expect(assembleChunks('')).toBeNull();
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
