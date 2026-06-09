import { describe, it, expect } from 'vitest';
import { studioLauncher } from '../../src/bridge/mcpBridge.js';
import { defaultClientFactory, type DoctorClient } from '../../src/doctor.js';

// Requires: a live Studio attached (place open, MCP enabled). No rojo needed.
const enabled = process.env.BLOX_LIVE_PLAY === '1';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function textOf(res: { content?: { text?: string }[] }): string {
  return (res?.content ?? []).map((c) => c?.text ?? '').join('').trim();
}

const IS_RUNNING = "return tostring(game:GetService('RunService'):IsRunning())";

describe.skipIf(!enabled)('tier-2 play (live)', () => {
  it('starts play, runs execute_luau in-play, reads an injected console marker, stops play', async () => {
    const marker = `PLAY-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    let client: DoctorClient | undefined;
    let play: string | undefined;
    let started = false;
    try {
      client = await defaultClientFactory(studioLauncher());
      const listed = await client.listTools();
      const names = listed.tools.map((t) => t.name);
      const find = (suffix: string) => names.find((n) => n.endsWith(suffix)) ?? suffix;
      play = find('start_stop_play');
      const consoleTool = find('get_console_output');
      const luau = find('execute_luau');
      expect(names.some((n) => n.endsWith('start_stop_play'))).toBe(true);
      expect(names.some((n) => n.endsWith('get_console_output'))).toBe(true);
      expect(names.some((n) => n.endsWith('execute_luau'))).toBe(true);

      // Start play, retrying past the proxy->Studio attach race until it takes.
      let startText = '';
      for (let i = 0; i < 12 && !/game started/i.test(startText); i++) {
        startText = textOf(await client.callTool({ name: play, arguments: { is_start: true } }));
        if (!/game started/i.test(startText)) await sleep(700);
      }
      started = true;
      expect(startText).toMatch(/game started/i);

      // execute_luau runs in-play (client context) -> IsRunning() is true
      let running = false;
      for (let i = 0; i < 10 && !running; i++) {
        const r = await client.callTool({ name: luau, arguments: { code: IS_RUNNING, datamodel_type: 'Client' } });
        running = textOf(r).includes('true');
        if (!running) await sleep(800);
      }
      expect(running).toBe(true);

      // inject a runtime print, then read it back from the console
      await client.callTool({ name: luau, arguments: { code: `print('${marker}') return 'ok'`, datamodel_type: 'Client' } });
      let seen = false;
      for (let i = 0; i < 6 && !seen; i++) {
        const r = await client.callTool({ name: consoleTool, arguments: {} });
        seen = textOf(r).includes(marker);
        if (!seen) await sleep(500);
      }
      expect(seen).toBe(true);

      // stop play and confirm it took effect
      await client.callTool({ name: play, arguments: { is_start: false } });
      started = false;
      let stopped = false;
      for (let i = 0; i < 6 && !stopped; i++) {
        const r = await client.callTool({ name: luau, arguments: { code: IS_RUNNING, datamodel_type: 'Edit' } });
        stopped = textOf(r).includes('false');
        if (!stopped) await sleep(800);
      }
      expect(stopped).toBe(true);
    } finally {
      if (started && play) await client?.callTool({ name: play, arguments: { is_start: false } }).catch(() => {});
      await client?.close().catch(() => {});
    }
  }, 60_000);
});
