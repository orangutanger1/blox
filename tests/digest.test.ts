import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { buildDigest } from '../src/context/digest.js';

const game = resolve(__dirname, '../test-fixtures/game');

describe('buildDigest', () => {
  it('summarizes the fixture game', () => {
    const d = buildDigest(game);
    expect(d.name).toBe('blox-fixture');
    expect(d.tree).toEqual(expect.arrayContaining(['ReplicatedStorage', 'ServerScriptService']));
    expect(d.tree).not.toContain('$className');
    expect(d.scripts).toEqual(
      expect.arrayContaining([
        'src/ReplicatedStorage/Greeter.luau',
        'src/ServerScriptService/Hello.server.luau',
      ]),
    );
  });

  it('throws when there is no project file', () => {
    expect(() => buildDigest('/nonexistent')).toThrow(/default\.project\.json/);
  });
});
