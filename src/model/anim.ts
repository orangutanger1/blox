// Blender bone animation → Roblox KeyframeSequence.
//
// model.py exports, per action, every bone's rest and per-frame posed matrix in
// Blender model space. Here those become, per frame, each bone's motion
// relative to its parent (Q = D_parent⁻¹ · D_bone, with D = posed · rest⁻¹),
// moved into Roblox axes centred on the mesh (the MeshPart's frame after a GLB
// import). Studio then turns Q into Pose CFrames using each Bone's real rest
// frame (Transform = W0⁻¹ · M · Q · M⁻¹ · W0, M = MeshPart.CFrame), steps the
// animation in edit mode and compares bone positions with the prediction, so
// a wrong axis or rest mismatch fails loudly instead of shipping a broken
// animation. Everything here is pure; the Luau runs in Studio.

export type Mat4 = number[]; // 16, row-major

export interface AnimJson {
  name: string;
  fps: number;
  loop: boolean;
  meshes: string[];
  meshCenter: [number, number, number];
  bones: Record<string, { parent: string | null; rest: Mat4; head: [number, number, number] }>;
  frames: { t: number; bones: Record<string, Mat4> }[];
}

export const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function mul(a: Mat4, b: Mat4): Mat4 {
  const r = new Array<number>(16).fill(0);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) r[i * 4 + j] += a[i * 4 + k] * b[k * 4 + j];
  return r;
}

// Inverse of an affine matrix (rotation/scale + translation).
export function inv(m: Mat4): Mat4 {
  const [a, b, c, d, e, f, g, h, i] = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) throw new Error('singular bone matrix');
  const r = [
    A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det,
  ];
  const t = [m[3], m[7], m[11]];
  const tx = -(r[0] * t[0] + r[1] * t[1] + r[2] * t[2]);
  const ty = -(r[3] * t[0] + r[4] * t[1] + r[5] * t[2]);
  const tz = -(r[6] * t[0] + r[7] * t[1] + r[8] * t[2]);
  return [r[0], r[1], r[2], tx, r[3], r[4], r[5], ty, r[6], r[7], r[8], tz, 0, 0, 0, 1];
}

const translation = (x: number, y: number, z: number): Mat4 => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1];

// Blender (x, y, z; Z up, front −Y) → Roblox (x, y, z; Y up, front −Z):
// glTF export gives (x, z, −y); Roblox's importer turns glTF +Z to −Z, i.e.
// (−x, y, −z). Together (x, y, z) → (−x, z, y). Verified on the dog probe.
export const BASIS: Mat4 = [-1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1];

export function toRoblox(p: [number, number, number], center: [number, number, number]): [number, number, number] {
  const x = p[0] - center[0], y = p[1] - center[1], z = p[2] - center[2];
  return [-x, z, y];
}

// Roblox-axes, mesh-centred frame X = B · T(−c); motion Q becomes X·Q·X⁻¹.
function frameMatrix(center: [number, number, number]): Mat4 {
  return mul(BASIS, translation(-center[0], -center[1], -center[2]));
}

// Parents before children.
export function boneOrder(bones: AnimJson['bones']): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (n: string) => {
    if (seen.has(n)) return;
    const p = bones[n].parent;
    if (p && bones[p]) visit(p);
    seen.add(n);
    out.push(n);
  };
  for (const n of Object.keys(bones).sort()) visit(n);
  return out;
}

// CFrame components (x, y, z, R00..R22) of an affine matrix.
export const cframe = (m: Mat4): number[] => [m[3], m[7], m[11], m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]].map((v) => Math.round(v * 1e6) / 1e6);

export interface Keyframe {
  t: number;
  q: Record<string, number[]>; // bone → CFrame components (motion relative to parent, Roblox axes)
  heads: Record<string, [number, number, number]>; // predicted posed head, Roblox axes, mesh-centred
  tips: Record<string, [number, number, number]>; // a point 1 unit along the bone (off its pivot), posed
}

export interface Prepared {
  name: string;
  loop: boolean;
  length: number;
  order: string[];
  parents: Record<string, string | null>;
  restHeads: Record<string, [number, number, number]>;
  restTips: Record<string, [number, number, number]>;
  keyframes: Keyframe[];
}

// Blender bones point along their local Y: (0, 1, 0) in bone space.
const tipOf = (m: Mat4): [number, number, number] => [m[1] + m[3], m[5] + m[7], m[9] + m[11]];

