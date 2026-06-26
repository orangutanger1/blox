import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSyncHook, buildAssetResultHook, buildAssetDedupeHook, buildAssetRecordHook, extractAssetTag, jobLandedNothing, rejectMessage, GEN_MESH_TOOL, WAIT_JOB_TOOL } from '../src/agent/hooks.js';
import type { ResultGateChannel } from '../src/agent/hooks.js';
import { lookupAsset, assetCacheKey, recordAsset } from '../src/agent/assetCache.js';
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

type BlockOut = { decision?: string; reason?: string; continue?: boolean };

const meshResponse = { content: [{ type: 'text', text: '{"tag":"Assistant-MeshGen-1f2e3d4c-0000-4000-8000-aabbccddeeff"}' }] };

function postInput(tool: string, response: unknown): HookInput {
  return {
    hook_event_name: 'PostToolUse',
    tool_name: tool,
    tool_input: { textPrompt: 'a low-poly barrel' },
    tool_response: response,
    tool_use_id: 't9',
    session_id: 's',
    transcript_path: '',
    cwd: '/game',
  } as unknown as HookInput;
}

describe('extractAssetTag', () => {
  it('finds the mesh tag inside an MCP text block', () => {
    expect(extractAssetTag(meshResponse)).toBe('Assistant-MeshGen-1f2e3d4c-0000-4000-8000-aabbccddeeff');
  });

  it('finds the procedural model name from a Completed wait_job_finished result (live-probed shape)', () => {
    const waitResponse = {
      content: [
        {
          type: 'text',
          text: '{"modelFullName":"Workspace.SmallGrayRock","resultName":"SmallGrayRock","status":"Completed","prompt":"a small gray rock","generationId":"49a17172-aa30-4234-8e3d-f09b99831fca"}',
        },
      ],
      isError: false,
    };
    expect(extractAssetTag(waitResponse)).toBe('SmallGrayRock');
  });

  it('returns null for a non-Completed job (nothing landed)', () => {
    const failed = { content: [{ type: 'text', text: '{"status":"Failed","generationId":"x"}' }] };
    expect(extractAssetTag(failed)).toBeNull();
    expect(jobLandedNothing(failed)).toBe(true);
    expect(jobLandedNothing({ content: [{ type: 'text', text: '{"status":"Completed","resultName":"R"}' }] })).toBe(false);
    expect(jobLandedNothing({ weird: 'shape' })).toBe(false); // unknown shape: not provably failed
  });

  it('falls back to the Assistant-* tag regex for unexpected shapes', () => {
    expect(extractAssetTag({ result: 'inserted Assistant-ModelGen-deadbeef-1111-4222-8333-444455556666 ok' })).toBe(
      'Assistant-ModelGen-deadbeef-1111-4222-8333-444455556666',
    );
  });

  it('returns null when nothing matches', () => {
    expect(extractAssetTag({ content: [{ type: 'text', text: 'no tag here' }] })).toBeNull();
    expect(extractAssetTag(undefined)).toBeNull();
  });
});

describe('buildAssetResultHook', () => {
  const channel = (decision: 'approve' | 'reject', feedback?: string, calls?: unknown[][]): ResultGateChannel => ({
    isConnected: () => true,
    requestResult: async (...args: unknown[]) => {
      calls?.push(args);
      return { decision, source: 'dock' as const, ...(feedback ? { feedback } : {}) };
    },
  });

  it('continues on approve', async () => {
    const calls: unknown[][] = [];
    const hook = buildAssetResultHook(channel('approve', undefined, calls));
    const out = (await hook(postInput(GEN_MESH_TOOL, meshResponse), 't9', { signal })) as BlockOut;
    expect(out.continue).toBe(true);
    expect(out.decision).toBeUndefined();
    expect(calls[0][0]).toBe(GEN_MESH_TOOL);
    expect(calls[0][1]).toBe('Assistant-MeshGen-1f2e3d4c-0000-4000-8000-aabbccddeeff');
  });

  it('blocks on reject with stash notice and feedback in the reason', async () => {
    const hook = buildAssetResultHook(channel('reject', 'too tall'));
    const out = (await hook(postInput(GEN_MESH_TOOL, meshResponse), 't9', { signal })) as BlockOut;
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('_bloxRejected');
    expect(out.reason).toContain('too tall');
    expect(out.reason).toBe(rejectMessage(GEN_MESH_TOOL, true, 'too tall'));
  });

  it('reject without a tag omits the stash notice (nothing was stashed)', async () => {
    const hook = buildAssetResultHook(channel('reject'));
    const out = (await hook(postInput(WAIT_JOB_TOOL, { weird: 'shape' }), 't9', { signal })) as BlockOut;
    expect(out.decision).toBe('block');
    expect(out.reason).not.toContain('_bloxRejected');
  });

  it('ignores other tools, missing channel, and disconnected dock', async () => {
    const calls: unknown[][] = [];
    const connected = channel('reject', undefined, calls);
    const hookOther = buildAssetResultHook(connected);
    const outOther = (await hookOther(postInput('mcp__Roblox_Studio__execute_luau', meshResponse), 't9', { signal })) as BlockOut;
    expect(outOther.continue).toBe(true);
    expect(calls.length).toBe(0);

    const hookNone = buildAssetResultHook(undefined);
    expect(((await hookNone(postInput(GEN_MESH_TOOL, meshResponse), 't9', { signal })) as BlockOut).continue).toBe(true);

    const hookDisc = buildAssetResultHook({ ...connected, isConnected: () => false });
    expect(((await hookDisc(postInput(GEN_MESH_TOOL, meshResponse), 't9', { signal })) as BlockOut).continue).toBe(true);
    expect(calls.length).toBe(0);
  });

  it('continues if the channel throws (a broken panel never stalls the run)', async () => {
    const hook = buildAssetResultHook({
      isConnected: () => true,
      requestResult: async () => {
        throw new Error('boom');
      },
    });
    const out = (await hook(postInput(GEN_MESH_TOOL, meshResponse), 't9', { signal })) as BlockOut;
    expect(out.continue).toBe(true);
  });

  it('skips the gate for a non-Completed job — nothing landed, nothing to review', async () => {
    const calls: unknown[][] = [];
    const hook = buildAssetResultHook(channel('reject', undefined, calls));
    const failed = { content: [{ type: 'text', text: '{"status":"Failed","generationId":"x"}' }] };
    const out = (await hook(postInput(WAIT_JOB_TOOL, failed), 't9', { signal })) as BlockOut;
    expect(out.continue).toBe(true);
    expect(calls.length).toBe(0);
  });

  it('continues when tool_input is unserializable (defense: a hook must never throw)', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const hook = buildAssetResultHook(channel('reject'));
    const input = postInput(GEN_MESH_TOOL, meshResponse) as unknown as { tool_input: unknown };
    input.tool_input = circular;
    const out = (await hook(input as never, 't9', { signal })) as BlockOut;
    expect(out.continue).toBe(true);
  });
});

