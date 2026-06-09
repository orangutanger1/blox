import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { buildDigest, classifyKind } from '../src/context/digest.js';

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

describe('classifyKind', () => {
  it('maps .server.luau/.lua to a server Script', () => {
    expect(classifyKind('src/ServerScriptService/Hello.server.luau')).toBe('Script (server)');
    expect(classifyKind('a/B.server.lua')).toBe('Script (server)');
  });

  it('maps .client.luau/.lua to a LocalScript', () => {
    expect(classifyKind('src/StarterPlayer/Controls.client.luau')).toBe('LocalScript (client)');
    expect(classifyKind('a/B.client.lua')).toBe('LocalScript (client)');
  });

  it('maps a plain .luau/.lua to a ModuleScript', () => {
    expect(classifyKind('src/ReplicatedStorage/Greeter.luau')).toBe('ModuleScript');
    expect(classifyKind('a/B.lua')).toBe('ModuleScript');
  });

  it('is case-insensitive on the extension', () => {
    expect(classifyKind('A.SERVER.LUAU')).toBe('Script (server)');
  });
});
