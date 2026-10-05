// tests/idea.tool.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findTool, invokeTool, type ToolCtx } from '../src/tools/registry.js';
import { StudioSession } from '../src/studio/session.js';
import { BloxConfigSchema } from '../src/config.js';
import { readJson } from '../src/state/store.js';
import { cliArgs, parseFlags, TOOL_COMMANDS } from '../src/cliTools.js';
import { fakeFetch, WEB, type Web } from './helpers/ideaWeb.js';
import { saveSnapshot, listSnapshots } from '../src/idea/snapshot.js';

function ctxFor(P: string, web: Web = WEB, seen: string[] = []): ToolCtx {
  return {
    // idea never touches Studio; a session that fails to connect is enough.
    session: new StudioSession({ launch: { command: 'x', args: [] }, connector: async () => { throw new Error('no studio in idea tests'); }, sleep: async () => {}, attachTimeoutMs: 0 }),
    projectPath: P,
    config: BloxConfigSchema.parse({ projectPath: P }),
    agent: 'test',
    fetch: fakeFetch(web, seen),
  };
}
const tool = () => findTool('idea')!;
const idea = (id: string, cites: number[], extra: Record<string, unknown> = {}) => ({
  id, title: `T ${id}`, format: 'steal-tycoon', genre_l1: 'Simulation', genre_l2: 'Tycoon', theme: 'eggs', hook: 'h', loop: ['a', 'b', 'c'],
  monetization: [{ kind: 'pass', name: 'VIP', priceRobux: 399 }], cites, ...extra,
});

