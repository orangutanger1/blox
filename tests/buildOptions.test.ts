import { describe, it, expect } from 'vitest';
import { buildQueryOptions } from '../src/agent/buildOptions.js';
import { createMockStudioBridge } from '../src/bridge/mockBridge.js';
import type { BloxConfig } from '../src/config.js';
import type { ProjectDigest } from '../src/context/digest.js';

const config: BloxConfig = {
  projectPath: '/game',
  model: 'claude-opus-4-8',
  maxTurns: 40,
  maxBudgetUsd: 5,
};
const digest: ProjectDigest = { name: 'g', tree: [], scripts: [] };

describe('buildQueryOptions', () => {
  it('maps config to Agent SDK options', () => {
    const o = buildQueryOptions(config, createMockStudioBridge(), digest);
    expect(o.model).toBe('claude-opus-4-8');
    expect(o.cwd).toBe('/game');
    expect(o.maxTurns).toBe(40);
    expect(o.maxBudgetUsd).toBe(5);
    expect(o.permissionMode).toBe('bypassPermissions');
    expect(o.settingSources).toEqual([]);
    expect(o.thinking).toEqual({ type: 'adaptive' });
    expect(typeof o.systemPrompt).toBe('string');
  });

  it('whitelists file tools plus bridge tools and no Bash', () => {
    const o = buildQueryOptions(config, createMockStudioBridge(), digest);
    expect(o.allowedTools).toEqual(expect.arrayContaining(['Read', 'Write', 'Edit', 'Grep', 'Glob']));
    expect(o.allowedTools).toContain('mcp__roblox_studio__search_game_tree');
    expect(o.allowedTools).not.toContain('Bash');
    expect(o.mcpServers).toHaveProperty('roblox_studio');
  });
});
