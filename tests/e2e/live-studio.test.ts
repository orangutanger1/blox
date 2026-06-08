import { describe, it, expect } from 'vitest';
import { studioLauncher } from '../../src/bridge/mcpBridge.js';
import { runDoctor } from '../../src/doctor.js';

// Requires a live Windows Studio with a place open + MCP server enabled.
const enabled = process.env.BLOX_LIVE_STUDIO === '1';

describe.skipIf(!enabled)('live Studio bring-up', () => {
  it('connects to the proxy and lists the SP1b tool surface', async () => {
    const r = await runDoctor(studioLauncher());
    expect(r.connected).toBe(true);
    expect(r.serverName).toBe('RobloxStudio');
    const names = (r.tools ?? []).map((t) => t.replace(/^mcp__Roblox_Studio__/, ''));
    for (const t of ['execute_luau', 'script_read', 'search_game_tree', 'inspect_instance']) {
      expect(names).toContain(t);
    }
  }, 30_000);

  it('runs execute_luau on the attached Studio (return 1 + 1 -> 2)', async () => {
    const r = await runDoctor(studioLauncher());
    expect(r.studioAttached).toBe(true);
    expect(r.detail).toMatch(/-> 2\b/);
  }, 30_000);
});
