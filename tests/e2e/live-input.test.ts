import { describe, it, expect } from 'vitest';
import { studioLauncher } from '../../src/bridge/mcpBridge.js';
import { defaultClientFactory, type DoctorClient } from '../../src/doctor.js';

// Requires: a live Studio attached with a place that spawns a player character.
const enabled = process.env.BLOX_LIVE_INPUT === '1';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NO_STUDIO = /no active studio|unable to find an active studio/i;

function textOf(res: { content?: { text?: string }[] }): string {
  return (res?.content ?? []).map((c) => c?.text ?? '').join('').trim();
}

const HRP_POS =
  "local c=game.Players.LocalPlayer and game.Players.LocalPlayer.Character " +
  "local r=c and c:FindFirstChild('HumanoidRootPart') return r and tostring(r.Position) or 'no-hrp'";

describe.skipIf(!enabled)('input simulation (live)', () => {
  it('navigates the character in play and observes the position change', async () => {
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
      const nav = find('character_navigation');
      const kbd = find('user_keyboard_input');
      const mouse = find('user_mouse_input');
      for (const s of ['character_navigation', 'user_keyboard_input', 'user_mouse_input']) {
        expect(names.some((n) => n.endsWith(s))).toBe(true);
      }

      const callLuau = async (code: string) =>
        textOf(await client!.callTool({ name: luau, arguments: { code } }));

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

      // wait for the character, read start position
      let startPos = 'no-hrp';
      for (let i = 0; i < 12 && (startPos === 'no-hrp' || NO_STUDIO.test(startPos)); i++) {
        startPos = await callLuau(HRP_POS);
        if (startPos === 'no-hrp') await sleep(700);
      }
      expect(startPos).not.toBe('no-hrp');

      // navigate to an offset; assert the call succeeds
      const navRes = await client.callTool({
        name: nav,
        arguments: { x: 16, y: 5, z: 16, speed_multiplier: 2.0 },
      });
      expect(navRes.isError === true).toBe(false);
      expect(textOf(navRes)).toMatch(/success/i);

      // poll until the position changes (navigation is async)
      let moved = false;
      for (let i = 0; i < 10 && !moved; i++) {
        await sleep(800);
        const pos = await callLuau(HRP_POS);
        moved = pos !== 'no-hrp' && pos !== startPos;
      }
      expect(moved).toBe(true);

      // keyboard + mouse: assert each call succeeds (game-effect depends on wiring)
      const kbdRes = await client.callTool({
        name: kbd,
        arguments: { actions: [{ action: 'keyPress', key_code: 'Space' }] },
      });
      expect(kbdRes.isError === true).toBe(false);
      const mouseRes = await client.callTool({
        name: mouse,
        arguments: { actions: [{ action: 'moveTo', x: 400, y: 300 }, { action: 'mouseButtonClick', mouse_button: 'left' }] },
      });
      expect(mouseRes.isError === true).toBe(false);
    } finally {
      if (started && play) await client?.callTool({ name: play, arguments: { is_start: false } }).catch(() => {});
      await client?.close().catch(() => {});
    }
  }, 90_000);
});