export function prepare(a: AnimJson): Prepared {
  const order = boneOrder(a.bones);
  const X = frameMatrix(a.meshCenter);
  const Xi = inv(X);
  const restInv = Object.fromEntries(order.map((b) => [b, inv(a.bones[b].rest)]));
  const keyframes = a.frames.map((f) => {
    const D: Record<string, Mat4> = {};
    for (const b of order) D[b] = mul(f.bones[b] ?? a.bones[b].rest, restInv[b]);
    const q: Record<string, number[]> = {};
    const heads: Record<string, [number, number, number]> = {};
    const tips: Record<string, [number, number, number]> = {};
    for (const b of order) {
      const p = a.bones[b].parent;
      const rel = p && D[p] ? mul(inv(D[p]), D[b]) : D[b];
      q[b] = cframe(mul(mul(X, rel), Xi));
      const P = f.bones[b] ?? a.bones[b].rest;
      heads[b] = toRoblox([P[3], P[7], P[11]], a.meshCenter);
      tips[b] = toRoblox(tipOf(P), a.meshCenter);
    }
    return { t: f.t, q, heads, tips };
  });
  return {
    name: a.name,
    loop: a.loop,
    length: a.frames.length ? a.frames[a.frames.length - 1].t : 0,
    order,
    parents: Object.fromEntries(order.map((b) => [b, a.bones[b].parent])),
    restHeads: Object.fromEntries(order.map((b) => [b, toRoblox(a.bones[b].head, a.meshCenter)])),
    restTips: Object.fromEntries(order.map((b) => [b, toRoblox(tipOf(a.bones[b].rest), a.meshCenter)])),
    keyframes,
  };
}

// --- motion checks (offline, on the Blender data) ------------------------------

function rotAngleDeg(c: number[]): number {
  const tr = c[3] + c[7] + c[11];
  return (Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2))) * 180) / Math.PI;
}

// Rotation between two CFrames' rotation parts: angle of A⁻¹B.
function deltaDeg(a: number[], b: number[]): number {
  const A = [a[3], a[4], a[5], a[6], a[7], a[8], a[9], a[10], a[11]];
  const B = [b[3], b[4], b[5], b[6], b[7], b[8], b[9], b[10], b[11]];
  let tr = 0; // trace(Aᵀ B)
  for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) tr += A[k * 3 + i] * B[k * 3 + i];
  return (Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2))) * 180) / Math.PI;
}

export interface MotionCheck {
  id: string;
  ok: boolean;
  detail: string;
}

export const MAX_DEG_PER_SEC = 1440; // 4 turns a second: faster reads as a snap

export function checkMotion(p: Prepared): MotionCheck[] {
  const out: MotionCheck[] = [];
  if (p.keyframes.length < 2) return [{ id: 'anim:frames', ok: false, detail: 'fewer than 2 frames' }];
  if (p.loop) {
    const a = p.keyframes[0], b = p.keyframes[p.keyframes.length - 1];
    let worst = { bone: '', deg: 0, studs: 0 };
    for (const bone of p.order) {
      const deg = deltaDeg(a.q[bone], b.q[bone]);
      const studs = Math.hypot(a.q[bone][0] - b.q[bone][0], a.q[bone][1] - b.q[bone][1], a.q[bone][2] - b.q[bone][2]);
      if (deg > worst.deg || studs > worst.studs) worst = { bone, deg: Math.max(deg, worst.deg), studs: Math.max(studs, worst.studs) };
    }
    const ok = worst.deg <= 2 && worst.studs <= 0.05;
    out.push({ id: 'anim:loop', ok, detail: ok ? 'loop ends where it starts' : `loop does not close: ${worst.bone} differs by ${worst.deg.toFixed(1)}° / ${worst.studs.toFixed(2)} studs between first and last frame` });
  }
  let worst = { bone: '', speed: 0, t: 0 };
  for (let i = 1; i < p.keyframes.length; i++) {
    const a = p.keyframes[i - 1], b = p.keyframes[i];
    const dt = b.t - a.t;
    if (dt <= 0) continue;
    for (const bone of p.order) {
      const speed = deltaDeg(a.q[bone], b.q[bone]) / dt;
      if (speed > worst.speed) worst = { bone, speed, t: b.t };
    }
  }
  const ok = worst.speed <= MAX_DEG_PER_SEC;
  out.push({ id: 'anim:speed', ok, detail: ok ? `fastest joint ${Math.round(worst.speed)}°/s` : `${worst.bone} turns ${Math.round(worst.speed)}°/s at ${worst.t.toFixed(2)}s (> ${MAX_DEG_PER_SEC}°/s reads as a snap)` });
  const still = p.order.every((b) => p.keyframes.every((k) => rotAngleDeg(k.q[b]) < 0.5 && Math.hypot(k.q[b][0], k.q[b][1], k.q[b][2]) < 0.01));
  if (still) out.push({ id: 'anim:moves', ok: false, detail: 'no bone moves' });
  return out;
}

