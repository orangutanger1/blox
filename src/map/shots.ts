import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StudioSession } from '../studio/session.js';
import { restoreFor } from '../studio/host.js';
import { composeSheet, meanSaturation } from '../ui/sheet.js';
import { withStage } from './run.js';

// The standard map views, framed on the play area: four high corners, eye
// level from the spawn and from the far end, straight down, and a player's
// view behind the spawn. One call → one contact sheet to compare with references.

type V3 = number[];
export interface ShotCamera {
  name: string;
  position: V3;
  lookAt: V3;
}

export function shotCameras(bbox: { min: V3; max: V3 }, spawn: V3, far?: V3): ShotCamera[] {
  const [x0, y0, z0] = bbox.min, [x1, y1, z1] = bbox.max;
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, gy = Math.min(spawn[1], y0 + 2);
  const span = Math.max(x1 - x0, z1 - z0, 40);
  const h = gy + span * 0.42;
  const c = [cx, gy, cz];
  const pad = 0.12;
  const corners = [[x0 - (x1 - x0) * pad, z0 - (z1 - z0) * pad], [x1 + (x1 - x0) * pad, z0 - (z1 - z0) * pad], [x1 + (x1 - x0) * pad, z1 + (z1 - z0) * pad], [x0 - (x1 - x0) * pad, z1 + (z1 - z0) * pad]];
  const f = far ?? [x1 - (spawn[0] - x0 < x1 - spawn[0] ? 4 : x1 - x0 - 4), spawn[1], z1 - (spawn[2] - z0 < z1 - spawn[2] ? 4 : z1 - z0 - 4)];
  const toward = (from: V3, d: number) => {
    const dx = cx - from[0], dz = cz - from[2], l = Math.hypot(dx, dz) || 1;
    return [from[0] - (dx / l) * d, from[1], from[2] - (dz / l) * d];
  };
  const back = toward(spawn, 10);
  return [
    ...corners.map(([x, z], i) => ({ name: `corner${i + 1}`, position: [x, h, z], lookAt: c })),
    { name: 'eye-spawn', position: [spawn[0], spawn[1] + 5, spawn[2]], lookAt: [cx, spawn[1] + 4, cz] },
    { name: 'eye-far', position: [f[0], f[1] + 5, f[2]], lookAt: [cx, f[1] + 4, cz] },
    { name: 'top', position: [cx, y1 + span * 1.05, cz + 0.01], lookAt: c },
    { name: 'play', position: [back[0], back[1] + 7, back[2]], lookAt: [cx, spawn[1] + 3, cz] },
  ];
}

export interface MapShots {
  path: string;
  data: string; // base64 JPEG sheet
  saturation: number;
  names: string[];
  failed: string[]; // views with no image after a retry
  notes: string[];
}

// screen_capture times out now and then (2 of 4 calls in the bake-off): try
// once more with a longer timeout before giving a view up.
async function capture(session: StudioSession, c: ShotCamera): Promise<{ img?: Buffer; error?: string }> {
  let error = 'no image';
  for (const timeout of [30_000, 75_000]) {
    try {
      const r = await session.call('screen_capture', { capture_id: `map-${c.name}`, camera_position: c.position, look_at_position: c.lookAt }, timeout);
      const img = (r.content ?? []).find((b) => b.type === 'image' && b.data);
      if (img?.data) return { img: Buffer.from(img.data, 'base64') };
    } catch (e) {
      error = (e as Error).message;
    }
  }
  return { error };
}

export async function runMapShots(session: StudioSession, projectPath: string, o: { bbox: { min: V3; max: V3 }; spawn: V3; far?: V3; root?: string }): Promise<MapShots> {
  if ((await session.state()).mode !== 'Edit') throw new Error('map shots are edit-mode captures: stop the playtest first');
  await restoreFor(session);
  const cams = shotCameras(o.bbox, o.spawn, o.far);
  const caps: (Buffer | null)[] = [];
  const notes: string[] = [];
  const failed: string[] = [];
  await withStage(session, o.root, async () => {
    for (const c of cams) {
      const r = await capture(session, c);
      if (!r.img) {
        notes.push(`${c.name}: no capture (${r.error})`);
        failed.push(c.name);
      }
      caps.push(r.img ?? null);
    }
  });
  const shots = caps.filter((x): x is Buffer => !!x);
  if (!shots.length) throw new Error(`map shots: no view captured (${notes.join('; ')}) — is the Studio window minimised or behind a dialog?`);
  const saturation = shots.length ? shots.reduce((a, b) => a + meanSaturation(b), 0) / shots.length : 0;
  const sheet = composeSheet([caps.slice(0, 4), caps.slice(4, 8)], 300);
  mkdirSync(join(projectPath, '.blox'), { recursive: true });
  writeFileSync(join(projectPath, '.blox/map-shots.jpg'), sheet);
  return { path: '.blox/map-shots.jpg', data: sheet.toString('base64'), saturation, names: cams.map((c) => c.name), failed, notes };
}
