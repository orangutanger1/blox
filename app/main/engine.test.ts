import { describe, it, expect } from 'vitest';
import { buildRunArgs, buildChildEnv, createEngineHost, type EngineChild } from './engine.js';

describe('buildRunArgs', () => {
  it('builds prompt + project + autonomy flags', () => {
    expect(buildRunArgs('make a door', '/p', { mode: 'ask', maxTurns: 8, budgetUsd: 2, effort: 'high' }))
      .toEqual(['make a door', '--project', '/p', '--ask', '--max-turns', '8', '--budget', '2', '--effort', 'high']);
  });
  it('defaults to --auto with no extras', () => {
    expect(buildRunArgs('x', '/p')).toEqual(['x', '--project', '/p', '--auto']);
  });
  it('adds --image when given', () => {
    expect(buildRunArgs('x', '/p', { image: '/ref.png' })).toContain('--image');
  });
});

describe('buildRunArgs model', () => {
  it('appends --model when set', () => {
    const a = buildRunArgs('p', '/x', { model: 'openrouter,deepseek/deepseek-chat' });
    expect(a[a.indexOf('--model') + 1]).toBe('openrouter,deepseek/deepseek-chat');
  });
  it('omits --model when unset', () => {
    expect(buildRunArgs('p', '/x', {})).not.toContain('--model');
  });
});

describe('buildChildEnv', () => {
  it('prepends rojo dir to PATH and injects no key', () => {
    const env = buildChildEnv({ PATH: '/usr/bin' }, '/opt/rojo', ':');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.PATH).toBe('/opt/rojo:/usr/bin');
  });
  it('leaves PATH alone with no rojo dir', () => {
    const env = buildChildEnv({ PATH: '/usr/bin' }, undefined, ':');
    expect(env.PATH).toBe('/usr/bin');
  });
});

describe('createEngineHost.run', () => {
  it('forks the engine, resolves done on exit, and cancel kills the child', async () => {
    let killed = false;
    const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    let exitCb: (code: number | null) => void = () => {};
    const fakeChild: EngineChild = {
      on: (_e, cb) => { exitCb = cb; },
      kill: () => { killed = true; },
    };
    const host = createEngineHost({
      enginePath: '/app/dist/cli.js',
      rojoDir: '/opt/rojo',
      fork: (entry, args, env) => { calls.push({ args, env }); expect(entry).toBe('/app/dist/cli.js'); return fakeChild; },
      pathSep: ':',
    });
    const handle = host.run('build it', '/proj', { mode: 'auto' });
    expect(calls[0].args).toEqual(['build it', '--project', '/proj', '--auto']);
    handle.cancel();
    expect(killed).toBe(true);
    exitCb(0);
    expect(await handle.done).toEqual({ code: 0 });
  });
});
