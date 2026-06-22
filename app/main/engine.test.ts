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

describe('buildChildEnv', () => {
  it('injects the key and prepends rojo dir to PATH', () => {
    const env = buildChildEnv({ PATH: '/usr/bin' }, 'sk-123', '/opt/rojo', ':');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-123');
    expect(env.PATH).toBe('/opt/rojo:/usr/bin');
  });
  it('omits the key when null and leaves PATH alone with no rojo dir', () => {
    const env = buildChildEnv({ PATH: '/usr/bin' }, null, undefined, ':');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
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
      loadKey: () => 'sk-9',
      fork: (entry, args, env) => { calls.push({ args, env }); expect(entry).toBe('/app/dist/cli.js'); return fakeChild; },
      pathSep: ':',
    });
    const handle = host.run('build it', '/proj', { mode: 'auto' });
    expect(calls[0].args).toEqual(['build it', '--project', '/proj', '--auto']);
    expect(calls[0].env.ANTHROPIC_API_KEY).toBe('sk-9');
    handle.cancel();
    expect(killed).toBe(true);
    exitCb(0);
    expect(await handle.done).toEqual({ code: 0 });
  });
});
