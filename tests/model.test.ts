import { describe, it, expect, afterEach } from 'vitest';
import { rmSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeProvider } from '../src/model.js';
import { allCcrModels } from '../src/ccr.js';

const tmp = join(tmpdir(), `model-test-${process.pid}.json`);
afterEach(() => { try { rmSync(tmp); } catch { /* ignore */ } });

describe('writeProvider', () => {
  it('writes an OpenRouter block with transformer + Router.default', () => {
    writeProvider('openrouter', { apiKey: 'sk-or-x', models: ['deepseek/deepseek-chat'] }, tmp);
    const cfg = JSON.parse(readFileSync(tmp, 'utf8'));
    expect(cfg.Providers[0]).toMatchObject({
      name: 'openrouter',
      api_base_url: 'https://openrouter.ai/api/v1/chat/completions',
      api_key: 'sk-or-x',
      models: ['deepseek/deepseek-chat'],
      transformer: { use: ['openrouter'] },
    });
    expect(cfg.Router.default).toBe('openrouter,deepseek/deepseek-chat');
  });

  it('local block has no transformer and defaults to the Ollama base URL', () => {
    writeProvider('local', { models: ['qwen2.5-coder'] }, tmp);
    const cfg = JSON.parse(readFileSync(tmp, 'utf8'));
    expect(cfg.Providers[0].transformer).toBeUndefined();
    expect(cfg.Providers[0].api_base_url).toBe('http://localhost:11434/v1/chat/completions');
  });

  it('accumulates models for a same-named provider and preserves others', () => {
    writeProvider('local', { models: ['qwen2.5-coder'] }, tmp);
    writeProvider('openrouter', { apiKey: 'k', models: ['openai/gpt-4o'] }, tmp);
    writeProvider('local', { models: ['llama3.1'] }, tmp); // adds to local, not replace
    expect(allCcrModels(tmp).sort()).toEqual(['local,llama3.1', 'local,qwen2.5-coder', 'openrouter,openai/gpt-4o']);
  });

  it('appends new models to a provider and dedupes', () => {
    writeProvider('openrouter', { apiKey: 'k', models: ['a/b'] }, tmp);
    writeProvider('openrouter', { apiKey: 'k', models: ['c/d'] }, tmp);
    writeProvider('openrouter', { apiKey: 'k', models: ['a/b'] }, tmp); // dup ignored
    expect(allCcrModels(tmp).sort()).toEqual(['openrouter,a/b', 'openrouter,c/d']);
  });

  it('reuses the stored openrouter key when a later add omits it', () => {
    writeProvider('openrouter', { apiKey: 'sk-or-x', models: ['a/b'] }, tmp);
    writeProvider('openrouter', { models: ['c/d'] }, tmp); // no key this time
    const cfg = JSON.parse(readFileSync(tmp, 'utf8'));
    expect(cfg.Providers[0].api_key).toBe('sk-or-x');
    expect(allCcrModels(tmp).sort()).toEqual(['openrouter,a/b', 'openrouter,c/d']);
  });

  it('rejects openrouter without a key and any provider without a model', () => {
    expect(() => writeProvider('openrouter', { models: ['x'] }, tmp)).toThrow(/key/);
    expect(() => writeProvider('local', { models: [] }, tmp)).toThrow(/model/);
  });

  it('writes the config user-only (0600) since it holds the api key', () => {
    writeProvider('openrouter', { apiKey: 'sk-or-x', models: ['a/b'] }, tmp);
    if (process.platform !== 'win32') {
      expect(statSync(tmp).mode & 0o777).toBe(0o600);
    }
  });
});
