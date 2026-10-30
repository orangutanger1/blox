import { describe, it, expect } from 'vitest';
import { projectProperties } from '../src/sync/push.js';

describe('projectProperties', () => {
  it('collects scalar $properties by DataModel path', () => {
    const project = {
      name: 'P',
      tree: {
        $className: 'DataModel',
        Players: { $properties: { CharacterAutoLoads: false, RespawnTime: 3 } },
        Workspace: { $properties: { Gravity: { Float32: 150 } }, Map: { $className: 'Folder', $properties: { Name: 'Map' } } },
      },
    };
    const r = projectProperties(project);
    expect(r.props).toEqual([
      { path: ['Players'], name: 'CharacterAutoLoads', value: false },
      { path: ['Players'], name: 'RespawnTime', value: 3 },
      { path: ['Workspace'], name: 'Gravity', value: 150 },
      { path: ['Workspace', 'Map'], name: 'Name', value: 'Map' },
    ]);
    expect(r.skipped).toEqual([]);
  });

  it('reports non-scalar values instead of dropping them silently', () => {
    const r = projectProperties({ tree: { Lighting: { $properties: { Ambient: [0.1, 0.2, 0.3], Technology: { Enum: 'Future' } } } } });
    expect(r.props).toEqual([]);
    expect(r.skipped.map((s) => s.file)).toEqual(['default.project.json:Lighting.Ambient', 'default.project.json:Lighting.Technology']);
    expect(r.skipped[0].reason).toMatch(/not applied by blox sync/);
  });

  it('ignores a project without a tree', () => {
    expect(projectProperties({})).toEqual({ props: [], skipped: [] });
  });
});
