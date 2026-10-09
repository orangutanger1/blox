import { describe, it, expect } from 'vitest';
import { evaluateFtue, evaluateSoak, memorySlope, normalizeDump, formatMetrics, playerTimeline, type TelemetryDump } from '../src/metrics/gamefeel.js';
import { validateDesign, type DesignDoc } from '../src/design/schema.js';

function doc(): DesignDoc {
  const r = validateDesign({
    version: 1,
    meta: { title: 'T', format: 'incremental' },
    ftue: [
      { id: 'first-step', text: 'a', targetSec: 5 },
      { id: 'first-wall', text: 'b', targetSec: 60 },
      { id: 'first-pet', text: 'c', targetSec: 90 },
    ],
    economy: {
      resources: [{ id: 'cash' }],
      actions: [{ id: 'c', yields: { cash: 1 }, perSec: 1 }],
      generators: [{ id: 'g', produces: { cash: 1 }, cost: { res: 'cash', base: 10, growth: 2 } }],
    },
    archetypes: [{ id: 'bot', session: { lengthSec: 3600, perDay: 1 }, policy: 'cheapest' }],
  });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.doc;
}

const dump = (over: Partial<TelemetryDump> = {}): TelemetryDump =>
  normalizeDump({
    elapsed: 120,
    players: { '1': { joinedAt: 0.5, steps: { 'first-step': 2.2, 'first-wall': 75, 'auto:first-currency': 3 } } },
    events: [],
    samples: [],
    ...over,
  });

describe('evaluateFtue', () => {
  it('checks each design step against its target, plus the first-currency budget', () => {
    const r = evaluateFtue(dump(), doc());
    expect(r.map((x) => [x.id, x.ok])).toEqual([
      ['ftue:first-step', true],
      ['ftue:first-wall', false],
      ['ftue:first-pet', false],
      ['ftue:auto:first-currency', true],
    ]);
    expect(r[0].detail).toBe('first-step at 2s (<= 5s)');
    expect(r[1].detail).toBe('first-wall at 1m15s (<= 1m00s)');
    expect(r[2].detail).toMatch(/never reached in 2m00s/);
  });
  it('works without a design (auto steps only) and with no player', () => {
    expect(evaluateFtue(dump(), null).map((x) => x.id)).toEqual(['ftue:auto:first-currency']);
    const none = evaluateFtue(normalizeDump({ elapsed: 5, players: [], events: [], samples: [] }), doc());
    expect(none).toEqual([{ id: 'ftue:player', ok: false, actual: null, detail: 'no player joined during the playtest' }]);
  });
});

describe('memorySlope', () => {
  it('is MB/min over the second half (least squares)', () => {
    const s = [0, 10, 20, 30, 40, 50, 60].map((t) => ({ t, memMb: t < 30 ? 500 : 500 + (t - 30) * 0.5, stats: {} }));
    expect(memorySlope(s)).toBeCloseTo(30, 6); // 0.5 MB/s
    expect(memorySlope(s.slice(0, 3))).toBeNull();
  });
});

describe('playerTimeline', () => {
  it('lists the first player\'s events in time order, capped, and formats the last one', () => {
    const d = dump({ events: [{ t: 90, uid: '1', name: 'wave:3' }, { t: 5, uid: '2', name: 'wave:1' }, { t: 30, uid: '1', name: 'wave:2', value: 2 }] });
    expect(playerTimeline(d)).toEqual([{ t: 30, name: 'wave:2', value: 2 }, { t: 90, name: 'wave:3' }]);
    expect(playerTimeline(d, 1)).toEqual([{ t: 90, name: 'wave:3' }]);
    const text = formatMetrics({ ranAt: '', mode: 'soak', seconds: 100, bot: 'b', results: [], notes: [], timeline: playerTimeline(d) });
    expect(text).toMatch(/timeline: 2 event\(s\), last wave:3 at 1m30s/);
  });
});

