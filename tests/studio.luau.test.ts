import { describe, it, expect } from 'vitest';
import { longString, wrapLuau, mapLines, runLuau, userLineOffset } from '../src/studio/luau.js';
import { StudioSession } from '../src/studio/session.js';
import { fakeStudio } from './fakeStudio.js';

describe('longString', () => {
  it('picks a level whose closer is absent', () => {
    expect(longString('abc')).toBe('[[abc]]');
    expect(longString('a]]b')).toBe('[=[a]]b]=]');
  });
  it('does not let a trailing "]" fuse with the closer (JSON arrays)', () => {
    const s = longString('[1,2]');
    // "[[[1,2]]]" would close one char early; must escalate.
    expect(s).toBe('[=[[1,2]]=]');
  });
  it('pads a leading newline so it survives', () => {
    expect(longString('\nx')).toBe('[[\n\nx]]');
  });
});

describe('wrapLuau / mapLines', () => {
  it('places user code at the computed offset', () => {
    for (const fresh of [false, true]) {
      const { program, userLineOffset: off } = wrapLuau('MARK_LINE_1\nMARK_LINE_2', { freshRequire: fresh });
      expect(off).toBe(userLineOffset(fresh));
      expect(program.split('\n')[off]).toBe('MARK_LINE_1');
    }
  });
  it('maps AssistantCommand lines to the chunk, clamping wrapper lines', () => {
    const off = 100;
    expect(mapLines('AssistantCommand:102: boom', off, 'tests/a.luau', 5)).toBe('tests/a.luau:2: boom');
    expect(mapLines('AssistantCommand:190: x', off, 'c', 5)).toBe('<blox-wrapper>: x');
  });
});

describe('runLuau', () => {
  const session = (luau: (code: string, dm: string) => any) =>
    new StudioSession({ launch: { command: 'x', args: [] }, connector: async () => fakeStudio({ luau }).client, sleep: async () => {} });

  it('decodes the JSON envelope (values keyed v1..vn survive nil holes)', async () => {
    const s = session(() => JSON.stringify({ ok: true, n: 3, values: { v1: 1, v3: 'x' }, logs: [{ level: 'output', message: 'hi' }], ms: 2 }));
    const r = await runLuau(s, 'return 1, nil, "x"');
    expect(r.ok).toBe(true);
    expect(r.values).toEqual([1, null, 'x']);
    expect(r.logs[0]).toEqual({ level: 'output', message: 'hi' });
  });
  it('routes context to datamodel_type and uses fresh require only in edit', async () => {
    const seen: { dm: string; code: string }[] = [];
    const s = session((code, dm) => { seen.push({ dm, code }); return JSON.stringify({ ok: true, n: 0, values: [], logs: [] }); });
    await runLuau(s, 'return 1', 'server');
    await runLuau(s, 'return 1', 'edit');
    expect(seen[0].dm).toBe('Server');
    expect(seen[0].code).not.toContain('local require = __freshRequire');
    expect(seen[1].dm).toBe('Edit');
    expect(seen[1].code).toContain('local require = __freshRequire');
  });
  it('recovers syntax errors via loadstring', async () => {
    let n = 0;
    const s = session(() => (n++ === 0 ? { content: [{ type: 'text', text: 'X:54: Failed to parse command code' }], isError: true } : "bad.luau:1: Expected identifier"));
    const r = await runLuau(s, 'local x = = 1', 'edit', { chunkName: 'bad.luau' });
    expect(r.ok).toBe(false);
    expect(r.error?.message).toBe('syntax error: bad.luau:1: Expected identifier');
  });
  it('turns Play-mode edit failures into wrong_mode', async () => {
    const s = session(() => ({ content: [{ type: 'text', text: 'Edit datamodel is not available in Play mode' }], isError: true }));
    await expect(runLuau(s, 'return 1', 'edit')).rejects.toMatchObject({ code: 'wrong_mode' });
  });
});
