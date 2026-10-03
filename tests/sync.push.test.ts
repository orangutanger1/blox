import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planFromSourcemap, diffPlan, sourceSum, jsonToLuau, planWorldBuilders, pushProject, type SourcemapNode } from '../src/sync/push.js';
import type { StudioSession } from '../src/studio/session.js';

const files: Record<string, string> = {
  'src/S/Main.server.luau': 'print(1)',
  'src/R/Util.luau': 'return {}',
  'src/R/Cfg.json': '{"a":[1,2],"b":{"c":true}}',
  'src/R/Note.txt': 'hello',
};
const read = (p: string) => {
  const k = Object.keys(files).find((f) => p.endsWith(f));
  if (!k) throw new Error('missing ' + p);
  return files[k];
};
const sm: SourcemapNode = {
  name: 'g', className: 'DataModel', filePaths: ['default.project.json'], children: [
    { name: 'ServerScriptService', className: 'ServerScriptService', children: [
      { name: 'Main', className: 'Script', filePaths: ['src/S/Main.server.luau'] },
    ] },
    { name: 'ReplicatedStorage', className: 'ReplicatedStorage', children: [
      { name: 'Shared', className: 'Folder', children: [
        { name: 'Util', className: 'ModuleScript', filePaths: ['src/R/Util.luau'] },
        { name: 'Cfg', className: 'ModuleScript', filePaths: ['src/R/Cfg.json'] },
        { name: 'Note', className: 'StringValue', filePaths: ['src/R/Note.txt'] },
        { name: 'Map', className: 'Model', filePaths: ['src/R/Map.rbxm'] },
      ] },
    ] },
    { name: 'StarterPlayer', className: 'StarterPlayer', children: [
      { name: 'StarterPlayerScripts', className: 'StarterPlayerScripts', filePaths: ['default.project.json'] },
    ] },
  ],
};

describe('planFromSourcemap', () => {
  const plan = planFromSourcemap(sm, '/p', read);
  const byKey = Object.fromEntries(plan.instances.map((i) => [i.key, i]));
  it('maps scripts with source and services as roots', () => {
    expect(byKey['ServerScriptService/Main']).toMatchObject({ className: 'Script', source: 'print(1)' });
    expect(byKey['ServerScriptService']).toBeUndefined();
  });
  it('converts JSON modules and .txt StringValues', () => {
    expect(byKey['ReplicatedStorage/Shared/Cfg'].source).toContain('["b"] = {');
    expect(byKey['ReplicatedStorage/Shared/Note']).toMatchObject({ className: 'StringValue', value: 'hello' });
  });
  it('marks project-declared engine containers as anchors (never managed)', () => {
    expect(byKey['StarterPlayer/StarterPlayerScripts'].anchor).toBe(true);
    expect(byKey['ReplicatedStorage/Shared'].anchor).toBeUndefined();
  });
  it('skips binary/model files with a reason', () => {
    expect(plan.skipped.map((s) => s.file)).toContain('src/R/Map.rbxm');
  });
});

