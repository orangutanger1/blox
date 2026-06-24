import { describe, it, expect } from 'vitest';
import { aggregateUsage } from '../src/usageReport.js';
import type { AuditEntry } from '../src/audit.js';

function e(over: Partial<AuditEntry> = {}): AuditEntry {
  return {
    ts: '2026-06-23T12:00:00Z',
    user: 'dev@example.com',
    model: 'claude-opus-4-8',
    turns: 3,
    costUsd: 1,
    status: 'success',
    commit: 'abc1234',
    prompt: 'p',
    ...over,
  };
}
const now = new Date('2026-06-24T12:00:00Z');

describe('aggregateUsage', () => {
  it('sums cost, counts runs and errors, buckets by user and model', () => {
    const s = aggregateUsage(
      [
        e({ user: 'a@x.com', model: 'claude-opus-4-8', costUsd: 2 }),
        e({ user: 'b@x.com', model: 'claude-opus-4-8', costUsd: 3 }),
        e({ user: 'a@x.com', model: 'claude-sonnet-4-6', costUsd: 1, status: 'error' }),
      ],
      { now, windowDays: null, capUsd: null },
    );
    expect(s.totalUsd).toBe(6);
    expect(s.runCount).toBe(3);
    expect(s.errorCount).toBe(1);
    expect(s.byUser).toEqual([
      { key: 'a@x.com', costUsd: 3, runs: 2 },
      { key: 'b@x.com', costUsd: 3, runs: 1 },
    ]);
    expect(s.byModel[0]).toEqual({ key: 'claude-opus-4-8', costUsd: 5, runs: 2 });
  });

  it('windows by ts: drops out-of-window and unparseable ts when windowed', () => {
    const s = aggregateUsage(
      [
        e({ ts: '2026-06-23T12:00:00Z', costUsd: 5 }), // 1 day ago — in
        e({ ts: '2026-05-01T12:00:00Z', costUsd: 9 }), // >30 days — out
        e({ ts: 'garbage', costUsd: 99 }),             // unparseable — out when windowed
      ],
      { now, windowDays: 30, capUsd: null },
    );
    expect(s.totalUsd).toBe(5);
    expect(s.runCount).toBe(1);
    expect(s.window).toEqual({ days: 30, since: '2026-05-25T12:00:00.000Z' });
  });

  it('keeps unparseable ts in an all-time report', () => {
    const s = aggregateUsage([e({ ts: 'garbage', costUsd: 7 })], { now, windowDays: null, capUsd: null });
    expect(s.totalUsd).toBe(7);
    expect(s.window).toEqual({ days: null, since: null });
  });

  it('buckets missing user/model under (unknown) and treats non-number cost as 0', () => {
    const s = aggregateUsage(
      [e({ user: '', model: undefined as unknown as string, costUsd: undefined as unknown as number })],
      { now, windowDays: null, capUsd: null },
    );
    expect(s.totalUsd).toBe(0);
    expect(s.byUser).toEqual([{ key: '(unknown)', costUsd: 0, runs: 1 }]);
    expect(s.byModel).toEqual([{ key: '(unknown)', costUsd: 0, runs: 1 }]);
  });

  it('computes capPct when a cap is set, null otherwise', () => {
    const withCap = aggregateUsage([e({ costUsd: 50 })], { now, windowDays: null, capUsd: 200 });
    expect(withCap.capUsd).toBe(200);
    expect(withCap.capPct).toBeCloseTo(0.25);
    const noCap = aggregateUsage([e({ costUsd: 50 })], { now, windowDays: null, capUsd: null });
    expect(noCap.capPct).toBeNull();
  });

  it('returns an empty summary for no entries', () => {
    const s = aggregateUsage([], { now, windowDays: 30, capUsd: 200 });
    expect(s).toMatchObject({ totalUsd: 0, runCount: 0, errorCount: 0, byUser: [], byModel: [] });
  });
});

import { renderUsageTable } from '../src/usageReport.js';

describe('renderUsageTable', () => {
  it('shows used/cap with a percent when a cap is set', () => {
    const out = renderUsageTable(
      aggregateUsage([e({ user: 'a@x.com', costUsd: 142.3 })], { now, windowDays: 30, capUsd: 200 }),
    );
    expect(out).toContain('$142.30');
    expect(out).toContain('$200.00');
    expect(out).toContain('71%');
    expect(out).toContain('a@x.com');
  });

  it('omits the cap line when there is no cap', () => {
    const out = renderUsageTable(
      aggregateUsage([e({ costUsd: 5 })], { now, windowDays: null, capUsd: null }),
    );
    expect(out).toContain('$5.00');
    expect(out).not.toContain('cap');
  });

  it('renders an empty ledger without throwing', () => {
    expect(() => renderUsageTable(aggregateUsage([], { now, windowDays: 30, capUsd: 200 }))).not.toThrow();
  });
});
