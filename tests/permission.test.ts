import { describe, it, expect } from 'vitest';
import {
  GATED_TOOLS,
  isGated,
  nonGatedAllowedTools,
  denyMessage,
  buildCanUseTool,
} from '../src/agent/permission.js';
import { createMockStudioBridge } from '../src/bridge/mockBridge.js';

describe('isGated', () => {
  it('matches gated tools by bare and MCP-qualified name', () => {
    expect(isGated('generate_mesh')).toBe(true);
    expect(isGated('mcp__Roblox_Studio__generate_mesh')).toBe(true);
    expect(isGated('mcp__Roblox_Studio__insert_from_creator_store')).toBe(true);
    expect(isGated('mcp__Roblox_Studio__start_stop_play')).toBe(true);
    expect(isGated('mcp__Roblox_Studio__user_mouse_input')).toBe(true);
  });

  it('does not gate the inner loop or read-only tools', () => {
    expect(isGated('mcp__Roblox_Studio__execute_luau')).toBe(false);
    expect(isGated('mcp__Roblox_Studio__search_creator_store')).toBe(false);
    expect(isGated('mcp__Roblox_Studio__wait_job_finished')).toBe(false);
    expect(isGated('mcp__Roblox_Studio__get_console_output')).toBe(false);
    expect(isGated('Read')).toBe(false);
    expect(isGated('Write')).toBe(false);
    expect(isGated('Edit')).toBe(false);
  });
});

describe('nonGatedAllowedTools', () => {
  it('strips gated tools but keeps file + non-gated bridge tools', () => {
    const all = ['Read', 'Write', 'mcp__Roblox_Studio__execute_luau', 'mcp__Roblox_Studio__generate_mesh'];
    expect(nonGatedAllowedTools(all)).toEqual(['Read', 'Write', 'mcp__Roblox_Studio__execute_luau']);
  });
});

describe('buildCanUseTool', () => {
  it('denies gated tools with a feedback message', async () => {
    const cb = buildCanUseTool();
    const r = await cb('mcp__Roblox_Studio__generate_mesh', {}, {} as never);
    expect(r.behavior).toBe('deny');
    if (r.behavior === 'deny') expect(r.message).toBe(denyMessage('mcp__Roblox_Studio__generate_mesh'));
  });

  it('allows non-gated tools', async () => {
    const cb = buildCanUseTool();
    const r = await cb('mcp__Roblox_Studio__execute_luau', {}, {} as never);
    expect(r.behavior).toBe('allow');
  });
});

describe('drift guard', () => {
  it('every gated name is advertised by the bridge', () => {
    const advertised = createMockStudioBridge().allowedTools();
    for (const g of GATED_TOOLS) {
      expect(advertised).toContain(`mcp__Roblox_Studio__${g}`);
    }
  });
});
