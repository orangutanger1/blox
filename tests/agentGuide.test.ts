import { describe, it, expect } from 'vitest';
import { AGENT_GUIDE } from '../src/agentGuide.js';
import { TOOLS } from '../src/tools/registry.js';

// The guide is paid for in context on every session: keep it small, but never
// lose a rule. Every phrase below is a rule or pointer the guide must keep.
const MUST_KEEP = [
  '# Building Roblox games with blox',
  // layout
  '.server.luau', '.client.luau', 'src/StarterGui', 'src/ServerStorage', 'world/<Name>.luau', '-- @parent', 'default.project.json',
  '-- @context edit|server|client', 'toBeCloseTo', 'toThrow', 'waitFor',
  // loop + proof
  'task {action:"set"}', 'acceptance criteria', 'stylua', 'luau-lsp', 'file:line', '{kind:"click"', 'server_code',
  // starting points
  'kit {action:"apply"', 'FRAMEWORK.md', 'scout {action:"search"', 'skill {name}',
  // multiplayer
  '.mp.luau', '-- @clients N', 'mp.client(',
  // assets / models / animation
  'asset {action:"sanitize"', 'asset {action:"lint"}', 'model {action:"brief"}', 'Color to white', 'animate recipes', 'animate wire', 'animate npc',
  // release, ui, store, design, metrics
  'release {action:"check"}', 'never confirm unless asked', 'liveops report', 'ui {action:"lint"}', '44px', 'present {action:"render"}', '16:9',
  'design {action:"simulate"}', 'Tunables', 'design:<assertionId>', 'metrics {action:"soak"', 'ftue:<id>',
  // human gates and proof (safety wording: keep exact)
  'human approves', 'Approvals and uploads are human steps', 'human decisions', 'prepare and dry-run', 'apply (local)',
  'final title/art and upload are human', 'not a successful tool call', 'delete exactly what the task names', 'never claim it works',
  'try (quarantined, verdict)', 'no extra confirmation runs',
  // efficiency + rules
  'same turn', "Don't re-read", 'Stop when every criterion passes',
  'Prefer tests over one-off probes', 'lost on reload', 'context server', 'context client', 'Never edit scripts in Studio',
  'Screenshots only for visual', 'run_luau context edit', 'LocalScript UI', 'kit apply boilerplate', 'strips scripts, flags backdoors', 'check {rig:<model path>}', 'start/stop/state', 'server_code/client_code to check', 'not a full dump', 'WaitForChild(x, 5)', 'DataStore and HttpService', 'Never Destroy/ClearAllChildren broadly', 'retry once', 'task {action:"block"}',
];

describe('AGENT_GUIDE', () => {
  it('keeps every rule', () => {
    const flat = AGENT_GUIDE.replace(/\s+/g, ' '); // line wrapping is not meaning
    const missing = MUST_KEEP.filter((p) => !flat.includes(p));
    expect(missing).toEqual([]);
  });
  it('names every agent tool', () => {
    const missing = TOOLS.map((t) => t.name).filter((n) => !new RegExp(`\\b${n}\\b`).test(AGENT_GUIDE));
    expect(missing).toEqual([]);
  });
  it('stays under its context budget', () => {
    expect(AGENT_GUIDE.length).toBeLessThanOrEqual(5800);
  });
});
