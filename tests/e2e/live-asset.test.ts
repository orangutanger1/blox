import { describe, it, expect } from 'vitest';
import { studioLauncher } from '../../src/bridge/mcpBridge.js';
import { defaultClientFactory, type DoctorClient } from '../../src/doctor.js';

// Requires: a live Studio attached with a place open.
const enabled = process.env.BLOX_LIVE_ASSET === '1';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NO_STUDIO = /no active studio|unable to find an active studio|no studio available/i;

function textOf(res: { content?: { type?: string; text?: string }[] }): string {
  return (res?.content ?? []).map((c) => c?.text ?? '').join('').trim();
}

// Parse the leading integer out of an execute_luau result (e.g. a child count).
function intOf(res: { content?: { type?: string; text?: string }[] }): number {
  const m = textOf(res).match(/-?\d+/);
  return m ? parseInt(m[0], 10) : NaN;
}

describe.skipIf(!enabled)('asset pipeline (live)', () => {
  it('repairs the search->insert and procedural->wait chains', async () => {
    let client: DoctorClient | undefined;
    try {
      client = await defaultClientFactory(studioLauncher());
      const listed = await client.listTools();
      const names = listed.tools.map((t) => t.name);
      const find = (s: string) => names.find((n) => n.endsWith(s)) ?? s;
      const luau = find('execute_luau');
      const search = find('search_creator_store');
      const insert = find('insert_from_creator_store');
      const genModel = find('generate_procedural_model');
      const wait = find('wait_job_finished');
      for (const s of ['search_creator_store', 'wait_job_finished']) {
        expect(names.some((n) => n.endsWith(s))).toBe(true);
      }

      // Warm up past the proxy->Studio attach race.
      let attached = false;
      for (let i = 0; i < 15 && !attached; i++) {
        const t = textOf(await client.callTool({ name: luau, arguments: { code: 'return 1+1' } }));
        attached = !NO_STUDIO.test(t) && t.includes('2');
        if (!attached) await sleep(700);
      }
      expect(attached).toBe(true);

      const childCount = 'return #workspace:GetChildren()';

      // Chain 1: search_creator_store -> insert_from_creator_store.
      const before1 = intOf(await client.callTool({ name: luau, arguments: { code: childCount } }));
      const searchRes = await client.callTool({ name: search, arguments: { query: 'tree' } });
      expect(searchRes.isError === true).toBe(false);
      const parsed = JSON.parse(textOf(searchRes)) as { searchId?: string; objectTypes?: string[] };
      expect(typeof parsed.searchId).toBe('string');
      const insertRes = await client.callTool({ name: insert, arguments: { searchId: parsed.searchId } });
      expect(insertRes.isError === true).toBe(false);
      // Assert the asset actually landed under Workspace (spec §7.4).
      const after1 = intOf(await client.callTool({ name: luau, arguments: { code: childCount } }));
      expect(after1).toBeGreaterThan(before1);

      // Chain 2: generate_procedural_model -> wait_job_finished.
      const before2 = intOf(await client.callTool({ name: luau, arguments: { code: childCount } }));
      const genRes = await client.callTool({ name: genModel, arguments: { prompt: 'a small gray rock' } });
      expect(genRes.isError === true).toBe(false);
      const genId = textOf(genRes).match(/Generation ID:\s*([0-9a-fA-F-]+)/)?.[1];
      expect(typeof genId).toBe('string');
      if (!genId) throw new Error(`no Generation ID in: ${textOf(genRes)}`);
      const waitRes = await client.callTool(
        { name: wait, arguments: { generationId: genId, timeout: 180 } },
      );
      // Record the real done-result shape (un-probed at design time).
      console.log('[live-asset] wait_job_finished result:', JSON.stringify(waitRes));
      expect(waitRes.isError === true).toBe(false);
      // Assert the model actually landed under Workspace (spec §7.5).
      const after2 = intOf(await client.callTool({ name: luau, arguments: { code: childCount } }));
      expect(after2).toBeGreaterThan(before2);
    } finally {
      await client?.close().catch(() => {});
    }
  }, 300_000);
});
