# Model Rigs + NPC Loader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `animate` animates NPCs (stock R15/R6 bodies driven by one central server loader) and Part+Motor6D model rigs read from Studio, through the same check → build → approve → upload → wire → verify flow as spec A.

**Architecture:** Vendor Roqer's `model-rig`, `rig-declarations`, `body-plans` into `src/anim`. New `src/anim/modelRig.ts` reads a model's rig in Studio (edit probe) and turns it into a `Rig`; new `src/anim/npc.ts` holds the NPC body program, the central `BloxModelAnimate.server.luau` loader (CollectionService tag `BloxAnimated` + model attributes) and the model-wire program. `studio.ts` gains a model branch for build (play on a clone) and a server verify probe. `tool.ts` gains `rig`, `declare`, `npc` actions and model variants of check/build/wire/verify.

**Tech Stack:** TypeScript (NodeNext ESM, strict), vitest, zod, Luau via Studio MCP `execute_luau` (edit) and the eval bridge (server), lune for compile checks, Rojo sync.

**Spec:** `docs/superpowers/specs/2026-10-02-model-rig-npc-animation-design.md`

## Global Constraints

- Agent data reaches Luau only as a payload: edit programs `local PAYLOAD = ${longString(JSON.stringify(...))}` decoded with `HS:JSONDecode`; bridge probes `local P = ${jsonToLuau(...)}` and return tables. No `HttpService` text in bridge probes.
- Model paths are resolved inside Luau by walking `FindFirstChild` over `.`-separated segments from `game`; a leading `game.` is stripped in TS. Names containing `.` are unsupported.
- Allowed model locations: under Workspace, ServerStorage or ReplicatedStorage; never a player's character, never under Players/StarterPlayer.
- Limits: 64 joints, 128 rig parts, 256 welded parts (overflow counted as `weldedLeftOut`).
- Declarations attribute: `BloxRig` (JSON, version 1). Loader: `src/ServerScriptService/BloxModelAnimate.server.luau`, tag `BloxAnimated`, attributes `BloxAnim_idle|walk|run`, `BloxAnim_walkSpeed|runSpeed`. Pace clamp 0.5–2× (`LOADER_PACE`), fade 0.2 s, standing < 0.5 studs/s.
- Bones are skipped by the reader (skinned rigs belong to `model animate`, PR #68). MeshParts are drawn as boxes.
- Edit programs that write do so in one ChangeHistory recording (`TryBeginRecording` / `FinishRecording` in `pcall`).
- `npx tsc --noEmit` clean and `npm test` green before any task is called complete; vitest skips typecheck.
- Vendored files change only import paths, `node:` prefixes and the `Roqer*` → `Blox*` names; record it in `src/anim/VENDOR.md`.
- Git: branch `animate-model-rigs` (exists); commit per task; PR + squash-merge at the end.

## Review Focus

1. A model whose parts are all **Anchored** (common for hand-built Part models): the Animator still writes `Motor6D.Transform` in the build clone, so build must still compare joints — but the loader in a playtest cannot move an anchored Humanoid. Verify must say "root part is anchored" instead of a vague movement failure. Test in Task 8.
2. An existing **malformed `BloxRig`** attribute must not lock the model out of `declare` (the fix path): `declare` reads with `bare:true`. Test in Task 4.
3. **Clones of a checked model** (spawner copies `Workspace.Dog` to `Workspace.Dog2`): wire must accept them by revision, not path. Test in Task 3 (revision ignores path) and Task 7.
4. A **non-looping or locomotion-less** animation wired to walk/run: refuse with the fix (`loop:true`, `locomotion:true`). Test in Task 7.
5. An **empty / non-JSON Studio reply** on any new call: a named error, not a `JSON.parse` throw. Test in Task 3 (`readRig`) and reused by every new caller through `parseReply`.

---

### Task 1: Live spike — server probe through the eval bridge

No production code. Settles the spec's open risk before Task 8 depends on it.

**Files:** scratch only (`$SCRATCH/spike-server.mjs`, not committed).

**Interfaces:**
- Consumes: `runLuau(session, code, 'server', opts)` (`src/studio/luau.ts:168`), `withPlay` (`src/studio/play.ts:77`), `StudioSession` construction as `src/cli.ts` does it.
- Produces: a ledger line `Task 1: spike result: server probe via bridge = <works|fails: reason>`; if it fails, a `Ruling:` switching Task 8 to a client probe that reads the replicated model's `Animator:GetPlayingAnimationTracks()`.

- [ ] **Step 1: Run a server probe in ~/blox-fw**

Studio has `steal.rbxl` open and `~/blox-fw/blox.config.json` has `bridge.eval: true`. Run from `~/blox-fw`:

```bash
cd ~/blox-fw && npx tsx ~/blox/src/cli.ts play start && \
npx tsx ~/blox/src/cli.ts luau --context server 'local CS = game:GetService("CollectionService") local m = Instance.new("Model") m.Parent = workspace CS:AddTag(m, "BloxAnimated") local n = #CS:GetTagged("BloxAnimated") m:Destroy() return { ok = true, tagged = n, server = game:GetService("RunService"):IsServer() }' ; \
npx tsx ~/blox/src/cli.ts play stop
```

Expected: the luau result shows `{"ok":true,"tagged":1,"server":true}` (as an object or JSON string).

- [ ] **Step 2: Record the result in the ledger**

Append `Task 1: spike result: ...` to `.superpowers/sdd/2026-10-02-model-rig-npc-animation/progress.md`. If it failed, add the Ruling described under Produces.

---

### Task 2: Vendor model-rig, rig-declarations, body-plans (+ fixtures, tests)

**Files:**
- Create: `src/anim/model-rig.ts`, `src/anim/rig-declarations.ts`, `src/anim/body-plans.ts` (copied from Roqer)
- Create: `tests/fixtures/anim/parts-dog.ts`, `tests/fixtures/anim/parts-octopus.ts`
- Create: `tests/anim.model-rig.test.ts`, `tests/anim.rig-declarations.test.ts`, `tests/anim.body-plans.test.ts`
- Replace: `tests/anim.gait.test.ts`, `tests/anim.wave.test.ts` (Roqer's full versions)
- Modify: `src/anim/animation-tool.ts:296` (`RoqerModelAnimate` → `BloxModelAnimate`), `src/anim/VENDOR.md`

**Interfaces:**
- Produces: `rigFromModel(input: unknown): ModelRigResult`, `type ModelRigReading`, `MAX_RIG_JOINTS = 64`, `MAX_RIG_PARTS = 128`, `MAX_WELDED_PARTS = 256` (`model-rig.ts`); `declareRig`, `RIG_ATTRIBUTE = 'BloxRig'` (`rig-declarations.ts`); `planDeclarations(plan, joints: PlanJoint[])`, `mergeDeclarations(planned, given)`, `BODY_PLANS = ['quadruped','custom']`, `type PlanJoint = {name, parentPart, childPart}` (`body-plans.ts`); fixtures `partsDog({knees?, declarations?})`, `kneeDeclarations()`, `LEG_ROOTS`, `partsOctopus`, `armDeclarations`, `ARMS`, `armJoints`.

- [ ] **Step 1: Copy sources and fixtures**

```bash
R=/tmp/claude-1000/-home-myen-blox/238e5717-754d-46d3-9e7c-45226cb930e3/scratchpad/roqer
[ -d $R ] || { git clone -q https://github.com/S4US/Roqer $R && git -C $R checkout -q 4dcb9a7; }
A=$R/packages/core/src/animation; T=$R/packages/core/src/__tests__
cp $A/model-rig.ts $A/rig-declarations.ts $A/body-plans.ts src/anim/
mkdir -p tests/fixtures/anim && cp $T/fixtures/parts-dog.ts $T/fixtures/parts-octopus.ts tests/fixtures/anim/
cp $T/model-rig.test.ts tests/anim.model-rig.test.ts
cp $T/rig-declarations.test.ts tests/anim.rig-declarations.test.ts
cp $T/gait.test.ts tests/anim.gait.test.ts
cp $T/wave.test.ts tests/anim.wave.test.ts
sed -i "s#'../../animation/#'../../../src/anim/#" tests/fixtures/anim/*.ts
sed -i -e "s#'../animation/#'../src/anim/#" -e "s#'./fixtures/#'./fixtures/anim/#" -e "s#from '@jest/globals'#from 'vitest'#" -e "s#from 'zlib'#from 'node:zlib'#" tests/anim.model-rig.test.ts tests/anim.rig-declarations.test.ts tests/anim.gait.test.ts tests/anim.wave.test.ts
grep -rl "RoqerRig\|RoqerModelAnimate" src/anim tests/anim.*.test.ts | xargs sed -i -e 's/RoqerRig/BloxRig/g' -e 's/RoqerModelAnimate/BloxModelAnimate/g'
```

- [ ] **Step 2: Remove the GLB-preview cases**

`rig-glb.ts` is not vendored (3D preview, out of scope). In `tests/anim.model-rig.test.ts` delete the `import { renderRigGlb } ...` line and every `test(...)`/`describe(...)` block whose body calls `renderRigGlb`. Run `grep -n renderRigGlb tests/anim.model-rig.test.ts`.
Expected: no output.

- [ ] **Step 3: Write the body-plan test**

`tests/anim.body-plans.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mergeDeclarations, planDeclarations } from '../src/anim/body-plans.js';
import { rigFromModel } from '../src/anim/model-rig.js';
import { partsDog } from './fixtures/anim/parts-dog.js';

const jointsOf = (r: ReturnType<typeof partsDog>) => r.joints.map((j) => ({ name: j.name, parentPart: j.part0, childPart: j.part1 }));

describe('body plans', () => {
  it('quadruped declares feet, knees and ranges from part names, and the rig accepts them', () => {
    const reading = partsDog({ knees: true });
    const planned = planDeclarations('quadruped', jointsOf(reading));
    expect(planned.feet).toEqual(['FrontLeftLower', 'FrontRightLower', 'HindLeftLower', 'HindRightLower']);
    expect(planned.hinges?.FrontLeftKnee).toEqual({ axis: 'X', flex: -1 });
    expect(planned.hinges?.HindLeftKnee).toEqual({ axis: 'X', flex: 1 });
    const r = rigFromModel({ ...reading, declarations: JSON.stringify(planned) });
    expect(r.ok && r.rig.feet.length).toBe(4);
  });
  it('custom declares only what is given; given values win joint by joint', () => {
    expect(planDeclarations('custom', jointsOf(partsDog()))).toEqual({ version: 1 });
    const merged = mergeDeclarations(planDeclarations('quadruped', jointsOf(partsDog({ knees: true }))), { limits: { Tail: { turn: 30 } } });
    expect((merged.limits as Record<string, unknown>).Tail).toEqual({ turn: 30 });
    expect((merged.limits as Record<string, unknown>).FrontLeft).toEqual({ turn: 120 });
  });
});
```

- [ ] **Step 4: Run the vendored and new tests**

Run: `npx vitest run tests/anim.model-rig.test.ts tests/anim.rig-declarations.test.ts tests/anim.body-plans.test.ts tests/anim.gait.test.ts tests/anim.wave.test.ts > $WS/t2.log 2>&1; tail -20 $WS/t2.log`
Expected: all pass. A failure from a renamed string (`RoqerRig.` in an expectation) means Step 1's sed missed a file: rerun it on that file. Any other failure: systematic-debugging (vendored code is unchanged, so a failure is an import path or a jest-only API such as `test.each` template syntax).

- [ ] **Step 5: Update VENDOR.md, typecheck, commit**

Replace the last paragraph of `src/anim/VENDOR.md` ("Not vendored (spec B): ...") with:

```markdown
Spec B (model rigs) adds model-rig, rig-declarations and body-plans, with
their tests (tests/anim.model-rig, anim.rig-declarations; gait and wave now
ported whole) and the parts-dog / parts-octopus fixtures
(tests/fixtures/anim/). Local changes: `RoqerRig` → `BloxRig`,
`RoqerModelAnimate` → `BloxModelAnimate`; model-rig's GLB-preview test cases
are removed (rig-glb is not vendored).

Not vendored: rig-build, rig-glb, rig-tool (spec C: building rigs).
```

```bash
npx tsc --noEmit && git add src/anim tests/anim.*.test.ts tests/fixtures/anim && git commit -m "anim: vendor model-rig, rig-declarations, body-plans (BloxRig)"
```

---

### Task 3: `modelRig.ts` — read a model's rig in Studio

**Files:**
- Create: `src/anim/modelRig.ts`
- Modify: `src/anim/store.ts` (add `saveRigReading`, `loadRigReading`, `clearRigReading`, `loadReport`)
- Test: `tests/anim.modelRig.test.ts`

**Interfaces:**
- Consumes: `rigFromModel`, `ModelRigReading` (Task 2); `runLuau` (`src/studio/luau.ts`), `longString`; `RIGS` (`src/anim/rigs.ts`).
- Produces:
  - `parseReply(values: unknown[], what: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string }`
  - `modelPath(input: string): string` — strips a leading `game.`
  - `rigRevision(reading: Omit<ModelRigReading, 'revision'>): string` — `rr1:` + 16 hex
  - `READ_RIG_LUAU: string`, `readRigProgram(path: string, bare: boolean): string`
  - `type RigRead = { ok: true; reading: ModelRigReading; rig: Rig; notes: string[]; rigType?: 'R15' | 'R6'; walkSpeed?: number } | { ok: false; error: string; code?: string }`
  - `readRig(session: StudioSession, path: string, opts?: { bare?: boolean }): Promise<RigRead>`
  - `rigForSequence(projectPath: string, seq: KeyframeSequenceDescription): Rig`
  - store: `saveRigReading(projectPath, name, reading)`, `loadRigReading(projectPath, name): ModelRigReading | null`, `clearRigReading(projectPath, name)`, `loadReport(projectPath, name): { groundSpeed?: number } | null`

- [ ] **Step 1: Write the failing tests**

`tests/anim.modelRig.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { modelPath, parseReply, readRig, readRigProgram, rigForSequence, rigRevision } from '../src/anim/modelRig.js';
import { saveRigReading } from '../src/anim/store.js';
import { compilePoseAnimation } from '../src/anim/pose-compiler.js';
import { kneeDeclarations, partsDog } from './fixtures/anim/parts-dog.js';
import { luneBin, luneCheck } from './helpers/lune.js';
import type { StudioSession } from '../src/studio/session.js';

const envelope = (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, n: 1, values: { v1: JSON.stringify(v) }, logs: [] }) }] });
const session = (reply: unknown, codes: string[] = []) => ({ call: async (_n: string, a: Record<string, unknown>) => { codes.push(String(a.code)); return envelope(reply); } }) as unknown as StudioSession;
const dog = () => { const { revision: _r, ...rest } = partsDog({ knees: true, declarations: kneeDeclarations() }); return { ...rest, path: 'Workspace.Dog' }; };

describe('rig revision', () => {
  it('ignores the path (clones match) and joint order, and sees a moved pivot', () => {
    const a = dog();
    expect(rigRevision({ ...a, path: 'Workspace.Dog2' })).toBe(rigRevision(a));
    expect(rigRevision({ ...a, joints: [...a.joints].reverse() })).toBe(rigRevision(a));
    const moved = structuredClone(a);
    moved.joints[1].c0[1] += 0.1;
    expect(rigRevision(moved)).not.toBe(rigRevision(a));
    expect(rigRevision(a)).toMatch(/^rr1:[0-9a-f]{16}$/);
  });
});

describe('readRig', () => {
  it('turns a reading into a rig and adds the revision', async () => {
    const codes: string[] = [];
    const r = await readRig(session({ ok: true, reading: dog(), rigType: 'R15', walkSpeed: 16 }, codes), 'game.Workspace.Dog');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rig.name).toBe('Workspace.Dog');
    expect(r.reading.revision).toBe(rigRevision(dog()));
    expect(r.rig.feet.length).toBe(4);
    expect(codes[0]).toContain('local PAYLOAD = ');
    expect(codes[0]).not.toMatch(/resolve\("Workspace/); // the path reaches Luau only inside the payload
  });
  it('passes a Studio refusal through with its code', async () => {
    const r = await readRig(session({ ok: false, code: 'not_rigged', error: 'Workspace.Box has no Motor6D ... rig building is not supported yet' }), 'Workspace.Box');
    expect(r).toMatchObject({ ok: false, code: 'not_rigged' });
  });
  it('refuses a reading rigFromModel rejects, naming the problems', async () => {
    const bad = dog();
    bad.joints = bad.joints.filter((j) => j.name !== 'Root');
    const r = await readRig(session({ ok: true, reading: bad }), 'Workspace.Dog');
    expect(r.ok).toBe(false);
  });
  it('an empty or non-JSON reply is a named error', () => {
    expect(parseReply([], 'rig read')).toEqual({ ok: false, error: 'rig read: Studio returned no reply' });
    expect(parseReply(['<html>'], 'rig read')).toMatchObject({ ok: false, error: expect.stringMatching(/^rig read: Studio returned non-JSON/) });
    expect(parseReply([{ ok: true }], 'x')).toEqual({ ok: true, value: { ok: true } });
  });
  it('modelPath strips game.', () => {
    expect(modelPath('game.Workspace.Dog')).toBe('Workspace.Dog');
    expect(modelPath('Workspace.Dog')).toBe('Workspace.Dog');
  });
});

describe('rigForSequence', () => {
  it('stock names map to stock rigs; a model path to the saved reading', () => {
    const P = mkdtempSync(join(tmpdir(), 'blox-mrig-'));
    const reading = { ...dog(), revision: rigRevision(dog()) };
    saveRigReading(P, 'DogWalk', reading);
    const c = compilePoseAnimation({ name: 'DogWalk', rig: 'R15', loop: true, duration: 1, keyframes: [{ time: 0, pose: {} }, { time: 1, pose: {} }] });
    if (!c.ok) throw new Error(c.errors.join());
    expect(rigForSequence(P, c.sequence).name).toBe('R15');
    expect(rigForSequence(P, { ...c.sequence, name: 'DogWalk', rig: 'Workspace.Dog' }).name).toBe('Workspace.Dog');
    expect(() => rigForSequence(P, { ...c.sequence, name: 'Other', rig: 'Workspace.Dog' })).toThrow(/check it again/);
    writeFileSync(join(P, 'x'), '');
  });
});

describe('rig read Luau compiles', () => {
  it.skipIf(!luneBin())('read program', () => {
    const d = mkdtempSync(join(tmpdir(), 'blox-mrigluau-'));
    writeFileSync(join(d, 'read.luau'), readRigProgram('Workspace.Dog', false));
    expect(luneCheck([join(d, 'read.luau')])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/anim.modelRig.test.ts 2>&1 | tail -5`
Expected: FAIL — cannot find module `../src/anim/modelRig.js`.

- [ ] **Step 3: Add the store helpers**

Append to `src/anim/store.ts`:

```ts
import { rmSync } from 'node:fs';
import type { ModelRigReading } from './model-rig.js';

// A model rig's reading as check saw it: build and wire compare its revision.
export function saveRigReading(projectPath: string, name: string, reading: ModelRigReading): void {
  const dir = animDir(projectPath, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'rig.json'), JSON.stringify(reading, null, 2));
}

export function loadRigReading(projectPath: string, name: string): ModelRigReading | null {
  const f = join(animDir(projectPath, name), 'rig.json');
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as ModelRigReading) : null;
}

export function clearRigReading(projectPath: string, name: string): void {
  rmSync(join(animDir(projectPath, name), 'rig.json'), { force: true });
}

export function loadReport(projectPath: string, name: string): { groundSpeed?: number } | null {
  const f = join(animDir(projectPath, name), 'report.json');
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as { groundSpeed?: number }) : null;
}
```

(Merge the `rmSync` import into the existing `node:fs` import line.)

- [ ] **Step 4: Write `src/anim/modelRig.ts`**

```ts
import { createHash } from 'node:crypto';
import { longString, runLuau } from '../studio/luau.js';
import type { StudioSession } from '../studio/session.js';
import { rigFromModel, type ModelRigReading } from './model-rig.js';
import type { KeyframeSequenceDescription } from './pose-compiler.js';
import type { Rig } from './rig.js';
import { RIGS } from './rigs.js';
import { loadRigReading } from './store.js';

// Reading a model's own rig (Motor6Ds and AnimationConstraints between its
// parts) in Studio's edit thread, and turning it into a Rig the compiler,
// checks and contact sheet take like R15's. Port of Roqer's animatedModel,
// readModelRig and copyRefusal, without Bones (model animate, PR #68) or meshes.

/** A Studio reply's first value as an object: the envelope hands back a JSON string or a table. */
export function parseReply(values: unknown[], what: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const v = values[0];
  if (v === undefined || v === null || v === '') return { ok: false, error: `${what}: Studio returned no reply` };
  if (typeof v === 'object') return { ok: true, value: v as Record<string, unknown> };
  try {
    const parsed = JSON.parse(String(v)) as unknown;
    if (typeof parsed === 'object' && parsed !== null) return { ok: true, value: parsed as Record<string, unknown> };
  } catch { /* fall through */ }
  return { ok: false, error: `${what}: Studio returned non-JSON: ${String(v).slice(0, 200)}` };
}

export function modelPath(input: string): string {
  return input.replace(/^game\./, '');
}

const fmt = (n: number) => String(Math.round(n * 1e6) / 1e6);
const list = (v: readonly number[]) => v.map(fmt).join(',');

/**
 * A digest of everything the compiler, checks and previews take from a
 * reading; not its path, so a clone of the model reads as the same rig, and
 * not welded offsets, which moving a model jitters (Roqer's rigRevision).
 */
export function rigRevision(r: Omit<ModelRigReading, 'revision'>): string {
  const out = [`c:${r.controller}:${r.rootPart}:${fmt(r.hipHeight ?? 0)}`];
  for (const p of [...r.parts].sort((a, b) => (a.name < b.name ? -1 : 1))) out.push(`p:${p.name}:${list(p.size)}:${p.shape ?? 'Block'}:${p.hidden === true}`);
  for (const j of [...r.joints].sort((a, b) => (a.part1 < b.part1 ? -1 : 1))) out.push(`j:${j.name}:${j.part0}:${j.part1}:${list(j.c0)}:${list(j.c1)}`);
  for (const w of [...(r.welded ?? [])].sort((a, b) => (`${a.to}/${a.name}` < `${b.to}/${b.name}` ? -1 : 1))) out.push(`w:${w.name}:${w.to}:${list(w.size)}:${w.shape ?? 'Block'}`);
  out.push(`d:${r.declarations ?? ''}`);
  return `rr1:${createHash('sha256').update(out.join('\n')).digest('hex').slice(0, 16)}`;
}

// Shared Luau: resolve a model path and read its rig. Used by the read, build
// and wire programs. Returns { ok = false, code, error } or { ok = true, ... }.
export const RESOLVE_LUAU = `local function resolve(path)
	local node = game
	for seg in string.gmatch(path, "[^%.]+") do
		node = node:FindFirstChild(seg)
		if not node then return nil end
	end
	return node
end
local function animatedModel(path)
	local model = resolve(path)
	if not model then return nil, "not_found", path .. " does not exist" end
	if not model:IsA("Model") then return nil, "not_model", path .. " is a " .. model.ClassName .. ", not a Model" end
	local Players = game:GetService("Players")
	if Players:GetPlayerFromCharacter(model) or model:IsDescendantOf(Players) or model:IsDescendantOf(game:GetService("StarterPlayer")) then
		return nil, "player_character", path .. " is a player's character; wire its Animate slots with slot instead"
	end
	if not (model:IsDescendantOf(workspace) or model:IsDescendantOf(game:GetService("ServerStorage")) or model:IsDescendantOf(game:GetService("ReplicatedStorage"))) then
		return nil, "bad_location", path .. " must be under Workspace, ServerStorage or ReplicatedStorage"
	end
	local controller = model:FindFirstChildOfClass("Humanoid") or model:FindFirstChildOfClass("AnimationController")
	if not controller then return nil, "no_controller", path .. " has no Humanoid or AnimationController to animate" end
	return model, controller
end
`;

export const READ_RIG_LUAU = `local function r6(v) return math.round(v * 1e6) / 1e6 end
local function comps(c) local o = {} for _, v in { c:GetComponents() } do table.insert(o, r6(v)) end return o end
local function size(p) return { r6(p.Size.X), r6(p.Size.Y), r6(p.Size.Z) } end
local function shape(p)
	if p:IsA("WedgePart") then return "Wedge" end
	if p:IsA("Part") then
		if p.Shape == Enum.PartType.Ball then return "Ball" end
		if p.Shape == Enum.PartType.Cylinder then return "Cylinder" end
		if p.Shape == Enum.PartType.Wedge then return "Wedge" end
	end
	return "Block"
end
local function holdsRig(i)
	local function needed(c)
		return c:IsA("BasePart") or c:IsA("JointInstance") or c:IsA("WeldConstraint") or c:IsA("Constraint") or c:IsA("Attachment") or c:IsA("Humanoid") or c:IsA("AnimationController") or c:IsA("Animator")
	end
	if needed(i) then return true end
	for _, d in i:GetDescendants() do if needed(d) then return true end end
	return false
end
local function copyRefusal(model)
	local path = model:GetFullName()
	if not model.Archivable then return path .. " cannot be archived, so it cannot be copied to play on" end
	for _, d in model:GetDescendants() do
		if not d.Archivable and holdsRig(d) then return d:GetFullName() .. " cannot be archived, so a copy of " .. path .. " would leave it out; make it archivable" end
		local held = {}
		if d:IsA("JointInstance") or d:IsA("WeldConstraint") or d:IsA("NoCollisionConstraint") then held = { d.Part0, d.Part1 }
		elseif d:IsA("Constraint") then held = { d.Attachment0 and d.Attachment0.Parent, d.Attachment1 and d.Attachment1.Parent } end
		for _, p in held do
			if p and not p:IsDescendantOf(model) then return d:GetFullName() .. " holds " .. p:GetFullName() .. ", outside " .. path .. ", which a copy would still hold" end
		end
	end
	return nil
end
local function weldedPair(i)
	local a, b
	if i:IsA("Weld") or i:IsA("ManualWeld") or i:IsA("Snap") or i:IsA("Glue") or i:IsA("WeldConstraint") then a, b = i.Part0, i.Part1
	elseif i:IsA("RigidConstraint") then a, b = i.Attachment0 and i.Attachment0.Parent, i.Attachment1 and i.Attachment1.Parent end
	if a and b and a:IsA("BasePart") and b:IsA("BasePart") then return a, b end
	return nil
end
local function weldedParts(model, rigParts)
	local neighbours = {}
	local function link(a, b) neighbours[a] = neighbours[a] or {} table.insert(neighbours[a], b) end
	for _, d in model:GetDescendants() do
		local a, b = weldedPair(d)
		if a and a:IsDescendantOf(model) and b:IsDescendantOf(model) then link(a, b) link(b, a) end
	end
	local host, queue = {}, {}
	for p in rigParts do table.insert(queue, p) end
	local i = 1
	while i <= #queue do
		local p = queue[i]
		i += 1
		local reached = rigParts[p] and p or host[p]
		for _, n in neighbours[p] or {} do
			if not rigParts[n] and not host[n] then host[n] = reached table.insert(queue, n) end
		end
	end
	local visible = {}
	for p in host do if p.Transparency < 0.99 then table.insert(visible, p) end end
	local function vol(p) return p.Size.X * p.Size.Y * p.Size.Z end
	table.sort(visible, function(a, b) if vol(a) == vol(b) then return a:GetFullName() < b:GetFullName() end return vol(a) > vol(b) end)
	local out = {}
	for k = 1, math.min(#visible, ${256}) do
		local p = visible[k]
		local to = host[p]
		table.insert(out, { name = p.Name, to = to.Name, offset = comps(to.CFrame:ToObjectSpace(p.CFrame)), size = size(p), shape = shape(p) })
	end
	return out, #visible - #out
end
local function readModelRig(path, bare)
	local model, controller, err = animatedModel(path)
	if not model then return { ok = false, code = controller, error = err } end
	local joints = {}
	for _, d in model:GetDescendants() do
		if d:IsA("Motor6D") then
			local a, b = d.Part0, d.Part1
			if a and b and a:IsDescendantOf(model) and b:IsDescendantOf(model) then table.insert(joints, { name = d.Name, part0 = a, part1 = b, c0 = d.C0, c1 = d.C1 }) end
		elseif d:IsA("AnimationConstraint") then
			local a0, a1 = d.Attachment0, d.Attachment1
			local a, b = a0 and a0.Parent, a1 and a1.Parent
			if a and b and a:IsA("BasePart") and b:IsA("BasePart") and a:IsDescendantOf(model) and b:IsDescendantOf(model) then
				table.insert(joints, { name = d.Name, part0 = a, part1 = b, c0 = a0.CFrame, c1 = a1.CFrame })
			end
		end
	end
	if #joints == 0 then return { ok = false, code = "not_rigged", error = path .. " has no Motor6D or AnimationConstraint joints between its parts. Rig building is not supported yet; rig it in Studio (Rig Builder / RigEdit) or Blender" } end
	if #joints > 64 then return { ok = false, code = "rig_too_large", error = path .. " has " .. #joints .. " joints; blox animates a rig of at most 64" } end
	local humanoid = controller:IsA("Humanoid") and controller or nil
	local root
	if humanoid then
		root = humanoid.RootPart
		if not root then return { ok = false, code = "rig_root", error = path .. "'s Humanoid has no root part; give it a HumanoidRootPart" } end
	else
		local moved, roots = {}, {}
		for _, j in joints do moved[j.part1] = true end
		for _, j in joints do if not moved[j.part0] and not table.find(roots, j.part0) then table.insert(roots, j.part0) end end
		if model.PrimaryPart and table.find(roots, model.PrimaryPart) then root = model.PrimaryPart
		elseif #roots == 1 then root = roots[1]
		else return { ok = false, code = "rig_root", error = path .. "'s joints hang from " .. #roots .. " parts that nothing moves; set its PrimaryPart to the one the rig hangs from" } end
	end
	local nodes, partList = {}, {}
	local function add(p) if not nodes[p] then nodes[p] = true table.insert(partList, p) end end
	add(root)
	for _, j in joints do add(j.part0) add(j.part1) end
	if #partList > 128 then return { ok = false, code = "rig_too_large", error = path .. "'s joints join " .. #partList .. " parts; blox animates a rig of at most 128" } end
	local seen = {}
	for _, p in partList do
		if seen[p.Name] then return { ok = false, code = "duplicate_names", error = path .. " has two rig parts named " .. p.Name .. "; poses find parts by name, so rename one" } end
		seen[p.Name] = true
	end
	local declared = model:GetAttribute("BloxRig")
	if declared ~= nil and typeof(declared) ~= "string" then return { ok = false, code = "invalid_declarations", error = path .. "'s BloxRig attribute is a " .. typeof(declared) .. "; it must be JSON text" } end
	local refusal = copyRefusal(model)
	if refusal then return { ok = false, code = "not_copyable", error = refusal } end
	local parts = {}
	for _, p in partList do
		local entry = { name = p.Name, size = size(p), shape = shape(p) }
		if p.Transparency >= 0.99 then entry.hidden = true end
		table.insert(parts, entry)
	end
	table.sort(parts, function(a, b) return a.name < b.name end)
	local outJoints = {}
	for _, j in joints do table.insert(outJoints, { name = j.name, part0 = j.part0.Name, part1 = j.part1.Name, c0 = comps(j.c0), c1 = comps(j.c1) }) end
	local welded, leftOut = weldedParts(model, nodes)
	local reading = { path = model:GetFullName(), rootPart = root.Name, controller = controller.ClassName, parts = parts, joints = outJoints }
	if humanoid then reading.hipHeight = r6(humanoid.HipHeight) end
	if declared ~= nil and not bare then reading.declarations = declared end
	if #welded > 0 then reading.welded = welded end
	if leftOut > 0 then reading.weldedLeftOut = leftOut end
	return { ok = true, reading = reading, rigType = humanoid and humanoid.RigType.Name or nil, walkSpeed = humanoid and humanoid.WalkSpeed or nil }
end
`;

export function readRigProgram(path: string, bare: boolean): string {
  return `local PAYLOAD = ${longString(JSON.stringify({ path: modelPath(path), bare }))}
local HS = game:GetService("HttpService")
local P = HS:JSONDecode(PAYLOAD)
${RESOLVE_LUAU}${READ_RIG_LUAU}return HS:JSONEncode(readModelRig(P.path, P.bare))`;
}

export type RigRead =
  | { ok: true; reading: ModelRigReading; rig: Rig; notes: string[]; rigType?: 'R15' | 'R6'; walkSpeed?: number }
  | { ok: false; error: string; code?: string };

export async function readRig(session: StudioSession, path: string, opts: { bare?: boolean } = {}): Promise<RigRead> {
  const r = await runLuau(session, readRigProgram(path, opts.bare === true), 'edit', { chunkName: 'animateReadRig', timeoutMs: 60_000 });
  if (!r.ok) return { ok: false, error: `reading ${path} failed in Studio: ${r.error?.message}` };
  const p = parseReply(r.values, 'rig read');
  if (!p.ok) return p;
  const v = p.value as { ok?: boolean; code?: string; error?: string; reading?: Omit<ModelRigReading, 'revision'>; rigType?: 'R15' | 'R6'; walkSpeed?: number };
  if (!v.ok || !v.reading) return { ok: false, error: v.error ?? 'the rig read failed', code: v.code };
  const reading: ModelRigReading = { ...v.reading, revision: rigRevision(v.reading) };
  const built = rigFromModel(reading);
  if (!built.ok) return { ok: false, code: 'invalid_rig', error: `${reading.path} cannot be animated:\n${built.errors.map((e) => `  ${e}`).join('\n')}` };
  return { ok: true, reading, rig: built.rig, notes: built.notes, ...(v.rigType ? { rigType: v.rigType } : {}), ...(typeof v.walkSpeed === 'number' ? { walkSpeed: v.walkSpeed } : {}) };
}

/** The rig a compiled sequence was checked on: a stock rig, or the model reading check saved. */
export function rigForSequence(projectPath: string, seq: KeyframeSequenceDescription): Rig {
  const stock = RIGS.get(seq.rig);
  if (stock) return stock;
  const reading = loadRigReading(projectPath, seq.name);
  if (!reading || reading.path !== seq.rig) throw new Error(`${seq.name} has no saved rig reading for ${seq.rig}: check it again`);
  const built = rigFromModel(reading);
  if (!built.ok) throw new Error(`${seq.name}'s saved rig no longer reads: ${built.errors.join('; ')}; check it again`);
  return built.rig;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/anim.modelRig.test.ts 2>&1 | tail -15`
Expected: PASS (lune case skips only without lune). If `readRig`'s happy case fails inside `rigFromModel` because the fixture's `revision` field is required by validation, that is expected-shape drift: the reading passed to `rigFromModel` includes `revision` — check `rigFromModel`'s validation message and fix the call, not the fixture.

- [ ] **Step 6: Typecheck, commit**

```bash
npx tsc --noEmit && git add src/anim/modelRig.ts src/anim/store.ts tests/anim.modelRig.test.ts && git commit -m "anim: read a model's Motor6D rig from Studio"
```

---

### Task 4: `rig` and `declare` actions

**Files:**
- Modify: `src/anim/tool.ts` (shape + two actions), `src/anim/modelRig.ts` (add `DECLARE_LUAU`, `declareProgram`, `skippedChecks`)
- Test: `tests/anim.rigtool.test.ts`

**Interfaces:**
- Consumes: `readRig`, `parseReply`, `modelPath`, `RESOLVE_LUAU` (Task 3); `planDeclarations`, `mergeDeclarations`, `BODY_PLANS` (Task 2); `rigFromModel`; `describeRig` (`animation-tool.ts:544`).
- Produces:
  - `skippedChecks(rig: Rig): string[]` — human lines naming checks a missing declaration disables
  - `declareProgram(path: string, text: string, expectRevision: string): string` — edit program; refuses `code:"changed"` when the bare re-read revision differs
  - `animateShape` gains `model: z.string().optional()`, `plan: z.enum(BODY_PLANS).optional()`, `declarations: z.record(z.string(), z.unknown()).optional()`, `state`, `at`, `parent`, `target` (declared here once for all later tasks; see Step 3), and `rig` widens to `z.string()`.

- [ ] **Step 1: Write the failing tests**

`tests/anim.rigtool.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findTool, invokeTool, type ToolCtx } from '../src/tools/registry.js';
import { BloxConfigSchema } from '../src/config.js';
import { partsDog } from './fixtures/anim/parts-dog.js';
import type { StudioSession } from '../src/studio/session.js';

const envelope = (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, n: 1, values: { v1: JSON.stringify(v) }, logs: [] }) }] });
function ctx(reply: (code: string) => unknown, codes: string[] = []): ToolCtx {
  const session = { call: async (_n: string, a: Record<string, unknown>) => { codes.push(String(a.code)); return envelope(reply(String(a.code))); } } as unknown as StudioSession;
  const projectPath = mkdtempSync(join(tmpdir(), 'blox-rigtool-'));
  return { session, projectPath, config: BloxConfigSchema.parse({ projectPath }), agent: 'test' };
}
const call = (args: Record<string, unknown>, c: ToolCtx) => invokeTool(findTool('animate')!, args, c);
const bareDog = (declarations?: string) => { const { revision: _r, ...rest } = partsDog({ knees: true }); return { ...rest, path: 'Workspace.Dog', ...(declarations ? { declarations } : {}) }; };