// --- Studio build + verify ------------------------------------------------------

// Payload is JSON in a long string; the Luau returns JSON.
export function buildLuau(target: string, p: Prepared, kfsName: string): string {
  const payload = JSON.stringify({ target, name: kfsName, loop: p.loop, length: p.length, order: p.order, parents: p.parents, restHeads: p.restHeads, restTips: p.restTips, keyframes: p.keyframes });
  let eq = '';
  while (payload.includes(`]${eq}]`)) eq += '=';
  return `local P = game:GetService("HttpService"):JSONDecode([${eq}[${payload}]${eq}])
${BUILD_LUAU}`;
}

const BUILD_LUAU = `local HS = game:GetService("HttpService")
local KSP = game:GetService("KeyframeSequenceProvider")
local function resolve(path)
	local cur = game
	for name in string.gmatch(path, "[^%.]+") do
		if cur == game and name == "game" then continue end
		cur = cur:FindFirstChild(name) or (cur == game and game:GetService(name))
		if not cur then return nil end
	end
	return cur
end
local function cf(c) return CFrame.new(c[1], c[2], c[3], c[4], c[5], c[6], c[7], c[8], c[9], c[10], c[11], c[12]) end
local function comps(x) return { x:GetComponents() } end
local model = resolve(P.target)
if not model then error("no instance at " .. P.target, 0) end
local bones, part = {}, nil
for _, d in model:GetDescendants() do
	if d:IsA("Bone") and P.restHeads[d.Name] then
		bones[d.Name] = d
		local p = d.Parent
		while p and not p:IsA("BasePart") do p = p.Parent end
		part = part or p
	end
end
for _, n in P.order do
	if not bones[n] then error("bone " .. n .. " not found under " .. P.target .. " (insert the uploaded model first)", 0) end
end
local M = part.CFrame
for _, b in bones do b.Transform = CFrame.new() end
-- Rest check: the mesh-centred Blender heads must land on the imported bones.
local restErr, restWorst = 0, ""
for n, h in P.restHeads do
	local e = (bones[n].WorldPosition - M * Vector3.new(h[1], h[2], h[3])).Magnitude
	if e > restErr then restErr, restWorst = e, n end
end
if restErr > 0.05 then
	return HS:JSONEncode({ ok = false, error = string.format("rest pose mismatch: bone %s is %.2f studs from where the Blender export puts it (axis or centre error)", restWorst, restErr) })
end
local W0, tipLocal = {}, {}
for n, b in bones do
	W0[n] = b.WorldCFrame
	local tp = P.restTips[n]
	-- the probe point rides on the bone: keep it in the bone's own frame
	tipLocal[n] = W0[n]:PointToObjectSpace(M * Vector3.new(tp[1], tp[2], tp[3]))
end
local Mi = M:Inverse()
local ks = Instance.new("KeyframeSequence")
ks.Name = P.name
ks.Loop = P.loop
local lower = string.lower(P.name)
ks.Priority = (string.find(lower, "idle") or string.find(lower, "sleep")) and Enum.AnimationPriority.Idle
	or (string.find(lower, "walk") or string.find(lower, "run") or string.find(lower, "move")) and Enum.AnimationPriority.Movement
	or Enum.AnimationPriority.Action
local out = {}
for _, k in P.keyframes do
	local kf = Instance.new("Keyframe")
	kf.Time = k.t
	local root = Instance.new("Pose")
	root.Name = part.Name
	root.Weight = 1
	root.Parent = kf
	local poses = {}
	local row = { t = k.t, poses = {} }
	for _, n in P.order do
		local T = W0[n]:Inverse() * M * cf(k.q[n]) * Mi * W0[n]
		local pose = Instance.new("Pose")
		pose.Name = n
		pose.Weight = 1
		pose.CFrame = T
		pose.Parent = poses[P.parents[n] or ""] or root
		poses[n] = pose
		row.poses[n] = comps(T)
	end
	kf.Parent = ks
	table.insert(out, row)
end
-- Verify: play it on the real rig in edit mode and compare bone positions.
local controller = model:FindFirstChildWhichIsA("AnimationController", true) or model:FindFirstChildWhichIsA("Humanoid", true)
if not controller then
	controller = Instance.new("AnimationController")
	controller.Parent = model
end
local animator = controller:FindFirstChildOfClass("Animator") or Instance.new("Animator", controller)
local anim = Instance.new("Animation")
anim.AnimationId = KSP:RegisterKeyframeSequence(ks)
local track = animator:LoadAnimation(anim)
local t0 = os.clock()
while track.Length == 0 and os.clock() - t0 < 5 do task.wait() end
track:Play(0)
local maxErr, worst = 0, ""
local samples = { 1, math.max(1, math.floor(#P.keyframes / 2)), #P.keyframes }
for _, i in samples do
	local k = P.keyframes[i]
	track.TimePosition = math.min(k.t, math.max(track.Length - 1e-3, 0))
	animator:StepAnimations(0)
	for n, h in k.heads do
		local e = (bones[n].TransformedWorldCFrame.Position - M * Vector3.new(h[1], h[2], h[3])).Magnitude
		if e > maxErr then maxErr, worst = e, string.format("%s at %.2fs", n, k.t) end
		local tp = k.tips[n]
		local et = (bones[n].TransformedWorldCFrame * tipLocal[n] - M * Vector3.new(tp[1], tp[2], tp[3])).Magnitude
		if et > maxErr then maxErr, worst = et, string.format("%s (1 stud along it) at %.2fs", n, k.t) end
	end
end
track:Stop(0)
animator:StepAnimations(0)
for _, b in bones do b.Transform = CFrame.new() end
local folder = game:GetService("ServerStorage"):FindFirstChild("BloxAnimations") or Instance.new("Folder")
folder.Name = "BloxAnimations"
folder.Parent = game:GetService("ServerStorage")
local old = folder:FindFirstChild(P.name)
if old then old:Destroy() end
ks.Parent = folder
return HS:JSONEncode({ ok = true, restErr = restErr, playErr = maxErr, playWorst = worst, part = part.Name, length = track.Length, frames = out })`;

