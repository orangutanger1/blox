import { describe, it, expect } from 'vitest';
import { noticeFromStderr } from '../src/agent/notices.js';

describe('noticeFromStderr', () => {
  it('surfaces rate-limit / retry lines with a model: prefix', () => {
    expect(noticeFromStderr('API Error: 429 rate_limit_exceeded')).toBe('model: API Error: 429 rate_limit_exceeded');
    expect(noticeFromStderr('  Overloaded, retrying in 2s  ')).toBe('model: Overloaded, retrying in 2s');
    expect(noticeFromStderr('Provider returned 503')).toBe('model: Provider returned 503');
  });

  it('drops debug noise and blank lines', () => {
    expect(noticeFromStderr('')).toBeNull();
    expect(noticeFromStderr('[debug] spawning subprocess')).toBeNull();
    expect(noticeFromStderr('reading config from disk')).toBeNull();
  });

  it('caps long lines', () => {
    const out = noticeFromStderr('429 ' + 'x'.repeat(500));
    expect(out).not.toBeNull();
    expect((out as string).endsWith('…')).toBe(true);
    expect((out as string).length).toBe('model: '.length + 200 + 1);
  });
});
