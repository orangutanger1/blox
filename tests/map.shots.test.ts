import { describe, expect, it } from 'vitest';
import jpeg from 'jpeg-js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shotCameras, runMapShots } from '../src/map/shots.js';
import { meanSaturation } from '../src/ui/sheet.js';
import { StudioSession } from '../src/studio/session.js';
import { fakeStudio } from './fakeStudio.js';
import { STAGE } from '../src/map/program.js';

const box = { min: [-100, 0, -50], max: [100, 30, 50] };
const inside = (p: number[]) => p[0] >= -100 && p[0] <= 100 && p[2] >= -50 && p[2] <= 50;

describe('map shots', () => {
  it('8 standard cameras: 4 high corners, 2 eye level, top, play — all aimed into the play area', () => {
    const c = shotCameras(box, [-80, 2, -30], [90, 2, 40]);
    expect(c.map((x) => x.name)).toEqual(['corner1', 'corner2', 'corner3', 'corner4', 'eye-spawn', 'eye-far', 'top', 'play']);
    for (const x of c) expect(inside(x.lookAt)).toBe(true);
    const top = c.find((x) => x.name === 'top')!;
    expect(top.position[1]).toBeGreaterThan(150);
    expect(Math.abs(top.position[0])).toBeLessThan(1);
    expect(c.find((x) => x.name === 'eye-spawn')!.position[1]).toBeLessThan(10);
  });
  it('mean saturation: grey is 0, pure red is 1', () => {
    const img = (rgb: number[]) => { const d = Buffer.alloc(16 * 16 * 4); for (let i = 0; i < 256; i++) d.set([...rgb, 255], i * 4); return Buffer.from(jpeg.encode({ data: d, width: 16, height: 16 }, 95).data); };
    expect(meanSaturation(img([128, 128, 128]))).toBeLessThan(0.05);
    expect(meanSaturation(img([230, 10, 10]))).toBeGreaterThan(0.85);
  });
  it('captures each camera and returns one sheet with its saturation', async () => {
    const d = Buffer.alloc(32 * 18 * 4); for (let i = 0; i < 32 * 18; i++) d.set([40, 160, 40, 255], i * 4);
    const tiny = Buffer.from(jpeg.encode({ data: d, width: 32, height: 18 }, 90).data).toString('base64');
    const f = fakeStudio({ tools: { screen_capture: () => ({ content: [{ type: 'image', data: tiny, mimeType: 'image/jpeg' }] }) } });
    const s = new StudioSession({ launch: { command: 'x', args: [] }, connector: async () => f.client, sleep: async () => {}, attachTimeoutMs: 0 });
    const P = mkdtempSync(join(tmpdir(), 'blox-shots-'));
    const r = await runMapShots(s, P, { bbox: box, spawn: [-80, 2, -30] });
    expect(f.calls.filter((c) => c.name === 'screen_capture')).toHaveLength(8);
    expect(r.path).toBe('.blox/map-shots.jpg');
    expect(r.saturation).toBeGreaterThan(0.5);
  });
  it('a map kept outside Workspace is staged for the captures and removed after', async () => {
    const order: string[] = [];
    const f = fakeStudio({
      luau: (code) => { if (code.includes(STAGE)) order.push(code.includes(':Clone()') ? 'stage' : 'unstage'); return JSON.stringify({ ok: true, n: 1, values: { v1: true }, logs: [] }); },
      tools: { screen_capture: () => { order.push('cap'); return { content: [] }; } },
    });
    const s = new StudioSession({ launch: { command: 'x', args: [] }, connector: async () => f.client, sleep: async () => {}, attachTimeoutMs: 0 });
    await runMapShots(s, mkdtempSync(join(tmpdir(), 'blox-shots-')), { bbox: box, spawn: [-80, 2, -30], root: 'ServerStorage.Maps.Farm' });
    expect(order[0]).toBe('stage');
    expect(order.at(-1)).toBe('unstage');
  });
});
