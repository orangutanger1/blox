import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendRelayEntry, readRelayEntries, type RelayEntry } from '../src/relay/ledger.js';

const entry = (over: Partial<RelayEntry> = {}): RelayEntry => ({
  ts: new Date().toISOString(), user: 'a@x.com', model: 'claude-opus-4-8',
  turns: 1, costUsd: 0.5, status: 'success', commit: null, prompt: '',
  inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, ...over,
});

describe('relay ledger', () => {
  it('appends and reads back relay entries at a custom path', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'blox-')), 'relay-audit.jsonl');
    appendRelayEntry(f, entry({ costUsd: 1 }));
    appendRelayEntry(f, entry({ costUsd: 2 }));
    expect(readRelayEntries(f).map((e) => e.costUsd)).toEqual([1, 2]);
  });
});
