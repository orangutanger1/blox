import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blenderBin, defaultSpawn, type Spawner } from '../assets/blender.js';
import { longString } from '../studio/luau.js';

// AI-built models: the agent writes Blender Python against tools/blender/
// blox_model.py helpers, blox runs it headless and hands back stats, turnaround
// renders, a Roblox-ready FBX (+ one FBX per animation) and a preview mesh.
// Everything lives in .blox/models/<id>/: brief.json, model.blend, code/,
// views/*.png, export/.

export const MODEL_SCRIPT = fileURLToPath(new URL('../../tools/blender/model.py', import.meta.url));
export const ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export interface ModelBrief {
  id: string;
  prompt: string;
  style?: string;
  tris: number;
  rig: boolean;
  animations: string[];
  refs: string[];
  createdAt: string;
}

export interface ModelStats {
  triangles: number;
  meshes: Record<string, number>;
  materials: number;
  bones: number;
  maxInfluences: number;
  actions: { name: string; frames: [number, number] }[];
  textures: { name: string; size: [number, number] }[];
  size: [number, number, number];
  issues: string[];
  views?: string[];
  colours?: Record<string, string>; // material → flat | vertex | texture | procedural | missing-image
  uploadParts?: number; // MeshParts an upload makes after the export bake
}

export function modelDir(projectPath: string, id: string): string {
  if (!ID_RE.test(id)) throw new Error(`bad model id "${id}" (letters, digits, _ and -; starts with a letter)`);
  return join(projectPath, '.blox', 'models', id);
}

export function readBrief(projectPath: string, id: string): ModelBrief | null {
  const f = join(modelDir(projectPath, id), 'brief.json');
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as ModelBrief) : null;
}

export function writeBrief(projectPath: string, b: Omit<ModelBrief, 'createdAt'>): ModelBrief {
  const dir = modelDir(projectPath, b.id);
  mkdirSync(dir, { recursive: true });
  const brief = { ...b, createdAt: new Date().toISOString() };
  writeFileSync(join(dir, 'brief.json'), JSON.stringify(brief, null, 2) + '\n');
  return brief;
}

// The build guide returned with a brief: the "one-shot" spec the agent works to.
export function briefText(b: ModelBrief): string {
  return [
    `model ${b.id}: ${b.prompt}`,
    `style: ${b.style ?? 'match the references; blocky/voxel reads best on Roblox'} · budget ${b.tris} triangles · ${b.rig ? `rigged, animations: ${b.animations.join(', ') || '(none)'}` : 'static'}`,
    b.refs.length ? `references (look at them first, all angles): ${b.refs.join(', ')}` : 'no reference images — consider asking for front/side/back references of the style',
    '',
    'Build loop:',
    '1. Write Blender Python using the helpers (1 unit = 1 stud, Z up, model faces -Y):',
    '   reset() · voxels(name, [(x,y,z,"#hex"),…]) · box(name, size, at, color) · join(objs, name)',
    b.rig
      ? '   rig(name, [{name, head, tail, parent?}]) · bind_rigid(armature, {bone: [objs]}, name) · animate(armature, "Walk", {frame: {bone: {"rot": (x,y,z)}}})'
      : '   (static: no rig needed)',
    '   Separate body parts that move into their own objects so each binds to one bone.',
    `2. model {action:"run", id:"${b.id}", code} — rebuilds the .blend from your code (keep the whole build in one script; rerun after edits).`,
    `3. model {action:"check", id:"${b.id}"} — stats vs Roblox limits + front/right/back/¾ renders: open them and compare with the references; fix and rerun.`,
    `4. model {action:"export", id:"${b.id}"} — model.glb (upload), model.fbx, anim_<name>.fbx + .json, preview.json.`,
    `5. model {action:"preview", id:"${b.id}"} — coloured mesh in Studio (no upload) to judge scale in the real place.`,
    `6. model {action:"import", id:"${b.id}"} — records it in .blox/assets.json; a human approves (blox asset approve ${b.id}) before upload.`,
    ...(b.rig
      ? [
          `7. After upload + insert (studio_tool insert_asset; set MeshPart Color white): model {action:"animate", id:"${b.id}", target:"Workspace.<Name>"} — KeyframeSequence per action, motion checks, played on the real rig and compared with Blender, anim_<name>.rbxm recorded for upload.`,
          '8. Upload each animation (human approval), then in game code: require(ReplicatedStorage.BloxAnimate).auto(model, {idle = <id>, walk = <id>}) or .play(model, <id>).',
        ]
      : []),
  ].join('\n');
}

