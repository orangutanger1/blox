import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enforceRelay } from '../src/relay/enforce.js';
import { appendRelayEntry, type RelayEntry } from '../src/relay/ledger.js';

const ledger = () => join(mkdtempSync(join(tmpdir(), 'blox-')), 'relay-audit.jsonl');
const entry = (over: Partial<RelayEntry>): RelayEntry => ({
  ts: new Date().toISOString(), user: 'a@x.com', model: 'claude-opus-4-8', turns: 1,
  costUsd: 0, status: 'success', commit: null, prompt: '',
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...over,
});
const now = new Date('2026-06-24T12:00:00Z');

describe('enforceRelay', () => {
  it('allows when there is no policy', () => {
    expect(enforceRelay({ model: 'anything', ledgerPath: ledger(), now })).toBeNull();
  });
  it('rejects a model outside the allowlist', () => {
    const r = enforceRelay({ model: 'gpt-4', policy: { models: ['claude-opus-4-8'] }, ledgerPath: ledger(), now });
    expect(r?.status).toBe(403);
    expect(r?.error).toMatch(/allowlist/);
  });
  it('allows a model inside the allowlist', () => {
    expect(enforceRelay({ model: 'claude-opus-4-8', policy: { models: ['claude-opus-4-8'] }, ledgerPath: ledger(), now })).toBeNull();
  });
  it('rejects when the rolling window spend meets/exceeds the cap', () => {
    const f = ledger();
    appendRelayEntry(f, entry({ ts: '2026-06-23T12:00:00Z', costUsd: 200 }));
    const r = enforceRelay({ model: 'claude-opus-4-8', policy: { rollingBudget: { windowDays: 30, maxUsd: 200 } }, ledgerPath: f, now });
    expect(r?.status).toBe(403);
    expect(r?.error).toMatch(/budget/);
  });
  it('ignores spend outside the window', () => {
    const f = ledger();
    appendRelayEntry(f, entry({ ts: '2026-01-01T12:00:00Z', costUsd: 999 }));
    expect(enforceRelay({ model: 'claude-opus-4-8', policy: { rollingBudget: { windowDays: 30, maxUsd: 200 } }, ledgerPath: f, now })).toBeNull();
  });
});
