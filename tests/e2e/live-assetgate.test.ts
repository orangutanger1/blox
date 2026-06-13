// Gated live test for the P2 asset-gate result hook.
// Requires: a live Studio attached with a place open and BLOX_LIVE_ASSETGATE=1.
//
// NOTE: Full approve/reject click-through (the dock card with Allow/Deny buttons)
// needs a human in Studio — that is the manual smoke (Task 13 step 3) and is NOT
// covered here. This test only proves that generate_mesh still returns a result
// that extractAssetTag can parse, and that the asset lands in the workspace.

import { describe, it, expect } from 'vitest';
import { studioLauncher } from '../../src/bridge/mcpBridge.js';
import { defaultClientFactory, type DoctorClient } from '../../src/doctor.js';
import { extractAssetTag } from '../../src/agent/hooks.js';

const enabled = process.env.BLOX_LIVE_ASSETGATE === '1';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NO_STUDIO = /no active studio|unable to find an active studio|no studio available/i;

function textOf(res: { content?: { type?: string; text?: string }[] }): string {
  return (res?.content ?? []).map((c) => c?.text ?? '').join('').trim();
}

describe.skipIf(!enabled)('asset gate (live)', () => {
  it('generate_mesh result is parseable by extractAssetTag and asset lands in workspace', async () => {
    let client: DoctorClient | undefined;
    try {
      client = await defaultClientFactory(studioLauncher());
      const listed = await client.listTools();
      const names = listed.tools.map((t) => t.name);
      const find = (s: string) => names.find((n) => n.endsWith(s)) ?? s;
      const luau = find('execute_luau');
      const genMesh = find('generate_mesh');

      // Warm up past the proxy->Studio attach race.
      let attached = false;
      for (let i = 0; i < 15 && !attached; i++) {
        const t = textOf(
          await client.callTool({ name: luau, arguments: { code: 'return 1+1', datamodel_type: 'Edit' } }),
        );
        attached = !NO_STUDIO.test(t) && t.includes('2');
        if (!attached) await sleep(700);
      }
      expect(attached).toBe(true);

      // Call generate_mesh with a simple prompt.
      const meshRes = await client.callTool({
        name: genMesh,
        arguments: { textPrompt: 'a small test cube', maxTriangles: 500 },
      });

      // The call must not be an error.
      expect(meshRes.isError === true).toBe(false);

      // extractAssetTag must parse a non-null, non-empty tag from the result.
      const tag = extractAssetTag(meshRes);
      expect(tag).not.toBeNull();
      expect(typeof tag).toBe('string');
      expect((tag as string).length).toBeGreaterThan(0);

      // The asset must have landed in the workspace under the extracted tag.
      const landedRes = await client.callTool({
        name: luau,
        arguments: {
          code: `return workspace:FindFirstChild("${tag}", true) ~= nil`,
          datamodel_type: 'Edit',
        },
      });
      expect(textOf(landedRes)).toContain('true');
    } finally {
      await client?.close().catch(() => {});
    }
  }, 300_000);
});