describe('diffPlan', () => {
  const plan = planFromSourcemap(sm, '/p', read);
  const main = plan.instances.find((i) => i.key === 'ServerScriptService/Main')!;
  it('upserts changed/missing, deletes stale managed keys, always re-ensures anchors', () => {
    const inv = { 'ServerScriptService/Main': { hash: main.hash, cls: 'Script' }, 'ServerScriptService/Old': { hash: 'h', cls: 'Script' } };
    const d = diffPlan(plan, inv);
    const keys = d.upserts.map((u) => u.key);
    expect(keys).not.toContain('ServerScriptService/Main');
    expect(keys).toContain('ReplicatedStorage/Shared/Util');
    expect(keys).toContain('StarterPlayer/StarterPlayerScripts');
    expect(d.deletes).toEqual(['ServerScriptService/Old']);
    // parents before children
    expect(keys.indexOf('ReplicatedStorage/Shared')).toBeLessThan(keys.indexOf('ReplicatedStorage/Shared/Util'));
  });
  it('refuses to overwrite or delete scripts edited in Studio since the last sync', () => {
    const inv = {
      'ServerScriptService/Main': { hash: 'stale', cls: 'Script', edited: true },
      'ServerScriptService/Old': { hash: 'h', cls: 'Script', edited: true },
      'ServerScriptService/Gone': { hash: 'h', cls: 'Script' },
    };
    const d = diffPlan(plan, inv);
    expect(d.upserts.map((u) => u.key)).not.toContain('ServerScriptService/Main');
    expect(d.deletes).toEqual(['ServerScriptService/Gone']);
    expect(d.conflicts).toEqual([
      { key: 'ServerScriptService/Main', file: main.file, op: 'overwrite' },
      { key: 'ServerScriptService/Old', op: 'delete' },
    ]);
    const forced = diffPlan(plan, inv, true);
    expect(forced.conflicts).toEqual([]);
    expect(forced.upserts.map((u) => u.key)).toContain('ServerScriptService/Main');
    expect(forced.deletes).toContain('ServerScriptService/Old');
  });
  it('reports Studio-only edits when the file is unchanged', () => {
    const inv = Object.fromEntries(plan.instances.map((i) => [i.key, { hash: i.hash, cls: i.className }])) as Record<string, { hash: string; cls: string; edited?: boolean }>;
    inv['ServerScriptService/Main'].edited = true;
    const d = diffPlan(plan, inv);
    expect(d.conflicts).toEqual([]);
    expect(d.studioEdits).toEqual([{ key: 'ServerScriptService/Main', file: main.file }]);
  });
  it('stamps legacy scripts that match their file, flags ones that do not', () => {
    const util = plan.instances.find((i) => i.key === 'ReplicatedStorage/Shared/Util')!;
    const inv = {
      'ServerScriptService/Main': { hash: main.hash, cls: 'Script', sum: sourceSum(main.source!) },
      'ReplicatedStorage/Shared/Util': { hash: util.hash, cls: util.className, sum: 'deadbeef' },
    };
    const d = diffPlan(plan, inv);
    expect(d.stamps).toEqual(['ServerScriptService/Main']);
    expect(d.studioEdits.map((e) => e.key)).toEqual(['ReplicatedStorage/Shared/Util']);
  });
  it('force re-pushes everything', () => {
    const inv = Object.fromEntries(plan.instances.map((i) => [i.key, { hash: i.hash, cls: i.className }]));
    expect(diffPlan(plan, inv).upserts.filter((u) => !u.anchor)).toHaveLength(0);
    expect(diffPlan(plan, inv, true).upserts.length).toBe(plan.instances.length);
  });
});

describe('jsonToLuau', () => {
  it('emits a Luau literal', () => {
    expect(jsonToLuau({ a: [1, 'x'], b: null })).toBe('{\n\t["a"] = {\n\t\t1,\n\t\t"x"\n\t},\n\t["b"] = nil\n}');
  });
});

describe('planWorldBuilders', () => {
  it('reads world/*.luau with optional @parent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-world-'));
    mkdirSync(join(dir, 'world'));
    writeFileSync(join(dir, 'world', 'Arena.luau'), 'return function(m) end');
    writeFileSync(join(dir, 'world', 'Loot.luau'), '-- @parent ServerStorage\nreturn function(m) end');
    const b = planWorldBuilders(dir);
    expect(b.map((x) => [x.key, x.parent])).toEqual([['world:Arena', 'Workspace'], ['world:Loot', 'ServerStorage']]);
  });
  it('returns [] without a world dir', () => {
    expect(planWorldBuilders(mkdtempSync(join(tmpdir(), 'blox-noworld-')))).toEqual([]);
  });
});