describe('animate rig', () => {
  it('summarizes the rig and names the checks a missing declaration disables', async () => {
    const r = await call({ action: 'rig', model: 'Workspace.Dog' }, ctx(() => ({ ok: true, reading: bareDog() })));
    expect(r.isError, r.text).toBeFalsy();
    expect(r.text).toMatch(/FrontLeftKnee/);
    expect(r.text).toMatch(/groundContact, footSliding and gaitSymmetry are not checked/);
    expect(r.text).toMatch(/plan:"quadruped"/);
  });
  it('passes a Studio refusal through', async () => {
    const r = await call({ action: 'rig', model: 'Workspace.Box' }, ctx(() => ({ ok: false, code: 'not_rigged', error: 'Workspace.Box has no Motor6D ... rig building is not supported yet' })));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not supported yet/);
  });
});

describe('animate declare', () => {
  it('reads bare, merges the plan, validates, then writes BloxRig once', async () => {
    const codes: string[] = [];
    const c = ctx((code) => (code.includes('BloxRigWrite') ? { ok: true, written: true } : { ok: true, reading: bareDog() }), codes);
    const r = await call({ action: 'declare', model: 'Workspace.Dog', plan: 'quadruped' }, c);
    expect(r.isError, r.text).toBeFalsy();
    expect(codes[0]).toMatch(/"bare":true/);
    const writes = codes.filter((x) => x.includes('BloxRigWrite'));
    expect(writes.length).toBe(1);
    expect(writes[0]).toMatch(/FrontLeftLower/);
    expect(r.text).toMatch(/feet/);
  });
  it('a malformed existing BloxRig does not block declare (bare read)', async () => {
    const codes: string[] = [];
    const c = ctx((code) => (code.includes('BloxRigWrite') ? { ok: true, written: true } : code.includes('"bare":true') ? { ok: true, reading: bareDog() } : { ok: true, reading: bareDog('{not json') }), codes);
    const r = await call({ action: 'declare', model: 'Workspace.Dog', plan: 'quadruped' }, c);
    expect(r.isError, r.text).toBeFalsy();
  });
  it('invalid declarations write nothing and list every problem', async () => {
    const codes: string[] = [];
    const c = ctx((code) => (code.includes('BloxRigWrite') ? { ok: true } : { ok: true, reading: bareDog() }), codes);
    const r = await call({ action: 'declare', model: 'Workspace.Dog', declarations: { version: 1, feet: ['NoSuchPart'] } }, c);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/NoSuchPart/);
    expect(codes.some((x) => x.includes('BloxRigWrite'))).toBe(false);
  });
  it('needs plan or declarations', async () => {
    const r = await call({ action: 'declare', model: 'Workspace.Dog' }, ctx(() => ({})));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/plan.*declarations/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/anim.rigtool.test.ts 2>&1 | tail -8`
Expected: FAIL — schema rejects `action:"rig"` (invalid enum value) or the tool returns "unknown action".

- [ ] **Step 3: Widen the shape**

In `src/anim/tool.ts` replace `animateShape` with:

```ts
export const animateShape = {
  action: z.enum(['recipes', 'check', 'build', 'wire', 'verify', 'rig', 'declare', 'npc']),
  name: z.string().optional(),
  animation: z.record(z.string(), z.unknown()).optional().describe('check: the pose description (see the character-animation skill)'),
  locomotion: z.boolean().optional(),
  grounded: z.boolean().optional(),
  waive: z.array(z.enum(MOTION_CHECK_IDS as unknown as [string, ...string[]])).optional(),
  force: z.boolean().optional(),
  slot: z.enum(ANIMATE_SLOTS as unknown as [string, ...string[]]).optional(),
  asset: z.union([z.string(), z.number()]).optional(),
  replaces: z.union([z.string(), z.number()]).optional(),
  rig: z.string().optional().describe('R15, R6, or (npc) the stock body; check reads the rig from animation.rig'),
  model: z.string().optional().describe('a model path, e.g. Workspace.Dog'),
  plan: z.enum(BODY_PLANS as unknown as [string, ...string[]]).optional(),
  declarations: z.record(z.string(), z.unknown()).optional(),
  state: z.enum(MODEL_STATES as unknown as [string, ...string[]]).optional(),
  at: z.array(z.number()).length(3).optional(),
  parent: z.string().optional(),
  target: z.array(z.number()).length(3).optional(),
};
```

Add imports: `BODY_PLANS, mergeDeclarations, planDeclarations` from `./body-plans.js`; `MODEL_STATES, describeRig` from `./animation-tool.js`; `rigFromModel` from `./model-rig.js`; `readRig, declareProgram, skippedChecks, parseReply, modelPath` from `./modelRig.js`. In the `wire` branch, keep `rig` validation for slots: `if (rig !== 'R15' && rig !== 'R6') return err('wire with slot takes rig:"R15" or rig:"R6"', 'bad rig')` before `planWire`.

- [ ] **Step 4: Add `skippedChecks`, `DECLARE_LUAU`, `declareProgram` to modelRig.ts**

```ts
/** What the checks cannot judge on a rig for want of declarations, and the call that would let them. */
export function skippedChecks(rig: Rig): string[] {
  const out: string[] = [];
  if (rig.feet.length === 0) out.push('no feet declared: groundContact, footSliding and gaitSymmetry are not checked (and gaits cannot be used) — animate {action:"declare", model, plan:"quadruped"} or declarations.feet');
  const free = rig.joints.filter((j) => rig.limits[j.name] === undefined).map((j) => j.name);
  if (free.length) out.push(`no range declared for ${free.join(', ')}: jointLimits does not judge them — declarations.limits`);
  return out;
}

const DECLARE_LUAU = `local model = resolve(P.path)
if not model then return HS:JSONEncode({ ok = false, error = P.path .. " does not exist" }) end
local now = readModelRig(P.path, true)
if not now.ok then return HS:JSONEncode(now) end
if now.fingerprint ~= P.expect then return HS:JSONEncode({ ok = false, code = "changed", error = P.path .. " changed while blox was declaring it; run declare again" }) end
local CHS = game:GetService("ChangeHistoryService")
local rec
pcall(function() rec = CHS:TryBeginRecording("blox animate declare") end)
model:SetAttribute("BloxRig", P.text)
if rec then pcall(function() CHS:FinishRecording(rec, Enum.FinishRecordingOperation.Commit) end) end
return HS:JSONEncode({ ok = true, written = true })`;
```

The TS revision (sha256) cannot be recomputed in Luau, so the read-then-write guard compares a Luau-side fingerprint of the joints, computed identically by the read and the write. Add to `READ_RIG_LUAU`, before `readModelRig`:

```lua
local function fingerprint(reading)
	local out = {}
	for _, j in reading.joints do table.insert(out, j.name .. ":" .. j.part0 .. ":" .. j.part1 .. ":" .. table.concat(j.c0, ",") .. ":" .. table.concat(j.c1, ",")) end
	table.sort(out)
	return table.concat(out, "|")
end
```

and in `readModelRig`'s success return add `fingerprint = fingerprint(reading)`.

```ts
export function declareProgram(path: string, text: string, expectFingerprint: string): string {
  return `-- BloxRigWrite
local PAYLOAD = ${longString(JSON.stringify({ path: modelPath(path), text, expect: expectFingerprint }))}
local HS = game:GetService("HttpService")
local P = HS:JSONDecode(PAYLOAD)
${RESOLVE_LUAU}${READ_RIG_LUAU}${DECLARE_LUAU}`;
}
```

`readRig` returns the fingerprint: add `fingerprint?: string` to the ok branch of `RigRead` and pass `v.fingerprint` through.

- [ ] **Step 5: Add the actions in `animateTool`** (before the final `return err(unknown action ...)`):

```ts
  if (a.action === 'rig') {
    if (typeof a.model !== 'string') return err('rig needs model (a model path, e.g. Workspace.Dog)', 'no model');
    const r = await readRig(ctx.session, a.model);
    if (!r.ok) return err(r.error, r.code ?? 'refused');
    const lines = [JSON.stringify(describeRig(r.rig, r.notes), null, 2), ...skippedChecks(r.rig)];
    lines.push(`Next: animate {action:"check", animation:{..., rig:"${r.reading.path}"}} (the joints above are what poses may key)`);
    return { text: lines.join('\n'), summary: `${r.rig.joints.length} joints` };
  }
  if (a.action === 'declare') {
    if (typeof a.model !== 'string') return err('declare needs model', 'no model');
    if (a.plan === undefined && a.declarations === undefined) return err('declare needs plan ("quadruped" | "custom") or declarations (the BloxRig JSON; see the character-animation skill)', 'nothing to declare');
    const bare = await readRig(ctx.session, a.model, { bare: true });
    if (!bare.ok) return err(bare.error, bare.code ?? 'refused');
    const joints = bare.reading.joints.map((j) => ({ name: j.name, parentPart: j.part0, childPart: j.part1 }));
    const merged = mergeDeclarations(planDeclarations((a.plan as 'quadruped' | 'custom' | undefined) ?? 'custom', joints), a.declarations as Record<string, unknown> | undefined);
    const text = JSON.stringify(merged);
    const trial = rigFromModel({ ...bare.reading, declarations: text });
    if (!trial.ok) return err(`not written; the declarations do not fit ${bare.reading.path}:\n${trial.errors.map((e) => `  ${e}`).join('\n')}`, 'invalid');
    const w = await runLuau(ctx.session, declareProgram(a.model, text, bare.fingerprint ?? ''), 'edit', { chunkName: 'animateDeclare', timeoutMs: 60_000 });
    if (!w.ok) return err(`write failed in Studio: ${w.error?.message}`, 'studio error');
    const p = parseReply(w.values, 'declare');
    if (!p.ok) return err(p.error, 'studio error');
    if (p.value.ok !== true) return err(String(p.value.error ?? 'declare refused'), String(p.value.code ?? 'refused'));
    const lines = [`wrote BloxRig on ${bare.reading.path}:`, JSON.stringify(describeRig(trial.rig, trial.notes), null, 2), ...skippedChecks(trial.rig)];
    return { text: lines.join('\n'), summary: 'declared' };
  }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/anim.rigtool.test.ts tests/anim.modelRig.test.ts tests/anim.tool.test.ts tests/anim.wire.test.ts 2>&1 | tail -10`
Expected: PASS. `anim.wire.test` must still pass with `rig` now a string (bad rig strings now refused by the new guard).

- [ ] **Step 7: Typecheck, commit**

```bash
npx tsc --noEmit && git add src/anim tests/anim.rigtool.test.ts && git commit -m "animate: rig and declare actions (BloxRig declarations)"
```

---

### Task 5: check and build on a model rig

**Files:**
- Modify: `src/anim/tool.ts` (check, build), `src/anim/studio.ts` (`buildProgram` model branch)
- Test: `tests/anim.modelbuild.test.ts`; extend the lune compile test in `tests/anim.verify.test.ts`

**Interfaces:**
- Consumes: `readRig`, `rigForSequence`, `skippedChecks`, `modelPath` (Tasks 3–4); `saveRigReading`, `loadRigReading`, `clearRigReading` (Task 3); `RESOLVE_LUAU`.
- Produces: `buildProgram(seq, times, model?: { path: string; rootPart: string } | null): string` (third arg new, default `null`); check stores `rig.json` for model rigs and removes it for stock rigs.

- [ ] **Step 1: Write the failing tests**

`tests/anim.modelbuild.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findTool, invokeTool, type ToolCtx } from '../src/tools/registry.js';
import { BloxConfigSchema } from '../src/config.js';
import { loadChecked } from '../src/anim/store.js';
import { buildTracks, sampleTrack } from '../src/anim/motion.js';
import { previewSampleTimes } from '../src/anim/animation-tool.js';
import { rigForSequence } from '../src/anim/modelRig.js';
import { kneeDeclarations, partsDog } from './fixtures/anim/parts-dog.js';
import type { StudioSession } from '../src/studio/session.js';

const envelope = (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, n: 1, values: { v1: JSON.stringify(v) }, logs: [] }) }] });
function ctx(reply: (code: string) => unknown, codes: string[] = []): ToolCtx {
  const session = { call: async (_n: string, a: Record<string, unknown>) => { codes.push(String(a.code)); return envelope(reply(String(a.code))); } } as unknown as StudioSession;
  const projectPath = mkdtempSync(join(tmpdir(), 'blox-mbuild-'));
  return { session, projectPath, config: BloxConfigSchema.parse({ projectPath }), agent: 'test' };
}
const call = (args: Record<string, unknown>, c: ToolCtx) => invokeTool(findTool('animate')!, args, c);
const dog = (tweak = 0) => { const { revision: _r, ...rest } = partsDog({ knees: true, declarations: kneeDeclarations() }); const d = { ...rest, path: 'Workspace.Dog' }; if (tweak) d.joints[1].c0[1] += tweak; return d; };
const WAG = { name: 'TailWag', rig: 'game.Workspace.Dog', loop: true, priority: 'Idle', duration: 1, waves: [{ joints: ['Tail'], axis: 'Y', amplitude: 20, cycles: 2 }] };

