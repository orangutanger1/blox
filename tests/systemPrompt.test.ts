import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../src/agent/systemPrompt.js';
import type { ProjectDigest } from '../src/context/digest.js';

const digest: ProjectDigest = {
  name: 'blox-fixture',
  tree: ['ReplicatedStorage', 'ServerScriptService'],
  scripts: ['src/ReplicatedStorage/Greeter.luau'],
};

describe('buildSystemPrompt', () => {
  it('orients the agent to Roblox/Luau and embeds the digest', () => {
    const p = buildSystemPrompt(digest);
    expect(p).toContain('blox');
    expect(p).toContain('Luau');
    expect(p).toContain('Rojo');
    expect(p).toContain('blox-fixture');
    expect(p).toContain('ReplicatedStorage, ServerScriptService');
    expect(p).toContain('src/ReplicatedStorage/Greeter.luau');
    expect(p).toContain('Verify loop');
    expect(p).toContain('execute_luau');
    expect(p).toContain('multi_edit');
    expect(p).toContain('generate_mesh');
    expect(p).toContain('start_stop_play');
    expect(p).toContain('get_console_output');
    expect(p).toContain('CLIENT context');
    expect(p).toContain('stop play');
    expect(p).toContain('character_navigation');
    expect(p).toContain('user_keyboard_input');
    expect(p).toContain('user_mouse_input');
    expect(p).toContain('wait/poll');
  });
});
