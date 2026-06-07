import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';

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