function faithful(c: ToolCtx, name: string) {
  const seq = loadChecked(c.projectPath, name)!.sequence;
  const rig = rigForSequence(c.projectPath, seq);
  const tracks = buildTracks(seq);
  return previewSampleTimes(seq).map((time) => ({ time, transforms: Object.fromEntries(rig.joints.map((j) => { const f = sampleTrack(tracks.get(j.childPart), time); return [j.childPart, [...f.p, ...f.r]]; })) }));
}

describe('check on a model rig', () => {
  it('reads the rig, compiles against it under its own path, saves rig.json', async () => {
    const codes: string[] = [];
    const c = ctx(() => ({ ok: true, reading: dog() }), codes);
    const r = await call({ action: 'check', animation: WAG }, c);
    expect(r.isError, r.text).toBeFalsy();
    expect(codes.length).toBe(1);
    expect(loadChecked(c.projectPath, 'TailWag')!.sequence.rig).toBe('Workspace.Dog');
    expect(existsSync(join(c.projectPath, '.blox/anims/TailWag/rig.json'))).toBe(true);
    expect(r.images?.length).toBe(1);
  });
  it('a stock-rig check touches no Studio and clears a stale rig.json', async () => {
    const codes: string[] = [];
    const c = ctx(() => ({ ok: true, reading: dog() }), codes);
    await call({ action: 'check', animation: WAG }, c);
    await call({ action: 'check', animation: { ...WAG, rig: 'R15', waves: [{ joints: ['Waist'], axis: 'Y', amplitude: 5, cycles: 1 }] } }, c);
    expect(codes.length).toBe(1);
    expect(existsSync(join(c.projectPath, '.blox/anims/TailWag/rig.json'))).toBe(false);
  });
});

