import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enforcePolicy, PolicyError } from '../src/policy.js';
import { appendAuditEntry } from '../src/audit.js';
import type { BloxConfig } from '../src/config.js';

function cfg(over: Partial<BloxConfig> = {}): BloxConfig {
  return {
    projectPath: '/game',
    model: 'claude-opus-4-8',
    maxTurns: 40,
    maxBudgetUsd: 5,
    mode: 'auto',
    panel: { port: 35768, gateTimeoutSeconds: 120 },
    ...over,
  } as BloxConfig;
}

describe('enforcePolicy', () => {
  it('is a no-op when policy is absent', () => {
    expect(() => enforcePolicy(cfg())).not.toThrow();
  });

  it('rejects a model not in the allowlist', () => {
    expect(() => enforcePolicy(cfg({ model: 'deepseek', policy: { models: ['claude-opus-4-8'] } })))
      .toThrow(PolicyError);
  });

  it('rejects maxBudgetUsd over the ceiling', () => {
    expect(() => enforcePolicy(cfg({ maxBudgetUsd: 20, policy: { maxBudgetUsd: 10 } })))
      .toThrow(/maxBudgetUsd/);
  });

  it('rejects maxTurns over the ceiling', () => {
    expect(() => enforcePolicy(cfg({ maxTurns: 100, policy: { maxTurns: 60 } })))
      .toThrow(/maxTurns/);
  });

  it('rejects downgrading mode ask -> auto', () => {
    expect(() => enforcePolicy(cfg({ mode: 'auto', policy: { mode: 'ask' } })))
      .toThrow(/mode/);
  });

  it('allows values at or under the ceiling', () => {
    expect(() => enforcePolicy(cfg({ maxBudgetUsd: 10, maxTurns: 60, policy: { maxBudgetUsd: 10, maxTurns: 60 } })))
      .not.toThrow();
  });

  it('blocks when rolling window spend already meets the cap', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-'));
    const now = new Date('2026-06-23T12:00:00Z');
    appendAuditEntry(dir, {
      ts: '2026-06-23T00:00:00Z', user: 'a@b.c', model: 'claude-opus-4-8',
      turns: 1, costUsd: 200, status: 'success', commit: 'x', prompt: 'p',
    });
    expect(() => enforcePolicy(
      cfg({ projectPath: dir, policy: { rollingBudget: { windowDays: 30, maxUsd: 200 } } }),
      now,
    )).toThrow(/rolling/i);
  });

  it('passes when rolling window spend is under the cap', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-'));
    expect(() => enforcePolicy(
      cfg({ projectPath: dir, policy: { rollingBudget: { windowDays: 30, maxUsd: 200 } } }),
    )).not.toThrow();
  });
});
