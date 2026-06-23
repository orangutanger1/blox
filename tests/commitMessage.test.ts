import { describe, it, expect } from 'vitest';
import { renderCommitMessage } from '../src/commitMessage.js';

const ctx = { prompt: 'add leaderboard', user: 'dev@x.io', model: 'claude-opus-4-8', date: '2026-06-23' };

describe('renderCommitMessage', () => {
  it('falls back to the default template when none set', () => {
    expect(renderCommitMessage(undefined, ctx)).toBe('blox: add leaderboard');
  });

  it('substitutes all known tokens', () => {
    expect(renderCommitMessage('{date} {user} [{model}]: {prompt}', ctx))
      .toBe('2026-06-23 dev@x.io [claude-opus-4-8]: add leaderboard');
  });

  it('leaves unknown tokens literal', () => {
    expect(renderCommitMessage('blox({user}): {prmpt}', ctx))
      .toBe('blox(dev@x.io): {prmpt}');
  });
});
