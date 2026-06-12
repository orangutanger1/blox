import { describe, it, expect } from 'vitest';
import { buildQueryOptions } from '../src/agent/buildOptions.js';
import { createMockStudioBridge } from '../src/bridge/mockBridge.js';
import type { BloxConfig } from '../src/config.js';
import type { ProjectDigest } from '../src/context/digest.js';
import type { GateChannel } from '../src/agent/permission.js';

const config: BloxConfig = {
  projectPath: '/game',
  model: 'claude-opus-4-8',
  maxTurns: 40,
  maxBudgetUsd: 5,
  mode: 'auto',
  panel: { port: 35768, gateTimeoutSeconds: 120 },
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

const askConfig: BloxConfig = { ...config, mode: 'ask', effort: 'xhigh' };

describe('buildQueryOptions — ask mode', () => {
  it('uses default permission mode + a canUseTool callback', () => {
    const o = buildQueryOptions(askConfig, createMockStudioBridge(), digest);
    expect(o.permissionMode).toBe('default');
    expect(o.allowDangerouslySkipPermissions).toBeUndefined();
    expect(typeof o.canUseTool).toBe('function');
  });

  it('drops gated tools from the allow-list but keeps the inner loop', () => {
    const o = buildQueryOptions(askConfig, createMockStudioBridge(), digest);
    expect(o.allowedTools).not.toContain('mcp__Roblox_Studio__generate_mesh');
    expect(o.allowedTools).not.toContain('mcp__Roblox_Studio__start_stop_play');
    expect(o.allowedTools).toContain('mcp__Roblox_Studio__execute_luau');
    expect(o.allowedTools).toEqual(expect.arrayContaining(['Read', 'Write', 'Edit']));
  });

  it('passes effort when set and omits it when unset', () => {
    expect(buildQueryOptions(askConfig, createMockStudioBridge(), digest).effort).toBe('xhigh');
    expect(buildQueryOptions(config, createMockStudioBridge(), digest).effort).toBeUndefined();
  });
});

describe('buildQueryOptions — gate channel', () => {
  it('threads the gate channel into canUseTool in ask mode', async () => {
    let asked = false;
    const gate: GateChannel = {
      isConnected: () => true,
      request: async () => {
        asked = true;
        return { decision: 'allow', source: 'dock' };
      },
    };
    const o = buildQueryOptions(askConfig, createMockStudioBridge(), digest, gate);
    const r = await o.canUseTool!('mcp__Roblox_Studio__generate_mesh', {}, {} as never);
    expect(r.behavior).toBe('allow');
    expect(asked).toBe(true);
  });

  it('ignores the gate channel in auto mode', () => {
    const gate: GateChannel = {
      isConnected: () => true,
      request: async () => ({ decision: 'deny', source: 'dock' }),
    };
    const o = buildQueryOptions(config, createMockStudioBridge(), digest, gate);
    expect(o.canUseTool).toBeUndefined();
    expect(o.allowDangerouslySkipPermissions).toBe(true);
  });
});
