import { describe, it, expect } from 'vitest';
import { planLayout, classToSuffix, sanitizeName } from '../src/onboard/layout.js';
import type { PulledScript } from '../src/onboard/pull.js';

const s = (fullName: string, className: PulledScript['className'], source = 'x'): PulledScript => ({ fullName, className, source });

describe('classToSuffix', () => {
  it('maps each script class to its Rojo suffix', () => {
    expect(classToSuffix('Script')).toBe('.server.luau');
    expect(classToSuffix('LocalScript')).toBe('.client.luau');
    expect(classToSuffix('ModuleScript')).toBe('.luau');
  });
});

describe('sanitizeName', () => {
  it('replaces filesystem-illegal characters with underscore', () => {
    expect(sanitizeName('a/b:c*?')).toBe('a_b_c__');
  });
});

describe('planLayout — paths', () => {
  it('maps top-level scripts under src/<service> with the class suffix', () => {
    const plan = planLayout([s('ServerScriptService.Hello', 'Script')], 'abort', 'g');
    expect(plan.files).toEqual([{ path: 'src/ServerScriptService/Hello.server.luau', source: 'x' }]);
    expect(plan.conflicts).toEqual([]);
  });

  it('drops scripts under unsyncable services (PluginDebugService)', () => {
    const plan = planLayout(
      [s('PluginDebugService.DebugScript', 'Script'), s('StarterGui.ShopUI', 'LocalScript')],
      'abort',
      'g',
    );
    expect(plan.files).toEqual([{ path: 'src/StarterGui/ShopUI.client.luau', source: 'x' }]);
    expect(plan.project.tree).toEqual({
      $className: 'DataModel',
      StarterGui: { $path: 'src/StarterGui' },
    });
    expect(plan.project.tree).not.toHaveProperty('PluginDebugService');
  });

  it('nests ancestor instances as directories', () => {
    const plan = planLayout([s('ReplicatedStorage.Systems.Combat', 'ModuleScript')], 'abort', 'g');
    expect(plan.files[0].path).toBe('src/ReplicatedStorage/Systems/Combat.luau');
  });

  it('uses the Rojo init convention for a script that contains a script', () => {
    const plan = planLayout(
      [s('ServerScriptService.Manager', 'Script'), s('ServerScriptService.Manager.Helper', 'ModuleScript')],
      'abort', 'g',
    );
    const paths = plan.files.map((f) => f.path).sort();
    expect(paths).toEqual([
      'src/ServerScriptService/Manager/Helper.luau',
      'src/ServerScriptService/Manager/init.server.luau',
    ]);
  });

  it('sanitizes illegal characters in instance names', () => {
    const plan = planLayout([s('ReplicatedStorage.a/b', 'ModuleScript')], 'abort', 'g');
    expect(plan.files[0].path).toBe('src/ReplicatedStorage/a_b.luau');
  });
});

describe('planLayout — conflicts', () => {
  const dupes = [s('ReplicatedStorage.Dup', 'ModuleScript', 'A'), s('ReplicatedStorage.Dup', 'ModuleScript', 'B')];

  it('abort: collects conflicts and emits no files', () => {
    const plan = planLayout(dupes, 'abort', 'g');
    expect(plan.files).toEqual([]);
    expect(plan.conflicts).toHaveLength(2);
    expect(plan.conflicts[0].path).toBe('src/ReplicatedStorage/Dup.luau');
  });

  it('suffix: disambiguates colliding files and records the renames', () => {
    const plan = planLayout(dupes, 'suffix', 'g');
    const paths = plan.files.map((f) => f.path).sort();
    expect(paths).toEqual(['src/ReplicatedStorage/Dup.luau', 'src/ReplicatedStorage/Dup_2.luau']);
    expect(plan.conflicts).toEqual([]);
    expect(plan.renamed).toHaveLength(1);
  });

  it('suffix: a generated _N never overwrites a real _N-named sibling', () => {
    // Dup×2 plus a genuine "Dup_2": every script must keep a unique path — no
    // silent overwrite/loss. Bumps the generated suffix past the real collision.
    const plan = planLayout(
      [s('ReplicatedStorage.Dup', 'ModuleScript', 'A'), s('ReplicatedStorage.Dup', 'ModuleScript', 'B'), s('ReplicatedStorage.Dup_2', 'ModuleScript', 'C')],
      'suffix', 'g',
    );
    const paths = plan.files.map((f) => f.path);
    expect(new Set(paths).size).toBe(3); // all distinct — nothing lost
    expect(paths).toContain('src/ReplicatedStorage/Dup.luau');
    expect(paths).toContain('src/ReplicatedStorage/Dup_2.luau');
    expect(paths).toContain('src/ReplicatedStorage/Dup_2_2.luau');
    // sources preserved 1:1 with the three inputs
    expect(plan.files.map((f) => f.source).sort()).toEqual(['A', 'B', 'C']);
  });
});

describe('planLayout — project.json', () => {
  it('emits one tree entry per script-bearing service plus the DataModel root', () => {
    const plan = planLayout(
      [s('ServerScriptService.Hello', 'Script'), s('ReplicatedStorage.Mod', 'ModuleScript')],
      'abort', 'mygame',
    );
    expect(plan.project).toEqual({
      name: 'mygame',
      tree: {
        $className: 'DataModel',
        ReplicatedStorage: { $path: 'src/ReplicatedStorage' },
        ServerScriptService: { $path: 'src/ServerScriptService' },
      },
    });
  });
});
