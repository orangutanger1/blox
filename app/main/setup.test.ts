import { describe, it, expect } from 'vitest';
import { createSetup, type SetupDeps } from './setup.js';

function deps(over: Partial<SetupDeps> = {}): SetupDeps {
  return {
    runCli: async () => ({ code: 0, stdout: '' }),
    which: async () => '/usr/bin/rojo',
    download: async () => {},
    rojoBinPath: '/opt/rojo/rojo',
    ...over,
  };
}

describe('detectRojo', () => {
  it('ok when rojo is on PATH', async () => {
    expect((await createSetup(deps()).detectRojo()).status).toBe('ok');
  });
  it('missing when not found', async () => {
    expect((await createSetup(deps({ which: async () => null })).detectRojo()).status).toBe('missing');
  });
});

describe('installRojo', () => {
  it('ok after a successful download', async () => {
    expect((await createSetup(deps()).installRojo()).status).toBe('ok');
  });
  it('error when download throws', async () => {
    const r = await createSetup(deps({ download: async () => { throw new Error('net'); } })).installRojo();
    expect(r.status).toBe('error');
    expect(r.detail).toMatch(/net/);
  });
});

describe('installPlugin', () => {
  it('ok when `panel install` exits 0', async () => {
    const calls: string[][] = [];
    const r = await createSetup(deps({ runCli: async (a) => { calls.push(a); return { code: 0, stdout: 'installed' }; } })).installPlugin();
    expect(calls[0]).toEqual(['panel', 'install']);
    expect(r.status).toBe('ok');
  });
  it('error when it exits nonzero', async () => {
    expect((await createSetup(deps({ runCli: async () => ({ code: 1, stdout: 'fail' }) })).installPlugin()).status).toBe('error');
  });
});

describe('checkStudio', () => {
  it('ok when doctor exits 0', async () => {
    const r = await createSetup(deps({ runCli: async (a) => ({ code: a[0] === 'doctor' ? 0 : 1, stdout: '' }) })).checkStudio();
    expect(r.status).toBe('ok');
  });
  it('missing when doctor exits nonzero', async () => {
    expect((await createSetup(deps({ runCli: async () => ({ code: 1, stdout: 'not attached' }) })).checkStudio()).status).toBe('missing');
  });
});
