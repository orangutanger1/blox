import { describe, it, expect, afterEach } from 'vitest';
import { rmSync, readFileSync } from 'node:fs';
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

  it('upsert replaces a same-named provider but preserves others', () => {
    writeProvider('local', { models: ['qwen2.5-coder'] }, tmp);
    writeProvider('openrouter', { apiKey: 'k', models: ['openai/gpt-4o'] }, tmp);
    writeProvider('local', { models: ['llama3.1'] }, tmp); // replace local
    expect(allCcrModels(tmp).sort()).toEqual(['local,llama3.1', 'openrouter,openai/gpt-4o']);
  });

  it('rejects openrouter without a key and any provider without a model', () => {
    expect(() => writeProvider('openrouter', { models: ['x'] }, tmp)).toThrow(/key/);
    expect(() => writeProvider('local', { models: [] }, tmp)).toThrow(/model/);
  });
});
