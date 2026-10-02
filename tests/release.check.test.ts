import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJson } from '../src/state/store.js';
import { releaseCheck, formatRelease } from '../src/release/check.js';

const ok = (ids: string[]) => ({ ranAt: '2030-01-01T00:00:00Z', results: ids.map((id) => ({ id, ok: true })) });
function ready(): string {
  const p = mkdtempSync(join(tmpdir(), 'blox-rel-'));
  writeJson(p, 'last-tests.json', { ranAt: 'x', tests: [{ file: 'tests/a.spec.luau', name: 'a', status: 'pass' }], fileErrors: [] });
  writeJson(p, 'metrics-report.json', ok(['ftue:first-step', 'soak:errors']));
  writeJson(p, 'ui-report.json', ok(['ui:offscreen']));
  writeJson(p, 'present-report.json', ok(['present:title-length']));
  return p;
}
const status = (p: string) => Object.fromEntries(releaseCheck(p).gates.map((g) => [g.id, g.status]));

describe('releaseCheck', () => {
  it('ready when every required gate passed', () => {
    const r = releaseCheck(ready());
    expect(r.ready).toBe(true);
    expect(status(ready())).toMatchObject({ tests: 'pass', ftue: 'pass', soak: 'pass', ui: 'pass', present: 'pass', design: 'n/a', multiplayer: 'n/a', assets: 'n/a' });
    expect(formatRelease(r)).toMatch(/^release check: READY/);
    expect(formatRelease(r)).toMatch(/human gates/i);
  });
  it('missing and failing gates block', () => {
    const p = ready();
    writeJson(p, 'last-tests.json', { ranAt: 'x', tests: [{ file: 'a', name: 'b', status: 'fail' }], fileErrors: [] });
    writeJson(p, 'ui-report.json', { ranAt: 'x', results: [{ id: 'ui:overlap', ok: false }] });
    const r = releaseCheck(p);
    expect(r.ready).toBe(false);
    expect(status(p)).toMatchObject({ tests: 'fail', ui: 'fail' });
    expect(r.gates.find((g) => g.id === 'ui')!.detail).toMatch(/ui:overlap/);
  });
  it('design required once design.json exists; stale sim blocks', () => {
    const p = ready();
    writeJson(p, 'design.json', { version: 1 });
    expect(status(p).design).toBe('missing');
    writeJson(p, 'sim-report.json', { ranAt: new Date(Date.now() + 60_000).toISOString(), assertions: [{ id: 'a', ok: true }] });
    expect(status(p).design).toBe('pass');
    writeJson(p, 'sim-report.json', { ranAt: '2000-01-01T00:00:00Z', assertions: [{ id: 'a', ok: true }] });
    expect(status(p).design).toBe('stale');
  });
  it('multiplayer required when mp specs exist; assets when a manifest exists', () => {
    const p = ready();
    mkdirSync(join(p, 'tests'));
    writeFileSync(join(p, 'tests/x.mp.luau'), '-- @context multiplayer\n');
    writeJson(p, 'assets.json', { version: 1, assets: [] });
    expect(status(p)).toMatchObject({ multiplayer: 'missing', assets: 'missing' });
    writeJson(p, 'mp-report.json', { ranAt: 'x', clients: 2, results: [{ file: 'tests/x.mp.luau', name: 'n', status: 'pass' }], fileErrors: [] });
    writeJson(p, 'asset-report.json', ok(['asset:licence']));
    expect(releaseCheck(p).ready).toBe(true);
  });
  it('soak is advisory', () => {
    const p = ready();
    writeJson(p, 'metrics-report.json', ok(['ftue:first-step']));
    expect(status(p).soak).toBe('missing');
    expect(releaseCheck(p).ready).toBe(true);
  });
});
