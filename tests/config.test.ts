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
    expect(overridesFromArgs({ projectPath: null, maxTurns: null, maxBudgetUsd: null, effort: null, mode: null, model: null })).toEqual({});
    expect(
      overridesFromArgs({ projectPath: '/g', maxTurns: 10, maxBudgetUsd: 2.5, effort: 'high', mode: 'ask', model: null }),
    ).toEqual({ projectPath: '/g', maxTurns: 10, maxBudgetUsd: 2.5, effort: 'high', mode: 'ask' });
  });
  it('overridesFromArgs passes the run model through', () => {
    const o = overridesFromArgs({ projectPath: null, maxTurns: null, maxBudgetUsd: null, effort: null, mode: null, model: 'openrouter,x' });
    expect(o.model).toBe('openrouter,x');
  });
});

describe('panel config', () => {
  it('defaults port and gate timeout', () => {
    const c = loadConfig('/tmp/definitely-missing-blox-config');
    expect(c.panel).toEqual({ port: 35768, gateTimeoutSeconds: 120 });
  });

  it('fills missing panel fields when the config file sets only some', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-'));
    writeFileSync(join(dir, 'blox.config.json'), JSON.stringify({ panel: { port: 40000 } }));
    const c = loadConfig(dir);
    expect(c.panel).toEqual({ port: 40000, gateTimeoutSeconds: 120 });
  });
});

describe('policy schema', () => {
  it('parses a full policy block from blox.config.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-'));
    writeFileSync(join(dir, 'blox.config.json'), JSON.stringify({
      policy: {
        models: ['claude-opus-4-8'],
        maxBudgetUsd: 10,
        maxTurns: 60,
        mode: 'ask',
        rollingBudget: { windowDays: 30, maxUsd: 200 },
        commitConvention: 'blox({user}): {prompt}',
      },
    }));
    const cfg = loadConfig(dir);
    expect(cfg.policy?.models).toEqual(['claude-opus-4-8']);
    expect(cfg.policy?.rollingBudget?.maxUsd).toBe(200);
    expect(cfg.policy?.commitConvention).toBe('blox({user}): {prompt}');
  });

  it('leaves policy undefined when absent (back-compat)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-'));
    const cfg = loadConfig(dir);
    expect(cfg.policy).toBeUndefined();
  });

  it('rejects a non-positive rolling window', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-'));
    writeFileSync(join(dir, 'blox.config.json'), JSON.stringify({
      policy: { rollingBudget: { windowDays: 0, maxUsd: 200 } },
    }));
    expect(() => loadConfig(dir)).toThrow();
  });
});

describe('relay schema', () => {
  it('defaults the relay block when absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-'));
    writeFileSync(join(dir, 'blox.config.json'), '{}');
    const c = loadConfig(dir, { projectPath: dir });
    expect(c.relay).toBeUndefined();
  });

  it('fills relay defaults when the block is present but partial', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-'));
    writeFileSync(join(dir, 'blox.config.json'), JSON.stringify({ relay: { port: 9000 } }));
    const c = loadConfig(dir, { projectPath: dir });
    expect(c.relay).toMatchObject({
      port: 9000, host: '127.0.0.1', apiKeyEnv: 'ANTHROPIC_API_KEY',
      upstream: 'https://api.anthropic.com',
      membersPath: '.blox/relay-members.json', ledgerPath: '.blox/relay-audit.jsonl',
    });
    expect(c.relay!.pricing['claude-opus-4-8']).toEqual({ in: 5, out: 25 });
  });
});
