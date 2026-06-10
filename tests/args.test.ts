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

describe('doctor subcommand', () => {
  it('parses a leading doctor token into command', () => {
    const a = parseArgs(['doctor']);
    expect(a.command).toBe('doctor');
    expect(a.prompt).toBeNull();
  });

  it('leaves command null for a normal prompt', () => {
    const a = parseArgs(['Add a comment']);
    expect(a.command).toBeNull();
    expect(a.prompt).toBe('Add a comment');
  });
});

describe('serve subcommand', () => {
  it('parses a leading serve token into command', () => {
    const a = parseArgs(['serve']);
    expect(a.command).toBe('serve');
    expect(a.prompt).toBeNull();
  });

  it('honors --project with serve', () => {
    const a = parseArgs(['serve', '--project', '/game']);
    expect(a.command).toBe('serve');
    expect(a.projectPath).toBe('/game');
  });
});

describe('autonomy flags', () => {
  it('parses numeric + effort + mode flags', () => {
    const a = parseArgs(['--max-turns', '12', '--budget', '2.5', '--effort', 'xhigh', '--ask', 'do', 'x']);
    expect(a.maxTurns).toBe(12);
    expect(a.maxBudgetUsd).toBe(2.5);
    expect(a.effort).toBe('xhigh');
    expect(a.mode).toBe('ask');
    expect(a.prompt).toBe('do x');
  });

  it('defaults the new flags to null', () => {
    const a = parseArgs(['hi']);
    expect(a.maxTurns).toBeNull();
    expect(a.maxBudgetUsd).toBeNull();
    expect(a.effort).toBeNull();
    expect(a.mode).toBeNull();
  });

  it('parses --auto', () => {
    expect(parseArgs(['--auto', 'hi']).mode).toBe('auto');
  });

  it('rejects invalid values', () => {
    expect(() => parseArgs(['--max-turns', '0'])).toThrow(/positive integer/);
    expect(() => parseArgs(['--max-turns', 'abc'])).toThrow(/positive integer/);
    expect(() => parseArgs(['--budget', '-1'])).toThrow(/positive number/);
    expect(() => parseArgs(['--effort', 'medium'])).toThrow(/high or xhigh/);
  });
});
