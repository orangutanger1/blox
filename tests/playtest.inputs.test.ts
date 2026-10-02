import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clientPath, runInput } from '../src/testing/playtest.js';
import { StudioSession } from '../src/studio/session.js';
import { findTool, invokeTool } from '../src/tools/registry.js';
import { BloxConfigSchema } from '../src/config.js';
import { fakeStudio, type FakeStudio } from './fakeStudio.js';

const sessionOf = (f: FakeStudio) =>
  new StudioSession({ launch: { command: 'x', args: [] }, connector: async () => f.client, sleep: async () => {}, attachTimeoutMs: 0 });

describe('clientPath', () => {
  it('maps DataModel-style paths to the LocalPlayer paths Studio input tools resolve', () => {
    expect(clientPath('game.Players.LocalPlayer.PlayerGui.HUD.B')).toBe('LocalPlayer.PlayerGui.HUD.B');
    expect(clientPath('Players.LocalPlayer.PlayerGui.HUD.B')).toBe('LocalPlayer.PlayerGui.HUD.B');
    expect(clientPath('PlayerGui.HUD.B')).toBe('LocalPlayer.PlayerGui.HUD.B');
    expect(clientPath('Workspace.Door')).toBe('Workspace.Door');
  });
});

describe('playtest click input', () => {
  it('clicks a GUI button by path through user_mouse_input', async () => {
    const f = fakeStudio({ tools: { user_mouse_input: () => 'Success' } });
    const r = await runInput(sessionOf(f), { kind: 'click', args: { target: 'PlayerGui.HUD.Buy', settle: 0 } });
    expect(r.ok).toBe(true);
    expect(f.calls.at(-1)?.args).toMatchObject({
      datamodel_type: 'Client',
      actions: [{ action: 'mouseButtonClick', mouse_button: 'left', instance_path: 'LocalPlayer.PlayerGui.HUD.Buy' }],
    });
  });
  it('fails a click that lands on Roblox CoreGui and says why', async () => {
    const f = fakeStudio({ tools: { user_mouse_input: () => 'VirtualInput::SendMousePosition: position (116.0, 142.0) hits CoreGUI.' } });
    const r = await runInput(sessionOf(f), { kind: 'click', args: { target: 'PlayerGui.HUD.Buy', settle: 0 } });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/move the button/);
  });
  it('normalizes instance_path inside raw mouse actions', async () => {
    const f = fakeStudio({ tools: { user_mouse_input: () => 'Success' } });
    await runInput(sessionOf(f), { kind: 'mouse', args: { actions: [{ action: 'mouseButtonClick', mouse_button: 'left', instance_path: 'Players.LocalPlayer.PlayerGui.X' }] } });
    expect((f.calls.at(-1)?.args.actions as { instance_path: string }[])[0].instance_path).toBe('LocalPlayer.PlayerGui.X');
  });
});

describe('studio_tool datamodel_type', () => {
  it('fixes the casing Studio rejects', async () => {
    const f = fakeStudio({ tools: { user_mouse_input: () => 'Success' } });
    const projectPath = mkdtempSync(join(tmpdir(), 'blox-pt-'));
    const ctx = { session: sessionOf(f), projectPath, config: BloxConfigSchema.parse({ projectPath }), agent: 't' };
    await invokeTool(findTool('studio_tool')!, { name: 'user_mouse_input', args: { datamodel_type: 'client', actions: [] } }, ctx);
    expect(f.calls.at(-1)?.args.datamodel_type).toBe('Client');
  });
});