export async function runModelPy(cmd: 'run' | 'check' | 'export', args: Record<string, unknown>, dir: string, spawn: Spawner = defaultSpawn): Promise<Record<string, unknown>> {
  mkdirSync(dir, { recursive: true });
  const argFile = join(dir, `.${cmd}.json`);
  writeFileSync(argFile, JSON.stringify(args));
  // Workbench renders need GL; headless Linux/WSLg fails with EGL_BAD_MATCH
  // unless Blender uses software GL and ignores the Wayland display.
  const env = process.platform === 'linux' ? { LIBGL_ALWAYS_SOFTWARE: '1', WAYLAND_DISPLAY: 'nonexistent' } : undefined;
  const r = await spawn(blenderBin(), ['-b', '--factory-startup', '--disable-autoexec', '--python', MODEL_SCRIPT, '--', cmd, argFile], env);
  if (r.notFound) throw new Error(`Blender not found ("${blenderBin()}") — install Blender 3.6+ and put it on PATH, or set BLOX_BLENDER`);
  const all = `${r.stdout}\n${r.stderr}`;
  const err = /BLOX_ERROR (.*)/.exec(all)?.[1];
  if (err) throw new Error(err);
  const line = /BLOX_MODEL (.*)/.exec(r.stdout)?.[1];
  if (!line) throw new Error(`blender exited ${r.code} without a result: ${(r.stderr || r.stdout).trim().split('\n').slice(-5).join(' | ')}`);
  return JSON.parse(line) as Record<string, unknown>;
}

export function formatStats(s: ModelStats, projectPath: string): string {
  const lines = [
    `${s.triangles} triangles · ${s.materials} materials · ${s.bones} bones · size ${s.size.join(' × ')} studs (x × y × z)`,
    s.actions.length ? `animations: ${s.actions.map((a) => `${a.name} [${a.frames[0]}-${a.frames[1]}]`).join(', ')}` : 'animations: none',
  ];
  for (const i of s.issues) lines.push(`  ✗ ${i}`);
  if (!s.issues.length) lines.push('  ✓ within Roblox limits');
  if (s.views?.length) lines.push(`views (open and compare with the references): ${s.views.map((v) => relative(projectPath, v)).join(', ')}`);
  return lines.join('\n');
}

// Edit-context Luau that builds a coloured MeshPart from preview.json via
// EditableMesh (works from the MCP thread; nothing is uploaded) and puts it in
// Workspace.__BloxModelPreview_<id>, standing on the ground at `at`.
export function previewLuau(id: string, preview: { triangles: { v: number[][]; c: string }[] }, at: [number, number, number]): string {
  return `local HttpService = game:GetService("HttpService")
local AssetService = game:GetService("AssetService")
local P = HttpService:JSONDecode(${longString(JSON.stringify(preview))})
local name = ${JSON.stringify(`__BloxModelPreview_${id}`)}
local old = workspace:FindFirstChild(name)
if old then old:Destroy() end
local em = AssetService:CreateEditableMesh()
local colors = {}
local minY = math.huge
for _, t in P.triangles do
	for _, v in t.v do minY = math.min(minY, v[2]) end
end
for _, t in P.triangles do
	local ids = {}
	for i, v in t.v do ids[i] = em:AddVertex(Vector3.new(v[1], v[2], v[3])) end
	local f = em:AddTriangle(ids[1], ids[2], ids[3])
	local c = colors[t.c]
	if not c then
		c = em:AddColor(Color3.fromHex(t.c), 1)
		colors[t.c] = c
	end
	em:SetFaceColors(f, { c, c, c })
end
local mp = AssetService:CreateMeshPartAsync(Content.fromObject(em))
mp.Name = name
mp.Anchored = true
local at = Vector3.new(${at.join(', ')})
mp.Position = at + Vector3.new(0, mp.Size.Y / 2, 0)
mp.Parent = workspace
return { name = mp:GetFullName(), size = { mp.Size.X, mp.Size.Y, mp.Size.Z }, triangles = #P.triangles }`;
}