export interface BuildResult {
  ok: boolean;
  error?: string;
  restErr?: number;
  playErr?: number;
  playWorst?: string;
  part?: string;
  frames?: { t: number; poses: Record<string, number[]> }[];
}

export const PLAY_TOLERANCE = 0.1; // studs

// --- rbxmx ------------------------------------------------------------------------

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const num = (v: number) => String(Math.round(v * 1e6) / 1e6);

function cframeXml(c: number[]): string {
  const k = ['X', 'Y', 'Z', 'R00', 'R01', 'R02', 'R10', 'R11', 'R12', 'R20', 'R21', 'R22'];
  return `<CoordinateFrame name="CFrame">${k.map((n, i) => `<${n}>${num(c[i])}</${n}>`).join('')}</CoordinateFrame>`;
}

const IDENT_CF = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];

export function priorityToken(name: string): number {
  const l = name.toLowerCase();
  if (/idle|sleep/.test(l)) return 0; // Idle
  if (/walk|run|move/.test(l)) return 1; // Movement
  return 2; // Action
}

export function keyframeSequenceXml(o: { name: string; loop: boolean; part: string; order: string[]; parents: Record<string, string | null>; frames: { t: number; poses: Record<string, number[]> }[] }): string {
  let ref = 0;
  const item = (cls: string, props: string, children: string) => `<Item class="${cls}" referent="RBX${ref++}"><Properties>${props}</Properties>${children}</Item>`;
  const pose = (name: string, c: number[], kids: string) =>
    item('Pose', `<string name="Name">${esc(name)}</string>${cframeXml(c)}<token name="EasingDirection">0</token><token name="EasingStyle">0</token><float name="Weight">1</float>`, kids);
  const children: Record<string, string[]> = {};
  for (const b of o.order) (children[o.parents[b] ?? ''] ??= []).push(b);
  const frames = o.frames
    .map((f) => {
      const tree = (b: string): string => pose(b, f.poses[b], (children[b] ?? []).map(tree).join(''));
      const roots = children[''] ?? [];
      return item('Keyframe', `<string name="Name">Keyframe</string><float name="Time">${num(f.t)}</float>`, pose(o.part, IDENT_CF, roots.map(tree).join('')));
    })
    .join('');
  const ks = item('KeyframeSequence', `<string name="Name">${esc(o.name)}</string><bool name="Loop">${o.loop}</bool><token name="Priority">${priorityToken(o.name)}</token>`, frames);
  return `<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.roblox.com/roblox.xsd" version="4">${ks}</roblox>\n`;
}