describe('pushProject script creation (Studio capability sandbox)', () => {
  // Since the Sep 2026 Studio build the execute_luau thread cannot parent a
  // script it created; sync must create scripts with multi_edit, then adopt them.
  it('creates missing scripts via multi_edit, re-applies them, then runs builders/deletes last', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-push-'));
    for (const [p, c] of Object.entries(files)) {
      mkdirSync(join(dir, p, '..'), { recursive: true });
      writeFileSync(join(dir, p), c);
    }
    const spawn = async () => ({ code: 0, stdout: JSON.stringify(sm), stderr: '' });
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    let applies = 0;
    const session = {
      call: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        if (name === 'multi_edit') return { content: [{ type: 'text', text: 'Created' }] };
        const code = String(args.code);
        if (!code.includes('PAYLOAD')) return { content: [{ type: 'text', text: '{"ReplicatedStorage/Shared/Gone":{"hash":"x","cls":"ModuleScript"}}' }] };
        applies++;
        const payload = JSON.parse(/local PAYLOAD = \[(=*)\[([\s\S]*?)\]\1\]/.exec(code)![2]);
        if (applies === 1) {
          expect(payload.builders).toEqual([]);
          expect(payload.deletes).toEqual([]);
          return { content: [{ type: 'text', text: JSON.stringify({ created: ['ReplicatedStorage/Shared'], updated: [], deleted: [], builders: [], errors: [], needCreate: [
            { key: 'ServerScriptService/Main', path: ['ServerScriptService', 'Main'], className: 'Script' },
            { key: 'ReplicatedStorage/Shared/Util', path: ['ReplicatedStorage', 'Shared', 'Util'], className: 'ModuleScript' },
          ] }) }] };
        }
        if (applies === 2) {
          expect(payload.upserts.map((u: { key: string }) => u.key).sort()).toEqual(['ReplicatedStorage/Shared/Util', 'ServerScriptService/Main']);
          expect(payload.upserts.every((u: { fresh?: boolean }) => u.fresh)).toBe(true);
          return { content: [{ type: 'text', text: JSON.stringify({ created: ['ServerScriptService/Main', 'ReplicatedStorage/Shared/Util'], updated: [], deleted: [], builders: [], errors: [] }) }] };
        }
        expect(payload.upserts).toEqual([]);
        expect(payload.deletes).toEqual(['ReplicatedStorage/Shared/Gone']);
        return { content: [{ type: 'text', text: JSON.stringify({ created: [], updated: [], deleted: ['ReplicatedStorage/Shared/Gone'], builders: [], errors: [] }) }] };
      },
    } as unknown as StudioSession;
    const r = await pushProject(session, dir, { spawn });
    const edits = calls.filter((c) => c.name === 'multi_edit').map((c) => c.args);
    expect(edits.map((e) => [e.file_path, e.className, e.datamodel_type])).toEqual([
      ['game.ServerScriptService.Main', 'Script', 'Edit'],
      ['game.ReplicatedStorage.Shared.Util', 'ModuleScript', 'Edit'],
    ]);
    expect((edits[0].edits as { old_string: string }[])[0].old_string).toBe('');
    expect(applies).toBe(3);
    expect(r.created).toEqual(['ReplicatedStorage/Shared', 'ServerScriptService/Main', 'ReplicatedStorage/Shared/Util']);
    expect(r.deleted).toEqual(['ReplicatedStorage/Shared/Gone']);
    expect(r.ok).toBe(true);
  });

  it('reports a multi_edit failure as a sync error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-push-'));
    for (const [p, c] of Object.entries(files)) {
      mkdirSync(join(dir, p, '..'), { recursive: true });
      writeFileSync(join(dir, p), c);
    }
    const spawn = async () => ({ code: 0, stdout: JSON.stringify(sm), stderr: '' });
    let applies = 0;
    const session = {
      call: async (name: string, args: Record<string, unknown>) => {
        if (name === 'multi_edit') return { isError: true, content: [{ type: 'text', text: 'boom' }] };
        if (!String(args.code).includes('PAYLOAD')) return { content: [{ type: 'text', text: '{}' }] };
        applies++;
        return { content: [{ type: 'text', text: JSON.stringify({ created: [], updated: [], deleted: [], builders: [], errors: [], needCreate: applies === 1 ? [{ key: 'ServerScriptService/Main', path: ['ServerScriptService', 'Main'], className: 'Script' }] : [] }) }] };
      },
    } as unknown as StudioSession;
    const r = await pushProject(session, dir, { spawn });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/ServerScriptService\/Main: multi_edit failed: boom/);
  });
});

