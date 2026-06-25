import { describe, it, expect } from 'vitest';
import { usageHtml } from './usageView.js';

const summary = {
  window: { days: 30, since: null }, totalUsd: 142.3, capUsd: 200, capPct: 0.7115,
  runCount: 5, errorCount: 1, byUser: [{ key: 'a@x.com', costUsd: 142.3, runs: 5 }],
  byModel: [{ key: 'claude-opus-4-8', costUsd: 142.3, runs: 5 }],
};

describe('usageHtml', () => {
  it('renders totals, cap percent and per-user rows', () => {
    const html = usageHtml(summary);
    expect(html).toContain('$142.30');
    expect(html).toContain('71%');
    expect(html).toContain('a@x.com');
  });

  it('shows a fallback when usage is unavailable', () => {
    expect(usageHtml(null)).toContain('usage unavailable');
  });

  it('escapes HTML in bucket keys', () => {
    const html = usageHtml({
      window: { days: null, since: null }, totalUsd: 1, capUsd: null, capPct: null,
      runCount: 1, errorCount: 0,
      byUser: [{ key: '<script>x</script>', costUsd: 1, runs: 1 }], byModel: [],
    });
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
