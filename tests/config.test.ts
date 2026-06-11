import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, overridesFromArgs } from '../src/config.js';

describe('loadConfig', () => {
  it('applies defaults when no config file exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-'));
    const cfg = loadConfig(dir);
    expect(cfg.projectPath).toBe(dir);
    expect(cfg.model).toBe('claude-opus-4-8');
    expect(cfg.maxTurns).toBe(40);
    expect(cfg.maxBudgetUsd).toBe(5);
  });

  it('reads blox.config.json and lets overrides win', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-'));
    writeFileSync(join(dir, 'blox.config.json'), JSON.stringify({ maxTurns: 10 }));
    const cfg = loadConfig(dir, { model: 'claude-opus-4-8', maxTurns: undefined });
    expect(cfg.maxTurns).toBe(10);
  });
});

describe('mode + effort schema', () => {
  it('defaults mode to auto and leaves effort unset', () => {
    const c = loadConfig('/game', {});
    expect(c.mode).toBe('auto');
    expect(c.effort).toBeUndefined();
  });

  it('accepts ask mode and an effort level', () => {
    const c = loadConfig('/game', { mode: 'ask', effort: 'xhigh' });
    expect(c.mode).toBe('ask');
    expect(c.effort).toBe('xhigh');
  });

  it('rejects an invalid mode', () => {
    expect(() => loadConfig('/game', { mode: 'yolo' as never })).toThrow();
  });
});

describe('overridesFromArgs', () => {
  it('includes only the flags that were set', () => {
    expect(overridesFromArgs({ projectPath: null, maxTurns: null, maxBudgetUsd: null, effort: null, mode: null })).toEqual({});
    expect(
      overridesFromArgs({ projectPath: '/g', maxTurns: 10, maxBudgetUsd: 2.5, effort: 'high', mode: 'ask' }),
    ).toEqual({ projectPath: '/g', maxTurns: 10, maxBudgetUsd: 2.5, effort: 'high', mode: 'ask' });
  });
});

describe('panel config', () => {
  it('defaults port and gate timeout', () => {
    const c = loadConfig('/tmp/definitely-missing-blox-config');
    expect(c.panel).toEqual({ port: 35768, gateTimeoutSeconds: 120 });
  });
});
