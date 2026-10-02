import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJson } from '../src/state/store.js';
import { approveRelease, buildPlace, publishRelease } from '../src/release/publish.js';
import { OpenCloud, type FetchLike } from '../src/opencloud/client.js';
import type { Spawner } from '../src/assets/blender.js';

const ok = (ids: string[]) => ({ ranAt: 'x', results: ids.map((id) => ({ id, ok: true })) });
function readyProject(): string {
  const p = mkdtempSync(join(tmpdir(), 'blox-pub-'));
  writeJson(p, 'last-tests.json', { ranAt: 'x', tests: [{ file: 'a', name: 'a', status: 'pass' }], fileErrors: [] });
  writeJson(p, 'metrics-report.json', ok(['ftue:a']));
  writeJson(p, 'ui-report.json', ok(['ui:a']));
  writeJson(p, 'present-report.json', ok(['present:a']));
  return p;
}
// fake rojo: writes the output file
const rojo = (content = 'RBXL'): Spawner => async (_cmd, args) => {
  writeFileSync(args[args.indexOf('--output') + 1], content);
  return { code: 0, stdout: '', stderr: '' };
};

describe('release build/approve/publish', () => {
  it('build hashes the place and warns about world builders', async () => {
    const p = readyProject();
    mkdirSync(join(p, 'world'));
    writeFileSync(join(p, 'world/Map.luau'), 'return function() end');
    const b = await buildPlace(p, { spawn: rojo() });
    expect(b.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(b.notes[0]).toMatch(/world\/ builders/);
  });
  it('missing rojo is readable', async () => {
    await expect(buildPlace(readyProject(), { spawn: async () => ({ code: null, stdout: '', stderr: '', notFound: true }) })).rejects.toThrow(/rojo not found/);
  });
  it('publish needs readiness, an approval bound to this build, a target, then confirm', async () => {
    const p = readyProject();
    await buildPlace(p, { spawn: rojo() });
    await expect(publishRelease(p)).rejects.toThrow(/not approved/);
    approveRelease(p);
    await expect(publishRelease(p)).rejects.toThrow(/release\.json/);
    writeJson(p, 'release.json', { universeId: 11, placeId: 22 });
    expect(await publishRelease(p)).toMatchObject({ dryRun: true, target: { universeId: 11, placeId: 22 } });
    // a rebuild with different content invalidates the approval
    await buildPlace(p, { spawn: rojo('CHANGED') });
    await expect(publishRelease(p, { confirm: true })).rejects.toThrow(/not approved/);
  });
  it('not ready blocks even with approval', async () => {
    const p = readyProject();
    writeJson(p, 'ui-report.json', { ranAt: 'x', results: [{ id: 'ui:overlap', ok: false }] });
    await buildPlace(p, { spawn: rojo() });
    approveRelease(p);
    await expect(publishRelease(p, { confirm: true })).rejects.toThrow(/not ready to publish: ui fail/);
  });
  it('confirmed publish posts the rbxl to Place Publishing (fake fetch) and logs it', async () => {
    const p = readyProject();
    await buildPlace(p, { spawn: rojo() });
    approveRelease(p);
    writeJson(p, 'release.json', { universeId: 11, placeId: 22 });
    const calls: { url: string; init?: { method?: string; headers?: Record<string, string>; body?: unknown } }[] = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => JSON.stringify({ versionNumber: 7 }) };
    };
    const r = await publishRelease(p, { confirm: true, client: new OpenCloud({ apiKey: 'k', fetch }) });
    expect(r).toMatchObject({ dryRun: false, versionNumber: 7 });
    expect(calls[0].url).toBe('https://apis.roblox.com/universes/v1/11/places/22/versions?versionType=Published');
    expect(calls[0].init).toMatchObject({ method: 'POST', headers: { 'x-api-key': 'k', 'content-type': 'application/octet-stream' } });
    expect(readFileSync(join(p, '.blox/release-log.jsonl'), 'utf8')).toMatch(/"versionNumber":7/);
  });
});
