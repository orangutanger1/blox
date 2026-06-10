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
  mode: 'auto',
};
const digest: ProjectDigest = { name: 'g', tree: [], scripts: [], groups: [] };

describe('buildQueryOptions', () => {
  it('maps config to Agent SDK options', () => {
    const o = buildQueryOptions(config, createMockStudioBridge(), digest);
    expect(o.model).toBe('claude-opus-4-8');
    expect(o.cwd).toBe('/game');
    expect(o.maxTurns).toBe(40);
    expect(o.maxBudgetUsd).toBe(5);
    expect(o.permissionMode).toBe('bypassPermissions');
    expect(o.allowDangerouslySkipPermissions).toBe(true);
    expect(o.settingSources).toEqual([]);
    expect(o.thinking).toEqual({ type: 'adaptive' });
    expect(typeof o.systemPrompt).toBe('string');
  });

  it('whitelists file tools plus bridge tools and no Bash', () => {
    const o = buildQueryOptions(config, createMockStudioBridge(), digest);
    expect(o.allowedTools).toEqual(expect.arrayContaining(['Read', 'Write', 'Edit', 'Grep', 'Glob']));
    expect(o.allowedTools).toContain('mcp__Roblox_Studio__search_game_tree');
    expect(o.allowedTools).not.toContain('Bash');
    expect(o.mcpServers).toHaveProperty('Roblox_Studio');
  });

  it('registers a PreToolUse sync hook for execute_luau', () => {
    const o = buildQueryOptions(config, createMockStudioBridge(), digest);
    const pre = o.hooks.PreToolUse;
    expect(pre).toBeDefined();
    expect(pre?.[0].matcher).toBe('mcp__Roblox_Studio__execute_luau');
    expect(pre?.[0].hooks).toHaveLength(1);
  });
});
