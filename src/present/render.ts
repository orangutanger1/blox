import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StudioSession } from '../studio/session.js';
import { runLuau } from '../studio/luau.js';
import type { Presentation } from './schema.js';
import { CLEANUP, rigProgram } from './rig.js';
import { ICON_SIZE, squareIconFromCapture } from './square.js';

export interface RenderResult {
  rendered: { id: string; file: string; avatar: string }[];
  failed: { id: string; error: string }[];
}

// Stages each shot in the edit DataModel, captures it with the shot camera,
// and records the file with provenance "render". The rig is always removed.
export async function renderShots(session: StudioSession, projectPath: string, doc: Presentation, ids?: string[]): Promise<RenderResult> {
  const st = await session.state();
  if (st.mode !== 'Edit') throw new Error('stop the playtest first: renders are staged in the edit DataModel');
  const shots = doc.shots.filter((s) => !ids?.length || ids.includes(s.id));
  if (ids?.length) {
    const missing = ids.filter((id) => !doc.shots.some((s) => s.id === id));
    if (missing.length) throw new Error(`unknown shot id(s): ${missing.join(', ')}`);
  }
  const out: RenderResult = { rendered: [], failed: [] };
  mkdirSync(join(projectPath, '.blox/artifacts/present'), { recursive: true });
  for (const shot of shots) {
    try {
      const rig = await runLuau(session, rigProgram(shot), 'edit', { chunkName: `rig-${shot.id}`, timeoutMs: 60_000 });
      if (!rig.ok) throw new Error(`rig: ${rig.error?.message}`);
      const r = await session.call('screen_capture', { capture_id: `present-${shot.id}`, camera_position: shot.camera.position, look_at_position: shot.camera.lookAt }, 30_000);
      const img = (r.content ?? []).find((b) => b.type === 'image' && b.data);
      if (!img?.data) throw new Error('screen_capture returned no image');
      let bytes: Buffer = Buffer.from(img.data, 'base64');
      let ext = (img.mimeType ?? 'image/jpeg').includes('png') ? 'png' : 'jpg';
      // The icon is square on the store: crop the 16:9 capture's centre.
      // An undecodable capture is kept as is; present lint then flags its shape.
      if (shot.kind === 'icon') {
        try {
          bytes = squareIconFromCapture(bytes, ICON_SIZE);
          ext = 'png';
        } catch {
          /* keep the raw capture */
        }
      }
      const rel = `.blox/artifacts/present/${shot.id}.${ext}`;
      writeFileSync(join(projectPath, rel), bytes);
      Object.assign(shot, { file: rel, provenance: 'render', renderedAt: new Date().toISOString() });
      out.rendered.push({ id: shot.id, file: rel, avatar: String(rig.values[0] ?? '') });
    } catch (e) {
      out.failed.push({ id: shot.id, error: e instanceof Error ? e.message : String(e) });
    } finally {
      await runLuau(session, CLEANUP, 'edit', { chunkName: 'rig-cleanup' }).catch(() => undefined);
    }
  }
  return out;
}