describe('pushProject deferral (module scripts with children)', () => {
  const files = {
    'default.project.json': '{}',
    'src/ReplicatedStorage/Packet/init.luau': 'return {}',
    'src/ReplicatedStorage/Packet/Task.luau': 'return {}',
  };
  const sm = {
    name: 'game', className: 'DataModel', children: [
      { name: 'ReplicatedStorage', className: 'ReplicatedStorage', children: [
        { name: 'Packet', className: 'ModuleScript', filePaths: ['src/ReplicatedStorage/Packet/init.luau'], children: [
          { name: 'Task', className: 'ModuleScript', filePaths: ['src/ReplicatedStorage/Packet/Task.luau'] },
        ] },
      ] },
    ],
  };
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'blox-push-'));
    for (const [p, c] of Object.entries(files)) {
      mkdirSync(join(dir, p, '..'), { recursive: true });
      writeFileSync(join(dir, p), c);
    }
    return { dir, spawn: async () => ({ code: 0, stdout: JSON.stringify(sm), stderr: '' }) };
  }
  const ok = (o: object) => ({ content: [{ type: 'text', text: JSON.stringify({ created: [], updated: [], deleted: [], builders: [], errors: [], ...o }) }] });

  it('creates the parent script, then re-applies it with its deferred children, then creates those', async () => {
    const { dir, spawn } = setup();
    const edits: string[] = [];
    const rounds: string[][] = [];
    const session = {
      call: async (name: string, args: Record<string, unknown>) => {
        if (name === 'multi_edit') {
          edits.push(String(args.file_path));
          return { content: [{ type: 'text', text: 'Created' }] };
        }
        const code = String(args.code);
        if (!code.includes('PAYLOAD')) return { content: [{ type: 'text', text: '{}' }] };
        const payload = JSON.parse(/local PAYLOAD = \[(=*)\[([\s\S]*?)\]\1\]/.exec(code)![2]);
        const keys = payload.upserts.map((u: { key: string }) => u.key);
        if (!keys.length) return ok({});
        rounds.push(keys);
        if (rounds.length === 1) return ok({ needCreate: [{ key: 'ReplicatedStorage/Packet', path: ['ReplicatedStorage', 'Packet'], className: 'ModuleScript' }], deferred: ['ReplicatedStorage/Packet/Task'] });
        if (rounds.length === 2) return ok({ created: ['ReplicatedStorage/Packet'], needCreate: [{ key: 'ReplicatedStorage/Packet/Task', path: ['ReplicatedStorage', 'Packet', 'Task'], className: 'ModuleScript' }] });
        return ok({ created: keys });
      },
    } as unknown as StudioSession;
    const r = await pushProject(session, dir, { spawn });
    expect(edits).toEqual(['game.ReplicatedStorage.Packet', 'game.ReplicatedStorage.Packet.Task']);
    expect(rounds).toEqual([
      ['ReplicatedStorage/Packet', 'ReplicatedStorage/Packet/Task'],
      ['ReplicatedStorage/Packet', 'ReplicatedStorage/Packet/Task'],
      ['ReplicatedStorage/Packet/Task'],
    ]);
    expect(r.ok).toBe(true);
  });

  it('children of a parent that could not be created are reported, not looped on', async () => {
    const { dir, spawn } = setup();
    let applies = 0;
    const session = {
      call: async (name: string, args: Record<string, unknown>) => {
        if (name === 'multi_edit') return { isError: true, content: [{ type: 'text', text: 'boom' }] };
        if (!String(args.code).includes('PAYLOAD')) return { content: [{ type: 'text', text: '{}' }] };
        applies++;
        return ok({ needCreate: applies === 1 ? [{ key: 'ReplicatedStorage/Packet', path: ['ReplicatedStorage', 'Packet'], className: 'ModuleScript' }] : [], deferred: applies === 1 ? ['ReplicatedStorage/Packet/Task'] : [] });
      },
    } as unknown as StudioSession;
    const r = await pushProject(session, dir, { spawn });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/Packet\/Task: not synced, its parent script could not be created/);
    expect(applies).toBeLessThanOrEqual(2);
  });

  it('stops when multi_edit succeeds but the re-apply still asks for the same script', async () => {
    const { dir, spawn } = setup();
    let applies = 0;
    let edits = 0;
    const session = {
      call: async (name: string, args: Record<string, unknown>) => {
        if (name === 'multi_edit') { edits++; return { content: [{ type: 'text', text: 'Edited' }] }; }
        if (!String(args.code).includes('PAYLOAD')) return { content: [{ type: 'text', text: '{}' }] };
        applies++;
        if (applies > 10) throw new Error('sync looped');
        return ok({ needCreate: [{ key: 'ReplicatedStorage/Packet', path: ['ReplicatedStorage', 'Packet'], className: 'ModuleScript' }] });
      },
    } as unknown as StudioSession;
    const r = await pushProject(session, dir, { spawn });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/Packet: multi_edit did not produce a ModuleScript/);
    expect(edits).toBe(1);
  });
});
