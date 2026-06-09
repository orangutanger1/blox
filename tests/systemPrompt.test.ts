import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../src/agent/systemPrompt.js';
import type { ProjectDigest } from '../src/context/digest.js';

const digest: ProjectDigest = {
  name: 'blox-fixture',
  tree: ['ReplicatedStorage', 'ServerScriptService', 'StarterPlayer'],
  scripts: [
    'src/ReplicatedStorage/Greeter.luau',
    'src/ServerScriptService/Hello.server.luau',
    'src/StarterPlayer/StarterPlayerScripts/Controls.client.luau',
  ],
  groups: [
    {
      service: 'ReplicatedStorage',
      total: 1,
      scripts: [{ path: 'src/ReplicatedStorage/Greeter.luau', kind: 'ModuleScript' }],
    },
    {
      service: 'ServerScriptService',
      total: 1,
      scripts: [{ path: 'src/ServerScriptService/Hello.server.luau', kind: 'Script (server)' }],
    },
    {
      service: 'StarterPlayer',
      total: 1,
      scripts: [
        { path: 'src/StarterPlayer/StarterPlayerScripts/Controls.client.luau', kind: 'LocalScript (client)' },
      ],
    },
  ],
};

describe('buildSystemPrompt', () => {
  it('orients the agent to Roblox/Luau and embeds the digest', () => {
    const p = buildSystemPrompt(digest);
    expect(p).toContain('blox');
    expect(p).toContain('Luau');
    expect(p).toContain('Rojo');
    expect(p).toContain('blox-fixture');
    expect(p).toContain('ReplicatedStorage, ServerScriptService');
    expect(p).toContain('Game map');
    expect(p).toContain('Greeter.luau — ModuleScript');
    expect(p).toContain('Hello.server.luau — Script (server)');
    expect(p).toContain('Controls.client.luau — LocalScript (client)');
    // flaw-A guidance
    expect(p).toContain('search_game_tree');
    expect(p).toContain('instance_type');
    expect(p).toContain('filter');
    expect(p).toContain('Verify loop');
    expect(p).toContain('execute_luau');
    expect(p).toContain('multi_edit');
    expect(p).toContain('generate_mesh');
    expect(p).toContain('Assets (generate & verify)');
    expect(p).toContain('search_creator_store');
    expect(p).toContain('insert_from_creator_store');
    expect(p).toContain('wait_job_finished');
    expect(p).toContain('Generation ID');
    expect(p).toContain('start_stop_play');
    expect(p).toContain('get_console_output');
    expect(p).toContain('CLIENT context');
    expect(p).toContain('stop play');
    expect(p).toContain('character_navigation');
    expect(p).toContain('user_keyboard_input');
    expect(p).toContain('user_mouse_input');
    expect(p).toContain('wait/poll');
    expect(p).toContain('screen_capture');
    expect(p).toContain('Visual verification');
    expect(p).toContain('only visible on screen');
  });

  it('renders the truncation line when a group exceeds its listed scripts', () => {
    const d: ProjectDigest = {
      name: 'x',
      tree: ['ReplicatedStorage'],
      scripts: ['src/ReplicatedStorage/A.luau', 'src/ReplicatedStorage/B.luau'],
      groups: [
        {
          service: 'ReplicatedStorage',
          total: 5,
          scripts: [
            { path: 'src/ReplicatedStorage/A.luau', kind: 'ModuleScript' },
            { path: 'src/ReplicatedStorage/B.luau', kind: 'ModuleScript' },
          ],
        },
      ],
    };
    const p = buildSystemPrompt(d);
    expect(p).toContain('… +3 more (use script_search / glob to list)');
    // a truncated group uses the generic noun
    expect(p).toContain('ReplicatedStorage/  (5 scripts)');
  });

  it('renders (none) for an empty project', () => {
    const d: ProjectDigest = { name: 'x', tree: [], scripts: [], groups: [] };
    expect(buildSystemPrompt(d)).toContain('Game map (0 scripts): (none)');
  });
});