describe('build on a model rig', () => {
  it('refuses when the rig changed since check', async () => {
    let tweak = 0;
    const codes: string[] = [];
    const c = ctx(() => ({ ok: true, reading: dog(tweak) }), codes);
    await call({ action: 'check', animation: WAG }, c);
    tweak = 0.25;
    const r = await call({ action: 'build', name: 'TailWag' }, c);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/rig changed since check/);
  });
  it('plays on a copy of the model and compares on its joints', async () => {
    let c!: ToolCtx;
    const codes: string[] = [];
    c = ctx((code) => (code.includes('readModelRig(P.path') ? { ok: true, reading: dog() } : code.includes('local WRITE = true') ? { ok: true, written: true } : { ok: true, length: 1, samples: faithful(c, 'TailWag') }), codes);
    await call({ action: 'check', animation: WAG }, c);
    const r = await call({ action: 'build', name: 'TailWag' }, c);
    expect(r.isError, r.text).toBeFalsy();
    const play = codes.find((x) => x.includes('local WRITE = false'))!;
    expect(play).toMatch(/"model":\{"path":"Workspace.Dog","rootPart":"HumanoidRootPart"\}/);
    expect(r.text).toMatch(/a copy of Workspace.Dog/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/anim.modelbuild.test.ts 2>&1 | tail -8`
Expected: FAIL — check reports `does not compile` (rig `game.Workspace.Dog` unknown) and no Studio call is made.

- [ ] **Step 3: check branch**

In `animateTool`'s check branch, after the name validation and before `prepareAnimation`, insert:

```ts
    let rig = RIGS.get(String(spec.rig));
    let notes: string[] = [];
    let animation = spec;
    if (!rig && typeof spec.rig === 'string') {
      const read = await readRig(ctx.session, spec.rig);
      if (!read.ok) return err(read.error, read.code ?? 'refused');
      rig = read.rig;
      notes = read.notes;
      animation = { ...spec, rig: read.reading.path };
      saveRigReading(P, spec.name, read.reading);
    } else {
      clearRigReading(P, spec.name);
    }
```

Change `prepareAnimation(spec, ...)` to `prepareAnimation(animation, { ... }, rig && !RIGS.has(rig.name) ? rig : undefined)`, `saveChecked(P, { spec: animation, ...})`, and the sheet to `renderContactSheet(sequence, undefined, { locomotion: options.locomotion, rig: rig ?? rigFor(sequence.rig) })`. After the check lines, when the rig is a model rig, push `...notes.map((n) => `note: ${n}`)`, `...skippedChecks(rig)` and `'note: MeshParts are drawn as their boxes'` if any reading part is a MeshPart — the reader reports shapes only, so instead always push it for model rigs: `note: the sheet draws each part as its box`. Import `RIGS` from `./rigs.js`.

- [ ] **Step 4: build branch**

After `const seq = stored.sequence;` insert:

```ts
    let rig = RIGS.get(seq.rig);
    let model: { path: string; rootPart: string } | null = null;
    if (!rig) {
      const saved = loadRigReading(P, seq.name);
      if (!saved) return err(`${seq.name} has no saved rig reading: check it again`, 'not checked');
      const now = await readRig(ctx.session, seq.rig);
      if (!now.ok) return err(now.error, now.code ?? 'refused');
      if (now.reading.revision !== saved.revision) return err(`${seq.rig}'s rig changed since check (${saved.revision} → ${now.reading.revision}); check it again`, 'rig changed');
      rig = now.rig;
      model = { path: now.reading.path, rootPart: now.reading.rootPart };
    }
```

Pass `model` to `buildProgram(seq, previewSampleTimes(seq), model)`, call `verifyPlayback(seq, reply.samples, rig)`, and make the success text say ``played on ${model ? `a copy of ${model.path}` : `a stock ${seq.rig} dummy`}``. Replace `JSON.parse(String(play.values[0]))` and `JSON.parse(String(commit.values[0]))` with `parseReply(...)` (error → `err(p.error, 'studio error')`).

- [ ] **Step 5: `buildProgram` model branch in `src/anim/studio.ts`**

Change the signature and payload:

```ts
export function buildProgram(seq: KeyframeSequenceDescription, sampleTimes: number[], model: { path: string; rootPart: string } | null = null): string {
  return `local WRITE = false\nlocal PAYLOAD = ${longString(JSON.stringify({ sequence: seq, times: sampleTimes, model }))}\n${EDIT_HEAD}${RESOLVE_LUAU}${SEQUENCE_LUAU}${PLAY_LUAU}`;
}
```

(import `RESOLVE_LUAU` from `./modelRig.js`). In `PLAY_LUAU` replace the block from `local rig = Players:CreateHumanoidModelFromDescription(...)` through `local animator = ...` with:

```lua
	local rig, root
	if P.model then
		local source = resolve(P.model.path)
		if not source then error(P.model.path .. " does not exist") end
		rig = source:Clone()
		if not rig then error(P.model.path .. " could not be copied") end
		for _, tag in rig:GetTags() do rig:RemoveTag(tag) end
		root = rig:FindFirstChild(P.model.rootPart, true)
		if not root then error("the copy has no " .. P.model.rootPart) end
	else
		rig = Players:CreateHumanoidModelFromDescription(Instance.new("HumanoidDescription"), P.sequence.rig == "R6" and Enum.HumanoidRigType.R6 or Enum.HumanoidRigType.R15)
		root = rig.HumanoidRootPart
	end
	rig.Archivable = false
	rig:PivotTo(CFrame.new(0, 100000, 0))
	root.Anchored = true
	rig.Parent = folder
	local controller = rig:FindFirstChildOfClass("Humanoid") or rig:FindFirstChildOfClass("AnimationController")
	local animator = controller:FindFirstChildOfClass("Animator") or Instance.new("Animator", controller)
```

and change the load-failure message to `"the animation never loaded on the " .. (P.model and "copy" or "dummy")`.

- [ ] **Step 6: Extend the lune compile test**

In `tests/anim.verify.test.ts`'s `files` object add `'build_model.luau': buildProgram(c.sequence, [0.1], { path: 'Workspace.Dog', rootPart: 'HumanoidRootPart' }),`.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run tests/anim.modelbuild.test.ts tests/anim.build.test.ts tests/anim.verify.test.ts tests/anim.tool.test.ts 2>&1 | tail -10`
Expected: PASS (spec A's build tests unchanged).

- [ ] **Step 8: Typecheck, commit**

```bash
npx tsc --noEmit && git add src/anim tests/anim.modelbuild.test.ts tests/anim.verify.test.ts && git commit -m "animate: check and build on a model's own rig (play on a copy)"
```

---

### Task 6: NPC bodies + the central model loader

**Files:**
- Create: `src/anim/npc.ts`
- Modify: `src/anim/tool.ts` (npc action)
- Test: `tests/anim.npc.test.ts`

**Interfaces:**
- Consumes: `RESOLVE_LUAU`, `parseReply`, `modelPath` (Task 3); `pushProject`, `formatSyncResult` (`src/sync/push.ts`); `longString`, `runLuau`.
- Produces:
  - `MODEL_LOADER_PATH = 'src/ServerScriptService/BloxModelAnimate.server.luau'`, `MODEL_TAG = 'BloxAnimated'`, `MODEL_LOADER_SOURCE: string`
  - `planModelLoader(projectPath): { ok: true; write: boolean } | { ok: false; error: string }`, `writeModelLoader(projectPath): void`
  - `NPC_NAME = /^[A-Za-z][A-Za-z0-9_ -]{0,63}$/`, `npcProgram(o: { name: string; rig: 'R15' | 'R6'; at: [number, number, number]; parent: string }): string`

- [ ] **Step 1: Write the failing tests**

`tests/anim.npc.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { findTool, invokeTool, type ToolCtx } from '../src/tools/registry.js';
import { BloxConfigSchema } from '../src/config.js';
import { MODEL_LOADER_PATH, MODEL_LOADER_SOURCE, npcProgram, planModelLoader } from '../src/anim/npc.js';
import { luneBin, luneCheck } from './helpers/lune.js';
import type { StudioSession } from '../src/studio/session.js';

const envelope = (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, n: 1, values: { v1: JSON.stringify(v) }, logs: [] }) }] });
function ctx(reply: (code: string) => unknown, codes: string[] = []): ToolCtx {
  const session = { call: async (n: string, a: Record<string, unknown>) => { codes.push(`${n}:${String(a.code ?? '')}`); return envelope(reply(String(a.code ?? ''))); } } as unknown as StudioSession;
  const projectPath = mkdtempSync(join(tmpdir(), 'blox-npc-'));
  return { session, projectPath, config: BloxConfigSchema.parse({ projectPath }), agent: 'test' };
}
const call = (args: Record<string, unknown>, c: ToolCtx) => invokeTool(findTool('animate')!, args, c);

describe('the model loader', () => {
  it('drives every tagged model from its attributes', () => {
    expect(MODEL_LOADER_SOURCE).toMatch(/GetInstanceAddedSignal\("BloxAnimated"\)/);
    expect(MODEL_LOADER_SOURCE).toMatch(/BloxAnim_/);
    expect(MODEL_LOADER_SOURCE).toMatch(/SLOWEST, FASTEST = 0\.5, 2/);
    expect(MODEL_LOADER_SOURCE.split('\n')[0]).toMatch(/^-- GENERATED by blox/);
  });
  it('a hand-edited loader is refused; CRLF is still ours', () => {
    const P = mkdtempSync(join(tmpdir(), 'blox-npcl-'));
    expect(planModelLoader(P)).toEqual({ ok: true, write: true });
    const f = join(P, MODEL_LOADER_PATH);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, MODEL_LOADER_SOURCE.replace(/\n/g, '\r\n'));
    expect(planModelLoader(P)).toEqual({ ok: true, write: false });
    writeFileSync(f, MODEL_LOADER_SOURCE + '\n-- mine');
    expect(planModelLoader(P)).toMatchObject({ ok: false, error: expect.stringMatching(/edited by hand/) });
  });
  it.skipIf(!luneBin())('loader and npc program compile', () => {
    const d = mkdtempSync(join(tmpdir(), 'blox-npcluau-'));
    writeFileSync(join(d, 'loader.luau'), MODEL_LOADER_SOURCE);
    writeFileSync(join(d, 'npc.luau'), npcProgram({ name: 'Guard', rig: 'R15', at: [0, 0, 0], parent: 'Workspace' }));
    expect(luneCheck([join(d, 'loader.luau'), join(d, 'npc.luau')])).toEqual([]);
  });
});

describe('animate npc', () => {
  it('creates the body, writes the loader, syncs', async () => {
    const codes: string[] = [];
    const c = ctx((code) => (code.includes('CreateHumanoidModelFromDescription') ? { ok: true, path: 'Workspace.Guard' } : {}), codes);
    const r = await call({ action: 'npc', name: 'Guard', rig: 'R15', at: [10, 0, 5] }, c);
    expect(r.text).toMatch(/Workspace\.Guard/);
    expect(readFileSync(join(c.projectPath, MODEL_LOADER_PATH), 'utf8')).toBe(MODEL_LOADER_SOURCE);
    const npc = codes.find((x) => x.includes('CreateHumanoidModelFromDescription'))!;
    expect(npc).toMatch(/"name":"Guard"/);
    expect(npc).not.toMatch(/Name = "Guard"/); // name only in the payload
  });
  it('refuses a bad name, rig or position before touching Studio', async () => {
    const codes: string[] = [];
    const c = ctx(() => ({}), codes);
    expect((await call({ action: 'npc', name: '1bad', rig: 'R15', at: [0, 0, 0] }, c)).isError).toBe(true);
    expect((await call({ action: 'npc', name: 'Guard', rig: 'Workspace.Dog', at: [0, 0, 0] }, c)).isError).toBe(true);
    expect((await call({ action: 'npc', name: 'Guard', rig: 'R15' }, c)).isError).toBe(true);
    expect(codes).toEqual([]);
  });
  it('passes a name clash through without writing the loader', async () => {
    const c = ctx(() => ({ ok: false, code: 'exists', error: 'Workspace already has a Guard' }));
    const r = await call({ action: 'npc', name: 'Guard', rig: 'R15', at: [0, 0, 0] }, c);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/already has a Guard/);
    expect(existsSync(join(c.projectPath, MODEL_LOADER_PATH))).toBe(false);
  });
});
```

Check how the fake session sees `pushProject`'s calls: `pushProject` calls `multi_edit` / `execute_luau` through `session.call`; the fake returns `{}` envelopes for those. If `pushProject` throws on `{}`, the npc branch must still report the body created (wrap sync like spec A's wire: `isError: !s.ok`). The first test asserts only the text and the file, not `isError`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/anim.npc.test.ts 2>&1 | tail -5`
Expected: FAIL — cannot find module `../src/anim/npc.js`.

- [ ] **Step 3: Write `src/anim/npc.ts`**

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { longString } from '../studio/luau.js';
import { RESOLVE_LUAU } from './modelRig.js';

// NPCs and models are animated by one server Script in the project: it plays
// each tagged model's idle, walk and run by how fast the model moves, from the
// model's attributes. Clones carry the tag and attributes, so spawners need
// nothing else. Port of Roqer's RoqerModelAnimate, retargeted from one script
// per model to a tag.
export const MODEL_LOADER_PATH = 'src/ServerScriptService/BloxModelAnimate.server.luau';
export const MODEL_TAG = 'BloxAnimated';

export const MODEL_LOADER_SOURCE = `-- GENERATED by blox animate (BloxModelAnimate 1). Edit with animate {action:"wire"}; hand edits stop blox managing it.
-- Plays the idle, walk and run animations of every model tagged BloxAnimated,
-- by how fast the model moves. They are the model's attributes: BloxAnim_idle,
-- BloxAnim_walk and BloxAnim_run hold animation ids, and BloxAnim_walkSpeed and
-- BloxAnim_runSpeed the ground speed in studs a second each was written for,
-- so its feet keep pace.
local CollectionService = game:GetService("CollectionService")
local RunService = game:GetService("RunService")

local TAG = "${MODEL_TAG}"
local PRIORITY = {
	idle = Enum.AnimationPriority.Idle,
	walk = Enum.AnimationPriority.Movement,
	run = Enum.AnimationPriority.Movement,
}
-- Seconds to cross-fade from one state to the next.
local FADE = 0.2
-- Studs a second below which the model stands.
local STANDING = 0.5
-- How far a gait may be slowed down or sped up to keep pace with the model.
local SLOWEST, FASTEST = 0.5, 2

local active = {}

local function attach(model)
	if active[model] or not model:IsA("Model") then
		return
	end
	local humanoid = model:FindFirstChildOfClass("Humanoid")
	local controller = humanoid or model:FindFirstChildOfClass("AnimationController")
	if not controller then
		warn("BloxModelAnimate: " .. model:GetFullName() .. " has no Humanoid or AnimationController to animate")
		return
	end
	local animator = controller:FindFirstChildOfClass("Animator")
	if not animator then
		animator = Instance.new("Animator")
		animator.Parent = controller
	end
	local state = { tracks = {}, current = nil, running = 0, measured = 0, last = nil, connections = {} }
	active[model] = state

	local function load(name)
		local old = state.tracks[name]
		if old then
			old:Stop(0)
			old:Destroy()
			state.tracks[name] = nil
		end
		if state.current == name then
			state.current = nil
		end
		local id = model:GetAttribute("BloxAnim_" .. name)
		if typeof(id) ~= "string" or id == "" then
			return
		end
		local animation = Instance.new("Animation")
		animation.AnimationId = id
		local ok, track = pcall(animator.LoadAnimation, animator, animation)
		if not ok then
			warn("BloxModelAnimate: " .. model:GetFullName() .. "'s " .. name .. " animation " .. id .. " did not load: " .. tostring(track))
			return
		end
		track.Priority = PRIORITY[name]
		track.Looped = true
		state.tracks[name] = track
	end
	for name in PRIORITY do
		load(name)
	end
	table.insert(state.connections, model.AttributeChanged:Connect(function(attribute)
		local name = string.match(attribute, "^BloxAnim_(%a+)$")
		if name and PRIORITY[name] then
			load(name)
		end
	end))
	if humanoid then
		table.insert(state.connections, humanoid.Running:Connect(function(speed)
			state.running = speed
		end))
	end
end

local function detach(model)
	local state = active[model]
	if not state then
		return
	end
	active[model] = nil
	for _, connection in state.connections do
		connection:Disconnect()
	end
	for _, track in state.tracks do
		track:Stop(0)
	end
end

local function choose(model, state, speed)
	if speed < STANDING then
		return "idle"
	end
	local walkSpeed, runSpeed = model:GetAttribute("BloxAnim_walkSpeed"), model:GetAttribute("BloxAnim_runSpeed")
	if state.tracks.walk and state.tracks.run and typeof(walkSpeed) == "number" and typeof(runSpeed) == "number" then
		return if speed > (walkSpeed + runSpeed) / 2 then "run" else "walk"
	end
	return if state.tracks.walk then "walk" elseif state.tracks.run then "run" else "idle"
end

RunService.Heartbeat:Connect(function(dt)
	for model, state in active do
		local speed = state.running
		if not model:FindFirstChildOfClass("Humanoid") then
			-- Anything without a Humanoid is timed from frame to frame.
			local root = model.PrimaryPart
			local position = root and root.Position
			if position and state.last and dt > 0 then
				local moved = (position - state.last) * Vector3.new(1, 0, 1)
				state.measured += (moved.Magnitude / dt - state.measured) * math.min(1, dt * 5)
			end
			state.last = position
			speed = state.measured
		end
		local name = choose(model, state, speed)
		if name ~= state.current then
			local previous = state.current and state.tracks[state.current]
			if previous then
				previous:Stop(FADE)
			end
			if state.tracks[name] then
				state.tracks[name]:Play(FADE)
			end
			state.current = name
		end
		local track = state.tracks[name]
		local written = model:GetAttribute("BloxAnim_" .. name .. "Speed")
		if track and name ~= "idle" and typeof(written) == "number" and written > 0 then
			track:AdjustSpeed(math.clamp(speed / written, SLOWEST, FASTEST))
		end
	end
end)

CollectionService:GetInstanceAddedSignal(TAG):Connect(attach)
CollectionService:GetInstanceRemovedSignal(TAG):Connect(detach)
for _, model in CollectionService:GetTagged(TAG) do
	task.spawn(attach, model)
end
`;

export function planModelLoader(projectPath: string): { ok: true; write: boolean } | { ok: false; error: string } {
  const f = join(projectPath, MODEL_LOADER_PATH);
  if (!existsSync(f)) return { ok: true, write: true };
  if (readFileSync(f, 'utf8').replace(/\r\n/g, '\n') !== MODEL_LOADER_SOURCE) return { ok: false, error: `${MODEL_LOADER_PATH} was edited by hand, so blox leaves it alone; restore it (delete the file and run npc or wire again) to let blox manage models` };
  return { ok: true, write: false };
}

export function writeModelLoader(projectPath: string): void {
  const f = join(projectPath, MODEL_LOADER_PATH);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, MODEL_LOADER_SOURCE);
}

export const NPC_NAME = /^[A-Za-z][A-Za-z0-9_ -]{0,63}$/;

// A stock body, without the LocalScript Animate (which runs only under a
// player), tagged for the loader, its feet on P.at; one undo step.
const NPC_LUAU = `local parent = resolve(P.parent)
if not parent then return HS:JSONEncode({ ok = false, code = "not_found", error = P.parent .. " does not exist" }) end
if not (parent == workspace or parent:IsDescendantOf(workspace)) then return HS:JSONEncode({ ok = false, code = "bad_location", error = "an NPC goes under Workspace" }) end
if parent:FindFirstChild(P.name) then return HS:JSONEncode({ ok = false, code = "exists", error = parent:GetFullName() .. " already has a " .. P.name }) end
local CHS = game:GetService("ChangeHistoryService")
local rec
pcall(function() rec = CHS:TryBeginRecording("blox animate npc") end)
local ok, res = pcall(function()
	local rig = game:GetService("Players"):CreateHumanoidModelFromDescription(Instance.new("HumanoidDescription"), P.rig == "R6" and Enum.HumanoidRigType.R6 or Enum.HumanoidRigType.R15)
	rig.Name = P.name
	local animate = rig:FindFirstChild("Animate")
	if animate then animate:Destroy() end
	rig:AddTag("${MODEL_TAG}")
	rig:PivotTo(CFrame.new(P.at[1], P.at[2], P.at[3]))
	local box, size = rig:GetBoundingBox()
	rig:PivotTo(rig:GetPivot() + Vector3.new(0, P.at[2] - (box.Position.Y - size.Y / 2), 0))
	rig.Parent = parent
	return rig:GetFullName()
end)
if rec then pcall(function() CHS:FinishRecording(rec, ok and Enum.FinishRecordingOperation.Commit or Enum.FinishRecordingOperation.Cancel) end) end
if not ok then return HS:JSONEncode({ ok = false, error = tostring(res) }) end
return HS:JSONEncode({ ok = true, path = res })`;

export function npcProgram(o: { name: string; rig: 'R15' | 'R6'; at: [number, number, number]; parent: string }): string {
  return `local PAYLOAD = ${longString(JSON.stringify(o))}
local HS = game:GetService("HttpService")
local P = HS:JSONDecode(PAYLOAD)
${RESOLVE_LUAU}${NPC_LUAU}`;
}
```

`RESOLVE_LUAU` also defines `animatedModel`, unused here; Luau permits unused locals.

- [ ] **Step 4: npc action in `animateTool`**

```ts
  if (a.action === 'npc') {
    if (typeof a.name !== 'string' || !NPC_NAME.test(a.name)) return err('npc needs name: letters, digits, space, _ and -, starting with a letter (max 64)', 'bad name');
    if (a.rig !== 'R15' && a.rig !== 'R6') return err('npc needs rig:"R15" or rig:"R6" (the stock body); a model of your own is animated with animate rig/check', 'bad rig');
    const at = a.at as number[] | undefined;
    if (!at || at.length !== 3 || !at.every(Number.isFinite)) return err('npc needs at:[x, y, z], where its feet stand', 'no position');
    const loader = planModelLoader(P);
    if (!loader.ok) return err(loader.error, 'refused');
    const r = await runLuau(ctx.session, npcProgram({ name: a.name, rig: a.rig, at: at as [number, number, number], parent: modelPath(typeof a.parent === 'string' ? a.parent : 'Workspace') }), 'edit', { chunkName: 'animateNpc', timeoutMs: 60_000 });
    if (!r.ok) return err(`npc failed in Studio: ${r.error?.message}`, 'studio error');
    const p = parseReply(r.values, 'npc');
    if (!p.ok) return err(p.error, 'studio error');
    if (p.value.ok !== true) return err(String(p.value.error ?? 'npc refused'), String(p.value.code ?? 'refused'));
    const lines = [`made ${String(p.value.path)} (stock ${a.rig} body, tagged ${MODEL_TAG}, no Animate script)`];
    if (loader.write) {
      writeModelLoader(P);
      const s = await pushProject(ctx.session, P);
      lines.push(`wrote ${MODEL_LOADER_PATH}`, formatSyncResult(s));
      if (!s.ok) return { text: lines.join('\n'), isError: true, summary: 'sync failed' };
    }
    lines.push(`Next: wire its idle and walk: animate {action:"wire", model:"${String(p.value.path)}", state:"walk", name, asset} (an ${a.rig} animation, checked with locomotion:true)`);
    return { text: lines.join('\n'), summary: 'npc made' };
  }
```

Imports: `MODEL_LOADER_PATH, MODEL_TAG, NPC_NAME, npcProgram, planModelLoader, writeModelLoader` from `./npc.js`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/anim.npc.test.ts 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 6: Typecheck, commit**

```bash
npx tsc --noEmit && git add src/anim/npc.ts src/anim/tool.ts tests/anim.npc.test.ts && git commit -m "animate: npc bodies and the central BloxModelAnimate loader"
```

---

### Task 7: wire an animation to a model state

**Files:**
- Modify: `src/anim/npc.ts` (`WIRE_MODEL_LUAU`, `wireModelProgram`, `readWired`, `saveWired`), `src/anim/tool.ts` (wire branch)
- Test: `tests/anim.wiremodel.test.ts`

**Interfaces:**
- Consumes: `readRig`, `parseReply`, `modelPath` (Task 3); `planModelLoader`, `writeModelLoader` (Task 6); `loadChecked`, `loadRigReading`, `loadReport` (store); `normalizeAnimationId`, `LOADER_PACE`, `MAX_GROUND_SPEED`.
- Produces:
  - `wireModelProgram(o: { path: string; state: ModelState; id: string; speed: number | null; allowed: string[]; force: boolean; rigType: 'R15' | 'R6' | null }): string`
  - `readWired(projectPath): Record<string, Partial<Record<ModelState, string>>>`, `saveWired(projectPath, wired)` — `.blox/anims/wired.json`
  - Studio reply: `{ ok: true, path, held, walkSpeed? } | { ok: false, code: 'held' | 'rig' | ..., error, held? }`

- [ ] **Step 1: Write the failing tests**

`tests/anim.wiremodel.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findTool, invokeTool, type ToolCtx } from '../src/tools/registry.js';
import { BloxConfigSchema } from '../src/config.js';
import { loadRecipes } from '../src/anim/recipes.js';
import { MODEL_LOADER_PATH, readWired } from '../src/anim/npc.js';
import { kneeDeclarations, partsDog } from './fixtures/anim/parts-dog.js';
import type { StudioSession } from '../src/studio/session.js';

const envelope = (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, n: 1, values: { v1: JSON.stringify(v) }, logs: [] }) }] });
function ctx(reply: (code: string) => unknown, codes: string[] = []): ToolCtx {
  const session = { call: async (_n: string, a: Record<string, unknown>) => { codes.push(String(a.code ?? '')); return envelope(reply(String(a.code ?? ''))); } } as unknown as StudioSession;
  const projectPath = mkdtempSync(join(tmpdir(), 'blox-wiremodel-'));
  return { session, projectPath, config: BloxConfigSchema.parse({ projectPath }), agent: 'test' };
}
const call = (args: Record<string, unknown>, c: ToolCtx) => invokeTool(findTool('animate')!, args, c);
const dog = (path = 'Workspace.Dog') => { const { revision: _r, ...rest } = partsDog({ knees: true, declarations: kneeDeclarations() }); return { ...rest, path }; };
const DOGWALK = { name: 'DogWalk', rig: 'Workspace.Dog', loop: true, priority: 'Movement', duration: 1, gait: { pattern: 'walk', stride: 1.2 } };
const isWrite = (code: string) => code.includes('BloxAnimWire');

describe('wire a model state', () => {
  it('stock NPC: sets the attributes, records wired.json, writes the loader', async () => {
    const codes: string[] = [];
    const c = ctx((code) => (isWrite(code) ? { ok: true, path: 'Workspace.Guard', walkSpeed: 16 } : {}), codes);
    await call({ action: 'check', animation: structuredClone(loadRecipes().get('Walk')!), locomotion: true }, c);
    const r = await call({ action: 'wire', model: 'Workspace.Guard', state: 'walk', name: 'Walk', asset: 123 }, c);
    expect(r.isError, r.text).toBeFalsy();
    const w = codes.find(isWrite)!;
    expect(w).toMatch(/"rigType":"R15"/);
    expect(w).toMatch(/"id":"rbxassetid:\/\/123"/);
    expect(w).toMatch(/"speed":\d/);
    expect(readWired(c.projectPath)['Workspace.Guard'].walk).toBe('rbxassetid://123');
    expect(existsSync(join(c.projectPath, MODEL_LOADER_PATH))).toBe(true);
  });
  it('model rig: a clone with the same rig passes; a different rig is refused', async () => {
    const codes: string[] = [];
    let readPath = 'Workspace.Dog';
    let tweak = false;
    const c = ctx((code) => (isWrite(code) ? { ok: true, path: readPath } : (() => { const d = dog(readPath); if (tweak) d.joints[1].c0[1] += 0.3; return { ok: true, reading: d }; })()), codes);
    await call({ action: 'check', animation: DOGWALK, locomotion: true }, c);
    readPath = 'Workspace.Dog2';
    expect((await call({ action: 'wire', model: 'Workspace.Dog2', state: 'walk', name: 'DogWalk', asset: 5 }, c)).isError).toBeFalsy();
    tweak = true;
    const bad = await call({ action: 'wire', model: 'Workspace.Dog2', state: 'walk', name: 'DogWalk', asset: 5 }, c);
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/not the rig DogWalk was checked on/);
  });
  it('walk/run need a looping, locomotion-checked animation', async () => {
    const c = ctx(() => ({ ok: true }));
    await call({ action: 'check', animation: structuredClone(loadRecipes().get('Walk')!) }, c); // no locomotion
    const r = await call({ action: 'wire', model: 'Workspace.Guard', state: 'walk', name: 'Walk', asset: 1 }, c);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/locomotion:true/);
    await call({ action: 'check', animation: { ...structuredClone(loadRecipes().get('Wave')!), loop: false } }, c);
    const r2 = await call({ action: 'wire', model: 'Workspace.Guard', state: 'idle', name: 'Wave', asset: 1 }, c);
    expect(r2.isError).toBe(true);
    expect(r2.text).toMatch(/loop/);
  });
  it('the attribute guard passes the ids blox wired, and force through', async () => {
    const codes: string[] = [];
    const c = ctx((code) => (isWrite(code) ? (code.includes('"force":true') ? { ok: true, path: 'Workspace.Guard' } : { ok: false, code: 'held', held: 'rbxassetid://999', error: 'Workspace.Guard BloxAnim_idle holds rbxassetid://999' }) : {}), codes);
    await call({ action: 'check', animation: structuredClone(loadRecipes().get('Idle')!) }, c);
    const r = await call({ action: 'wire', model: 'Workspace.Guard', state: 'idle', name: 'Idle', asset: 7 }, c);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/holds rbxassetid:\/\/999.*force:true/s);
    const f = await call({ action: 'wire', model: 'Workspace.Guard', state: 'idle', name: 'Idle', asset: 7, force: true }, c);
    expect(f.isError, f.text).toBeFalsy();
    await call({ action: 'wire', model: 'Workspace.Guard', state: 'idle', name: 'Idle', asset: 8, force: true }, c);
    expect(codes.filter(isWrite).at(-1)).toMatch(/"allowed":\["rbxassetid:\/\/7"\]/);
  });
  it('warns when WalkSpeed is outside the pace range', async () => {
    const c = ctx((code) => (isWrite(code) ? { ok: true, path: 'Workspace.Guard', walkSpeed: 100 } : {}));
    await call({ action: 'check', animation: structuredClone(loadRecipes().get('Walk')!), locomotion: true }, c);
    const r = await call({ action: 'wire', model: 'Workspace.Guard', state: 'walk', name: 'Walk', asset: 1 }, c);
    expect(r.text).toMatch(/WalkSpeed 100 is outside 0\.5–2×/);
  });
  it('slot and model are exclusive', async () => {
    const r = await call({ action: 'wire', model: 'Workspace.Guard', slot: 'walk', state: 'walk', name: 'Walk', asset: 1 }, ctx(() => ({})));
    expect(r.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/anim.wiremodel.test.ts 2>&1 | tail -8`
Expected: FAIL — `readWired` not exported / wire asks for `slot`.

- [ ] **Step 3: Add the wire program and wired.json to `src/anim/npc.ts`**

```ts
import type { ModelState } from './animation-tool.js';

const WIRE_MODEL_LUAU = `-- BloxAnimWire
local model, controller, err = animatedModel(P.path)
if not model then return HS:JSONEncode({ ok = false, code = controller, error = err }) end
local humanoid = controller:IsA("Humanoid") and controller or nil
if P.rigType and (not humanoid or humanoid.RigType.Name ~= P.rigType) then
	return HS:JSONEncode({ ok = false, code = "rig", error = model:GetFullName() .. " is " .. (humanoid and ("an " .. humanoid.RigType.Name .. " Humanoid") or "not a Humanoid") .. "; this is an " .. P.rigType .. " animation" })
end
local key = "BloxAnim_" .. P.state
local held = model:GetAttribute(key)
if typeof(held) == "string" and held ~= "" and held ~= P.id and not table.find(P.allowed, held) and not P.force then
	return HS:JSONEncode({ ok = false, code = "held", held = held, error = model:GetFullName() .. " " .. key .. " holds " .. held })
end
local CHS = game:GetService("ChangeHistoryService")
local rec
pcall(function() rec = CHS:TryBeginRecording("blox animate wire") end)
model:SetAttribute(key, P.id)
if P.state ~= "idle" then model:SetAttribute(key .. "Speed", P.speed) end
model:AddTag("${MODEL_TAG}")
if rec then pcall(function() CHS:FinishRecording(rec, Enum.FinishRecordingOperation.Commit) end) end
return HS:JSONEncode({ ok = true, path = model:GetFullName(), held = held, walkSpeed = humanoid and humanoid.WalkSpeed or nil })`;

export function wireModelProgram(o: { path: string; state: ModelState; id: string; speed: number | null; allowed: string[]; force: boolean; rigType: 'R15' | 'R6' | null }): string {
  return `local PAYLOAD = ${longString(JSON.stringify(o))}
local HS = game:GetService("HttpService")
local P = HS:JSONDecode(PAYLOAD)
${RESOLVE_LUAU}${WIRE_MODEL_LUAU}`;
}

type Wired = Record<string, Partial<Record<ModelState, string>>>;
const wiredFile = (projectPath: string) => join(projectPath, '.blox', 'anims', 'wired.json');

export function readWired(projectPath: string): Wired {
  const f = wiredFile(projectPath);
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Wired) : {};
}

export function saveWired(projectPath: string, wired: Wired): void {
  mkdirSync(dirname(wiredFile(projectPath)), { recursive: true });
  writeFileSync(wiredFile(projectPath), JSON.stringify(wired, null, 2));
}
```

`P.speed` is `nil` for idle in Luau (JSON null decodes to nil); `SetAttribute(key, nil)` is never reached for idle.

- [ ] **Step 4: wire branch for models in `animateTool`**

At the top of the existing wire branch:

```ts
    if (typeof a.model === 'string') {
      if (a.slot !== undefined) return err('wire takes slot (a player character) or model + state (an NPC or model), not both', 'ambiguous');
      return wireModel(a, ctx);
    }
```

and add a module-level function:

```ts
async function wireModel(a: Record<string, unknown>, ctx: ToolCtx): Promise<ToolOutput> {
  const P = ctx.projectPath;
  const state = a.state as ModelState | undefined;
  if (!state) return err(`wire with model needs state: ${MODEL_STATES.join(', ')}`, 'no state');
  if (typeof a.name !== 'string' || !ANIM_NAME.test(a.name)) return err('wire with model needs name (the checked animation, which says its rig and ground speed)', 'no name');
  const stored = loadChecked(P, a.name);
  if (!stored) return err(`no checked animation ${a.name}: run animate check first`, 'not checked');
  const seq = stored.sequence;
  if (!seq.loop) return err(`${seq.name} does not loop; the loader plays ${state} on repeat, so check it with loop:true`, 'not looped');
  const id = normalizeAnimationId(a.asset);
  if (!id) return err(`asset must be an asset id (123, rbxassetid://123 or a roblox.com asset link); got ${JSON.stringify(a.asset)}`, 'bad asset');
  let speed: number | null = null;
  if (state !== 'idle') {
    const gs = loadReport(P, seq.name)?.groundSpeed;
    if (typeof gs !== 'number' || gs <= 0) return err(`${seq.name} has no ground speed: check it with locomotion:true so the loader can pace its feet`, 'no ground speed');
    if (gs > MAX_GROUND_SPEED) return err(`${seq.name}'s ground speed ${gs} is above ${MAX_GROUND_SPEED} studs/s`, 'too fast');
    speed = gs;
  }
  const stock = seq.rig === 'R15' || seq.rig === 'R6' ? seq.rig : null;
  if (!stock) {
    const saved = loadRigReading(P, seq.name);
    const now = await readRig(ctx.session, a.model as string);
    if (!now.ok) return err(now.error, now.code ?? 'refused');
    if (!saved || now.reading.revision !== saved.revision) return err(`${now.reading.path} is not the rig ${seq.name} was checked on (${seq.rig}); wire it to a copy of that model, or check the animation on this one`, 'rig mismatch');
  }
  const loader = planModelLoader(P);
  if (!loader.ok) return err(loader.error, 'refused');
  const path = modelPath(a.model as string);
  const wired = readWired(P);
  const prior = wired[path]?.[state];
  const r = await runLuau(ctx.session, wireModelProgram({ path, state, id, speed, allowed: prior ? [prior] : [], force: a.force === true, rigType: stock }), 'edit', { chunkName: 'animateWireModel', timeoutMs: 60_000 });
  if (!r.ok) return err(`wire failed in Studio: ${r.error?.message}`, 'studio error');
  const p = parseReply(r.values, 'wire');
  if (!p.ok) return err(p.error, 'studio error');
  const v = p.value as { ok?: boolean; code?: string; error?: string; path?: string; walkSpeed?: number };
  if (!v.ok) return err(`${v.error ?? 'wire refused'}${v.code === 'held' ? `; blox did not wire it, so pass force:true to replace it` : ''}`, v.code ?? 'refused');
  const at = v.path ?? path;
  wired[at] = { ...wired[at], [state]: id };
  saveWired(P, wired);
  const lines = [`wired ${at} ${state} = ${id}${speed ? ` (ground speed ${speed} studs/s)` : ''}`];
  if (speed && typeof v.walkSpeed === 'number' && (v.walkSpeed < speed * LOADER_PACE.slowest || v.walkSpeed > speed * LOADER_PACE.fastest)) {
    lines.push(`warning: WalkSpeed ${v.walkSpeed} is outside 0.5–2× of ${seq.name}'s ground speed ${speed}, so its feet will slide; set WalkSpeed between ${round2(speed * LOADER_PACE.slowest)} and ${round2(speed * LOADER_PACE.fastest)}, or make a ${v.walkSpeed > speed ? 'faster' : 'slower'} gait`);
  }
  if (loader.write) {
    writeModelLoader(P);
    const s = await pushProject(ctx.session, P);
    lines.push(`wrote ${MODEL_LOADER_PATH}`, formatSyncResult(s));
    if (!s.ok) return { text: lines.join('\n'), isError: true, summary: 'sync failed' };
  }
  lines.push(`Next: animate {action:"verify", model:"${at}", name:"${seq.name}"}`);
  return { text: lines.join('\n'), summary: `wired ${state}` };
}
const round2 = (n: number) => Math.round(n * 100) / 100;
```

Imports: `LOADER_PACE, MAX_GROUND_SPEED, type ModelState` from `./animation-tool.js`; `loadReport, loadRigReading` from `./store.js`; `readWired, saveWired, wireModelProgram` from `./npc.js`.

Ruling recorded here so the executor does not re-decide it: wire syncs only when it writes the loader file (attributes live in the place, not the project; spec A's slot wire syncs always because its table is a project file).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/anim.wiremodel.test.ts tests/anim.wire.test.ts 2>&1 | tail -10`
Expected: PASS. If the stock "Walk" recipe's report has no `groundSpeed` with `locomotion:true`, read `checkMotion`'s `groundSpeed` condition (`motion-checks.ts:606`) before changing the test.

- [ ] **Step 6: Typecheck, commit, lune**

Add `'wire_model.luau': wireModelProgram({ path: 'Workspace.Guard', state: 'walk', id: 'rbxassetid://1', speed: 3, allowed: [], force: false, rigType: 'R15' })` to the lune compile list in `tests/anim.npc.test.ts`'s compile case.

```bash
npx vitest run tests/anim.npc.test.ts 2>&1 | tail -3 && npx tsc --noEmit && git add src/anim tests/anim.wiremodel.test.ts tests/anim.npc.test.ts && git commit -m "animate: wire idle/walk/run on an NPC or model (attribute guard, pace warning)"
```

---

### Task 8: verify a model in a playtest

**Files:**
- Modify: `src/anim/studio.ts` (`VERIFY_MODEL_LUAU`, `verifyModelProgram`, `type VerifyModelReply`), `src/anim/tool.ts` (verify branch)
- Test: `tests/anim.verifymodel.test.ts`; lune list in `tests/anim.verify.test.ts`

**Interfaces:**
- Consumes: `judgeMovement`, `verifyLivePlayback`, `MODEL_STATES` (`animation-tool.ts`); `rigForSequence`, `modelPath` (Task 3); `planModelLoader`, `readWired` (Tasks 6–7); `withPlay`; `SEQUENCE_LUAU` (studio.ts).
- Produces:
  - `verifyModelProgram(o: { model: string; sequence: KeyframeSequenceDescription | null; animationId: string | null; target: [number, number, number] | null }): string` — server probe, `jsonToLuau` payload, returns a table
  - `type VerifyModelReply = { ok: boolean; error?: string; rigType?: string; loader?: { ids: Record<string, string>; speeds: Record<string, number> }; length?: number; samples?: {time: number; transforms: Record<string, number[]>}[]; observation?: { mode: 'walked'; reached: boolean; samples: unknown[] }; skipped?: string }`

- [ ] **Step 1: Write the failing tests**

`tests/anim.verifymodel.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BloxConfigSchema } from '../src/config.js';
import type { ToolCtx } from '../src/tools/registry.js';
import type { StudioSession } from '../src/studio/session.js';
import { loadRecipes } from '../src/anim/recipes.js';
import { verifyModelProgram } from '../src/anim/studio.js';

let probe: (code: string) => unknown = () => ({});
vi.mock('../src/studio/play.js', async (orig) => ({ ...(await orig<typeof import('../src/studio/play.js')>()), withPlay: async (_s: unknown, fn: () => Promise<unknown>) => fn() }));
vi.mock('../src/studio/luau.js', async (orig) => {
  const real = await orig<typeof import('../src/studio/luau.js')>();
  return { ...real, runLuau: async (s: StudioSession, code: string, context: string, o: unknown) => (context === 'server' ? { ok: true, values: [probe(code)], logs: [], durationMs: 1 } : real.runLuau(s, code, context as 'edit', o as object)) };
});
const { findTool, invokeTool } = await import('../src/tools/registry.js');

const envelope = (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, n: 1, values: { v1: JSON.stringify(v) }, logs: [] }) }] });
function ctx(): ToolCtx {
  const session = { call: async () => envelope({ ok: true, path: 'Workspace.Guard', walkSpeed: 4 }) } as unknown as StudioSession;
  const projectPath = mkdtempSync(join(tmpdir(), 'blox-vmodel-'));
  return { session, projectPath, config: BloxConfigSchema.parse({ projectPath }), agent: 'test' };
}
const call = (args: Record<string, unknown>, c: ToolCtx) => invokeTool(findTool('animate')!, args, c);
const walkSamples = (id: string, pace: number) => [
  ...Array.from({ length: 30 }, (_u, i) => ({ t: i / 10, phase: 'moving', speed: 4, playing: id, pace })),
  ...Array.from({ length: 10 }, (_u, i) => ({ t: 3 + i / 10, phase: 'standing', speed: 0, playing: 'rbxassetid://1' })),
];

describe('verify a model', () => {
  it('passes when the loader walks at the needed pace and idles standing', async () => {
    const c = ctx();
    await call({ action: 'check', animation: structuredClone(loadRecipes().get('Walk')!), locomotion: true }, c);
    await call({ action: 'check', animation: structuredClone(loadRecipes().get('Idle')!) }, c);
    await call({ action: 'wire', model: 'Workspace.Guard', state: 'walk', name: 'Walk', asset: 2 }, c);
    await call({ action: 'wire', model: 'Workspace.Guard', state: 'idle', name: 'Idle', asset: 1 }, c);
    const { loadReport } = await import('../src/anim/store.js');
    const gs = loadReport(c.projectPath, 'Walk')!.groundSpeed!;
    probe = () => ({ ok: true, rigType: 'R15', loader: { ids: { walk: 'rbxassetid://2', idle: 'rbxassetid://1' }, speeds: { walk: gs } }, observation: { mode: 'walked', reached: true, samples: walkSamples('rbxassetid://2', Math.min(2, Math.max(0.5, 4 / gs))) } });
    const r = await call({ action: 'verify', model: 'Workspace.Guard' }, c);
    expect(r.isError, r.text).toBeFalsy();
    expect(r.text).toMatch(/✓ walk while moving/);
  });
  it('an anchored root is named, not a vague movement failure', async () => {
    const c = ctx();
    probe = () => ({ ok: false, error: 'Workspace.Guard\'s root part is anchored, so it cannot walk' });
    const r = await call({ action: 'verify', model: 'Workspace.Guard' }, c);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/anchored/);
  });
  it('the probe payload is a Luau literal with no HttpService', () => {
    const code = verifyModelProgram({ model: 'Workspace.Guard', sequence: null, animationId: null, target: null });
    expect(code).not.toMatch(/HttpService/);
    expect(code).toMatch(/^local P = \{/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/anim.verifymodel.test.ts 2>&1 | tail -8`
Expected: FAIL — `verifyModelProgram` is not exported.

- [ ] **Step 3: Add the probe to `src/anim/studio.ts`**

```ts
export interface VerifyModelReply {
  ok: boolean;
  error?: string;
  rigType?: string;
  loader?: { ids: Record<string, string>; speeds: Record<string, number> };
  length?: number;
  samples?: { time: number; transforms: Record<string, number[]> }[];
  observation?: { mode: 'walked'; reached: boolean; samples: unknown[] };
  skipped?: string;
}

// Playtest server, where the loader runs: optionally play the checked
// animation on the model and sample its joints; then, for a Humanoid, walk it
// to a point and sample (every 0.1 s) its speed and the loader's heaviest
// track, then stand it (port of Roqer's animationVerifyModel / observeModel).
const VERIFY_MODEL_LUAU = `local function components(c) local o = {} for _, v in { c:GetComponents() } do table.insert(o, r6(v)) end return o end
local function round2(v) return math.round(v * 100) / 100 end
local model, controller, err = animatedModel(P.model)
if not model then return { ok = false, error = err } end
local humanoid = controller:IsA("Humanoid") and controller or nil
local animator = controller:FindFirstChildOfClass("Animator")
local deadline = os.clock() + 3
while not animator and os.clock() < deadline do task.wait(0.1) animator = controller:FindFirstChildOfClass("Animator") end
if not animator then return { ok = false, error = P.model .. " has no Animator in the playtest, and the loader made none (is it tagged BloxAnimated and is BloxModelAnimate synced?)" } end
local loader = { ids = {}, speeds = {} }
for _, state in { "idle", "walk", "run" } do
	local id = model:GetAttribute("BloxAnim_" .. state)
	if typeof(id) == "string" and id ~= "" then loader.ids[state] = id end
	local sp = model:GetAttribute("BloxAnim_" .. state .. "Speed")
	if typeof(sp) == "number" then loader.speeds[state] = sp end
end
local result = { ok = true, rigType = humanoid and humanoid.RigType.Name or nil, loader = loader }
if P.sequence or P.animationId then
	local js = {}
	for _, d in model:GetDescendants() do
		if d:IsA("AnimationConstraint") and d.Attachment1 and d.Attachment1.Parent then js[d.Attachment1.Parent.Name] = d
		elseif d:IsA("Motor6D") and d.Part1 then js[d.Part1.Name] = d end
	end
	local ks, anim, track
	local ok, res = pcall(function()
		local id = P.animationId
		if not id then
			ks = buildSequence(P.sequence)
			id = tostring(game:GetService("AnimationClipProvider"):RegisterAnimationClip(ks))
		end
		anim = Instance.new("Animation")
		anim.AnimationId = id
		track = animator:LoadAnimation(anim)
		track.Priority = Enum.AnimationPriority.Action4
		track:Play(0)
		local by = os.clock() + 10
		while track.Length == 0 and os.clock() < by do task.wait(0.05) end
		if track.Length == 0 then error("the animation never loaded on " .. P.model .. " (not owned by this place's owner?)") end
		local gap = math.max(track.Length, 0.2) / 11
		local samples = {}
		for _ = 1, 10 do
			task.wait(gap)
			if not track.IsPlaying then break end
			local tr = {}
			for part, j in js do tr[part] = components(j.Transform) end
			table.insert(samples, { time = track.TimePosition, transforms = tr })
		end
		return { length = track.Length, samples = samples }
	end)
	if track then pcall(function() track:Stop(0) end) end
	if anim then anim:Destroy() end
	if ks then ks:Destroy() end
	if not ok then return { ok = false, error = tostring(res), rigType = result.rigType, loader = loader } end
	result.length = res.length
	result.samples = res.samples
end
if not humanoid then
	result.skipped = P.model .. " has no Humanoid, so verify does not walk it; move it from your game's code to see its walk"
	return result
end
local root = humanoid.RootPart
if not root then return { ok = false, error = P.model .. "'s Humanoid has no root part" } end
if root.Anchored then return { ok = false, error = P.model .. "'s root part is anchored, so it cannot walk; unanchor it (its Humanoid holds it up)" } end
local target = P.target and Vector3.new(P.target[1], P.target[2], P.target[3]) or (root.CFrame * CFrame.new(0, 0, -12)).Position
local ids = {}
for _, id in loader.ids do ids[id] = true end
local samples, started, last = {}, os.clock(), root.Position
local function sample(phase)
	task.wait(0.1)
	local v = root.AssemblyLinearVelocity
	local speed = Vector3.new(v.X, 0, v.Z).Magnitude
	local best
	for _, t in animator:GetPlayingAnimationTracks() do
		local id = t.Animation and t.Animation.AnimationId or ""
		if ids[id] and (not best or t.WeightCurrent > best.WeightCurrent) then best = t end
	end
	local s = { t = round2(os.clock() - started), phase = phase, speed = round2(speed), playing = best and best.Animation.AnimationId or false }
	if best then s.pace = round2(best.Speed) end
	table.insert(samples, s)
end
local reached
local connection = humanoid.MoveToFinished:Connect(function(value) reached = value end)
humanoid:MoveTo(target)
while reached == nil and os.clock() - started < 8 do sample("moving") end
connection:Disconnect()
for _ = 1, 15 do sample("standing") end
result.observation = { mode = "walked", reached = reached == true, samples = samples }
return result`;

export function verifyModelProgram(o: { model: string; sequence: KeyframeSequenceDescription | null; animationId: string | null; target: [number, number, number] | null }): string {
  return `local P = ${jsonToLuau(o)}\n${RESOLVE_LUAU}${SEQUENCE_LUAU}${VERIFY_MODEL_LUAU}`;
}
```

`SEQUENCE_LUAU` defines `r6` and `buildSequence`; `RESOLVE_LUAU` defines `animatedModel`. If Task 1's Ruling switched to a client probe, replace the movement part with reading the replicated model's tracks and say so in the ledger.

- [ ] **Step 4: verify branch for models in `animateTool`**

At the top of the verify branch:

```ts
    if (typeof a.model === 'string') return verifyModel(a, ctx);
```

```ts
async function verifyModel(a: Record<string, unknown>, ctx: ToolCtx): Promise<ToolOutput> {
  const P = ctx.projectPath;
  const path = modelPath(a.model as string);
  const stored = typeof a.name === 'string' && ANIM_NAME.test(a.name) ? loadChecked(P, a.name) : null;
  if (typeof a.name === 'string' && !stored) return err(`no checked animation ${a.name}: run animate check first`, 'not checked');
  const loader = planModelLoader(P);
  // The checked motion plays as a temporary clip; the wired asset ids are
  // verified by watching the loader play them below.
  const playId: string | null = null;
  let reply: VerifyModelReply;
  try {
    reply = await withPlay(ctx.session, async () => {
      const r = await runLuau(ctx.session, verifyModelProgram({ model: path, sequence: stored && !playId ? stored.sequence : null, animationId: playId, target: (a.target as [number, number, number] | undefined) ?? null }), 'server', { chunkName: 'animateVerifyModel', timeoutMs: 90_000 });
      if (!r.ok) throw new Error(r.error?.message ?? 'probe failed');
      const p = parseReply(r.values, 'verify');
      if (!p.ok) throw new Error(p.error);
      return p.value as unknown as VerifyModelReply;
    });
  } catch (e) {
    return err(`verify failed: ${(e as Error).message}`, 'probe failed');
  }
  const problems: string[] = [];
  const lines: string[] = [];
  if (!reply.ok) problems.push(reply.error ?? 'the probe failed');
  if (!loader.ok) problems.push(loader.error);
  else if (loader.write) problems.push(`${MODEL_LOADER_PATH} is missing: animate wire writes it`);
  if (stored && reply.ok) {
    const check = verifyLivePlayback(stored.sequence, reply.samples, rigForSequence(P, stored.sequence));
    lines.push(`${check.verified ? '✓' : '✗'} ${stored.sequence.name} on ${path}${playId ? ` (${playId})` : ' (temporary clip)'} within ${check.maxDegrees}° / ${check.maxStuds} studs over ${check.samples} samples`);
    if (!check.verified) problems.push(check.reason ?? 'played differently from the checked motion');
  }
  if (reply.ok && reply.skipped) lines.push(`· ${reply.skipped}`);
  if (reply.ok && reply.observation) {
    const m = judgeMovement(reply.observation, { unchanged: loader.ok, ids: reply.loader?.ids ?? {}, speeds: reply.loader?.speeds ?? {} });
    const moved = Object.entries(m.moving.played).map(([k, n]) => `${k}×${n}`).join(', ');
    const stood = Object.entries(m.standing.played).map(([k, n]) => `${k}×${n}`).join(', ');
    lines.push(`${m.verified ? '✓' : '✗'} ${m.pace?.state ?? 'walk'} while moving (${moved || 'no samples'}), idle while standing (${stood || 'no samples'})${m.pace ? `; pace ${m.pace.played} for ${m.pace.needed} needed` : ''}`);
    if (!m.verified) problems.push(m.reason ?? 'the loader played the wrong state');
  }
  lines.push(...problems.map((p) => `  ${p}`));
  const dir = animDir(P, stored ? stored.sequence.name : path.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^[^A-Za-z]/, 'M'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'verify.json'), JSON.stringify({ at: new Date().toISOString(), model: path, reply: { ...reply, samples: reply.samples?.length }, problems }, null, 2));
  return { text: lines.join('\n'), isError: problems.length > 0, summary: problems.length ? 'verify failed' : 'verified' };
}
```

Imports: `judgeMovement, verifyLivePlayback, MODEL_STATES` (already imported), `verifyModelProgram, type VerifyModelReply` from `./studio.js`; `mkdirSync` from `node:fs`.

The `✓ walk while moving` text depends on `m.pace?.state`; when `judgeMovement` returns no pace (no ground speed) it prints `walk`. Fine for the test.

- [ ] **Step 5: Lune compile list**

In `tests/anim.verify.test.ts` add `'verify_model.luau': verifyModelProgram({ model: 'Workspace.Guard', sequence: c.sequence, animationId: null, target: null }),`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/anim.verifymodel.test.ts tests/anim.verify.test.ts 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 7: Typecheck, commit**

```bash
npx tsc --noEmit && git add src/anim tests/anim.verifymodel.test.ts tests/anim.verify.test.ts && git commit -m "animate: verify an NPC or model in a playtest (playback + loader movement)"
```

---

### Task 9: Skill, recipes, CLI, guide, description

**Files:**
- Modify: `skills/blox/animation/character-animation/SKILL.md`, `tests/anim.recipes.test.ts`, `src/anim/tool.ts` (`ANIMATE_DESCRIPTION`), `src/cliTools.ts` (animate cases + HELP), `src/agentGuide.ts`
- Test: `tests/anim.recipes.test.ts`, `tests/cliTools*.test.ts` if one covers animate (grep first)

**Interfaces:**
- Consumes: everything above.
- Produces: recipes `DogWalk`, `TailWag` (rig `Workspace.Dog`); CLI `blox animate rig <model>`, `declare <model> [--plan quadruped] [--declarations file.json]`, `npc <name> --rig R15 --at x,y,z`, `wire --model <path> --state walk <name> <asset>`, `verify --model <path> [name]`.

- [ ] **Step 1: Failing recipe test**

In `tests/anim.recipes.test.ts`: change the expected list to `['DogWalk', 'Idle', 'Jump', 'Run', 'TailWag', 'Walk', 'WalkR6', 'Wave', 'WaveR6']`, add `'DogWalk'` to `GAITS`, and compile model recipes against the fixture dog:

```ts
import { rigFromModel } from '../src/anim/model-rig.js';
import { kneeDeclarations, partsDog } from './fixtures/anim/parts-dog.js';

const DOG = (() => { const r = rigFromModel({ ...partsDog({ knees: true, declarations: kneeDeclarations() }), path: 'Workspace.Dog' }); if (!r.ok) throw new Error(r.errors.join()); return r.rig; })();
```

and in the `it.each` body use `const model = all.get(name)!.rig === 'Workspace.Dog' ? DOG : undefined; const c = compilePoseAnimation(all.get(name), model);` and `const rig = model ?? rigFor(c.sequence.rig);`.

Run: `npx vitest run tests/anim.recipes.test.ts 2>&1 | tail -5`
Expected: FAIL — DogWalk / TailWag missing.

- [ ] **Step 2: Skill doc**

Append to `skills/blox/animation/character-animation/SKILL.md`:

````markdown
## NPCs

`animate {action:"npc", name:"Guard", rig:"R15", at:[x,y,z]}` makes a stock body
with no `Animate` script, tagged `BloxAnimated`, and writes
`src/ServerScriptService/BloxModelAnimate.server.luau` — one server script
that plays every tagged model's idle, walk and run by its speed. Then:
check a looping idle and a walk (`locomotion:true`), build, have a human
approve and upload, and wire each:
`animate {action:"wire", model:"Workspace.Guard", state:"walk", name:"Walk", asset}`.
The loader paces a gait at speed ÷ ground speed, between 0.5× and 2×; outside
that, set the Humanoid's `WalkSpeed` (wire warns). Prove it with
`animate {action:"verify", model:"Workspace.Guard", name:"Walk"}` (a playtest
walks it 12 studs and watches). Clones of the NPC keep the tag and attributes.
An attack or other one-shot: play it from game code,
`humanoid.Animator:LoadAnimation(anim):Play()`.

## A model's own rig

A Part-built model joined with `Motor6D`s (a dog, a door, a turret) is its own
rig: give its path as `rig` in the description (`"rig":"Workspace.Dog"`).
`animate {action:"rig", model}` lists the joints a pose may key and what the
checks cannot judge. Poses turn joints about the body's own axes (right, up,
back at rest). Rigging loose parts is not supported yet: rig it in Studio
first.

Declarations say what geometry cannot — feet, knees, ranges — as the model's
`BloxRig` attribute. For four legs named `FrontLeft`/`FrontLeftUpper`+
`FrontLeftLower` (and FrontRight, HindLeft, HindRight; `Head`, `Jaw`, `Tail`):
`animate {action:"declare", model, plan:"quadruped"}`. Otherwise give them:

```text
{ "version": 1,
  "feet": ["FrontLeftLower", ...],
  "hinges": { "FrontLeftKnee": { "axis": "X", "flex": -1 } },
  "limbs": { "FrontLeft": { "hinge": "FrontLeftKnee" } },
  "limits": { "Tail": { "turn": 90 }, "FrontLeftKnee": { "min": -150, "max": 10 } } }
```

Build plays the animation on a copy of the model, so the model must be rigged
as it was at check; wire works on the model and on copies of it.

### DogWalk (quadruped, `plan:"quadruped"` declared; replace the rig path)

```json
{ "name": "DogWalk", "rig": "Workspace.Dog", "loop": true, "priority": "Movement", "duration": 1,
  "gait": { "pattern": "walk", "stride": 1.2 } }
```

### TailWag

```json
{ "name": "TailWag", "rig": "Workspace.Dog", "loop": true, "priority": "Idle", "duration": 1,
  "waves": [{ "joints": ["Tail"], "axis": "Y", "amplitude": 20, "cycles": 2 }] }
```
````

(The `BloxRig` example uses a `text` fence so `loadRecipes` — which parses ` ```json ` blocks — does not take it for a recipe.)

Run: `npx vitest run tests/anim.recipes.test.ts tests/skills.test.ts 2>&1 | tail -5`
Expected: PASS. If TailWag fails `loopContinuity` or `rootDrift`, adjust `cycles` to a whole number (it is) and read the failing check's detail before changing the recipe.

- [ ] **Step 3: CLI, description, guide**

`src/cliTools.ts` `case 'animate'` — add before the `default` throw:

```ts
        case 'rig':
          return { tool: 'animate', args: { action, model: f.rest[1] } };
        case 'declare':
          return { tool: 'animate', args: { action, model: f.rest[1], ...str('plan'), ...(typeof o.declarations === 'string' ? { declarations: JSON.parse(readFileSync(o.declarations, 'utf8')) } : {}) } };
        case 'npc':
          return { tool: 'animate', args: { action, name: f.rest[1], ...str('rig'), ...(typeof o.at === 'string' ? { at: o.at.split(',').map(Number) } : {}), ...str('parent') } };
```

and change `wire`/`verify` to pass `...str('model'), ...str('state')` (wire with `--model` takes `name` as `f.rest[1]` and `asset` as `f.rest[2]`: `return { tool: 'animate', args: typeof o.model === 'string' ? { action, model: o.model, ...str('state'), name: f.rest[1], asset: f.rest[2], ...flag('force') } : { action, slot: f.rest[1], asset: f.rest[2], ...str('replaces'), ...str('rig') } }`; verify: `{ action, ...(f.rest[1] ? { name: f.rest[1] } : {}), ...str('slot'), ...str('asset'), ...str('model') }`). HELP: add a line under the animate line:

```
           blox animate rig <model> | declare <model> [--plan quadruped] | npc <name> --rig R15 --at x,y,z | wire --model <path> --state walk <name> <asset> | verify --model <path> [name]
```

`ANIMATE_DESCRIPTION`: replace the leading `'R15/R6 player-character animation` with `'Character, NPC and model animation` and append:

```
 | rig {model} (read a Part+Motor6D model\'s rig: joints, what checks cannot judge) | declare {model, plan:"quadruped" | declarations} (write its BloxRig: feet, knees, ranges) | npc {name, rig:R15|R6, at:[x,y,z], parent?} (stock NPC body + the BloxModelAnimate loader) | wire {model, state:idle|walk|run, name, asset, force?} (sets the model\'s loader attributes) | verify {model, name?, target?} (playtest server: playback + walks it and checks idle/walk and pace). check takes animation.rig = a model path for a model\'s own rig.
```

`src/agentGuide.ts`: after the existing animate line add: `NPCs / models: animate npc or rig → declare → check {rig:<model path>} → build → approve → upload → wire {model, state} → verify {model}.`

- [ ] **Step 4: Full suite + typecheck**

Run: `npx tsc --noEmit && npm test > $WS/t9.log 2>&1; tail -15 $WS/t9.log`
Expected: tsc clean; all tests pass (count ≈ 1000 + new). Any CLI test that pins the HELP text or `animate` arg shapes must be updated to the new lines.

- [ ] **Step 5: Commit**

```bash
git add skills src tests && git commit -m "animate: NPC + model-rig docs, DogWalk/TailWag recipes, CLI"
```

---

### Task 10: Live smoke, PR, memory

**Files:** none in the repo unless a live bug is found (then RED test → fix in the owning file, and a ledger line).

- [ ] **Step 1: Model rig, live (~/blox-fw, Studio on steal.rbxl, edit mode)**

Build a test dog in Studio with `run_luau` (edit): Model `Workspace.BloxDog` with Humanoid, invisible `HumanoidRootPart`, `Body`, `Head`, `Tail`, four legs `<Leg>Upper`/`<Leg>Lower` on Motor6Ds named `<Leg>` and `<Leg>Knee` at the parts-dog fixture's pivots (`LEG_ROOTS`, knee 0.8 below), `Neck`, `Tail`, root `Root`. Then from `~/blox-fw`:

```bash
B="npx tsx $HOME/blox/src/cli.ts"
$B animate rig Workspace.BloxDog
$B animate declare Workspace.BloxDog --plan quadruped
sed 's#Workspace.Dog#Workspace.BloxDog#' > /tmp/claude-1000/dogwalk.json <<'EOF'
{ "name": "DogWalk", "rig": "Workspace.Dog", "loop": true, "priority": "Movement", "duration": 1, "gait": { "pattern": "walk", "stride": 1.2 } }
EOF
$B animate check /tmp/claude-1000/dogwalk.json --locomotion && $B animate build DogWalk
```

Expected: rig lists 11 joints; declare writes feet ×4; check passes with a sheet; build "played on a copy of Workspace.BloxDog within ~0.x°". Also check `TailWag` the same way. Then move a Motor6D's C0 and rebuild: expected "rig changed since check".

- [ ] **Step 2: NPC, live**

```bash
$B animate npc BloxGuard --rig R15 --at 0,0,20
$B animate wire --model Workspace.BloxGuard --state walk Walk rbxassetid://<a stock R15 walk id, e.g. 913402848>
$B animate wire --model Workspace.BloxGuard --state idle Idle rbxassetid://<stock idle, e.g. 507766388>
$B animate verify --model Workspace.BloxGuard
```

Stock ids stand in for uploaded ones (upload stays human-gated). `Walk`/`Idle` must have been checked in `~/blox-fw` first (`animate check` from the recipes). Expected: verify walks it, `✓ walk while moving … idle while standing`; the pace line may report the stock walk's pace differs (stock ids' ground speed ≠ our recipe's) — record what it says. Clean up: delete `Workspace.BloxDog`, `Workspace.BloxGuard`, `BloxAnimations.DogWalk/TailWag`, the loader file in `~/blox-fw` (or keep and note it).

- [ ] **Step 3: Final review per executing-plans, then PR**

After the final whole-branch review and its fix pass:

```bash
git push -u origin animate-model-rigs && gh pr create --title "animate: model rigs + NPC loader (spec B)" --body "<summary, live smoke results, deferred minors>

https://claude.ai/code/session_01S9BqaZdZYrotiDVZwjqA1k" && gh pr merge --squash --delete-branch && git checkout main && git pull -q
```

- [ ] **Step 4: Memory**

Update `~/.claude/projects/-home-myen-blox/memory/game-pipeline-research.md` (PR number, what shipped, live facts learned) and its MEMORY.md line.
