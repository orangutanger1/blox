import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFlags, cliArgs, setupAgent, mcpServerEntry } from '../src/cliTools.js';
import { scaffoldProject } from '../src/scaffold.js';

describe('parseFlags / cliArgs', () => {
  it('maps animate rig flags', () => {
    expect(cliArgs('animate', parseFlags(['rig', 'Workspace.Dog', '--suggest', '--plan', 'quadruped']))).toEqual({
      tool: 'animate', args: { action: 'rig', model: 'Workspace.Dog', suggest: true, plan: 'quadruped' },
    });
    expect(cliArgs('animate', parseFlags(['rig', 'Workspace.Dog', '--joints', 'suggested', '--controller', 'Humanoid', '--revision', 'rr1:ab']))).toEqual({
      tool: 'animate', args: { action: 'rig', model: 'Workspace.Dog', joints: 'suggested', controller: 'Humanoid', expected_revision: 'rr1:ab' },
    });
    expect(cliArgs('animate', parseFlags(['rig', 'Workspace.Wolf', '--joints', 'blender', '--blender', 'wolf', '--controller', 'Humanoid']))).toEqual({
      tool: 'animate', args: { action: 'rig', model: 'Workspace.Wolf', joints: 'blender', blender_id: 'wolf', controller: 'Humanoid' },
    });
  });
  it('maps friendly flags onto tool args', () => {
    expect(cliArgs('test', parseFlags(['coins', '--context', 'server,client', '--no-sync']))).toEqual({
      tool: 'run_tests', args: { filter: 'coins', contexts: ['server', 'client'], sync: false },
    });
    expect(cliArgs('playtest', parseFlags(['--seconds', '5', '--screenshot', '--camera', '0,10,0', '--look-at', '0,0,0']))).toEqual({
      tool: 'playtest', args: { seconds: 5, screenshot: true, camera_position: [0, 10, 0], look_at: [0, 0, 0] },
    });
    expect(cliArgs('luau', parseFlags(['return', '1', '--context', 'server']))).toEqual({ tool: 'run_luau', args: { code: 'return 1', context: 'server' } });
    expect(cliArgs('tool', parseFlags(['studio_tool', '{"name":"list"}']))).toEqual({ tool: 'studio_tool', args: { name: 'list' } });
    expect(cliArgs('nope', parseFlags([]))).toBeNull();
  });
  it('captures --project separately', () => {
    expect(parseFlags(['--project', '/g', 'x']).project).toBe('/g');
  });
});

describe('setupAgent', () => {
  it('claude: writes .mcp.json (merging existing servers) + CLAUDE.md importing AGENTS.md', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-setup-'));
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    setupAgent('claude', dir);
    const cfg = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'));
    expect(Object.keys(cfg.mcpServers).sort()).toEqual(['blox', 'other']);
    expect(cfg.mcpServers.blox.args).toContain('mcp');
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toBe('@AGENTS.md\n');
    expect(existsSync(join(dir, 'AGENTS.md'))).toBe(true);
  });
  it('refuses to clobber an invalid .mcp.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-setup-'));
    writeFileSync(join(dir, '.mcp.json'), '{nope');
    expect(() => setupAgent('claude', dir)).toThrow(/not valid JSON/);
  });
  it('codex: prints a config snippet instead of editing global config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-setup-'));
    const out = setupAgent('codex', dir).join('\n');
    expect(out).toContain('[mcp_servers.blox]');
    expect(mcpServerEntry(dir).args.slice(-3)).toEqual(['mcp', '--project', dir]);
  });
});

describe('scaffoldProject', () => {
  it('is non-destructive and optional about agent files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-scaffold-'));
    writeFileSync(join(dir, 'default.project.json'), '{"keep":true}');
    const r = scaffoldProject(dir, 'g');
    expect(r.existing).toContain('default.project.json');
    expect(readFileSync(join(dir, 'default.project.json'), 'utf8')).toBe('{"keep":true}');
    expect(r.created).toContain('tests/smoke.spec.luau');
    const neutral = mkdtempSync(join(tmpdir(), 'blox-scaffold-'));
    const n = scaffoldProject(neutral, 'g', { agentFiles: false });
    expect(n.created).not.toContain('AGENTS.md');
    expect(n.created).not.toContain('tests/smoke.spec.luau');
  });
});