describe('evaluateSoak', () => {
  const flat = [0, 5, 10, 15, 20, 25, 30, 35].map((t) => ({ t, memMb: 400, stats: {} }));
  it('expect: passes when the first player logged each event, fails with the missing ones', () => {
    const d = dump({ samples: flat, events: [{ t: 30, uid: '1', name: 'wave:5' }, { t: 900, uid: '1', name: 'boss:MegaDog' }] });
    const ok = evaluateSoak(d, 0, { seconds: 40, expect: ['boss:MegaDog'] });
    expect(ok.find((x) => x.id === 'soak:expect:boss:MegaDog')).toMatchObject({ ok: true, actual: 900 });
    const bad = evaluateSoak(d, 0, { seconds: 40, expect: ['boss:KingSlimeDog'] });
    expect(bad.find((x) => x.id === 'soak:expect:boss:KingSlimeDog')).toMatchObject({ ok: false, actual: null });
  });
  it('passes errors and memory when clean', () => {
    const r = evaluateSoak(dump({ samples: flat }), 0, { seconds: 40 });
    expect(r.map((x) => [x.id, x.ok])).toEqual([['soak:errors', true], ['soak:memory', true]]);
  });
  it('fails on runtime errors and memory growth', () => {
    const leak = flat.map((s) => ({ ...s, memMb: 400 + s.t * 2 }));
    const r = evaluateSoak(dump({ samples: leak }), 3, { seconds: 40 });
    expect(r.map((x) => x.ok)).toEqual([false, false]);
    expect(r[0].detail).toBe('3 runtime error(s)');
    expect(r[1].detail).toMatch(/120\.0 MB\/min/);
  });
  it('too few samples is a failing memory check with advice', () => {
    expect(evaluateSoak(dump({ samples: flat.slice(0, 2) }), 0, { seconds: 10 })[1].detail).toMatch(/soak >= 30s/);
  });
  it('pace compares first purchases to the simulator for an archetype', () => {
    // sim (cheapest, 1 cash/s, 10·2^n): g#1 at 10s, g#2 at 20s (owned 1 → +2/s) ...
    const good = dump({ samples: flat, events: [{ t: 14, uid: '1', name: 'generator:g' }] });
    const r = evaluateSoak(good, 0, { seconds: 120, doc: doc(), archetype: 'bot' });
    expect(r.find((x) => x.id === 'soak:pace')).toMatchObject({ ok: true });
    const slow = dump({ samples: flat, events: [{ t: 70, uid: '1', name: 'generator:g' }] });
    const s = evaluateSoak(slow, 0, { seconds: 120, doc: doc(), archetype: 'bot' }).find((x) => x.id === 'soak:pace')!;
    expect(s.ok).toBe(false);
    expect(s.detail).toMatch(/generator:g at 1m10s vs sim 10s/);
    const never = evaluateSoak(dump({ samples: flat }), 0, { seconds: 120, doc: doc(), archetype: 'bot' }).find((x) => x.id === 'soak:pace')!;
    expect(never.detail).toMatch(/generator:g never vs sim 10s/);
  });
});

describe('formatMetrics', () => {
  it('summarises pass/fail', () => {
    const text = formatMetrics({ ranAt: 'x', mode: 'ftue', seconds: 60, bot: 'walk', results: evaluateFtue(dump(), doc()), notes: ['n1'] });
    expect(text).toMatch(/^metrics ftue \(60s, bot walk\): 2\/4 pass/);
    expect(text).toMatch(/✗ ftue:first-wall/);
    expect(text).toMatch(/note: n1/);
  });
});

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withSyntheticResults, writeJson } from '../src/state/store.js';

describe('withSyntheticResults', () => {
  it('appends metrics results after design results', () => {
    const p = mkdtempSync(join(tmpdir(), 'blox-syn-'));
    writeJson(p, 'sim-report.json', { ranAt: 'a', assertions: [{ id: 'x', ok: true }] });
    writeJson(p, 'metrics-report.json', { ranAt: 'b', results: [{ id: 'ftue:first-step', ok: false }, { id: 'soak:errors', ok: true }] });
    expect(withSyntheticResults(p, null)!.tests).toEqual([
      { file: 'design', name: 'design:x', status: 'pass' },
      { file: 'metrics', name: 'ftue:first-step', status: 'fail' },
      { file: 'metrics', name: 'soak:errors', status: 'pass' },
    ]);
  });
});
