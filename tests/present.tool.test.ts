import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findTool, invokeTool, type ToolCtx } from '../src/tools/registry.js';
import { StudioSession } from '../src/studio/session.js';
import { BloxConfigSchema } from '../src/config.js';
import { readJson, withSyntheticResults, writeJson } from '../src/state/store.js';
import { cliArgs, parseFlags } from '../src/cliTools.js';
import { fakeStudio } from './fakeStudio.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000007800000043808020000', 'hex');
let n = 0;
function ctx(): ToolCtx {
  const projectPath = mkdtempSync(join(tmpdir(), 'blox-ptool-'));
  const f = fakeStudio({
    luau: () => JSON.stringify({ ok: true, n: 1, values: { v1: 'r15' }, logs: [] }),
    // distinct bytes per capture so variants are not duplicates
    tools: { screen_capture: () => ({ content: [{ type: 'image', data: Buffer.concat([PNG, Buffer.from([n++])]).toString('base64'), mimeType: 'image/png' }] }) },
  });
  return {
    session: new StudioSession({ launch: { command: 'x', args: [] }, connector: async () => f.client, sleep: async () => {}, attachTimeoutMs: 0 }),
    projectPath,
    config: BloxConfigSchema.parse({ projectPath }),
    agent: 'test',
  };
}
const call = (args: Record<string, unknown>, c: ToolCtx) => invokeTool(findTool('present')!, args, c);
const design = () => JSON.parse(readFileSync(new URL('../docs/examples/design/steal-tycoon.json', import.meta.url), 'utf8'));

describe('present tool', () => {
  it('generate → render → lint passes, results bind as present:<rule>', async () => {
    const c = ctx();
    writeJson(c.projectPath, 'design.json', design());
    const g = await call({ action: 'generate' }, c);
    expect(g.text).toMatch(/title candidates:\n  1\. Carve A Snow Beast/);
    const saved = readJson<{ title: string; shots: unknown[] }>(c.projectPath, 'presentation.json')!;
    expect(saved.title).toBe('Carve A Snow Beast');
    expect(saved.shots).toHaveLength(6);
    const r = await call({ action: 'render' }, c);
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/rendered 6\/6/);
    const l = await call({ action: 'lint' }, c);
    expect(l.text).toMatch(/17\/17 rules pass/);
    expect(l.isError).toBeFalsy();
    expect(withSyntheticResults(c.projectPath, null)!.tests.some((t) => t.name === 'present:thumb-rendered' && t.status === 'pass')).toBe(true);
  });
  it('generate keeps an existing title/description', async () => {
    const c = ctx();
    writeJson(c.projectPath, 'design.json', design());
    writeJson(c.projectPath, 'presentation.json', { version: 1, title: 'Mine', description: 'Mine too', shots: [] });
    await call({ action: 'generate' }, c);
    const p = readJson<{ title: string; description: string; shots: unknown[] }>(c.projectPath, 'presentation.json')!;
    expect([p.title, p.description, p.shots.length]).toEqual(['Mine', 'Mine too', 6]);
  });
  it('set validates; lint fails on policy errors', async () => {
    const c = ctx();
    const bad = await call({ action: 'set', doc: { version: 1, title: 'x', description: 'y', shots: [{ id: 'a' }] } }, c);
    expect(bad.isError).toBe(true);
    await call({ action: 'set', doc: { version: 1, title: 'Roblox Tycoon', description: 'free robux', shots: [] } }, c);
    const l = await call({ action: 'lint' }, c);
    expect(l.isError).toBe(true);
    expect(l.text).toMatch(/ERROR title-roblox/);
    expect(l.text).toMatch(/ERROR scam/);
  });
  it('cli mapping', () => {
    expect(cliArgs('present', parseFlags(['render', '--shots', 'a,b']))).toEqual({ tool: 'present', args: { action: 'render', ids: ['a', 'b'] } });
    expect(cliArgs('present', parseFlags(['set', '{"version":1}']))).toEqual({ tool: 'present', args: { action: 'set', doc: { version: 1 } } });
    expect(cliArgs('present', parseFlags([]))).toEqual({ tool: 'present', args: { action: 'get' } });
  });
});
