import { describe, it, expect } from 'vitest';
import { adaptVerdict, findingsOf, mergeResults, scoutFile, scoutQueries, statsOf, type SearchHit } from '../src/assets/scout.js';

const hit = (assetId: string, name: string, extra: Partial<SearchHit> = {}): SearchHit => ({
  assetId, name, description: '', creatorName: 'c', assetType: 'Model', isFree: true, priceCents: 0,
  creatorStoreUrl: `https://create.roblox.com/store/asset/${assetId}`, ...extra,
});

describe('scoutQueries', () => {
  it('builds kind-specific variants', () => {
    expect(scoutQueries('obby', 'map').map((q) => q.query)).toEqual(['obby map template', 'obby map', 'obby kit']);
    expect(scoutQueries('shop', 'ui').map((q) => q.query)).toEqual(['shop ui', 'shop gui pack', 'shop ui template']);
    expect(scoutQueries('coin', 'audio')).toEqual([{ query: 'coin', assetType: 'Audio' }]);
    expect(scoutQueries('coin', 'image')).toEqual([{ query: 'coin', assetType: 'Image' }, { query: 'coin icon', assetType: 'Image' }]);
    expect(scoutQueries('  tree ', 'model').map((q) => q.query)).toEqual(['tree', 'tree pack']);
  });
});

describe('mergeResults', () => {
  it('drops paid, dedupes, ranks by query hits then name words then kind words', () => {
    const r = mergeResults(
      [
        [hit('1', 'Random thing'), hit('2', 'Obby Map Template'), hit('9', 'Paid obby', { isFree: false, priceCents: 500 })],
        [hit('2', 'Obby Map Template'), hit('3', 'Obby course')],
        [hit('4', 'Lava kit')],
      ],
      'obby',
      'map',
    );
    expect(r.map((x) => x.assetId)).toEqual(['2', '3', '4', '1']);
    expect(r[0]).toMatchObject({ hits: 2, score: 2 * 2 + 1 + 1 });
    expect(r.find((x) => x.assetId === '9')).toBeUndefined();
  });
  it('counts a need word once however often the name repeats it', () => {
    const r = mergeResults([[hit('1', 'Obby obby OBBY Obby'), hit('2', 'Obby Map Template')]], 'obby', 'map');
    expect(r.map((x) => x.assetId)).toEqual(['2', '1']);
  });
  it('treats a free flag with a price as paid', () => {
    expect(mergeResults([[hit('5', 'x', { priceCents: 100 })]], 'x', 'model')).toEqual([]);
  });
});

describe('adaptVerdict', () => {
  const base = { parts: 200, meshParts: 0, guis: 0, screenGuis: 0, sounds: 0, scripts: 0, size: [120, 20, 120] as [number, number, number] };
  it('adapt for a clean map', () => {
    expect(adaptVerdict('map', base, []).verdict).toBe('adapt');
  });
  it('build when empty, or a ui with no GUI', () => {
    expect(adaptVerdict('map', { ...base, parts: 0 }, []).verdict).toBe('build');
    expect(adaptVerdict('ui', base, []).verdict).toBe('build');
    expect(adaptVerdict('ui', { ...base, parts: 0, guis: 12, screenGuis: 1 }, []).verdict).toBe('adapt');
  });
  it('adapt-with-care for risks, scripts, heavy, or tiny maps', () => {
    expect(adaptVerdict('map', base, ['Workspace.X.S: loadstring'])).toMatchObject({ verdict: 'adapt-with-care' });
    expect(adaptVerdict('map', { ...base, scripts: 3 }, []).reasons.join(' ')).toMatch(/3 script/);
    expect(adaptVerdict('map', { ...base, parts: 6000 }, []).verdict).toBe('adapt-with-care');
    expect(adaptVerdict('map', { ...base, size: [30, 5, 20] }, []).reasons.join(' ')).toMatch(/small/);
  });
});

describe('statsOf / findingsOf', () => {
  it('reads a sanitize report', () => {
    const r = { path: 'X', removed: 0, parts: 3, meshParts: 1, textures: 0, guis: 0, screenGuis: 0, sounds: 1, size: [1, 2, 3] as [number, number, number], scripts: [{ path: 'a.S', class: 'Script', findings: ['loadstring'] }, { path: 'a.T', class: 'Script', findings: [] }] };
    expect(statsOf(r)).toMatchObject({ parts: 3, scripts: 2, sounds: 1, size: [1, 2, 3] });
    expect(findingsOf(r)).toEqual(['a.S: loadstring']);
  });
});

describe('scoutFile', () => {
  it('slugs the need', () => {
    expect(scoutFile('Lava Obby!', 'map')).toBe('scout/lava-obby-map.json');
  });
});

describe('mergeResults DevForum boost', () => {
  it('ranks a DevForum-announced pack above a store hit with the same words, and keeps its thread when found twice', async () => {
    const { mergeResults } = await import('../src/assets/scout.js');
    const store = { assetId: '1', name: 'park pack', isFree: true, priceCents: 0 };
    const forum = { assetId: '2', name: 'park pack', isFree: true, priceCents: 0, sourceUrl: 'https://devforum.roblox.com/t/x/2' };
    const both = { ...store, sourceUrl: 'https://devforum.roblox.com/t/y/1', licenceNote: 'free to use' };
    const r = mergeResults([[store], [forum]], 'park', 'model');
    expect(r.map((x) => x.assetId)).toEqual(['2', '1']);
    const r2 = mergeResults([[store], [both]], 'park', 'model');
    expect(r2[0]).toMatchObject({ assetId: '1', hits: 2, sourceUrl: 'https://devforum.roblox.com/t/y/1', licenceNote: 'free to use' });
  });
});
