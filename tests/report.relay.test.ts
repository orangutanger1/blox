import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runReportCommand } from '../src/reportCommand.js';

const summary = { window: { days: 7, since: null }, totalUsd: 4.5, capUsd: 10, capPct: 0.45, runCount: 30, errorCount: 1, byUser: [{ key: 'a@x.com', costUsd: 4.5, runs: 30 }], byModel: [{ key: 'claude-opus-5-5', costUsd: 4.5, runs: 30 }], unit: 'requests' };
const relayStore = { mode: 'relay' as const, relay: { url: 'http://relay:8787', token: 'blx_t' } };

describe('blox report sources', () => {
  it('relay mode shows the team relay summary', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string, init: { headers: Record<string, string> }) => {
      seen.push(`${url} ${init.headers['x-api-key']}`);
      return new Response(JSON.stringify(summary));
    }) as unknown as typeof fetch;
    const out = await runReportCommand({ projectPath: mkdtempSync(join(tmpdir(), 'blox-rr-')), since: 7, json: false, source: 'auto', store: relayStore, fetchImpl });
    expect(seen).toEqual(['http://relay:8787/api/v1/usage?since=7d blx_t']);
    expect(out).toContain('(team relay)');
    expect(out).toContain('30 requests, 1 errors');
  });
  it('--local reads the project ledger even in relay mode; --relay needs a linked relay', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-rr-'));
    const out = await runReportCommand({ projectPath: dir, since: null, json: false, source: 'local', store: relayStore });
    expect(out).toContain('0 runs');
    await expect(runReportCommand({ projectPath: dir, since: null, json: false, source: 'relay', store: {} })).rejects.toThrow(/no team relay linked/);
  });
  it('surfaces relay errors', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ type: 'error', error: { message: 'blox relay: unknown member token' } }), { status: 401 })) as unknown as typeof fetch;
    await expect(runReportCommand({ projectPath: '/x', since: null, json: true, source: 'auto', store: relayStore, fetchImpl })).rejects.toThrow(/unknown member token/);
  });
});
