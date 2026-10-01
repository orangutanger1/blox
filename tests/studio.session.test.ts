import { describe, it, expect } from 'vitest';
import { StudioSession, selectStudio, parseStudioState, StudioError } from '../src/studio/session.js';
import { fakeStudio } from './fakeStudio.js';

const noSleep = async () => {};
const launch = { command: 'x', args: [] };

describe('selectStudio', () => {
  it('requires an attached studio', () => {
    expect(() => selectStudio([])).toThrow(StudioError);
  });
  it('picks the only studio, or matches by name substring / id', () => {
    expect(selectStudio([{ id: 'a', name: 'P' }]).id).toBe('a');
    const two = [{ id: 'a', name: 'Lobby (placeId: 1)' }, { id: 'b', name: 'Arena' }];
    expect(selectStudio(two, 'arena').id).toBe('b');
    expect(selectStudio(two, 'a').id).toBe('a'); // exact id beats substring order
    expect(() => selectStudio(two)).toThrow(/2 Studio instances/);
    expect(() => selectStudio(two, 'zzz')).toThrow(/No attached Studio matches/);
  });
  it('tolerates unnamed studios', () => {
    expect(selectStudio([{ id: 'a', name: null }], 'x' === 'y' ? 'x' : undefined).id).toBe('a');
  });
});

describe('parseStudioState', () => {
  it('parses mode and datamodels', () => {
    const s = parseStudioState('- Current Studio Mode: Play\n- Available DataModels: Client, Server\n- Focused DataModel in the viewport: Client');
    expect(s.mode).toBe('Play');
    expect(s.dataModels).toEqual(['Client', 'Server']);
  });
});

describe('StudioSession', () => {
  it('polls until a studio attaches, then injects studio_id', async () => {
    const f = fakeStudio({ studios: [[], [], [{ id: 'sid', name: 'P' }]], luau: () => 'ok' });
    const s = new StudioSession({ launch, connector: async () => f.client, sleep: noSleep });
    const r = await s.call('execute_luau', { code: 'return 1', datamodel_type: 'Edit' });
    expect(r.content?.[0].text).toBe('ok');
    const exec = f.calls.find((c) => c.name === 'execute_luau')!;
    expect(exec.args.studio_id).toBe('sid');
    expect(f.calls.filter((c) => c.name === 'list_roblox_studios').length).toBe(3);
  });
  it('omits studio_id for pre-routing Studio builds', async () => {
    const f = fakeStudio({ studioId: false, luau: () => 'ok' });
    const s = new StudioSession({ launch, connector: async () => f.client, sleep: noSleep });
    await s.call('execute_luau', { code: 'x', datamodel_type: 'Edit' });
    expect(f.calls[0].args.studio_id).toBeUndefined();
  });
  it('re-attaches once after a "no studio" error', async () => {
    let n = 0;
    const f = fakeStudio({
      studios: [[{ id: 'old', name: 'P' }], [{ id: 'new', name: 'P' }]],
      luau: () => (n++ === 0 ? { content: [{ type: 'text', text: 'Unable to find an active Studio instance' }], isError: true } : 'fine'),
    });
    const s = new StudioSession({ launch, connector: async () => f.client, sleep: noSleep });
    const r = await s.call('execute_luau', { code: 'x', datamodel_type: 'Edit' });
    expect(r.content?.[0].text).toBe('fine');
    const ids = f.calls.filter((c) => c.name === 'execute_luau').map((c) => c.args.studio_id);
    expect(ids).toEqual(['old', 'new']);
  });
  it('times out attach with a no_studio error and a setup hint', async () => {
    const f = fakeStudio({ studios: [[]] });
    const s = new StudioSession({ launch, connector: async () => f.client, sleep: noSleep, attachTimeoutMs: 0 });
    await expect(s.attach()).rejects.toMatchObject({ code: 'no_studio' });
  });
  it('wraps connector failures as not_connected', async () => {
    const s = new StudioSession({ launch, connector: async () => { throw new Error('spawn ENOENT'); } });
    await expect(s.listTools()).rejects.toMatchObject({ code: 'not_connected' });
  });
});
