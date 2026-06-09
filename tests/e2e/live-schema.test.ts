import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { studioLauncher, createStudioMcpBridge } from '../../src/bridge/mcpBridge.js';
import { defaultClientFactory, type DoctorClient } from '../../src/doctor.js';

// Early-warning guard: fails when Studio's MCP tool schemas drift from what
// blox depends on (a removed/renamed tool, a new required arg, a renamed arg).
// listTools is served from the proxy's static catalog, so NO attached Studio /
// play mode is needed. Gated; self-skips without BLOX_LIVE_SCHEMA=1.
// Re-baseline after a legit Studio change: BLOX_UPDATE_SCHEMA_SNAPSHOT=1.
const enabled = process.env.BLOX_LIVE_SCHEMA === '1';
const update = process.env.BLOX_UPDATE_SCHEMA_SNAPSHOT === '1';
const snapshotPath = resolve(__dirname, '../fixtures/tool-schema.snapshot.json');
const PREFIX = /^mcp__Roblox_Studio__/;

type ToolShape = { required: string[]; props: string[] };

function shapeOf(inputSchema: { required?: string[]; properties?: Record<string, unknown> } | undefined): ToolShape {
  return {
    required: [...(inputSchema?.required ?? [])].sort(),
    props: Object.keys(inputSchema?.properties ?? {}).sort(),
  };
}

// Set diff -> human-readable "+[added] -[removed]" or null when equal.
function setDiff(expected: string[], actual: string[]): string | null {
  const e = new Set(expected), a = new Set(actual);
  const added = actual.filter((x) => !e.has(x));
  const removed = expected.filter((x) => !a.has(x));
  if (!added.length && !removed.length) return null;
  const parts = [];
  if (added.length) parts.push(`+[${added.join(',')}]`);
  if (removed.length) parts.push(`-[${removed.join(',')}]`);
  return `${parts.join(' ')} (expected [${expected.join(',')}], got [${actual.join(',')}])`;
}

describe.skipIf(!enabled)('tool schema drift guard (live)', () => {
  it('blox tools still match the committed schema snapshot', async () => {
    let client: DoctorClient | undefined;
    try {
      client = await defaultClientFactory(studioLauncher());
      const { tools } = await client.listTools();
      const liveByName = new Map(tools.map((t) => [t.name.replace(PREFIX, ''), t]));

      // blox's tool surface (names only) from the public bridge seam.
      const bloxNames = createStudioMcpBridge().allowedTools()
        .map((n) => n.replace(PREFIX, ''))
        .sort();

      const live: Record<string, ToolShape> = {};
      const problems: string[] = [];
      for (const name of bloxNames) {
        const t = liveByName.get(name);
        if (!t) { problems.push(`MISSING live tool: ${name}`); continue; }
        live[name] = shapeOf(t.inputSchema as { required?: string[]; properties?: Record<string, unknown> });
      }

      if (update) {
        writeFileSync(snapshotPath, JSON.stringify(live, null, 2) + '\n');
        // eslint-disable-next-line no-console
        console.log(`[live-schema] snapshot rewritten from live: ${snapshotPath}`);
        return;
      }

      const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as Record<string, ToolShape>;
      for (const name of bloxNames) {
        if (!live[name]) continue; // already reported MISSING
        const exp = snapshot[name];
        if (!exp) { problems.push(`${name}: no snapshot entry (run BLOX_UPDATE_SCHEMA_SNAPSHOT=1)`); continue; }
        const reqDiff = setDiff(exp.required, live[name].required);
        const propDiff = setDiff(exp.props, live[name].props);
        if (reqDiff) problems.push(`${name}.required ${reqDiff}`);
        if (propDiff) problems.push(`${name}.props ${propDiff}`);
      }

      expect(problems, `\nSchema drift vs snapshot (re-baseline with BLOX_UPDATE_SCHEMA_SNAPSHOT=1 if intended):\n${problems.join('\n')}\n`).toEqual([]);
    } finally {
      await client?.close().catch(() => {});
    }
  }, 60_000);
});