function preMesh(projectPath: string, textPrompt: unknown): HookInput {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: GEN_MESH_TOOL,
    tool_input: { textPrompt },
    tool_use_id: 't',
    session_id: 's',
    transcript_path: '',
    cwd: projectPath,
  } as unknown as HookInput;
}

describe('buildAssetDedupeHook (PreToolUse, advisory)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'blox-dedupe-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('continues with no hint when the prompt was never generated before', async () => {
    const hook = buildAssetDedupeHook(dir);
    const out = (await hook(preMesh(dir, 'a fresh rock'), 't', { signal })) as SyncOut;
    expect(out.continue).toBe(true);
    expect(out.hookSpecificOutput?.additionalContext).toBeUndefined();
  });

  it('injects a reuse hint naming the prior tag on a cache hit', async () => {
    const key = assetCacheKey({ textPrompt: 'a barrel' })!;
    recordAsset(dir, key, { tag: 'Assistant-MeshGen-99', tool: 'generate_mesh', prompt: 'a barrel' });
    const hook = buildAssetDedupeHook(dir);
    const out = (await hook(preMesh(dir, 'A  Barrel '), 't', { signal })) as SyncOut;
    expect(out.continue).toBe(true); // advisory — never blocks
    expect(out.hookSpecificOutput?.additionalContext).toContain('Assistant-MeshGen-99');
  });

  it('ignores non-mesh tools and inputs with no prompt', async () => {
    const hook = buildAssetDedupeHook(dir);
    const other = { ...preMesh(dir, 'x'), tool_name: 'mcp__Roblox_Studio__execute_luau' } as HookInput;
    expect(((await hook(other, 't', { signal })) as SyncOut).hookSpecificOutput).toBeUndefined();
    expect(((await hook(preMesh(dir, 42), 't', { signal })) as SyncOut).hookSpecificOutput).toBeUndefined();
  });
});

describe('buildAssetRecordHook (PostToolUse, recorder)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'blox-record-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('records prompt→tag after a successful generate_mesh', async () => {
    const hook = buildAssetRecordHook(dir);
    const input = { ...postInput(GEN_MESH_TOOL, meshResponse), tool_input: { textPrompt: 'a low-poly barrel' } } as HookInput;
    const out = (await hook(input, 't9', { signal })) as { continue?: boolean };
    expect(out.continue).toBe(true);
    const key = assetCacheKey({ textPrompt: 'a low-poly barrel' })!;
    expect(lookupAsset(dir, key)?.tag).toBe('Assistant-MeshGen-1f2e3d4c-0000-4000-8000-aabbccddeeff');
  });

  it('records nothing when no tag could be extracted', async () => {
    const hook = buildAssetRecordHook(dir);
    const input = { ...postInput(GEN_MESH_TOOL, { content: [{ type: 'text', text: 'no tag here' }] }), tool_input: { textPrompt: 'x' } } as HookInput;
    await hook(input, 't9', { signal });
    expect(lookupAsset(dir, assetCacheKey({ textPrompt: 'x' })!)).toBeNull();
  });

  it('never throws on a circular tool_input', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const hook = buildAssetRecordHook(dir);
    const input = postInput(GEN_MESH_TOOL, meshResponse) as unknown as { tool_input: unknown };
    input.tool_input = circular;
    const out = (await hook(input as never, 't9', { signal })) as { continue?: boolean };
    expect(out.continue).toBe(true);
  });
});
