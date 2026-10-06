import { describe, it, expect } from 'vitest';
import { checkedCliArgs, parseFlags } from '../src/cliTools.js';

describe('CLI flags', () => {
  it('names a flag the command never reads instead of ignoring it', () => {
    const r = checkedCliArgs('playtest', parseFlags(['--server-code', 'return 1', '--seconds', '2']));
    expect(r.unknown).toEqual(['--server-code']);
    expect(r.mapped?.args).toEqual({ seconds: 2 });
  });
  it('accepts the flags a command reads', () => {
    expect(checkedCliArgs('playtest', parseFlags(['--server', 'return 1', '--client', 'return 2'])).unknown).toEqual([]);
    expect(checkedCliArgs('test', parseFlags(['dog_', '--context', 'server'])).unknown).toEqual([]);
  });
});
