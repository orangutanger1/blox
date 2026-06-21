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

describe('init subcommand', () => {
  it('parses a leading init token into command', () => {
    const a = parseArgs(['init']);
    expect(a.command).toBe('init');
    expect(a.onConflict).toBeNull();
    expect(a.force).toBe(false);
  });

  it('parses --on-conflict and --force with init', () => {
    const a = parseArgs(['init', '--project', '/game', '--on-conflict', 'suffix', '--force']);
    expect(a.command).toBe('init');
    expect(a.projectPath).toBe('/game');
    expect(a.onConflict).toBe('suffix');
    expect(a.force).toBe(true);
  });

  it('rejects an invalid --on-conflict value', () => {
    expect(() => parseArgs(['init', '--on-conflict', 'nope'])).toThrow(/on-conflict/);
  });
});

describe('panel command', () => {
  it('parses "panel install"', () => {
    const a = parseArgs(['panel', 'install']);
    expect(a.command).toBe('panel');
    expect(a.prompt).toBe('install');
  });
});

describe('image flags', () => {
  it('parses --image with a path', () => {
    const a = parseArgs(['--image', 'ref.png', 'build', 'this']);
    expect(a.imagePath).toBe('ref.png');
    expect(a.imageFromDock).toBe(false);
    expect(a.prompt).toBe('build this');
  });

  it('parses --image-from-dock and --verify', () => {
    const a = parseArgs(['--image-from-dock', '--verify', 'build it']);
    expect(a.imageFromDock).toBe(true);
    expect(a.verify).toBe(true);
    expect(a.imagePath).toBeNull();
  });

  it('defaults image flags off', () => {
    const a = parseArgs(['hi']);
    expect(a.imagePath).toBeNull();
    expect(a.imageFromDock).toBe(false);
    expect(a.verify).toBe(false);
  });

  it('rejects --image together with --image-from-dock', () => {
    expect(() => parseArgs(['--image', 'r.png', '--image-from-dock', 'x'])).toThrow(
      /--image and --image-from-dock are mutually exclusive/,
    );
  });

  it('rejects --image with no path', () => {
    expect(() => parseArgs(['--image'])).toThrow(/--image needs a file path/);
  });

  it('parses the auth command and its subcommand words', () => {
    const a = parseArgs(['auth', 'key', 'set']);
    expect(a.command).toBe('auth');
    expect(a.prompt).toBe('key set');
  });

  it('maps --auth key to apiKey and --auth subscription', () => {
    expect(parseArgs(['--auth', 'key', 'do it']).authMode).toBe('apiKey');
    expect(parseArgs(['--auth', 'subscription', 'do it']).authMode).toBe('subscription');
  });

  it('rejects a bad --auth value', () => {
    expect(() => parseArgs(['--auth', 'nope'])).toThrow(/--auth/);
  });
});
