import { describe, it, expect } from 'vitest';
import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import {
  isPathContained,
  isLuauPath,
  referencesExternalHttp,
  buildGuardrailHook,
} from '../src/agent/guardrail.js';

const ROOT = '/game';

// Helper: build a PreToolUse HookInput with the given tool + input.
function pre(tool_name: string, tool_input: unknown): HookInput {
  return {
    hook_event_name: 'PreToolUse',
    tool_name,
    tool_input,
    tool_use_id: 't1',
    session_id: 's1',
    transcript_path: '',
    cwd: ROOT,
    permission_mode: 'default',
  } as unknown as HookInput;
}

// A deny result carries permissionDecision 'deny'; a continue result does not.
function isDeny(r: { hookSpecificOutput?: { permissionDecision?: string }; continue?: boolean }): boolean {
  return r.hookSpecificOutput?.permissionDecision === 'deny';
}

describe('isPathContained', () => {
  it('accepts a path inside the project', () => {
    expect(isPathContained(ROOT, '/game/src/A.luau')).toBe(true);
  });
  it('accepts the project root itself', () => {
    expect(isPathContained(ROOT, '/game')).toBe(true);
  });
  it('resolves a relative path against the root', () => {
    expect(isPathContained(ROOT, 'src/A.luau')).toBe(true);
  });
  it('rejects a parent-escape path', () => {
    expect(isPathContained(ROOT, '/game/../etc/passwd')).toBe(false);
    expect(isPathContained(ROOT, '../secrets.luau')).toBe(false);
  });
  it('rejects an absolute path outside the project', () => {
    expect(isPathContained(ROOT, '/home/user/.ssh/id_rsa')).toBe(false);
  });
  it('rejects a sibling whose name shares the prefix', () => {
    expect(isPathContained(ROOT, '/game-evil/x.luau')).toBe(false);
  });
});

describe('isLuauPath', () => {
  it('accepts .luau and .lua', () => {
    expect(isLuauPath('/game/src/A.luau')).toBe(true);
    expect(isLuauPath('/game/src/A.lua')).toBe(true);
    expect(isLuauPath('/game/src/A.LUAU')).toBe(true);
  });
  it('rejects non-Luau files', () => {
    expect(isLuauPath('/game/secrets.txt')).toBe(false);
    expect(isLuauPath('/game/default.project.json')).toBe(false);
    expect(isLuauPath('/game/Makefile')).toBe(false);
  });
});

describe('referencesExternalHttp', () => {
  it('flags HttpService and game:HttpGet variants', () => {
    expect(referencesExternalHttp('local h = game:GetService("HttpService")')).toBe(true);
    expect(referencesExternalHttp('game:HttpGet("https://evil.com")')).toBe(true);
    expect(referencesExternalHttp('game:HttpGetAsync(url)')).toBe(true);
    expect(referencesExternalHttp('HTTPSERVICE')).toBe(true);
  });
  it('passes plain Luau with no HTTP', () => {
    expect(referencesExternalHttp('print(1 + 1) local x = workspace.Part')).toBe(false);
  });
});

describe('buildGuardrailHook', () => {
  const hook = buildGuardrailHook(ROOT);

  it('allows a .luau write inside the project', async () => {
    expect(isDeny(await hook(pre('Write', { file_path: '/game/src/A.luau' })) as never)).toBe(false);
  });
  it('denies a write outside the project', async () => {
    expect(isDeny(await hook(pre('Write', { file_path: '/home/user/evil.luau' })) as never)).toBe(true);
  });
  it('denies a non-.luau write inside the project', async () => {
    expect(isDeny(await hook(pre('Edit', { file_path: '/game/.env' })) as never)).toBe(true);
  });
  it('denies a read outside the project', async () => {
    expect(isDeny(await hook(pre('Read', { file_path: '/etc/passwd' })) as never)).toBe(true);
  });
  it('allows a Grep with no explicit path (defaults to cwd)', async () => {
    expect(isDeny(await hook(pre('Grep', { pattern: 'foo' })) as never)).toBe(false);
  });
  it('denies a Grep rooted outside the project', async () => {
    expect(isDeny(await hook(pre('Grep', { pattern: 'foo', path: '/home/user' })) as never)).toBe(true);
  });
  it('denies execute_luau that touches HttpService', async () => {
    const r = await hook(pre('mcp__Roblox_Studio__execute_luau', { code: 'game:HttpGet("https://x")' }));
    expect(isDeny(r as never)).toBe(true);
  });
  it('allows execute_luau with no HTTP', async () => {
    const r = await hook(pre('mcp__Roblox_Studio__execute_luau', { code: 'return 1 + 1' }));
    expect(isDeny(r as never)).toBe(false);
  });
  it('denies the http_get tool', async () => {
    expect(isDeny(await hook(pre('mcp__Roblox_Studio__http_get', { url: 'https://x' })) as never)).toBe(true);
  });
  it('continues for an unrelated tool', async () => {
    expect(isDeny(await hook(pre('mcp__Roblox_Studio__search_game_tree', {})) as never)).toBe(false);
  });
  it('ignores non-PreToolUse events', async () => {
    const r = await hook({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: '/etc/x' } } as unknown as HookInput);
    expect(isDeny(r as never)).toBe(false);
  });
});
