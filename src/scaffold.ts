import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { AGENT_GUIDE } from './agentGuide.js';

// Non-destructive project scaffold: creates only what is missing, so it is
// safe to run on an existing Rojo project to add tests/, world/ and AGENTS.md.

export const PROJECT_TREE = {
  $className: 'DataModel',
  ReplicatedStorage: { $path: 'src/ReplicatedStorage' },
  ReplicatedFirst: { $path: 'src/ReplicatedFirst' },
  ServerScriptService: { $path: 'src/ServerScriptService' },
  ServerStorage: { $path: 'src/ServerStorage' },
  StarterGui: { $path: 'src/StarterGui' },
  StarterPlayer: {
    StarterPlayerScripts: { $path: 'src/StarterPlayerScripts' },
    StarterCharacterScripts: { $path: 'src/StarterCharacterScripts' },
  },
};

const SMOKE_SPEC = `-- @context server
-- Smoke test: the game boots and a player can join. Keep it; add your own specs.
test("a player joins and gets a character", function()
	local Players = game:GetService("Players")
	local player = waitFor(function() return Players:GetPlayers()[1] end, 10, "no player joined")
	local character = waitFor(function() return player.Character end, 10, "no character spawned")
	expect(character:FindFirstChildOfClass("Humanoid")).toExist()
end)
`;

export interface ScaffoldResult {
  dir: string;
  created: string[];
  existing: string[];
}

export interface ScaffoldOptions {
  // AGENTS.md + example spec. Off for neutral benchmark seeds, so an agent
  // under test only gets the guidance its own integration provides.
  agentFiles?: boolean;
}

export function scaffoldProject(dir: string, name?: string, opts: ScaffoldOptions = {}): ScaffoldResult {
  const agentFiles = opts.agentFiles !== false;
  const root = resolve(dir);
  mkdirSync(root, { recursive: true });
  const created: string[] = [];
  const existing: string[] = [];
  const write = (rel: string, content: string) => {
    const f = join(root, rel);
    if (existsSync(f)) {
      existing.push(rel);
      return;
    }
    mkdirSync(join(f, '..'), { recursive: true });
    writeFileSync(f, content);
    created.push(rel);
  };
  write('default.project.json', JSON.stringify({ name: name ?? basename(root), tree: PROJECT_TREE }, null, 2) + '\n');
  for (const d of ['ReplicatedStorage', 'ReplicatedFirst', 'ServerScriptService', 'ServerStorage', 'StarterGui', 'StarterPlayerScripts', 'StarterCharacterScripts']) {
    write(`src/${d}/.gitkeep`, '');
  }
  write('world/.gitkeep', '');
  if (agentFiles) {
    write('tests/smoke.spec.luau', SMOKE_SPEC);
    write('AGENTS.md', AGENT_GUIDE);
  }
  write('.gitignore', '.blox/artifacts/\n.blox/*.tmp\nsourcemap.json\n*.rbxl.lock\n');
  return { dir: root, created, existing };
}
