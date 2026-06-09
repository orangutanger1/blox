import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import {
  buildDigest, classifyKind, collectServicePaths, groupScripts, MAX_PER_GROUP,
} from '../src/context/digest.js';

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
    // groups: the fixture has Greeter (module) under ReplicatedStorage and
    // Hello (server script) under ServerScriptService.
    const services = d.groups.map((g) => g.service);
    expect(services).toContain('ReplicatedStorage');
    expect(services).toContain('ServerScriptService');
    const rep = d.groups.find((g) => g.service === 'ReplicatedStorage');
    expect(rep?.scripts).toEqual([
      { path: 'src/ReplicatedStorage/Greeter.luau', kind: 'ModuleScript' },
    ]);
    const ss = d.groups.find((g) => g.service === 'ServerScriptService');
    expect(ss?.scripts[0].kind).toBe('Script (server)');
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

describe('collectServicePaths', () => {
  it('collects a top-level service directory $path', () => {
    const tree = {
      $className: 'DataModel',
      ReplicatedStorage: { $className: 'ReplicatedStorage', $path: 'src/shared' },
    };
    expect(collectServicePaths(tree)).toEqual([
      { service: 'ReplicatedStorage', prefix: 'src/shared' },
    ]);
  });

  it('collects nested child $path tagged with its top-level service (fixture shape)', () => {
    const tree = {
      $className: 'DataModel',
      ReplicatedStorage: {
        $className: 'ReplicatedStorage',
        Greeter: { $path: 'src/ReplicatedStorage/Greeter.luau' },
      },
      ServerScriptService: {
        $className: 'ServerScriptService',
        Hello: { $path: 'src/ServerScriptService/Hello.server.luau' },
      },
    };
    expect(collectServicePaths(tree)).toEqual([
      { service: 'ReplicatedStorage', prefix: 'src/ReplicatedStorage/Greeter.luau' },
      { service: 'ServerScriptService', prefix: 'src/ServerScriptService/Hello.server.luau' },
    ]);
  });

  it('normalizes backslashes and trailing slashes', () => {
    const tree = { $className: 'DataModel', Foo: { $path: 'src\\\\foo\\\\' } };
    expect(collectServicePaths(tree)).toEqual([{ service: 'Foo', prefix: 'src/foo' }]);
  });

  it('ignores $-keys as service names', () => {
    const tree = { $className: 'DataModel', $ignoreUnknownInstances: true };
    expect(collectServicePaths(tree)).toEqual([]);
  });
});

describe('groupScripts', () => {
  const mappings = [
    { service: 'ReplicatedStorage', prefix: 'src/ReplicatedStorage' },
    { service: 'ServerScriptService', prefix: 'src/ServerScriptService' },
  ];
  const order = ['ReplicatedStorage', 'ServerScriptService'];

  it('groups scripts by longest matching prefix and tags kind', () => {
    const groups = groupScripts(
      ['src/ServerScriptService/Hello.server.luau', 'src/ReplicatedStorage/Greeter.luau'],
      mappings,
      order,
    );
    expect(groups).toEqual([
      {
        service: 'ReplicatedStorage',
        total: 1,
        scripts: [{ path: 'src/ReplicatedStorage/Greeter.luau', kind: 'ModuleScript' }],
      },
      {
        service: 'ServerScriptService',
        total: 1,
        scripts: [{ path: 'src/ServerScriptService/Hello.server.luau', kind: 'Script (server)' }],
      },
    ]);
  });

  it('puts unmatched scripts in the (root) group, ordered last', () => {
    const groups = groupScripts(['loose/Thing.luau', 'src/ReplicatedStorage/A.luau'], mappings, order);
    expect(groups.map((g) => g.service)).toEqual(['ReplicatedStorage', '(root)']);
  });

  it('prefers the longest (most specific) matching prefix', () => {
    const m = [
      { service: 'Shared', prefix: 'src' },
      { service: 'Net', prefix: 'src/net' },
    ];
    const groups = groupScripts(['src/net/Remote.luau'], m, ['Shared', 'Net']);
    expect(groups[0]).toMatchObject({ service: 'Net', total: 1 });
  });

  it('bounds a group at MAX_PER_GROUP and reports the true total', () => {
    const many = Array.from({ length: MAX_PER_GROUP + 5 }, (_, i) =>
      `src/ReplicatedStorage/M${String(i).padStart(2, '0')}.luau`);
    const groups = groupScripts(many, mappings, order);
    expect(groups[0].total).toBe(MAX_PER_GROUP + 5);
    expect(groups[0].scripts).toHaveLength(MAX_PER_GROUP);
  });
});
