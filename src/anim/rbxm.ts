import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { realSpawn, rojoBin } from '../sync/rojo.js';
import type { CompiledPose, KeyframeSequenceDescription } from './pose-compiler.js';
import { POSE_EASING_DIRECTIONS, POSE_EASING_STYLES } from './easing.js';

// A compiled sequence as an .rbxmx (Roblox XML), built to .rbxm by rojo for
// Open Cloud upload (assetType Animation).

const PRIORITY: Record<string, number> = { Idle: 0, Movement: 1, Action: 2, Action2: 3, Action3: 4, Action4: 5, Core: 1000 };
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (v: number) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6));
const CF = ['X', 'Y', 'Z', 'R00', 'R01', 'R02', 'R10', 'R11', 'R12', 'R20', 'R21', 'R22'];

export function sequenceXml(seq: KeyframeSequenceDescription): string {
  let ref = 0;
  const item = (cls: string, props: string, children = '') => `<Item class="${cls}" referent="RBX${ref++}"><Properties>${props}</Properties>${children}</Item>`;
  const pose = (p: CompiledPose): string =>
    item(
      'Pose',
      `<string name="Name">${esc(p.part)}</string><CoordinateFrame name="CFrame">${CF.map((k, i) => `<${k}>${num(p.cframe[i])}</${k}>`).join('')}</CoordinateFrame>` +
        `<token name="EasingDirection">${POSE_EASING_DIRECTIONS.indexOf(p.easingDirection)}</token><token name="EasingStyle">${POSE_EASING_STYLES.indexOf(p.easingStyle)}</token><float name="Weight">${p.weight}</float>`,
      p.children.map(pose).join(''),
    );
  const frames = seq.keyframes
    .map((k) =>
      item(
        'Keyframe',
        `<string name="Name">${esc(k.name ?? 'Keyframe')}</string><float name="Time">${num(k.time)}</float>`,
        pose(k.root) + (k.markers ?? []).map((m) => item('KeyframeMarker', `<string name="Name">${esc(m.name)}</string><string name="Value">${esc(m.value)}</string>`)).join(''),
      ),
    )
    .join('');
  const ks = item('KeyframeSequence', `<string name="Name">${esc(seq.name)}</string><bool name="Loop">${seq.loop}</bool><token name="Priority">${PRIORITY[seq.priority] ?? 2}</token>`, frames);
  return `<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.roblox.com/roblox.xsd" version="4">${ks}</roblox>\n`;
}

type SpawnLike = typeof realSpawn;

export async function writeRbxm(dir: string, seq: KeyframeSequenceDescription, spawn: SpawnLike = realSpawn): Promise<{ file: string } | { error: string }> {
  const base = `anim_${seq.name}`;
  writeFileSync(join(dir, `${base}.rbxmx`), sequenceXml(seq));
  writeFileSync(join(dir, `${base}.project.json`), JSON.stringify({ name: seq.name, tree: { $path: `${base}.rbxmx` } }));
  const r = await spawn(rojoBin(), ['build', `${base}.project.json`, '--output', `${base}.rbxm`], { cwd: dir });
  if (r.code !== 0) return { error: `rojo build of the .rbxm failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}` };
  return { file: join(dir, `${base}.rbxm`) };
}
