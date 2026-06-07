import { describe, it, expect } from 'vitest';
import { buildSyncHook } from '../src/agent/hooks.js';
import type { SpawnFn } from '../src/sync/rojo.js';
import type { HookInput } from '@anthropic-ai/claude-agent-sdk';

type SyncOut = { continue?: boolean; hookSpecificOutput?: { additionalContext?: string } };

const preExecuteLuau = {
  hook_event_name: 'PreToolUse',
  tool_name: 'mcp__Roblox_Studio__execute_luau',
  tool_input: {},
  tool_use_id: 't1',
  session_id: 's',
  transcript_path: '',
  cwd: '/game',
} as unknown as HookInput;

const preOtherTool = {
  ...preExecuteLuau,
  tool_name: 'mcp__Roblox_Studio__search_game_tree',
} as unknown as HookInput;

const signal = new AbortController().signal;

describe('buildSyncHook', () => {
  it('runs rojo sourcemap before execute_luau and continues', async () => {
    const calls: string[] = [];
    const spy: SpawnFn = async (cmd, args, opts) => {
      calls.push(`${cmd} ${args.join(' ')} @${opts.cwd}`);
      return { code: 0, stdout: '{}', stderr: '' };
    };
    const hook = buildSyncHook('/game', spy);
    const out = (await hook(preExecuteLuau, 't1', { signal })) as SyncOut;
    expect(calls).toEqual(['rojo sourcemap @/game']);
    expect(out.continue).toBe(true);
  });

  it('does not sync for other tools', async () => {
    const calls: string[] = [];
    const spy: SpawnFn = async () => {
      calls.push('x');
      return { code: 0, stdout: '', stderr: '' };
    };
    const hook = buildSyncHook('/game', spy);
    const out = (await hook(preOtherTool, 't1', { signal })) as SyncOut;
    expect(calls).toEqual([]);
    expect(out.continue).toBe(true);
  });

  it('surfaces a sync failure via additionalContext but still continues', async () => {
    const failSpawn: SpawnFn = async () => ({ code: 1, stdout: '', stderr: 'bad project' });
    const hook = buildSyncHook('/game', failSpawn);
    const out = (await hook(preExecuteLuau, 't1', { signal })) as SyncOut;
    expect(out.continue).toBe(true);
    expect(out.hookSpecificOutput?.additionalContext).toContain('bad project');
  });
});