describe('idea tool', () => {
  it('research writes a snapshot, prints stats + game list, reuses today', async () => {
    const P = mkdtempSync(join(tmpdir(), 'idea-tool-'));
    const seen: string[] = [];
    const out = await invokeTool(tool(), { action: 'research' }, ctxFor(P, WEB, seen));
    expect(out.isError).toBeFalsy();
    expect(listSnapshots(P)).toHaveLength(1);
    expect(out.text).toMatch(/Simulation/);
    expect(out.text).toMatch(/Steal An Egg/);
    expect(out.text).toMatch(/idea \{action:"propose"/);
    const n = seen.length;
    const again = await invokeTool(tool(), { action: 'research' }, ctxFor(P, WEB, seen));
    expect(seen.length).toBe(n); // cached
    expect(again.text).toMatch(/cached/);
    await invokeTool(tool(), { action: 'research', fresh: true }, ctxFor(P, WEB, seen));
    expect(seen.length).toBeGreaterThan(n);
  });
  it('research with a different device is not served from cache', async () => {
    const P = mkdtempSync(join(tmpdir(), 'idea-tool-'));
    const seen: string[] = [];
    await invokeTool(tool(), { action: 'research' }, ctxFor(P, WEB, seen));
    await invokeTool(tool(), { action: 'research', device: 'phone' }, ctxFor(P, WEB, seen));
    expect(seen.some((u) => u.includes('device=high_end_phone'))).toBe(true);
  });
  it('research: charts down is an error', async () => {
    const P = mkdtempSync(join(tmpdir(), 'idea-tool-'));
    const out = await invokeTool(tool(), { action: 'research' }, ctxFor(P, {}));
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/charts unavailable/);
  });
  it('propose before research says to research first', async () => {
    const P = mkdtempSync(join(tmpdir(), 'idea-tool-'));
    const out = await invokeTool(tool(), { action: 'propose', ideas: [] }, ctxFor(P));
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/idea \{action:"research"\}/);
  });
  it('propose → list → brief round trip; bad cites refused; unknown brief id listed', async () => {
    const P = mkdtempSync(join(tmpdir(), 'idea-tool-'));
    await invokeTool(tool(), { action: 'research' }, ctxFor(P));
    const bad = await invokeTool(tool(), { action: 'propose', ideas: [idea('a', [1, 99]), idea('b', [1, 2]), idea('c', [2, 1])] }, ctxFor(P));
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/99/);
    const ok = await invokeTool(tool(), { action: 'propose', ideas: [idea('a', [1, 2]), idea('b', [1, 2], { format: 'other' }), idea('c', [2, 1])] }, ctxFor(P));
    expect(ok.isError).toBeFalsy();
    const saved = readJson<{ ideas: { id: string; score: number }[] }>(P, 'ideas.json')!;
    expect(saved.ideas.map((i) => i.id)).toEqual(['a', 'c', 'b']);
    const list = await invokeTool(tool(), { action: 'list' }, ctxFor(P));
    expect(list.text).toMatch(/1\. a/);
    expect(list.text).toMatch(/demand/);
    const unknown = await invokeTool(tool(), { action: 'brief', id: 'zzz' }, ctxFor(P));
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toMatch(/a, c, b/);
    const brief = await invokeTool(tool(), { action: 'brief', id: 'c' }, ctxFor(P));
    expect(brief.isError).toBeFalsy();
    expect(readJson<{ idea: { id: string } }>(P, 'brief.json')!.idea.id).toBe('c');
    expect(readJson(P, 'design.json')).toBeNull(); // never written
  });
  it('brief refuses when the snapshot was re-fetched after propose (evidence could silently drop)', async () => {
    const P = mkdtempSync(join(tmpdir(), 'idea-tool-'));
    const at = (iso: string) => ({ ...ctxFor(P), now: new Date(iso) });
    await invokeTool(tool(), { action: 'research' }, at('2026-10-03T08:00:00Z'));
    await invokeTool(tool(), { action: 'propose', ideas: [idea('a', [1, 2]), idea('b', [1, 2]), idea('c', [2, 1])] }, at('2026-10-03T08:01:00Z'));
    await invokeTool(tool(), { action: 'research', fresh: true }, at('2026-10-03T09:00:00Z'));
    const out = await invokeTool(tool(), { action: 'brief', id: 'a' }, at('2026-10-03T09:01:00Z'));
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/propose again/);
    expect(readJson(P, 'brief.json')).toBeNull();
  });
  it('a device switch keeps its own snapshot file, so earlier ideas stay briefable', async () => {
    const P = mkdtempSync(join(tmpdir(), 'idea-tool-'));
    const at = (iso: string) => ({ ...ctxFor(P), now: new Date(iso) });
    await invokeTool(tool(), { action: 'research' }, at('2026-10-03T08:00:00Z'));
    await invokeTool(tool(), { action: 'propose', ideas: [idea('a', [1, 2]), idea('b', [1, 2]), idea('c', [2, 1])] }, at('2026-10-03T08:01:00Z'));
    await invokeTool(tool(), { action: 'research', device: 'phone' }, at('2026-10-03T09:00:00Z'));
    expect(listSnapshots(P)).toEqual(['2026-10-03', '2026-10-03.high_end_phone']);
    const out = await invokeTool(tool(), { action: 'brief', id: 'a' }, at('2026-10-03T09:01:00Z'));
    expect(out.isError).toBeFalsy();
    // propose now uses the newest fetch (phone) and records its key
    await invokeTool(tool(), { action: 'propose', ideas: [idea('a', [1, 2]), idea('b', [1, 2]), idea('c', [2, 1])] }, at('2026-10-03T09:02:00Z'));
    expect(readJson<{ snapshot: string }>(P, 'ideas.json')!.snapshot).toBe('2026-10-03.high_end_phone');
    expect((await invokeTool(tool(), { action: 'brief', id: 'b' }, at('2026-10-03T09:03:00Z'))).isError).toBeFalsy();
  });
  it('propose takes ideas as JSON text or {ideas}, and explains empty/bad input', async () => {
    const P = mkdtempSync(join(tmpdir(), 'idea-tool-'));
    await invokeTool(tool(), { action: 'research' }, ctxFor(P));
    const list = [idea('a', [1, 2]), idea('b', [1, 2]), idea('c', [2, 1])];
    expect((await invokeTool(tool(), { action: 'propose', ideas: JSON.stringify(list) }, ctxFor(P))).isError).toBeFalsy();
    expect((await invokeTool(tool(), { action: 'propose', ideas: JSON.stringify({ ideas: list }) }, ctxFor(P))).isError).toBeFalsy();
    const empty = await invokeTool(tool(), { action: 'propose', ideas: '' }, ctxFor(P));
    expect(empty.isError).toBe(true);
    expect(empty.text).toMatch(/no ideas given/);
    const nul = await invokeTool(tool(), { action: 'propose', ideas: 'null' }, ctxFor(P));
    expect(nul.text).toMatch(/no ideas given/);
    const bad = await invokeTool(tool(), { action: 'propose', ideas: '[{oops' }, ctxFor(P));
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/not valid JSON/);
  });
  it('list with no ideas explains the order', async () => {
    const P = mkdtempSync(join(tmpdir(), 'idea-tool-'));
    const out = await invokeTool(tool(), { action: 'list' }, ctxFor(P));
    expect(out.text).toMatch(/no ideas yet/);
  });
  it('research shows rising themes when a previous snapshot exists', async () => {
    const P = mkdtempSync(join(tmpdir(), 'idea-tool-'));
    saveSnapshot(P, { version: 1, at: '2026-09-01T00:00:00Z', date: '2026-09-01', device: 'all', sorts: [], notes: [], games: [] });
    const out = await invokeTool(tool(), { action: 'research' }, ctxFor(P));
    expect(out.text).toMatch(/vs 2026-09-01/);
  });
});

describe('idea CLI', () => {
  it('maps subcommands', () => {
    expect(TOOL_COMMANDS.has('idea')).toBe(true);
    expect(cliArgs('idea', parseFlags(['research', '--fresh', '--device', 'phone']))).toEqual({ tool: 'idea', args: { action: 'research', fresh: true, device: 'phone' } });
    // Raw text through; the tool parses it (bad/empty JSON gets the tool's error, not a crash).
    expect(cliArgs('idea', parseFlags(['propose', '[{"id":"a"}]']))).toEqual({ tool: 'idea', args: { action: 'propose', ideas: '[{"id":"a"}]' } });
    expect(cliArgs('idea', parseFlags(['propose']))).toEqual({ tool: 'idea', args: { action: 'propose', ideas: '' } });
    expect(cliArgs('idea', parseFlags(['brief', 'a']))).toEqual({ tool: 'idea', args: { action: 'brief', id: 'a' } });
    expect(cliArgs('idea', parseFlags([]))).toEqual({ tool: 'idea', args: { action: 'list' } });
  });
});
