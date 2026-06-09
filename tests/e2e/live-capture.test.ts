import { describe, it, expect } from 'vitest';
import { studioLauncher } from '../../src/bridge/mcpBridge.js';
import { defaultClientFactory, type DoctorClient } from '../../src/doctor.js';

// Requires: a live Studio attached with a place open.
const enabled = process.env.BLOX_LIVE_CAPTURE === '1';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function textOf(res: { content?: { type?: string; text?: string }[] }): string {
  return (res?.content ?? []).map((c) => c?.text ?? '').join('').trim();
}

function hasImage(res: { content?: { type?: string; data?: string }[] }): boolean {
  return (res?.content ?? []).some((c) => c?.type === 'image' && !!c?.data);
}

describe.skipIf(!enabled)('visual verification (live)', () => {
  it('captures the running game viewport as an image', async () => {
    let client: DoctorClient | undefined;
    let play: string | undefined;
    let started = false;
    try {
      client = await defaultClientFactory(studioLauncher());
      const listed = await client.listTools();
      const names = listed.tools.map((t) => t.name);
      const find = (s: string) => names.find((n) => n.endsWith(s)) ?? s;
      play = find('start_stop_play');
      const luau = find('execute_luau');
      const capture = find('screen_capture');
      expect(names.some((n) => n.endsWith('screen_capture'))).toBe(true);

      // All callLuau uses run after start_stop_play -> client datamodel context.
      const callLuau = async (code: string) =>
        textOf(await client!.callTool({ name: luau, arguments: { code, datamodel_type: 'Client' } }));

      // start play (attach retry), then wait for IsRunning
      let startText = '';
      for (let i = 0; i < 10 && !/game started/i.test(startText); i++) {
        startText = textOf(await client.callTool({ name: play, arguments: { is_start: true } }));
        if (!/game started/i.test(startText)) await sleep(700);
      }
      started = true;
      let running = false;
      for (let i = 0; i < 10 && !running; i++) {
        running = (await callLuau("return tostring(game:GetService('RunService'):IsRunning())")).includes('true');
        if (!running) await sleep(700);
      }
      expect(running).toBe(true);

      // capture the viewport; assert the call succeeds and returns an image
      const capRes = await client.callTool({ name: capture, arguments: {} });
      expect(capRes.isError === true).toBe(false);
      expect(hasImage(capRes)).toBe(true);
    } finally {
      if (started && play) await client?.callTool({ name: play, arguments: { is_start: false } }).catch(() => {});
      await client?.close().catch(() => {});
    }
  }, 90_000);
});
