import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readCcrModels, resolveModel } from '../src/ccr.js';

const tmp = join(tmpdir(), `ccr-test-${process.pid}.json`);
afterEach(() => { try { rmSync(tmp); } catch { /* ignore */ } });

describe('readCcrModels', () => {
  it('reads provider, models, and current slug from Router.default', () => {
    writeFileSync(tmp, JSON.stringify({
      Providers: [{ name: 'openrouter', models: ['anthropic/claude-sonnet-4.5', 'google/gemini-2.5-pro'] }],
      Router: { default: 'openrouter,google/gemini-2.5-pro' },
    }));
    expect(readCcrModels(tmp)).toEqual({
      provider: 'openrouter',
      models: ['anthropic/claude-sonnet-4.5', 'google/gemini-2.5-pro'],
      current: 'google/gemini-2.5-pro',
    });
  });

  it('returns empties when the file is missing', () => {
    expect(readCcrModels(join(tmpdir(), 'does-not-exist-xyz.json')))
      .toEqual({ provider: null, models: [], current: null });
  });

  it('returns empties when the file is malformed', () => {
    writeFileSync(tmp, 'not json {');
    expect(readCcrModels(tmp)).toEqual({ provider: null, models: [], current: null });
  });
});

describe('resolveModel', () => {
  it('prefixes the provider', () => {
    expect(resolveModel('openrouter', 'google/gemini-2.5-pro')).toBe('openrouter,google/gemini-2.5-pro');
  });
  it('passes the slug through when there is no provider', () => {
    expect(resolveModel(null, 'claude-opus-4-8')).toBe('claude-opus-4-8');
  });
});
