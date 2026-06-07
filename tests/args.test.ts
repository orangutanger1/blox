import { describe, it, expect } from 'vitest';
import { parseArgs } from '../src/args.js';

describe('parseArgs', () => {
  it('joins positional words into the prompt', () => {
    const a = parseArgs(['add', 'a', 'comment']);
    expect(a.prompt).toBe('add a comment');
    expect(a.mock).toBe(false);
    expect(a.projectPath).toBeNull();
  });

  it('parses --mock and --project', () => {
    const a = parseArgs(['--mock', '--project', '/game', 'do', 'thing']);
    expect(a.mock).toBe(true);
    expect(a.projectPath).toBe('/game');
    expect(a.prompt).toBe('do thing');
  });

  it('returns null prompt when none given', () => {
    expect(parseArgs(['--mock']).prompt).toBeNull();
  });
});
