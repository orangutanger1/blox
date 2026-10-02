import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addUsage, mcpToChatTools, runFileTool } from '../src/bench/openaiAgent.js';
import { agentSpec } from '../src/bench/cli.js';

describe('openai-compat bench agent', () => {
  it('splits prompt tokens into fresh / cached / written', () => {
    const t = addUsage({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, {
      prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 800, cache_write_tokens: 150 },
    });
    expect(t).toEqual({ input: 50, cacheRead: 800, cacheWrite: 150, output: 50 });
  });
  it('maps MCP tools to function tools', () => {
    const [t] = mcpToChatTools([{ name: 'status', inputSchema: { type: 'object', properties: {} } }]);
    expect(t.function.name).toBe('status');
    expect(t.function.parameters).toEqual({ type: 'object', properties: {} });
  });
  it('file tools stay inside the project and edit exactly one match', () => {
    const root = mkdtempSync(join(tmpdir(), 'oa-'));
    runFileTool(root, 'write_file', { path: 'src/a.luau', content: 'x = 1\ny = 1\n' });
    expect(runFileTool(root, 'list_files', {})).toBe(join('src', 'a.luau'));
    expect(() => runFileTool(root, 'edit_file', { path: 'src/a.luau', old_text: '= 1', new_text: '= 2' })).toThrow(/2 times/);
    runFileTool(root, 'edit_file', { path: 'src/a.luau', old_text: 'y = 1', new_text: 'y = 2' });
    expect(readFileSync(join(root, 'src/a.luau'), 'utf8')).toBe('x = 1\ny = 2\n');
    expect(() => runFileTool(root, 'read_file', { path: '../etc/passwd' })).toThrow(/escapes/);
  });
  it('bench profile requires a model and passes it through', () => {
    expect(() => agentSpec('openai', {})).toThrow(/--model/);
    const s = agentSpec('openai', { model: 'z-ai/glm-5.3-flash' });
    expect(s.model).toBe('z-ai/glm-5.3-flash');
    expect(s.argv).toContain('z-ai/glm-5.3-flash');
  });
});
