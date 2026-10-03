import { describe, it, expect } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexAppServer, codexArgs } from '../src/agent/codex/appServer.js';
import { codexEffort, codexModel, runCodexAgent } from '../src/agent/codexRunner.js';
import { codexAuthCommand } from '../src/agent/codex/login.js';
import { BloxConfigSchema, runnerFor } from '../src/config.js';
import { parseArgs } from '../src/args.js';
import { buildDigest } from '../src/context/digest.js';
import type { ToolCtx } from '../src/tools/registry.js';
import type { StudioSession } from '../src/studio/session.js';

const FAKE = fileURLToPath(new URL('./fixtures/fakeCodex.mjs', import.meta.url));

function fakeServer(scenario: string, stderr: string[] = []) {
  return new CodexAppServer({
    spawnProcess: () => {
      const c = spawn(process.execPath, [FAKE, scenario], { stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
      c.stderr.on('data', (d) => stderr.push(String(d)));
      return c;
    },
  });
}

function setup(extra: Record<string, unknown> = {}) {
  const projectPath = mkdtempSync(join(tmpdir(), 'blox-codex-'));
  writeFileSync(join(projectPath, 'default.project.json'), JSON.stringify({ name: 'g', tree: { $className: 'DataModel' } }));
  writeFileSync(join(projectPath, 'hello.txt'), 'hi there');
  const config = BloxConfigSchema.parse({ projectPath, runner: 'codex', maxTurns: 5, ...extra });
  const ctx: ToolCtx = { session: {} as StudioSession, projectPath, config, agent: 'test' };
  return { config, ctx, digest: buildDigest(projectPath) };
}

describe('codex runner', () => {
  it('locks Codex down to blox tools and answers dynamic tool calls', async () => {
    const { config, ctx, digest } = setup();
    const stderr: string[] = [];
    const logs: string[] = [];
    const r = await runCodexAgent('read hello', config, ctx, digest, {
      appServer: fakeServer('tool', stderr),
      sink: { emit: (e) => { if (e.type === 'log') logs.push(e.text); } },
    });
    expect(r).toMatchObject({ status: 'success', stopReason: 'completed', numTurns: 1, costUsd: 0, tokens: { input: 60, cacheRead: 40, output: 7, cacheWrite: 0 } });
    expect(logs.some((l) => l.includes('file says: hi there'))).toBe(true);
    const start = JSON.parse(stderr.join('').trim().split('\n')[0]);
    expect(start).toMatchObject({ sandbox: 'read-only', approval: 'never' });
    expect(start.tools).toEqual(expect.arrayContaining(['read_file', 'write_file', 'run_luau', 'sync']));
  });
  it('does not stall out a blox tool call that runs longer than stallMs', async () => {
    const { config, ctx, digest } = setup();
    const slow = async () => {
      await new Promise((r) => setTimeout(r, 400));
      return { content: [{ type: 'text', text: '1' }] };
    };
    ctx.session = new Proxy({}, { get: (_t, k) => (k === 'then' ? undefined : slow) }) as unknown as StudioSession;
    const r = await runCodexAgent('x', config, ctx, digest, { appServer: fakeServer('slow'), stallMs: 100 });
    expect(r.stopReason).toBe('completed');
  });
  it('stops a turn that uses a built-in Codex tool', async () => {
    const { config, ctx, digest } = setup();
    const r = await runCodexAgent('x', config, ctx, digest, { appServer: fakeServer('builtin') });
    expect(r.status).toBe('error');
    expect(r.detail).toMatch(/built-in "commandExecution"/);
  });
  it('enforces maxTurns as a tool-call cap', async () => {
    const { config, ctx, digest } = setup({ maxTurns: 3 });
    const r = await runCodexAgent('x', config, ctx, digest, { appServer: fakeServer('loop') });
    expect(r).toMatchObject({ stopReason: 'maxTurns', numTurns: 4 });
  });
  it('asks for sign-in when Codex has no ChatGPT account', async () => {
    const { config, ctx, digest } = setup();
    const r = await runCodexAgent('x', config, ctx, digest, { appServer: fakeServer('signedout') });
    expect(r.detail).toMatch(/blox auth codex/);
    const said: string[] = [];
    expect(await codexAuthCommand('status', (s) => said.push(s), fakeServer('signedout'))).toBe(1);
    expect(said[0]).toMatch(/not signed in/);
  });
});

describe('codex plumbing', () => {
  it('disables Codex acting features via -c, not --disable', () => {
    const a = codexArgs();
    expect(a[0]).toBe('app-server');
    expect(a).toContain('features.shell_tool=false');
    expect(a).not.toContain('--disable');
  });
  it('maps model and effort', () => {
    expect(codexModel('claude-opus-5-5')).toBeUndefined();
    expect(codexModel('gpt-5.5')).toBe('gpt-5.5');
    expect(codexModel('codex,gpt-5.5')).toBe('gpt-5.5');
    expect(codexEffort('max')).toBe('xhigh');
  });
  it('accepts --runner codex', () => {
    expect(parseArgs(['--runner', 'codex', 'do it']).runner).toBe('codex');
    expect(runnerFor({ runner: 'codex', model: 'openrouter,x' })).toBe('codex');
  });
});
