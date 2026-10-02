import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findTool, invokeTool, type ToolCtx } from '../src/tools/registry.js';
import { StudioSession } from '../src/studio/session.js';
import { readEvents, writeJson, evaluateCriteria, type TaskState } from '../src/state/store.js';
import { BloxConfigSchema } from '../src/config.js';
import { fakeStudio } from './fakeStudio.js';

function ctxWith(f = fakeStudio()): ToolCtx {
  const projectPath = mkdtempSync(join(tmpdir(), 'blox-tools-'));
  return {
    session: new StudioSession({ launch: { command: 'x', args: [] }, connector: async () => f.client, sleep: async () => {}, attachTimeoutMs: 0 }),
    projectPath,
    config: BloxConfigSchema.parse({ projectPath }),
    agent: 'test',
  };
}
const call = (name: string, args: Record<string, unknown>, ctx: ToolCtx) => invokeTool(findTool(name)!, args, ctx);

describe('invokeTool', () => {
  it('logs every call to events.jsonl', async () => {
    const ctx = ctxWith();
    await call('task', { action: 'get' }, ctx);
    const ev = readEvents(ctx.projectPath);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ tool: 'task', ok: true, agent: 'test' });
  });
  it('rejects invalid arguments with a readable error', async () => {
    const ctx = ctxWith();
    const r = await call('play', { action: 'jump' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/invalid arguments: action/);
    expect(readEvents(ctx.projectPath)[0].ok).toBe(false);
  });
  it('surfaces Studio errors with code + hint', async () => {
    const ctx = ctxWith(fakeStudio({ studios: [[]] }));
    const r = await call('play', { action: 'state' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/\[no_studio\]/);
    expect(r.text).toMatch(/hint:/);
  });
  it('status degrades gracefully without Studio', async () => {
    const ctx = ctxWith(fakeStudio({ studios: [[]] }));
    const r = await call('status', {}, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/studio: NOT AVAILABLE/);
    expect(r.text).toMatch(/tests: never run/);
  });
  it('blocks external HTTP in probes and http_get/multi_edit passthrough', async () => {
    const ctx = ctxWith();
    expect((await call('run_luau', { code: 'game:GetService("HttpService"):GetAsync("http://x")' }, ctx)).isError).toBe(true);
    expect((await call('studio_tool', { name: 'http_get', args: {} }, ctx)).text).toMatch(/blocked/);
    expect((await call('studio_tool', { name: 'multi_edit', args: {} }, ctx)).text).toMatch(/blocked/);
  });
});

describe('studio_tool schema help', () => {
  it('list {tool} returns the full schema without studio_id', async () => {
    const r = await call('studio_tool', { name: 'list', args: { tool: 'start_stop_play' } }, ctxWith());
    expect(r.text).toContain('"is_start"');
    expect(r.text).not.toContain('studio_id');
  });
  it('a rejected raw call comes back with that tool\'s schema', async () => {
    const r = await call('studio_tool', { name: 'execute_luau', args: { bogus: 1 } }, ctxWith());
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/input schema for execute_luau: .*"datamodel_type"/);
  });
});

describe('explore', () => {
  it('sends the datamodel Studio requires (edit at rest)', async () => {
    const f = fakeStudio({ tools: { search_game_tree: () => '[]' } });
    await call('explore', { path: 'Workspace' }, ctxWith(f));
    expect(f.calls.find((c) => c.name === 'search_game_tree')?.args).toMatchObject({ path: 'Workspace', datamodel_type: 'Edit' });
  });
});

describe('task tool', () => {
  it('sets criteria and derives test-bound status from the last run', async () => {
    const ctx = ctxWith();
    await call('task', { action: 'set', goal: 'coin game', criteria: [
      { id: 'c1', text: 'coins increment', tests: ['coin'] },
      { id: 'c2', text: 'looks good' },
    ] }, ctx);
    writeJson(ctx.projectPath, 'last-tests.json', { ranAt: 't', tests: [{ file: 'tests/coin.spec.luau', name: 'touch adds 1', status: 'pass' }] });
    const r = await call('task', { action: 'get' }, ctx);
    expect(r.text).toMatch(/\[x\] c1/);
    expect(r.text).toMatch(/\[ \] c2/);
    const u = await call('task', { action: 'update', id: 'c1', status: 'pass' }, ctx);
    expect(u.isError).toBe(true); // bound to tests
    await call('task', { action: 'update', id: 'c2', status: 'pass', evidence: 'screenshot .blox/artifacts/x.jpg' }, ctx);
    await call('task', { action: 'block', text: 'needs a published place for DataStores' }, ctx);
    const g = await call('task', { action: 'get' }, ctx);
    expect(g.text).toMatch(/criteria: 2\/2 passing/);
    expect(g.text).toMatch(/BLOCKER: needs a published place/);
  });
});

describe('evaluateCriteria', () => {
  const task: TaskState = { goal: 'g', criteria: [{ id: 'a', text: 'a', tests: ['x'], status: 'pending' }], notes: [], blockers: [], updatedAt: '' };
  it('fails when any matching test fails, pending when none match', () => {
    expect(evaluateCriteria(task, { ranAt: 'r', tests: [{ file: 'x', name: 'n', status: 'fail' }, { file: 'x', name: 'm', status: 'pass' }] })[0].status).toBe('fail');
    expect(evaluateCriteria(task, { ranAt: 'r', tests: [{ file: 'y', name: 'n', status: 'pass' }] })[0].status).toBe('pending');
  });
});
