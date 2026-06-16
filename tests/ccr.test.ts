import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readCcrModels, resolveModel, ccrEndpoint } from '../src/ccr.js';

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

describe('ccrEndpoint', () => {
  it('defaults to 127.0.0.1:3456 with a placeholder key when none configured', () => {
    writeFileSync(tmp, JSON.stringify({ LOG: true, Providers: [], Router: {} }));
    const e = ccrEndpoint(tmp);
    expect(e.baseUrl).toBe('http://127.0.0.1:3456');
    expect(e.apiKey).toBeTruthy();
  });

  it('honors HOST/PORT/APIKEY from the config', () => {
    writeFileSync(tmp, JSON.stringify({ HOST: '127.0.0.1', PORT: 8080, APIKEY: 'sk-secret' }));
    expect(ccrEndpoint(tmp)).toEqual({ baseUrl: 'http://127.0.0.1:8080', apiKey: 'sk-secret' });
  });

  it('rewrites a 0.0.0.0 bind host to 127.0.0.1 for the client URL', () => {
    writeFileSync(tmp, JSON.stringify({ HOST: '0.0.0.0', PORT: 3456 }));
    expect(ccrEndpoint(tmp).baseUrl).toBe('http://127.0.0.1:3456');
  });

  it('defaults when the file is missing', () => {
    const e = ccrEndpoint(join(tmpdir(), 'no-such-ccr.json'));
    expect(e.baseUrl).toBe('http://127.0.0.1:3456');
    expect(e.apiKey).toBeTruthy();
  });
});
