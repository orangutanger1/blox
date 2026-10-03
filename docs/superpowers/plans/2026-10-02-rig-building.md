# Rig Building (animate spec C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `animate rig` can join a model's loose pieces into a Motor6D rig: blox suggests the joints, plans the whole rig offline, builds it in one Studio call, reads it back, and draws a range sheet. Blender rigid-piece creatures bring their own pivots.

**Architecture:** Roqer's pure planner `rig-build.ts` is vendored unchanged apart from renames. Two new pure modules sit beside it: `rigSuggest.ts`, which proposes joints from contact geometry, and `rigBlender.ts`, which fits Blender pivots to the inserted pieces. `rigBuild.ts` generates three edit-thread Luau programs (read pieces, build rig, stamp) on top of spec B's shared `RESOLVE_LUAU` and `READ_RIG_LUAU`. `rigTool.ts` holds the two new `animate rig` actions, and `tool.ts` dispatches to them. The Blender side gains `rig_rigid` and a `pivots.json` export.

**Tech Stack:** TypeScript (ESM, vitest, zod), Luau generated as strings (checked with Lune), Python `bpy` (Blender 5.x headless).

**Spec:** `docs/superpowers/specs/2026-10-02-rig-building-design.md`

## Global Constraints

- Vendored file: copy Roqer commit `4dcb9a7fd9b884cae4ed10fe282ee359550c10b4` `packages/core/src/animation/rig-build.ts`. Only import paths, `node:` prefixes and Roqer→blox names change (`RoqerRig` → `BloxRig`, "Roqer's bound" → "blox's bound"). Record every change in `src/anim/VENDOR.md`.
- Clone Roqer for the vendoring task: `git clone https://github.com/S4US/Roqer /tmp/claude-1000/roqer && git -C /tmp/claude-1000/roqer checkout 4dcb9a7` (the owner gave permission; already recorded in VENDOR.md).
- Agent data reaches edit-thread Luau only as `longString(JSON.stringify(payload))` decoded with `HttpService:JSONDecode`.
- No program may contain HTTP calls, script creation, `loadstring`, or asset loads.
- Model locations allowed: under Workspace, ServerStorage or ReplicatedStorage; never a player's character.
- Bounds: `MAX_PIECE_PARTS = 512` pieces; spec B's reader caps a rig at 64 joints and 128 parts.
- Studio attributes: `BloxRig` (declarations), `BloxRigBuilt` (rr1 revision stamped after a matching build), `BloxMadeRoot` (root the build made), `BloxMadeWeld` (rider welds the build made). Rider welds are named `BloxWeld_<part0>`.
- Contact slack 0.05 studs; rider share 5% of parent volume; Blender fit tolerance 0.05 studs; range sheet turns every joint ±30° about X and Z (vendored `RANGE_SHEET_TURN`).
- Saved files: `.blox/anims/_rig/<model path with non-[A-Za-z0-9_.-] → _>/suggest.json` and `range.png`. `_rig` cannot collide with an animation, because animation names start with a letter.
- Gate before every commit: `npx tsc --noEmit` clean and `npx vitest run` green. Lune-backed tests skip without `lune`, so run them with `~/.local/bin/lune` on PATH.
- Commit messages end with `Claude-Session: https://claude.ai/code/session_01S9BqaZdZYrotiDVZwjqA1k`.

## Review Focus

1. **A rotated model.** A model placed at an odd yaw (e.g. 37°) must suggest, build and fit exactly as an axis-aligned one. Pinned in Task 2 (suggest on `dogPieces({turn: 37})`) and Task 3 (fit on a 37°-turned dog).
2. **The agent echoes suggestion output back.** The `joints` array an agent copies from a suggest result carries `why` and `loose` keys, which `parseBuildJoints` refuses. They must be stripped, not rejected. Pinned in Task 5.
3. **The model changes between read and build.** For example, the user drags a part while the agent thinks. The build must refuse with `model_changed` and change nothing. Pinned in Task 4 (Luau compares fingerprints) and Task 5 (the tool surfaces the refusal).
4. **A stale `suggest.json`.** Pieces moved after suggest, then `joints:"suggested"` is used. Must refuse, naming both revisions. Pinned in Task 5.
5. **Ambiguous Blender matching.** Symmetric or collinear pieces, or name mismatches with differing counts. Must refuse rather than silently pick one rotation. Pinned in Task 3.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/anim/rig-build.ts` (vendored) | Pure planner: `planRigBuild`, `parseBuildJoints`, `builtRigMismatches`, types `PiecesReading`, `RigBuildJoint`, `RigBuildPlan`. |
| `src/anim/rigSuggest.ts` (new) | Pure `suggestJoints(reading, plan)`: contact graph → max-area spanning tree → pivots, riders, loose parts, notes. |
| `src/anim/rigBlender.ts` (new) | Pure `fitBlenderPivots(pivots, parts)`: 24 axis rotations × model yaw, name or position matching → world-space `RigBuildJoint[]`. |
| `src/anim/rigBuild.ts` (new) | Luau programs (`readPiecesProgram`, `buildRigProgram`, `stampRigProgram`) and their runners (`readPieces`, `buildRig`, `stampRig`). |
| `src/anim/rigTool.ts` (new) | `rigSuggestAction`, `rigBuildAction`, `rigDir`, `stripSuggested`: argument handling, saved files, range sheet, result text. |
| `src/anim/modelRig.ts` (modify) | `READ_RIG_LUAU`: the Humanoid root falls back to `HumanoidRootPart`, and the `not_rigged` message points to `rig suggest`. |
| `src/anim/tool.ts` (modify) | New schema keys, `rig` dispatch, description. |
| `src/cliTools.ts` (modify) | `blox animate rig <model> --suggest / --joints / --controller / --plan / --revision / --blender`. |
| `tools/blender/blox_model.py` (modify) | `rig_rigid`, `rigid_pivots`, `piece_materials`. |
| `tools/blender/model.py` (modify) | `cmd_export` writes `pivots.json` and a pieces-only GLB for rigid models. |
| `src/tools/registry.ts` (modify) | `model export` text mentions `pivots.json`. |
| `src/model/run.ts` (modify) | Brief helper line lists `rig_rigid`. |
| `skills/blox/animation/character-animation/SKILL.md` (modify) | "Rigging a model" section. |
| `src/anim/VENDOR.md` (modify) | rig-build vendored + renames. |

---

### Task 1: Vendor the rig-build planner

**Files:**
- Create: `src/anim/rig-build.ts` (copy of Roqer's)
- Create: `tests/fixtures/anim/dog-pieces.ts` (copy of Roqer's `__tests__/fixtures/dog-pieces.ts`)
- Create: `tests/anim.rig-build.test.ts` (port of Roqer's `__tests__/rig-build.test.ts`)
- Modify: `src/anim/VENDOR.md`

**Interfaces:**
- Consumes: the existing vendored `body-plans.ts`, `limb-reach.ts`, `motion.ts`, `model-rig.ts`, `rig.ts`, `animation-tool.ts` (`rangeSheetAnimation`), `pose-compiler.ts`; the fixture `tests/fixtures/anim/parts-dog.ts` (`partsDog`, `kneeDeclarations`, `LEG_ROOTS`, type `V`).
- Produces, from `src/anim/rig-build.js`:
  - Functions:
    - `planRigBuild(reading: PiecesReading, request: RigBuildRequest): RigBuildResult`, where `RigBuildResult` is either `{ ok: true; plan: RigBuildPlan; expected: ModelRigReading; notes: string[] }` or `{ ok: false; errorCode: string; errors: string[] }`.
    - `parseBuildJoints(value: unknown)`, returning either `{ ok: true; joints: RigBuildJoint[] }` or `{ ok: false; errors: string[] }`.
    - `builtRigMismatches(expected: ModelRigReading, actual: ModelRigReading): string[]`.
    - `isBodyPlan`.
  - Constants: `MAX_PIECE_PARTS`, `PIVOT_SLACK`, `ROOT_PART`, `ROOT_JOINT`.
  - Types: `PiecesReading`, `PiecePart`, `PieceLink`, `RigBuildJoint`, `RigBuildRequest`, `RigBuildPlan`.
- From `tests/fixtures/anim/dog-pieces.js`: `dogFrame`, `dogPieces(options?: { at?: V; turn?: number }): PiecesReading`, `dogJoints(options?): RigBuildJoint[]`.

- [ ] **Step 1: Copy the files**

```bash
R=/tmp/claude-1000/roqer/packages/core/src
cp $R/animation/rig-build.ts src/anim/rig-build.ts
cp $R/__tests__/fixtures/dog-pieces.ts tests/fixtures/anim/dog-pieces.ts
cp $R/__tests__/rig-build.test.ts tests/anim.rig-build.test.ts
```

- [ ] **Step 2: Apply the local changes**

In `src/anim/rig-build.ts`:
- Line 17: `/** The most parts a model \`rig\` builds on may have: Roqer's bound, so a reading stays small. */` → `... blox's bound, ...`.
- Line 646: `'its RoqerRig is not the declarations written'` → `'its BloxRig is not the declarations written'`.
- Check the imports are already `./x.js` relative. They are in Roqer, so no change.

In `tests/fixtures/anim/dog-pieces.ts`: the import `'../../animation/rig-build.js'` → `'../../../src/anim/rig-build.js'`. `./parts-dog.js` stays.

In `tests/anim.rig-build.test.ts`:
- `import { describe, expect, test } from '@jest/globals';` → `import { describe, expect, test } from 'vitest';`
- Every `'../animation/X.js'` → `'../src/anim/X.js'`.
- `'./fixtures/dog-pieces.js'` → `'./fixtures/anim/dog-pieces.js'`; `'./fixtures/parts-dog.js'` → `'./fixtures/anim/parts-dog.js'`.
- Line 380: `'its RoqerRig is not the declarations written'` → `'its BloxRig is not the declarations written'`.

Then: `grep -n "Roqer" src/anim/rig-build.ts tests/anim.rig-build.test.ts tests/fixtures/anim/dog-pieces.ts`. Expected: no output.

- [ ] **Step 3: Run the ported tests**

Run: `npx vitest run tests/anim.rig-build.test.ts`
Expected: PASS, all ~30 tests. If a test fails only because `tests/fixtures/anim/parts-dog.ts` differs from Roqer's, diff the two (`diff $R/__tests__/fixtures/parts-dog.ts tests/fixtures/anim/parts-dog.ts`) and port the missing export; do not edit `rig-build.ts`.

- [ ] **Step 4: Record the vendoring in VENDOR.md**

Append to `src/anim/VENDOR.md`:

```markdown
Spec C (rig building) adds rig-build (`planRigBuild`, `parseBuildJoints`,
`planRigAdopt`, `builtRigMismatches`) with its tests
(tests/anim.rig-build.test.ts) and the dog-pieces fixture
(tests/fixtures/anim/dog-pieces.ts). Local changes: "Roqer's bound" →
"blox's bound"; the read-back message `its RoqerRig …` → `its BloxRig …`.
The Studio side (Roqer's plugin handlers animationReadPieces /
animationBuildRig) is not vendored: blox ports it to edit-thread Luau in
src/anim/rigBuild.ts, with attributes BloxMadeRoot / BloxMadeWeld /
BloxRigBuilt and rider welds named BloxWeld_<part0>. Import-space pivots
(BloxRigOrigin), importer-rig replacement and skinned rigs stay in the
planner's code but blox's tool refuses them.

Still not vendored: rig-glb, rig-tool.
```

Remove the earlier line `Not vendored: rig-build, rig-glb, rig-tool (spec C: building rigs).`

- [ ] **Step 5: Gate and commit**

Run: `npx tsc --noEmit && npx vitest run tests/anim.rig-build.test.ts`
Expected: clean, PASS.

```bash
git add src/anim/rig-build.ts src/anim/VENDOR.md tests/anim.rig-build.test.ts tests/fixtures/anim/dog-pieces.ts
git commit -m "anim: vendor Roqer rig-build planner (spec C)

Claude-Session: https://claude.ai/code/session_01S9BqaZdZYrotiDVZwjqA1k"
```

---

### Task 2: Joint suggester

**Files:**
- Create: `src/anim/rigSuggest.ts`
- Test: `tests/anim.rigSuggest.test.ts`

**Interfaces:**
- Consumes: `PiecesReading`, `RigBuildJoint`, `planRigBuild`, `parseBuildJoints` (Task 1); `BodyPlan` from `./body-plans.js`.
- Produces:
  - `suggestJoints(reading: PiecesReading, plan: BodyPlan): Suggestion`
  - `interface SuggestedJoint extends RigBuildJoint { why: string; loose?: number }`
  - `interface Suggestion { trunk: string; joints: SuggestedJoint[]; notes: string[] }`
  - Constants `CONTACT_SLACK = 0.05` and `RIDER_SHARE = 0.05`.

- [ ] **Step 1: Write the failing tests**

`tests/anim.rigSuggest.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { suggestJoints } from '../src/anim/rigSuggest.js';
import { parseBuildJoints, planRigBuild, type PiecesReading } from '../src/anim/rig-build.js';
import { dogJoints, dogPieces } from './fixtures/anim/dog-pieces.js';

const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const strip = (j: Record<string, unknown>) => { const { why: _w, loose: _l, ...rest } = j; return rest; };
const box = (name: string, at: [number, number, number], size: [number, number, number]) => ({ name, cframe: [...at, 1, 0, 0, 0, 1, 0, 0, 0, 1], size });
const reading = (parts: PiecesReading['parts']): PiecesReading => ({ path: 'Workspace.Thing', revision: 'rp1:x', pivot: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], parts, joints: [], welds: [], controllers: [] });

describe('suggestJoints on the Parts dog', () => {
  for (const turn of [0, 37]) {
    it(`proposes the hand rig's tree, names and pivots (turned ${turn}°)`, () => {
      const s = suggestJoints(dogPieces({ turn }), 'quadruped');
      expect(s.trunk).toBe('Body');
      const hand = dogJoints({ turn });
      const byPart = new Map(s.joints.map((j) => [j.part, j]));
      expect([...byPart.keys()].sort()).toEqual(hand.map((j) => j.part).sort());
      for (const h of hand) {
        const got = byPart.get(h.part)!;
        expect(got.parent, h.part).toBe(h.parent);
        expect(got.name ?? got.part, h.part).toBe(h.name ?? h.part);
        expect(dist(got.pivot, h.pivot), h.part).toBeLessThanOrEqual(0.15);
      }
      expect([...(byPart.get('Head')!.with ?? [])].sort()).toEqual(['LeftEar', 'Nose', 'RightEar']);
      expect(s.joints.every((j) => j.loose === undefined)).toBe(true);
    });
  }
  it('its output, stripped of why, plans a sound rig', () => {
    const s = suggestJoints(dogPieces(), 'quadruped');
    const parsed = parseBuildJoints(s.joints.map((j) => strip(j as unknown as Record<string, unknown>)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const r = planRigBuild(dogPieces(), { joints: parsed.joints, controller: 'Humanoid', plan: 'quadruped', replaceImporter: false });
    expect(r.ok, r.ok ? '' : r.errors.join('\n')).toBe(true);
  });
});

describe('suggestJoints on other bodies', () => {
  it('a biped: arms and legs on the torso, head on top', () => {
    const s = suggestJoints(reading([
      box('Torso', [0, 3, 0], [2, 2, 1]),
      box('Head', [0, 4.5, 0], [1, 1, 1]),
      box('LeftArm', [-1.5, 3, 0], [1, 2, 1]),
      box('RightArm', [1.5, 3, 0], [1, 2, 1]),
      box('LeftLeg', [-0.5, 1, 0], [1, 2, 1]),
      box('RightLeg', [0.5, 1, 0], [1, 2, 1]),
    ]), 'custom');
    expect(s.trunk).toBe('Torso');
    const parents = Object.fromEntries(s.joints.map((j) => [j.part, j.parent]));
    expect(parents).toEqual({ Head: 'Torso', LeftArm: 'Torso', RightArm: 'Torso', LeftLeg: 'Torso', RightLeg: 'Torso' });
    const leg = s.joints.find((j) => j.part === 'LeftLeg')!;
    expect(leg.pivot[1]).toBeCloseTo(2, 5); // the top of the leg, where it meets the torso
    const arm = s.joints.find((j) => j.part === 'LeftArm')!;
    expect(arm.pivot[0]).toBeCloseTo(-1, 5); // the arm's inner face
  });
  it('a snake: a chain from the biggest segment, each turning where it meets the last', () => {
    const segs = [0, 1, 2, 3].map((i) => box(`Seg${i}`, [0, 1, i * 2], i === 0 ? [1.2, 1.2, 2] : [1, 1, 2]));
    const s = suggestJoints(reading(segs), 'custom');
    expect(s.trunk).toBe('Seg0');
    expect(s.joints.map((j) => [j.part, j.parent])).toEqual([['Seg1', 'Seg0'], ['Seg2', 'Seg1'], ['Seg3', 'Seg2']]);
    expect(s.joints[1].pivot[2]).toBeCloseTo(3, 5);
  });
  it('a loose part is still joined, flagged with its gap', () => {
    const s = suggestJoints(reading([box('Body', [0, 0, 0], [2, 2, 2]), box('Orb', [0, 3, 0], [1, 1, 1])]), 'custom');
    const orb = s.joints.find((j) => j.part === 'Orb')!;
    expect(orb.parent).toBe('Body');
    expect(orb.loose).toBeCloseTo(1.5, 5);
    expect(s.notes.join('\n')).toMatch(/Orb touches nothing/);
  });
  it('a small part on the trunk keeps its own joint (the trunk has no joint to ride)', () => {
    const s = suggestJoints(reading([box('Body', [0, 0, 0], [4, 2, 4]), box('Gem', [0, 1.1, 0], [0.2, 0.2, 0.2])]), 'custom');
    expect(s.joints).toHaveLength(1);
    expect(s.joints[0].part).toBe('Gem');
  });
  it('quadruped names it cannot find become notes, never renames', () => {
    const s = suggestJoints(reading([box('Body', [0, 0, 0], [2, 1, 4]), box('Leg1', [0, -1, 0], [0.5, 1, 0.5])]), 'quadruped');
    expect(s.notes.join('\n')).toMatch(/FrontLeft/);
    expect(s.joints[0].part).toBe('Leg1');
  });
  it('skips hidden parts and a root an earlier build made', () => {
    const r = reading([box('Body', [0, 0, 0], [2, 2, 2]), box('Arm', [1.5, 0, 0], [1, 1, 1]), { ...box('HumanoidRootPart', [0, 0, 0], [2, 2, 2]), hidden: true, madeRoot: true }]);
    const s = suggestJoints(r, 'custom');
    expect(s.joints.map((j) => j.part)).toEqual(['Arm']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/anim.rigSuggest.test.ts`
Expected: FAIL, "Cannot find module '../src/anim/rigSuggest.js'".

- [ ] **Step 3: Implement `src/anim/rigSuggest.ts`**

```ts
// Proposing a rig for a model's loose pieces: which piece hangs from which and
// where it turns, from where the pieces touch. The agent reviews or edits the
// proposal; the planner (rig-build.ts) checks it, and the range sheet shows a
// pivot in the wrong place. Pure: nothing here reaches Studio.
import type { BodyPlan } from './body-plans.js';
import type { PiecesReading, RigBuildJoint } from './rig-build.js';

type V3 = [number, number, number];

/** How far apart two pieces may be and still touch, in studs. */
export const CONTACT_SLACK = 0.05;
/** A leaf piece smaller than this share of its parent rides it (welded) instead of getting a joint. */
export const RIDER_SHARE = 0.05;

const TRUNK_NAME = /^(upper)?(torso|body|trunk|chest)$/i;
const LIMB_WORD = /head|jaw|neck|tail|leg|arm|wing|fin|foot|feet|hand|paw|upper|lower|knee|elbow|tentacle|thigh|shin/i;
const QUADRUPED_LEGS = ['FrontLeft', 'FrontRight', 'HindLeft', 'HindRight'];

export interface SuggestedJoint extends RigBuildJoint {
  /** Why this parent and pivot, in a few words. */
  why: string;
  /** Set when the piece touches nothing: the gap to its parent, in studs. */
  loose?: number;
}

export interface Suggestion {
  trunk: string;
  joints: SuggestedJoint[];
  notes: string[];
}

interface Box { name: string; p: V3; r: readonly number[]; half: V3; volume: number }

const round = (v: number) => Math.round(v * 1e4) / 1e4 + 0;

function toLocal(b: Box, w: readonly number[]): V3 {
  const d = [w[0] - b.p[0], w[1] - b.p[1], w[2] - b.p[2]];
  const r = b.r;
  return [r[0] * d[0] + r[3] * d[1] + r[6] * d[2], r[1] * d[0] + r[4] * d[1] + r[7] * d[2], r[2] * d[0] + r[5] * d[1] + r[8] * d[2]];
}

function toWorld(b: Box, v: readonly number[]): V3 {
  const r = b.r;
  return [
    b.p[0] + r[0] * v[0] + r[1] * v[1] + r[2] * v[2],
    b.p[1] + r[3] * v[0] + r[4] * v[1] + r[5] * v[2],
    b.p[2] + r[6] * v[0] + r[7] * v[1] + r[8] * v[2],
  ];
}

function corners(b: Box): V3[] {
  const out: V3[] = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) out.push(toWorld(b, [sx * b.half[0], sy * b.half[1], sz * b.half[2]]));
  return out;
}

/** Where `other` meets `box`, in `box`'s own axes: other's bounds there, clipped to box grown by the slack. */
function region(box: Box, other: Box): { lo: V3; hi: V3 } | undefined {
  const pts = corners(other).map((c) => toLocal(box, c));
  const lo = [0, 1, 2].map((i) => Math.max(-box.half[i] - CONTACT_SLACK, Math.min(...pts.map((p) => p[i])))) as V3;
  const hi = [0, 1, 2].map((i) => Math.min(box.half[i] + CONTACT_SLACK, Math.max(...pts.map((p) => p[i])))) as V3;
  return lo.every((v, i) => v <= hi[i]) ? { lo, hi } : undefined;
}

function area(reg: { lo: V3; hi: V3 }): number {
  const e = [0, 1, 2].map((i) => reg.hi[i] - reg.lo[i]).sort((a, b) => b - a);
  return e[0] * e[1];
}

/** Where `child` turns on `parent`: the middle of where they meet, moved onto child's face toward the parent. */
function pivotOf(child: Box, parent: Box): V3 {
  const reg = region(child, parent)!;
  const c = [0, 1, 2].map((i) => (reg.lo[i] + reg.hi[i]) / 2) as V3;
  const e = [0, 1, 2].map((i) => reg.hi[i] - reg.lo[i]);
  const k = e.indexOf(Math.min(...e));
  const toward = toLocal(child, parent.p)[k];
  c[k] = (toward < 0 ? -1 : 1) * child.half[k];
  return toWorld(child, c).map(round) as V3;
}

/** The point of `b` nearest `w`. */
function nearestOn(b: Box, w: readonly number[]): V3 {
  const l = toLocal(b, w);
  return toWorld(b, l.map((v, i) => Math.max(-b.half[i], Math.min(b.half[i], v))));
}

function jointName(part: string): string | undefined {
  if (/^head$/i.test(part)) return 'Neck';
  const upper = /^(.+)Upper$/.exec(part);
  if (upper) return upper[1];
  const lower = /^(.+)Lower$/.exec(part);
  if (lower) return `${lower[1]}Knee`;
  return undefined;
}

export function suggestJoints(reading: PiecesReading, plan: BodyPlan): Suggestion {
  const boxes: Box[] = reading.parts
    .filter((part) => part.hidden !== true && part.madeRoot !== true)
    .map((part) => {
      const half: V3 = [part.size[0] / 2, part.size[1] / 2, part.size[2] / 2];
      return { name: part.name, p: [part.cframe[0], part.cframe[1], part.cframe[2]], r: part.cframe.slice(3, 12), half, volume: part.size[0] * part.size[1] * part.size[2] };
    });
  const notes: string[] = [];
  if (boxes.length === 0) return { trunk: '', joints: [], notes: ['no visible parts to rig'] };

  const byVolume = [...boxes].sort((a, b) => b.volume - a.volume || (a.name < b.name ? -1 : 1));
  const trunk = boxes.find((b) => TRUNK_NAME.test(b.name)) ?? byVolume[0];

  // Contact graph: a link wherever both boxes reach into each other (with slack), weighted by contact area.
  const links = new Map<Box, { to: Box; area: number }[]>(boxes.map((b) => [b, []]));
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const [a, b] = [boxes[i], boxes[j]];
      const ab = region(a, b);
      const ba = region(b, a);
      if (!ab || !ba) continue;
      const w = area(a.volume <= b.volume ? ab : ba);
      links.get(a)!.push({ to: b, area: w });
      links.get(b)!.push({ to: a, area: w });
    }
  }

  // Spanning tree from the trunk: a piece hangs from the touching piece nearest
  // the trunk (fewest hops), the biggest contact breaking ties — so legs hang
  // from the torso even where they touch each other.
  const parent = new Map<Box, { box: Box; area: number; gap?: number }>();
  const depth = new Map<Box, number>([[trunk, 0]]);
  const reached = new Set<Box>([trunk]);
  const order: Box[] = [];
  for (;;) {
    let best: { from: Box; to: Box; area: number; depth: number } | undefined;
    for (const from of reached) {
      const d = depth.get(from)!;
      for (const l of links.get(from)!) {
        if (reached.has(l.to)) continue;
        const better = !best || d < best.depth || (d === best.depth && (l.area > best.area || (l.area === best.area && l.to.name < best.to.name)));
        if (better) best = { from, to: l.to, area: l.area, depth: d };
      }
    }
    if (!best) break;
    reached.add(best.to);
    depth.set(best.to, best.depth + 1);
    parent.set(best.to, { box: best.from, area: best.area });
    order.push(best.to);
  }

  // Loose pieces: each joins the nearest reached piece, nearest first, and is flagged.
  // (depth is not needed past here: loose pieces never parent a contact link.)
  while (reached.size < boxes.length) {
    let best: { from: Box; to: Box; gap: number } | undefined;
    for (const to of boxes) {
      if (reached.has(to)) continue;
      for (const from of reached) {
        const onFrom = nearestOn(from, to.p);
        const onTo = nearestOn(to, onFrom);
        const gap = Math.hypot(onFrom[0] - onTo[0], onFrom[1] - onTo[1], onFrom[2] - onTo[2]);
        if (!best || gap < best.gap || (gap === best.gap && to.name < best.to.name)) best = { from, to, gap };
      }
    }
    reached.add(best!.to);
    parent.set(best!.to, { box: best!.from, area: 0, gap: best!.gap });
    order.push(best!.to);
    notes.push(`${best!.to.name} touches nothing: joined to ${best!.from.name} across a ${round(best!.gap)}-stud gap; move it to touch, or give its pivot yourself`);
  }

  // Riders: a small leaf whose name is not a limb word welds to its parent's joint.
  const children = new Map<Box, number>();
  for (const [, p] of parent) children.set(p.box, (children.get(p.box) ?? 0) + 1);
  const riders = new Map<Box, Box[]>();
  for (const b of order) {
    const p = parent.get(b)!;
    const leaf = !children.has(b);
    if (leaf && p.gap === undefined && p.box !== trunk && b.volume < RIDER_SHARE * p.box.volume && !LIMB_WORD.test(b.name)) {
      riders.set(p.box, [...(riders.get(p.box) ?? []), b]);
    }
  }
  const riding = new Set([...riders.values()].flat());

  const joints: SuggestedJoint[] = [];
  for (const b of order) {
    if (riding.has(b)) continue;
    const p = parent.get(b)!;
    const pivot = p.gap === undefined ? pivotOf(b, p.box) : (nearestOn(p.box, b.p).map(round) as V3);
    const name = jointName(b.name);
    const rode = riders.get(b)?.map((r) => r.name).sort();
    joints.push({
      part: b.name,
      parent: p.box.name,
      pivot,
      ...(name ? { name } : {}),
      ...(rode?.length ? { with: rode } : {}),
      why: p.gap === undefined ? `touches ${p.box.name} (${round(p.area)} studs²); turns on its face toward it` : `nearest piece, ${round(p.gap)} studs away`,
      ...(p.gap !== undefined ? { loose: round(p.gap) } : {}),
    });
  }

  if (plan === 'quadruped') {
    const names = new Set(boxes.map((b) => b.name));
    for (const leg of QUADRUPED_LEGS) {
      if (!names.has(leg) && !names.has(`${leg}Upper`)) notes.push(`plan quadruped: no ${leg} or ${leg}Upper part, so that leg's foot is not declared; rename the part or pass declarations`);
    }
    if (!names.has('Head')) notes.push('plan quadruped: no Head part; its neck is not declared');
  }
  return { trunk: trunk.name, joints, notes };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/anim.rigSuggest.test.ts`
Expected: PASS.

If the dog's `Neck` pivot lands at `z = -1.9` and not the hand rig's `-2`, that is expected: the distance is 0.1, within the 0.15 tolerance. If a pivot is off by more, print `s.joints` and check `pivotOf`'s axis choice before changing a tolerance.

- [ ] **Step 5: Gate and commit**

Run: `npx tsc --noEmit && npx vitest run tests/anim.rigSuggest.test.ts tests/anim.rig-build.test.ts`

```bash
git add src/anim/rigSuggest.ts tests/anim.rigSuggest.test.ts
git commit -m "anim: suggest rig joints from piece contacts (spec C)

Claude-Session: https://claude.ai/code/session_01S9BqaZdZYrotiDVZwjqA1k"
```

---

### Task 3: Blender pivot fit

**Files:**
- Create: `src/anim/rigBlender.ts`
- Test: `tests/anim.rigBlender.test.ts`

**Interfaces:**
- Consumes: `PiecesReading`, `RigBuildJoint` (Task 1).
- Produces:
  - `interface BlenderPivots { pieces: { name: string; bone: string; center: V3; size: V3 }[]; joints: { name: string; part: string; parent: string; pivot: V3 }[]; riders: Record<string, string[]> }`. This is the shape Task 7's `pivots.json` writes.
  - `AXIS_ROTATIONS: number[][]`: 24 row-major 3×3 matrices.
  - `FIT_TOLERANCE = 0.05`.
  - `fitBlenderPivots(pivots: BlenderPivots, parts: PiecesReading['parts'])`, returning either `{ ok: true; joints: RigBuildJoint[]; matchedBy: 'name' | 'position'; residual: number; notes: string[] }` or `{ ok: false; errors: string[] }`.

- [ ] **Step 1: Write the failing tests**

`tests/anim.rigBlender.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { AXIS_ROTATIONS, fitBlenderPivots, type BlenderPivots } from '../src/anim/rigBlender.js';
import { dogJoints, dogPieces } from './fixtures/anim/dog-pieces.js';

type V3 = [number, number, number];
const mul = (m: number[], v: readonly number[]): V3 => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
const tr = (m: number[]) => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
const absM = (m: number[]) => m.map(Math.abs);
const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * The dog as Blender would describe it if Roblox's import turned Blender
 * coordinates by `m` and moved them by `t`, in the model's own (unturned) frame.
 * `turn` turns the inserted model about Y.
 */
function blenderDog(m: number[], t: V3, turn = 0, rename: (n: string) => string = (n) => n): { pivots: BlenderPivots; parts: ReturnType<typeof dogPieces>['parts'] } {
  const pieces = dogPieces({ turn });
  const flat = dogPieces();
  const back = (q: readonly number[]) => mul(tr(m), [q[0] - t[0], q[1] - t[1], q[2] - t[2]]);
  const hand = dogJoints();
  const riders = hand.filter((j) => j.with?.length).map((j) => [j.part, j.with!] as const);
  return {
    parts: pieces.parts.map((p) => ({ ...p, name: rename(p.name) })),
    pivots: {
      pieces: flat.parts.map((p) => ({ name: p.name, bone: p.name, center: back(p.cframe.slice(0, 3)), size: mul(absM(tr(m)), p.size) })),
      joints: hand.map((j) => ({ name: j.name ?? j.part, part: j.part, parent: j.parent, pivot: back(j.pivot) })),
      riders: Object.fromEntries(riders),
    },
  };
}

describe('fitBlenderPivots', () => {
  it('there are 24 proper axis rotations', () => {
    expect(AXIS_ROTATIONS).toHaveLength(24);
  });
  it('recovers every axis rotation and offset, matched by name', () => {
    for (const m of AXIS_ROTATIONS) {
      const { pivots, parts } = blenderDog(m, [3, -1, 7]);
      const fit = fitBlenderPivots(pivots, parts);
      expect(fit.ok, fit.ok ? '' : fit.errors.join('\n')).toBe(true);
      if (!fit.ok) continue;
      expect(fit.matchedBy).toBe('name');
      for (const h of dogJoints()) {
        const got = fit.joints.find((j) => j.part === h.part)!;
        expect(dist(got.pivot, h.pivot)).toBeLessThan(1e-6);
        expect(got.parent).toBe(h.parent);
      }
      expect(fit.joints.find((j) => j.part === 'Head')!.with).toEqual(['LeftEar', 'RightEar', 'Nose']);
    }
  });
  it('places pivots on a model turned 37° after insert', () => {
    const { pivots, parts } = blenderDog(AXIS_ROTATIONS[5], [0, 2, 0], 37);
    const fit = fitBlenderPivots(pivots, parts);
    expect(fit.ok).toBe(true);
    if (!fit.ok) return;
    for (const h of dogJoints({ turn: 37 })) expect(dist(fit.joints.find((j) => j.part === h.part)!.pivot, h.pivot)).toBeLessThan(1e-6);
  });
  it('tolerates small noise, refuses a residual over tolerance', () => {
    const { pivots, parts } = blenderDog(AXIS_ROTATIONS[0], [0, 0, 0]);
    const noisy = { ...pivots, pieces: pivots.pieces.map((p, i) => ({ ...p, center: [p.center[0] + (i % 2 ? 0.01 : -0.01), p.center[1], p.center[2]] as V3 })) };
    expect(fitBlenderPivots(noisy, parts).ok).toBe(true);
    const moved = { ...pivots, pieces: pivots.pieces.map((p) => (p.name === 'Tail' ? { ...p, center: [p.center[0] + 1, p.center[1], p.center[2]] as V3 } : p)) };
    const r = fitBlenderPivots(moved, parts);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toMatch(/0\.05/);
  });
  it('matches by position when the upload renamed every piece', () => {
    const { pivots, parts } = blenderDog(AXIS_ROTATIONS[3], [1, 1, 1], 0, (n) => `Mesh_${n}`);
    const fit = fitBlenderPivots(pivots, parts);
    expect(fit.ok, fit.ok ? '' : fit.errors.join('\n')).toBe(true);
    if (!fit.ok) return;
    expect(fit.matchedBy).toBe('position');
    expect(fit.joints.find((j) => j.part === 'Mesh_Head')!.parent).toBe('Mesh_Body');
  });
  it('refuses names that do not match when the counts differ too', () => {
    const { pivots, parts } = blenderDog(AXIS_ROTATIONS[0], [0, 0, 0]);
    const r = fitBlenderPivots(pivots, parts.filter((p) => p.name !== 'Tail'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toMatch(/Tail/);
  });
  it('refuses a fit more than one rotation explains (pieces on one line)', () => {
    const line = ['A', 'B', 'C'].map((name, i) => ({ name, cframe: [0, 0, i * 2, 1, 0, 0, 0, 1, 0, 0, 0, 1], size: [1, 1, 2] as V3 }));
    const pivots: BlenderPivots = {
      pieces: line.map((p) => ({ name: p.name, bone: p.name, center: [0, p.cframe[2], 0], size: [1, 2, 1] })),
      joints: [{ name: 'B', part: 'B', parent: 'A', pivot: [0, 1, 0] }],
      riders: {},
    };
    const r = fitBlenderPivots(pivots, line);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toMatch(/more than one/);
  });
  it('refuses pieces turned differently from each other', () => {
    const { pivots, parts } = blenderDog(AXIS_ROTATIONS[0], [0, 0, 0]);
    const odd = parts.map((p) => (p.name === 'Tail' ? { ...p, cframe: [...p.cframe.slice(0, 3), 0, 0, 1, 0, 1, 0, -1, 0, 0] } : p));
    const r = fitBlenderPivots(pivots, odd);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toMatch(/turned differently/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/anim.rigBlender.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/anim/rigBlender.ts`**

```ts
// Carrying a Blender creature's pivots onto its pieces in Studio. blox model
// exports each piece as its own object plus pivots.json (bone heads in Blender
// coordinates). Roblox's importer turns and moves those coordinates by an
// amount blox does not assume: this fits it from the pieces' centres, trying
// every axis-aligned rotation in the model's own frame (the inserted model may
// be turned any way), and refuses when no single fit, or more than one, explains
// where the pieces are. Pure.
import type { PiecesReading, RigBuildJoint } from './rig-build.js';

type V3 = [number, number, number];

export interface BlenderPivots {
  pieces: { name: string; bone: string; center: V3; size: V3 }[];
  joints: { name: string; part: string; parent: string; pivot: V3 }[];
  riders: Record<string, string[]>;
}

/** How far a fitted piece centre or size may sit from Studio's, in studs. */
export const FIT_TOLERANCE = 0.05;

const det = (m: number[]) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);

/** Every proper rotation that maps axes onto axes: 24 signed permutation matrices with determinant +1, row-major. */
export const AXIS_ROTATIONS: number[][] = (() => {
  const out: number[][] = [];
  const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  for (const p of perms) for (const sx of [1, -1]) for (const sy of [1, -1]) for (const sz of [1, -1]) {
    const m = new Array<number>(9).fill(0);
    const s = [sx, sy, sz];
    for (let row = 0; row < 3; row++) m[row * 3 + p[row]] = s[row];
    if (Math.round(det(m)) === 1) out.push(m);
  }
  return out;
})();

const mul = (m: readonly number[], v: readonly number[]): V3 => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
const mulT = (m: readonly number[], v: readonly number[]): V3 => [m[0] * v[0] + m[3] * v[1] + m[6] * v[2], m[1] * v[0] + m[4] * v[1] + m[7] * v[2], m[2] * v[0] + m[5] * v[1] + m[8] * v[2]];
const sub = (a: readonly number[], b: readonly number[]): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: readonly number[], b: readonly number[]): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const len = (v: readonly number[]) => Math.hypot(v[0], v[1], v[2]);
const mean = (vs: readonly V3[]): V3 => vs.reduce((s, v) => add(s, v), [0, 0, 0] as V3).map((x) => x / vs.length) as V3;
const round = (v: number) => Math.round(v * 1e6) / 1e6 + 0;

interface Candidate { m: number[]; t: V3; residual: number; pairs: [number, number][] }

export function fitBlenderPivots(
  pivots: BlenderPivots,
  parts: PiecesReading['parts'],
): { ok: true; joints: RigBuildJoint[]; matchedBy: 'name' | 'position'; residual: number; notes: string[] } | { ok: false; errors: string[] } {
  const studio = parts.filter((p) => p.madeRoot !== true);
  if (pivots.pieces.length < 3) return { ok: false, errors: [`pivots.json has ${pivots.pieces.length} pieces; fitting them needs at least 3`] };
  if (studio.length === 0) return { ok: false, errors: ['the model has no parts'] };

  // The model's own frame: every imported piece shares its rotation.
  const r0 = studio[0].cframe.slice(3, 12);
  const turned = studio.filter((p) => p.cframe.slice(3, 12).some((v, i) => Math.abs(v - r0[i]) > 1e-3)).map((p) => p.name);
  if (turned.length) return { ok: false, errors: [`${turned.join(', ')} ${turned.length === 1 ? 'is' : 'are'} turned differently from ${studio[0].name}; blox fits pieces inserted together as one upload — undo the turn or give pivots yourself`] };
  const local = studio.map((p) => mulT(r0, p.cframe.slice(0, 3)));

  // Name match when every piece name is found exactly once; else position match if the counts agree.
  const index = new Map<string, number[]>();
  studio.forEach((p, i) => index.set(p.name, [...(index.get(p.name) ?? []), i]));
  const named = pivots.pieces.map((b) => index.get(b.name));
  const byName = named.every((n) => n?.length === 1);
  if (!byName && pivots.pieces.length !== studio.length) {
    const missing = pivots.pieces.filter((_, i) => named[i]?.length !== 1).map((b) => b.name);
    return { ok: false, errors: [`${missing.join(', ')} from pivots.json ${missing.length === 1 ? 'is' : 'are'} not one part in the model (missing or repeated), and the model has ${studio.length} parts, not ${pivots.pieces.length}; insert the uploaded model as it was exported`] };
  }

  const fits: Candidate[] = [];
  for (const m of AXIS_ROTATIONS) {
    const turnedB = pivots.pieces.map((b) => mul(m, b.center));
    let pairs: [number, number][];
    let t: V3;
    if (byName) {
      pairs = pivots.pieces.map((_, i) => [i, named[i]![0]]);
      t = sub(mean(pairs.map(([, s]) => local[s])), mean(pairs.map(([b]) => turnedB[b])));
    } else {
      t = sub(mean(local), mean(turnedB));
      const free = new Set(studio.map((_, i) => i));
      pairs = [];
      for (let b = 0; b < turnedB.length; b++) {
        const at = add(turnedB[b], t);
        let best = -1;
        for (const s of free) if (best < 0 || len(sub(local[s], at)) < len(sub(local[best], at))) best = s;
        free.delete(best);
        pairs.push([b, best]);
      }
    }
    let residual = 0;
    let sizesAgree = true;
    for (const [b, s] of pairs) {
      residual = Math.max(residual, len(sub(add(turnedB[b], t), local[s])));
      const size = mul(m.map(Math.abs), pivots.pieces[b].size);
      if (size.some((v, i) => Math.abs(v - studio[s].size[i]) > FIT_TOLERANCE)) sizesAgree = false;
    }
    if (sizesAgree) fits.push({ m, t, residual, pairs });
  }
  fits.sort((a, b) => a.residual - b.residual);
  const good = fits.filter((f) => f.residual <= FIT_TOLERANCE);
  if (good.length === 0) {
    const best = fits[0];
    return { ok: false, errors: [best ? `no single turn and move puts the Blender pieces where the model's are: the best fit leaves a piece ${round(best.residual)} studs off (tolerance ${FIT_TOLERANCE}); was a piece moved after insert?` : `no turn matches the pieces' sizes within ${FIT_TOLERANCE} studs; is this the model pivots.json was exported with?`] };
  }
  if (good.length > 1) return { ok: false, errors: [`more than one turn fits the pieces (${good.length}): they lie on one line or are symmetric, so blox cannot tell which way the upload faces; give the pivots yourself`] };

  const fit = good[0];
  const nameOf = new Map(fit.pairs.map(([b, s]) => [pivots.pieces[b].name, studio[s].name]));
  const place = (v: readonly number[]): V3 => mul(r0, add(mul(fit.m, v), fit.t)).map(round) as V3;
  const joints: RigBuildJoint[] = [];
  const errors: string[] = [];
  for (const j of pivots.joints) {
    const part = nameOf.get(j.part);
    const parent = nameOf.get(j.parent);
    if (!part || !parent) {
      errors.push(`pivots.json joint ${j.name} names ${!part ? j.part : j.parent}, which is not a piece`);
      continue;
    }
    const riders = (pivots.riders[j.part] ?? []).map((r) => nameOf.get(r) ?? r);
    joints.push({ part, parent, pivot: place(j.pivot), name: j.name, ...(riders.length ? { with: riders } : {}) });
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    joints,
    matchedBy: byName ? 'name' : 'position',
    residual: round(fit.residual),
    notes: [`fitted the Blender pieces to the model within ${round(fit.residual)} studs (matched by ${byName ? 'name' : 'position'})`],
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/anim.rigBlender.test.ts`
Expected: PASS.

The dog has two symmetric pairs of ears and legs but is not symmetric as a whole (head front, tail back), so exactly one rotation fits. If the "every rotation" test reports `more than one turn fits` for some `m`, print `good.map(g => g.residual)`. The size check is what separates mirror-equivalent turns; do not loosen `FIT_TOLERANCE`.

- [ ] **Step 5: Gate and commit**

Run: `npx tsc --noEmit && npx vitest run tests/anim.rigBlender.test.ts`

```bash
git add src/anim/rigBlender.ts tests/anim.rigBlender.test.ts
git commit -m "anim: fit Blender rigid-piece pivots to inserted pieces (spec C)

Claude-Session: https://claude.ai/code/session_01S9BqaZdZYrotiDVZwjqA1k"
```

---

### Task 4: Studio programs (read pieces, build rig, stamp)

**Files:**
- Create: `src/anim/rigBuild.ts`
- Modify: `src/anim/modelRig.ts` (`READ_RIG_LUAU` root fallback + `not_rigged` message)
- Modify: `tests/anim.modelRig.test.ts:41` and `tests/anim.rigtool.test.ts:28-30` if they assert the old message text. They feed their own fake text, so they keep passing; leave them.
- Test: `tests/anim.rigBuild.test.ts`

**Interfaces:**
- Consumes: `RESOLVE_LUAU`, `READ_RIG_LUAU`, `parseReply`, `modelPath`, `rigRevision` from `./modelRig.js`; `longString`, `runLuau` from `../studio/luau.js`; `StudioSession`; `PiecesReading`, `RigBuildPlan` (Task 1); `ModelRigReading` from `./model-rig.js`.
- Produces:
  - Program builders: `readPiecesProgram(path: string): string`, `buildRigProgram(path: string, plan: RigBuildPlan, expect: string): string`, `stampRigProgram(path: string, revision: string, expect: string): string`.
  - `readPieces(session, path)`, returning either `{ ok: true; reading: PiecesReading; fingerprint: string }` or `{ ok: false; error: string; code?: string }`.
  - `buildRig(session, path, plan, expect)`, returning `RigBuildReply`:
    - success: `{ ok: true; reading: ModelRigReading; fingerprint: string; recorded: boolean; backup?: string; removed: string[] }`
    - failure: `{ ok: false; error: string; code?: string; built?: boolean; backup?: string }`
  - `stampRig(session, path, revision, expect)`, returning either `{ ok: true }` or `{ ok: false; error: string }`.
  - Program markers (first line): `-- BloxReadPieces`, `-- BloxRigBuild`, `-- BloxRigStamp`.

- [ ] **Step 1: Patch spec B's reader**

In `src/anim/modelRig.ts`, inside `READ_RIG_LUAU`:

Replace
```lua
		root = humanoid.RootPart
		if not root then return { ok = false, code = "rig_root", error = path .. "'s Humanoid has no root part; give it a HumanoidRootPart" } end
```
with
```lua
		root = humanoid.RootPart or model:FindFirstChild("HumanoidRootPart")
		if not root or not root:IsA("BasePart") then return { ok = false, code = "rig_root", error = path .. "'s Humanoid has no root part; give it a HumanoidRootPart" } end
```
This lets the read-back work right after a build, before the Humanoid binds its `RootPart`.

Replace the `not_rigged` message
```lua
". Rig building is not supported yet; rig it in Studio (Rig Builder / RigEdit) or Blender"
```
with
```lua
". Join its pieces into a rig: animate {action:\"rig\", model:\"" .. path .. "\", suggest:true}"
```

- [ ] **Step 2: Write the failing tests**

`tests/anim.rigBuild.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRig, buildRigProgram, readPieces, readPiecesProgram, stampRig, stampRigProgram } from '../src/anim/rigBuild.js';
import { planRigBuild } from '../src/anim/rig-build.js';
import { rigRevision } from '../src/anim/modelRig.js';
import type { StudioSession } from '../src/studio/session.js';
import { dogJoints, dogPieces } from './fixtures/anim/dog-pieces.js';
import { luneBin, luneCheck } from './helpers/lune.js';

const envelope = (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, n: 1, values: { v1: JSON.stringify(v) }, logs: [] }) }] });
const session = (reply: (code: string) => unknown, codes: string[] = []) =>
  ({ call: async (_n: string, a: Record<string, unknown>) => { codes.push(String(a.code)); return envelope(reply(String(a.code))); } }) as unknown as StudioSession;

function rawDog() {
  const { revision: _r, ...rest } = dogPieces();
  return { ...rest, path: 'Workspace.Dog' };
}
function planned() {
  const r = planRigBuild({ ...dogPieces(), path: 'Workspace.Dog' }, { joints: dogJoints(), controller: 'Humanoid', plan: 'quadruped', replaceImporter: false });
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r;
}

describe('rig programs compile', () => {
  const d = mkdtempSync(join(tmpdir(), 'blox-rigbuild-'));
  it.skipIf(!luneBin())('read pieces', () => {
    writeFileSync(join(d, 'read.luau'), readPiecesProgram('Workspace.Dog'));
    expect(luneCheck([join(d, 'read.luau')])).toEqual([]);
  });
  it.skipIf(!luneBin())('build rig', () => {
    writeFileSync(join(d, 'build.luau'), buildRigProgram('Workspace.Dog', planned().plan, 'fp'));
    expect(luneCheck([join(d, 'build.luau')])).toEqual([]);
  });
  it.skipIf(!luneBin())('stamp', () => {
    writeFileSync(join(d, 'stamp.luau'), stampRigProgram('Workspace.Dog', 'rr1:abc', 'fp'));
    expect(luneCheck([join(d, 'stamp.luau')])).toEqual([]);
  });
});

describe('program payloads', () => {
  it('carry data only as a decoded payload, with their marker first', () => {
    const read = readPiecesProgram('game.Workspace.Dog');
    expect(read.split('\n')[0]).toBe('-- BloxReadPieces');
    expect(read).toMatch(/"path":"Workspace\.Dog"/);
    const build = buildRigProgram('Workspace.Dog', planned().plan, 'fp1');
    expect(build.split('\n')[0]).toBe('-- BloxRigBuild');
    expect(build).toMatch(/"expect":"fp1"/);
    expect(build).toMatch(/FrontLeftKnee/);
    for (const p of [read, build, stampRigProgram('Workspace.Dog', 'rr1:x', 'f')]) {
      expect(p).not.toMatch(/HttpService:(GetAsync|PostAsync|RequestAsync)|loadstring|require\(/);
    }
  });
});

describe('readPieces', () => {
  it('turns the reply into a PiecesReading with an rp1 revision', async () => {
    const r = await readPieces(session(() => ({ ok: true, reading: rawDog(), fingerprint: '0123abcd4567ef89' })), 'Workspace.Dog');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reading.revision).toBe('rp1:0123abcd4567ef89');
    expect(r.reading.parts).toHaveLength(dogPieces().parts.length);
    expect(r.reading.rig).toBeUndefined();
  });
  it('a jointed model gets its rig revision and the stamp it was built with', async () => {
    const exp = planned().expected;
    const { revision: _r, ...rigReading } = exp;
    const raw = { ...rawDog(), joints: [{ name: 'Neck', part0: 0, part1: 1 }], rigReading, builtRevision: 'rr1:old' };
    const r = await readPieces(session(() => ({ ok: true, reading: raw, fingerprint: 'f' })), 'Workspace.Dog');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reading.rig).toEqual({ revision: rigRevision(rigReading), builtRevision: 'rr1:old' });
    expect('rigReading' in r.reading).toBe(false);
  });
  it('a jointed model whose rig does not read is "unreadable"', async () => {
    const raw = { ...rawDog(), joints: [{ name: 'Neck', part0: 0, part1: 1 }] };
    const r = await readPieces(session(() => ({ ok: true, reading: raw, fingerprint: 'f' })), 'Workspace.Dog');
    expect(r.ok && r.reading.rig?.revision).toBe('unreadable');
  });
  it('passes refusals and garbage through as named errors', async () => {
    const no = await readPieces(session(() => ({ ok: false, code: 'skinned', error: 'Workspace.Wolf is a skinned mesh' })), 'Workspace.Wolf');
    expect(no).toEqual({ ok: false, code: 'skinned', error: 'Workspace.Wolf is a skinned mesh' });
    const junk = await readPieces({ call: async () => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, n: 1, values: { v1: 'oops' }, logs: [] }) }] }) } as unknown as StudioSession, 'Workspace.Dog');
    expect(junk.ok).toBe(false);
    if (!junk.ok) expect(junk.error).toMatch(/non-JSON/);
  });
});

describe('buildRig and stampRig', () => {
  it('returns the read-back with its rr1 revision', async () => {
    const { revision: _r, ...raw } = planned().expected;
    const codes: string[] = [];
    const r = await buildRig(session(() => ({ ok: true, reading: raw, fingerprint: 'rigfp', recorded: true, removed: [] }), codes), 'Workspace.Dog', planned().plan, 'fp');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reading.revision).toBe(rigRevision(raw));
    expect(r.recorded).toBe(true);
    expect(codes[0].split('\n')[0]).toBe('-- BloxRigBuild');
  });
  it('a model_changed refusal comes back named', async () => {
    const r = await buildRig(session(() => ({ ok: false, code: 'model_changed', error: 'Workspace.Dog has changed since its pieces were read. Nothing was changed; call rig again.' })), 'Workspace.Dog', planned().plan, 'fp');
    expect(r).toMatchObject({ ok: false, code: 'model_changed' });
  });
  it('stamp passes ok and refusals', async () => {
    expect(await stampRig(session(() => ({ ok: true })), 'Workspace.Dog', 'rr1:x', 'f')).toEqual({ ok: true });
    expect(await stampRig(session(() => ({ ok: false, error: 'changed' })), 'Workspace.Dog', 'rr1:x', 'f')).toEqual({ ok: false, error: 'changed' });
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tests/anim.rigBuild.test.ts`
Expected: FAIL, module `../src/anim/rigBuild.js` not found.

- [ ] **Step 4: Implement `src/anim/rigBuild.ts`**

```ts
import { longString, runLuau } from '../studio/luau.js';
import type { StudioSession } from '../studio/session.js';
import type { ModelRigReading } from './model-rig.js';
import { modelPath, parseReply, READ_RIG_LUAU, RESOLVE_LUAU, rigRevision } from './modelRig.js';
import type { PiecesReading, RigBuildPlan } from './rig-build.js';

// Rig building in Studio's edit thread: read a model's pieces for the planner
// (rig-build.ts), then make the planned rig in one call while the model is as
// it was read, then stamp it. Port of Roqer's plugin handlers
// animationReadPieces / animationBuildRig, without importer replacement, import
// space or skinned rigs (refused by name), and with a clone backup where the
// MCP thread gives no undo step.

// Shared: the model a rig builds on, a fingerprint of everything the build
// reads, and the pieces reading itself. Needs RESOLVE_LUAU and READ_RIG_LUAU.
const PIECES_LUAU = `local function piecesModel(path)
	local model = resolve(path)
	if not model then return nil, "not_found", path .. " does not exist" end
	if not model:IsA("Model") then return nil, "not_model", path .. " is a " .. model.ClassName .. ", not a Model" end
	local Players = game:GetService("Players")
	if Players:GetPlayerFromCharacter(model) or model:IsDescendantOf(Players) or model:IsDescendantOf(game:GetService("StarterPlayer")) then
		return nil, "player_character", path .. " is a player's character, which Roblox rigs; rig builds an NPC's or a creature's"
	end
	if not (model:IsDescendantOf(workspace) or model:IsDescendantOf(game:GetService("ServerStorage")) or model:IsDescendantOf(game:GetService("ReplicatedStorage"))) then
		return nil, "bad_location", path .. " must be under Workspace, ServerStorage or ReplicatedStorage"
	end
	return model
end
local function fnv(s, h)
	for i = 1, #s do
		h = bit32.bxor(h, string.byte(s, i))
		h = (bit32.lshift(h, 24) + h * 403) % 4294967296
	end
	return h
end
local function piecesFingerprint(model)
	local out = { "m:" .. tostring(model:GetAttribute("BloxRig")) .. ":" .. tostring(model:GetAttribute("BloxRigBuilt")) .. ":" .. table.concat(comps(model:GetPivot()), ",") }
	for _, d in model:GetDescendants() do
		if d:IsA("BasePart") then
			table.insert(out, "p:" .. d:GetFullName() .. ":" .. table.concat(comps(d.CFrame), ",") .. ":" .. table.concat(size(d), ",") .. ":" .. shape(d) .. ":" .. tostring(d.Transparency >= 0.95) .. ":" .. tostring(d:GetAttribute("BloxMadeRoot")))
		elseif d:IsA("Motor6D") then
			table.insert(out, "j:" .. d:GetFullName() .. ":" .. tostring(d.Part0 and d.Part0:GetFullName()) .. ":" .. tostring(d.Part1 and d.Part1:GetFullName()) .. ":" .. table.concat(comps(d.C0), ",") .. ":" .. table.concat(comps(d.C1), ","))
		elseif d:IsA("JointInstance") or d:IsA("WeldConstraint") or d:IsA("Constraint") or d:IsA("Humanoid") or d:IsA("AnimationController") or d:IsA("Bone") then
			table.insert(out, "o:" .. d.ClassName .. ":" .. d:GetFullName())
		end
	end
	local s = table.concat(out, "\\n")
	return string.format("%08x%08x", fnv(s, 2166136261), fnv(s, 84696351))
end
local function readPieces(path)
	local model, code, err = piecesModel(path)
	if not model then return { ok = false, code = code, error = err } end
	local parts, index = {}, {}
	for _, d in model:GetDescendants() do
		if d:IsA("BasePart") then
			table.insert(parts, d)
			index[d] = #parts - 1
		end
	end
	if #parts == 0 then return { ok = false, code = "model_empty", error = path .. " has no parts to rig" } end
	if #parts > ${512} then return { ok = false, code = "model_too_large", error = path .. " has " .. #parts .. " parts; rig builds on a model of at most ${512}" } end
	local bones = 0
	for _, d in model:GetDescendants() do if d:IsA("Bone") then bones += 1 end end
	if bones > 0 then return { ok = false, code = "skinned", error = path .. " is a skinned mesh (" .. bones .. " Bones): its bones are its joints. blox rig builds Part rigs only; animate a skinned model with model animate (Blender actions)" } end
	local outParts = {}
	for _, p in parts do
		local e = { name = p.Name, cframe = comps(p.CFrame), size = size(p), shape = shape(p) }
		if p.Transparency >= 0.95 then e.hidden = true end
		if p:GetAttribute("BloxMadeRoot") == true then e.madeRoot = true end
		table.insert(outParts, e)
	end
	local joints, welds, motors = {}, {}, {}
	for _, d in model:GetDescendants() do
		if d:IsA("Motor6D") then
			if d.Part0 and d.Part1 and index[d.Part0] ~= nil and index[d.Part1] ~= nil then
				table.insert(joints, { name = d.Name, part0 = index[d.Part0], part1 = index[d.Part1] })
				table.insert(motors, d)
			end
		elseif d:IsA("AnimationConstraint") then
			local a, b = d.Attachment0 and d.Attachment0.Parent, d.Attachment1 and d.Attachment1.Parent
			if a and b and index[a] ~= nil and index[b] ~= nil then table.insert(joints, { name = d.Name, part0 = index[a], part1 = index[b] }) end
		else
			local a, b = weldedPair(d)
			if a and index[a] ~= nil and index[b] ~= nil then
				local w = { part0 = index[a], part1 = index[b] }
				if d:GetAttribute("BloxMadeWeld") == true then w.made = true end
				table.insert(welds, w)
			end
		end
	end
	local controllers = {}
	for _, c in model:GetChildren() do
		if c:IsA("Humanoid") or c:IsA("AnimationController") then table.insert(controllers, c.ClassName) end
	end
	if #motors > 0 and #motors == #joints and model:GetAttribute("BloxRigBuilt") == nil and table.find(controllers, "AnimationController") then
		local root, centred = motors[1].Part0, true
		for _, m in motors do
			if m.Part0 ~= root or m.C1.Position.Magnitude > 0.01 then centred = false end
		end
		if centred then return { ok = false, code = "importer_rig", error = path .. " has an importer's rig (" .. #motors .. " Motor6Ds from " .. root.Name .. ", each turning a piece about its own centre). blox does not replace importer rigs; re-import without a rig, or rig it in Studio" } end
	end
	local reading = { path = model:GetFullName(), pivot = comps(model:GetPivot()), parts = outParts, joints = joints, welds = welds, controllers = controllers }
	local declared = model:GetAttribute("BloxRig")
	if typeof(declared) == "string" then reading.declarations = declared end
	if #joints > 0 then
		local rr = readModelRig(path, false)
		if rr.ok then reading.rigReading = rr.reading end
		local built = model:GetAttribute("BloxRigBuilt")
		if typeof(built) == "string" then reading.builtRevision = built end
	end
	return { ok = true, reading = reading, fingerprint = piecesFingerprint(model) }
end
`;

const BUILD_LUAU = `local function partNamed(parts, name)
	local found = {}
	for _, p in parts do if p.Name == name then table.insert(found, p) end end
	if #found ~= 1 then error("the model has " .. #found .. " parts named " .. tostring(name), 0) end
	return found[1]
end
local function cf(c, what)
	if type(c) ~= "table" or #c ~= 12 then error(what .. " must be a CFrame's 12 components", 0) end
	return CFrame.new(table.unpack(c))
end
local function buildRig(P)
	local model, code, err = piecesModel(P.path)
	if not model then return { ok = false, code = code, error = err .. ". Nothing was changed." } end
	if piecesFingerprint(model) ~= P.expect then
		return { ok = false, code = "model_changed", error = P.path .. " has changed since its pieces were read. Nothing was changed; call rig again." }
	end
	local plan = P.plan
	local CHS = game:GetService("ChangeHistoryService")
	local rec
	pcall(function() rec = CHS:TryBeginRecording("blox rig " .. model.Name) end)
	local backup
	if not rec then
		if not model.Archivable then
			return { ok = false, code = "no_undo", error = "Studio gave no undo step and " .. P.path .. " cannot be archived to back up first. Nothing was changed." }
		end
		local SS = game:GetService("ServerStorage")
		local folder = SS:FindFirstChild("__BloxRigBackup")
		if not folder then
			folder = Instance.new("Folder")
			folder.Name = "__BloxRigBackup"
			folder.Parent = SS
		end
		local old = folder:FindFirstChild(model.Name)
		if old then old:Destroy() end
		backup = model:Clone()
		backup.Parent = folder
	end
	local removed = {}
	local applied, applyErr = pcall(function()
		if plan.rebuild == true then
			local n = 0
			for _, d in model:GetDescendants() do
				if d:IsA("Motor6D") or d:IsA("AnimationConstraint") then
					d:Destroy()
					n += 1
				elseif (d:IsA("WeldConstraint") or d:IsA("Weld")) and d:GetAttribute("BloxMadeWeld") == true then
					d:Destroy()
				end
			end
			table.insert(removed, "the " .. n .. " joints rig built before")
		end
		local parts = {}
		for _, d in model:GetDescendants() do if d:IsA("BasePart") then table.insert(parts, d) end end
		local root
		if type(plan.root.make) == "table" then
			local made
			for _, p in parts do
				if p.Name == "HumanoidRootPart" and p:GetAttribute("BloxMadeRoot") == true then made = p end
			end
			if not made then
				made = Instance.new("Part")
				table.insert(parts, made)
			end
			made.Name = "HumanoidRootPart"
			local s = plan.root.make.size
			made.Size = Vector3.new(s[1], s[2], s[3])
			made.CFrame = cf(plan.root.make.cframe, "the root's CFrame")
			made.Transparency = 1
			made:SetAttribute("BloxMadeRoot", true)
			made.Parent = model
			root = made
		else
			root = partNamed(parts, plan.root.name)
		end
		for _, p in parts do
			p.Anchored = p == root and plan.rootAnchored == true
			p.CanCollide = p == root
			p.Massless = p ~= root
		end
		model.PrimaryPart = root
		for _, j in plan.joints do
			local m = Instance.new("Motor6D")
			m.Name = j.name
			m.C0 = cf(j.c0, j.name .. "'s C0")
			m.C1 = cf(j.c1, j.name .. "'s C1")
			m.Part0 = partNamed(parts, j.part0)
			m.Part1 = partNamed(parts, j.part1)
			m.Parent = m.Part1
		end
		for _, w in plan.welds do
			local p0, p1 = partNamed(parts, w.part0), partNamed(parts, w.part1)
			local weld = Instance.new("WeldConstraint")
			weld.Name = "BloxWeld_" .. p0.Name
			weld.Part0 = p0
			weld.Part1 = p1
			weld:SetAttribute("BloxMadeWeld", true)
			weld.Parent = p1
		end
		local className = plan.controller.className == "Humanoid" and "Humanoid" or "AnimationController"
		local controller = model:FindFirstChildOfClass(className)
		if not controller then
			controller = Instance.new(className)
			controller.Parent = model
		end
		if controller:IsA("Humanoid") then
			controller.RigType = Enum.HumanoidRigType.R15
			controller.HipHeight = plan.controller.hipHeight
			controller.RequiresNeck = false
			controller.BreakJointsOnDeath = false
			for _ = 1, 10 do
				if controller.RootPart then break end
				if not pcall(task.wait) then break end
			end
		end
		if not controller:FindFirstChildOfClass("Animator") then Instance.new("Animator").Parent = controller end
		model:SetAttribute("BloxRig", plan.declarations)
		model:SetAttribute("BloxRigBuilt", nil)
	end)
	if not applied then
		local how = ""
		if rec then
			pcall(function() CHS:FinishRecording(rec, Enum.FinishRecordingOperation.Cancel) end)
			how = " The undo step was cancelled; nothing was changed."
		elseif backup then
			local restored = backup:Clone()
			restored.Parent = model.Parent
			model:Destroy()
			how = " " .. P.path .. " was put back from its backup."
		end
		return { ok = false, code = "build_failed", error = "building the rig failed: " .. tostring(applyErr) .. "." .. how }
	end
	if rec then pcall(function() CHS:FinishRecording(rec, Enum.FinishRecordingOperation.Commit) end) end
	local after = readModelRig(P.path, false)
	local backupPath = backup and backup:GetFullName() or nil
	if not after.ok then
		return { ok = false, code = "read_back_failed", error = P.path .. " was rigged but does not read back: " .. tostring(after.error), built = true, backup = backupPath }
	end
	return { ok = true, reading = after.reading, fingerprint = after.fingerprint, recorded = rec ~= nil, backup = backupPath, removed = removed }
end
`;

const STAMP_LUAU = `local function stamp(P)
	local model = resolve(P.path)
	if not model then return { ok = false, error = P.path .. " does not exist" } end
	local now = readModelRig(P.path, false)
	if not now.ok then return now end
	if now.fingerprint ~= P.expect then return { ok = false, code = "changed", error = P.path .. " changed after it was rigged" } end
	local CHS = game:GetService("ChangeHistoryService")
	local rec
	pcall(function() rec = CHS:TryBeginRecording("blox rig stamp") end)
	model:SetAttribute("BloxRigBuilt", P.revision)
	if rec then pcall(function() CHS:FinishRecording(rec, Enum.FinishRecordingOperation.Commit) end) end
	return { ok = true }
end
`;

function head(marker: string, payload: unknown): string {
  return `-- ${marker}
local PAYLOAD = ${longString(JSON.stringify(payload))}
local HS = game:GetService("HttpService")
local P = HS:JSONDecode(PAYLOAD)
`;
}

export function readPiecesProgram(path: string): string {
  return `${head('BloxReadPieces', { path: modelPath(path) })}${RESOLVE_LUAU}${READ_RIG_LUAU}${PIECES_LUAU}return HS:JSONEncode(readPieces(P.path))`;
}

export function buildRigProgram(path: string, plan: RigBuildPlan, expect: string): string {
  return `${head('BloxRigBuild', { path: modelPath(path), expect, plan })}${RESOLVE_LUAU}${READ_RIG_LUAU}${PIECES_LUAU}${BUILD_LUAU}return HS:JSONEncode(buildRig(P))`;
}

export function stampRigProgram(path: string, revision: string, expect: string): string {
  return `${head('BloxRigStamp', { path: modelPath(path), revision, expect })}${RESOLVE_LUAU}${READ_RIG_LUAU}${STAMP_LUAU}return HS:JSONEncode(stamp(P))`;
}

type RawPieces = Omit<PiecesReading, 'revision' | 'rig'> & { rigReading?: Omit<ModelRigReading, 'revision'>; builtRevision?: string };

export async function readPieces(session: StudioSession, path: string): Promise<{ ok: true; reading: PiecesReading; fingerprint: string } | { ok: false; error: string; code?: string }> {
  const r = await runLuau(session, readPiecesProgram(path), 'edit', { chunkName: 'animateReadPieces', timeoutMs: 60_000 });
  if (!r.ok) return { ok: false, error: `reading ${path}'s pieces failed in Studio: ${r.error?.message}` };
  const p = parseReply(r.values, 'pieces read');
  if (!p.ok) return p;
  const v = p.value as { ok?: boolean; code?: string; error?: string; reading?: RawPieces; fingerprint?: string };
  if (!v.ok || !v.reading || typeof v.fingerprint !== 'string') return { ok: false, error: v.error ?? 'the pieces read failed', ...(v.code ? { code: v.code } : {}) };
  const { rigReading, builtRevision, ...rest } = v.reading;
  const reading: PiecesReading = {
    ...rest,
    revision: `rp1:${v.fingerprint}`,
    ...(rest.joints.length > 0 ? { rig: { revision: rigReading ? rigRevision(rigReading) : 'unreadable', ...(builtRevision ? { builtRevision } : {}) } } : {}),
  };
  return { ok: true, reading, fingerprint: v.fingerprint };
}

export type RigBuildReply =
  | { ok: true; reading: ModelRigReading; fingerprint: string; recorded: boolean; backup?: string; removed: string[] }
  | { ok: false; error: string; code?: string; built?: boolean; backup?: string };

export async function buildRig(session: StudioSession, path: string, plan: RigBuildPlan, expect: string): Promise<RigBuildReply> {
  const r = await runLuau(session, buildRigProgram(path, plan, expect), 'edit', { chunkName: 'animateBuildRig', timeoutMs: 120_000 });
  if (!r.ok) return { ok: false, error: `building ${path}'s rig failed in Studio: ${r.error?.message}` };
  const p = parseReply(r.values, 'rig build');
  if (!p.ok) return p;
  const v = p.value as { ok?: boolean; code?: string; error?: string; reading?: Omit<ModelRigReading, 'revision'>; fingerprint?: string; recorded?: boolean; backup?: string; removed?: string[]; built?: boolean };
  if (!v.ok || !v.reading) return { ok: false, error: v.error ?? 'the rig build failed', ...(v.code ? { code: v.code } : {}), ...(v.built ? { built: true } : {}), ...(v.backup ? { backup: v.backup } : {}) };
  return {
    ok: true,
    reading: { ...v.reading, revision: rigRevision(v.reading) },
    fingerprint: v.fingerprint ?? '',
    recorded: v.recorded === true,
    ...(v.backup ? { backup: v.backup } : {}),
    removed: v.removed ?? [],
  };
}

export async function stampRig(session: StudioSession, path: string, revision: string, expect: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await runLuau(session, stampRigProgram(path, revision, expect), 'edit', { chunkName: 'animateStampRig', timeoutMs: 60_000 });
  if (!r.ok) return { ok: false, error: `stamping failed in Studio: ${r.error?.message}` };
  const p = parseReply(r.values, 'rig stamp');
  if (!p.ok) return p;
  return p.value.ok === true ? { ok: true } : { ok: false, error: String(p.value.error ?? 'stamp refused') };
}
```

Notes for the implementer:
- `${512}` inside the template is a literal; keep it as written, since it mirrors `MAX_PIECE_PARTS`.
- `"\\n"` inside the TS template literal yields the Luau escape `"\n"`. Do not change it to a real newline.
- Luau `0` is truthy, so index comparisons use `~= nil`, never plain truthiness.
- `weldedPair`, `comps`, `size`, `shape` and `readModelRig` come from `READ_RIG_LUAU`, which is why it is concatenated first.

- [ ] **Step 5: Run the tests (with Lune on PATH)**

Run: `PATH=$HOME/.local/bin:$PATH npx vitest run tests/anim.rigBuild.test.ts tests/anim.modelRig.test.ts tests/anim.rigtool.test.ts`
Expected: PASS, with the three compile tests not skipped.

- [ ] **Step 6: Gate and commit**

Run: `npx tsc --noEmit && npx vitest run tests/anim.*.test.ts`

```bash
git add src/anim/rigBuild.ts src/anim/modelRig.ts tests/anim.rigBuild.test.ts
git commit -m "anim: Studio programs to read pieces, build and stamp a rig (spec C)

Claude-Session: https://claude.ai/code/session_01S9BqaZdZYrotiDVZwjqA1k"
```

---

### Task 5: `animate rig` suggest + build actions

**Files:**
- Create: `src/anim/rigTool.ts`
- Modify: `src/anim/tool.ts` (schema, `rig` dispatch, `ANIMATE_DESCRIPTION`)
- Modify: `src/cliTools.ts` (`case 'rig'`)
- Test: `tests/anim.rigbuildtool.test.ts`, `tests/cliTools.test.ts`

**Interfaces:**
- Consumes:
  - Task 1: `parseBuildJoints`, `planRigBuild`, `builtRigMismatches`.
  - Task 2: `suggestJoints`.
  - Task 3: `fitBlenderPivots`, `BlenderPivots`.
  - Task 4: `readPieces`, `buildRig`, `stampRig`.
  - Existing: `rangeSheetAnimation` and `describeRig` (`./animation-tool.js`); `compilePoseAnimation`; `renderContactSheet`; `rigFromModel`; `skippedChecks` (`./modelRig.js`); `modelDir` and `ID_RE` (`../model/run.js`); `ToolCtx` and `ToolOutput` (`../tools/registry.js`).
- Produces:
  - `rigDir(projectPath: string, model: string): string`
  - `stripSuggested(j: unknown): unknown`
  - `rigSuggestAction(a: Record<string, unknown>, ctx: ToolCtx): Promise<ToolOutput>`
  - `rigBuildAction(a: Record<string, unknown>, ctx: ToolCtx): Promise<ToolOutput>`
  - New `animate` args: `suggest`, `joints`, `controller`, `expected_revision`, `blender_id`, `replace`, `pivot_space`.

- [ ] **Step 1: Write the failing tool tests**

`tests/anim.rigbuildtool.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findTool, invokeTool, type ToolCtx } from '../src/tools/registry.js';
import { BloxConfigSchema } from '../src/config.js';
import type { StudioSession } from '../src/studio/session.js';
import { planRigBuild } from '../src/anim/rig-build.js';
import { rigDir } from '../src/anim/rigTool.js';
import { AXIS_ROTATIONS } from '../src/anim/rigBlender.js';
import { dogJoints, dogPieces } from './fixtures/anim/dog-pieces.js';

const envelope = (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, n: 1, values: { v1: JSON.stringify(v) }, logs: [] }) }] });
function ctx(reply: (code: string) => unknown, codes: string[] = []): ToolCtx {
  const session = { call: async (_n: string, a: Record<string, unknown>) => { codes.push(String(a.code)); return envelope(reply(String(a.code))); } } as unknown as StudioSession;
  const projectPath = mkdtempSync(join(tmpdir(), 'blox-rigbuild-tool-'));
  return { session, projectPath, config: BloxConfigSchema.parse({ projectPath }), agent: 'test' };
}
const call = (args: Record<string, unknown>, c: ToolCtx) => invokeTool(findTool('animate')!, args, c);
const rawDog = () => { const { revision: _r, ...rest } = dogPieces(); return { ...rest, path: 'Workspace.Dog' }; };
const expectedRig = () => {
  const r = planRigBuild({ ...dogPieces(), path: 'Workspace.Dog' }, { joints: dogJoints(), controller: 'Humanoid', plan: 'quadruped', replaceImporter: false });
  if (!r.ok) throw new Error(r.errors.join('\n'));
  const { revision: _r, ...raw } = r.expected;
  return raw;
};
/** Studio as it would answer when the build goes as planned. */
const studio = (overrides: { read?: unknown; build?: unknown } = {}) => (code: string) => {
  if (code.startsWith('-- BloxReadPieces')) return overrides.read ?? { ok: true, reading: rawDog(), fingerprint: 'fp1' };
  if (code.startsWith('-- BloxRigBuild')) return overrides.build ?? { ok: true, reading: expectedRig(), fingerprint: 'rigfp', recorded: true, removed: [] };
  if (code.startsWith('-- BloxRigStamp')) return { ok: true };
  return { ok: false, error: `unexpected program: ${code.slice(0, 40)}` };
};

describe('animate rig suggest', () => {
  it('proposes joints, saves suggest.json stamped with the pieces revision, writes nothing', async () => {
    const codes: string[] = [];
    const c = ctx(studio(), codes);
    const r = await call({ action: 'rig', model: 'Workspace.Dog', suggest: true, plan: 'quadruped' }, c);
    expect(r.isError, r.text).toBeFalsy();
    expect(r.text).toMatch(/Neck: Head ← Body/);
    expect(r.text).toMatch(/joints:"suggested"/);
    expect(codes.every((x) => x.startsWith('-- BloxReadPieces'))).toBe(true);
    const saved = JSON.parse(readFileSync(join(rigDir(c.projectPath, 'Workspace.Dog'), 'suggest.json'), 'utf8'));
    expect(saved.revision).toBe('rp1:fp1');
    expect(saved.joints.some((j: Record<string, unknown>) => 'why' in j)).toBe(false);
  });
  it('refuses a model that already has joints', async () => {
    const r = await call({ action: 'rig', model: 'Workspace.Dog', suggest: true }, ctx(studio({ read: { ok: true, reading: { ...rawDog(), joints: [{ name: 'Neck', part0: 0, part1: 1 }] }, fingerprint: 'f' } })));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/already has 1 joint/);
  });
});

describe('animate rig build', () => {
  it('builds from given joints, reads back, stamps, and draws the range sheet', async () => {
    const codes: string[] = [];
    const c = ctx(studio(), codes);
    const r = await call({ action: 'rig', model: 'Workspace.Dog', joints: dogJoints(), controller: 'Humanoid', plan: 'quadruped' }, c);
    expect(r.isError, r.text).toBeFalsy();
    expect(codes.map((x) => x.split('\n')[0])).toEqual(['-- BloxReadPieces', '-- BloxRigBuild', '-- BloxRigStamp']);
    expect(codes[1]).toMatch(/"expect":"fp1"/);
    expect(r.text).toMatch(/read back as planned/);
    expect(r.text).toMatch(/expected_revision/);
    expect(r.images?.[0].mimeType).toBe('image/png');
    expect(existsSync(join(rigDir(c.projectPath, 'Workspace.Dog'), 'range.png'))).toBe(true);
  });
  it('strips why and loose from echoed suggestion joints', async () => {
    const echoed = dogJoints().map((j) => ({ ...j, why: 'touches Body', loose: undefined }));
    const r = await call({ action: 'rig', model: 'Workspace.Dog', joints: echoed, controller: 'Humanoid', plan: 'quadruped' }, ctx(studio()));
    expect(r.isError, r.text).toBeFalsy();
  });
  it('joints:"suggested" uses the saved suggestion, refused when stale', async () => {
    const c = ctx(studio());
    await call({ action: 'rig', model: 'Workspace.Dog', suggest: true, plan: 'quadruped' }, c);
    const codes: string[] = [];
    const c2 = { ...c, session: ctx(studio(), codes).session };
    const ok = await call({ action: 'rig', model: 'Workspace.Dog', joints: 'suggested', controller: 'Humanoid', plan: 'quadruped' }, c2);
    // The fake Studio answers with the hand rig, so the read-back may differ by the suggested Neck pivot; what matters is that it built.
    expect(codes.some((x) => x.startsWith('-- BloxRigBuild')), ok.text).toBe(true);
    expect(ok.text).toMatch(/rigged Workspace\.Dog/);
    const stale = ctx(studio({ read: { ok: true, reading: rawDog(), fingerprint: 'fp2' } }));
    mkdirSync(rigDir(stale.projectPath, 'Workspace.Dog'), { recursive: true });
    writeFileSync(join(rigDir(stale.projectPath, 'Workspace.Dog'), 'suggest.json'), JSON.stringify({ model: 'Workspace.Dog', revision: 'rp1:fp1', joints: dogJoints() }));
    const r = await call({ action: 'rig', model: 'Workspace.Dog', joints: 'suggested', controller: 'Humanoid' }, stale);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/rp1:fp1 → rp1:fp2/);
  });
  it('joints:"suggested" without a saved suggestion says to suggest first', async () => {
    const r = await call({ action: 'rig', model: 'Workspace.Dog', joints: 'suggested', controller: 'Humanoid' }, ctx(studio()));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/suggest:true/);
  });
  it('joints:"blender" fits pivots.json from the model export', async () => {
    const c = ctx(studio());
    const m = AXIS_ROTATIONS[7];
    const tr = [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
    const back = (q: readonly number[]) => [tr[0] * q[0] + tr[1] * q[1] + tr[2] * q[2], tr[3] * q[0] + tr[4] * q[1] + tr[5] * q[2], tr[6] * q[0] + tr[7] * q[1] + tr[8] * q[2]];
    const absT = tr.map(Math.abs);
    const pieces = dogPieces().parts.map((p) => ({ name: p.name, bone: p.name, center: back(p.cframe.slice(0, 3)), size: back(p.size).map((_, i) => absT[i * 3] * p.size[0] + absT[i * 3 + 1] * p.size[1] + absT[i * 3 + 2] * p.size[2]) }));
    const joints = dogJoints().map((j) => ({ name: j.name ?? j.part, part: j.part, parent: j.parent, pivot: back(j.pivot) }));
    const dir = join(c.projectPath, '.blox', 'models', 'dog', 'export');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pivots.json'), JSON.stringify({ pieces, joints, riders: { Head: ['LeftEar', 'RightEar', 'Nose'] } }));
    const r = await call({ action: 'rig', model: 'Workspace.Dog', joints: 'blender', blender_id: 'dog', controller: 'Humanoid', plan: 'quadruped' }, c);
    expect(r.isError, r.text).toBeFalsy();
    expect(r.text).toMatch(/matched by name/);
  });
  it('planner refusals list every problem and touch nothing', async () => {
    const codes: string[] = [];
    const bad = [{ part: 'Head', parent: 'Nope', pivot: [0, 0, 0] }];
    const r = await call({ action: 'rig', model: 'Workspace.Dog', joints: bad, controller: 'Humanoid' }, ctx(studio(), codes));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/nothing was changed/);
    expect(codes.some((x) => x.startsWith('-- BloxRigBuild'))).toBe(false);
  });
  it('model_changed from Studio comes back as the refusal', async () => {
    const r = await call({ action: 'rig', model: 'Workspace.Dog', joints: dogJoints(), controller: 'Humanoid', plan: 'quadruped' }, ctx(studio({ build: { ok: false, code: 'model_changed', error: 'Workspace.Dog has changed since its pieces were read. Nothing was changed; call rig again.' } })));
    expect(r.isError).toBe(true);
    expect(r.summary).toBe('model_changed');
  });
  it('a read-back that differs is reported, not stamped', async () => {
    const moved = expectedRig();
    moved.joints = moved.joints.map((j) => (j.name === 'Tail' ? { ...j, c0: [j.c0[0] + 0.5, ...j.c0.slice(1)] } : j));
    const codes: string[] = [];
    const r = await call({ action: 'rig', model: 'Workspace.Dog', joints: dogJoints(), controller: 'Humanoid', plan: 'quadruped' }, ctx(studio({ build: { ok: true, reading: moved, fingerprint: 'x', recorded: true, removed: [] } }), codes));
    expect(r.text).toMatch(/Tail's C0 or C1/);
    expect(codes.some((x) => x.startsWith('-- BloxRigStamp'))).toBe(false);
  });
  it('a clone backup is named when Studio gave no undo step', async () => {
    const r = await call({ action: 'rig', model: 'Workspace.Dog', joints: dogJoints(), controller: 'Humanoid', plan: 'quadruped' }, ctx(studio({ build: { ok: true, reading: expectedRig(), fingerprint: 'x', recorded: false, backup: 'ServerStorage.__BloxRigBackup.Dog', removed: [] } })));
    expect(r.text).toMatch(/ServerStorage\.__BloxRigBackup\.Dog/);
  });
  it('refuses unsupported forms by name, before Studio is asked', async () => {
    const codes: string[] = [];
    for (const extra of [{ replace: 'importer' }, { pivot_space: 'import' }]) {
      const r = await call({ action: 'rig', model: 'Workspace.Dog', joints: dogJoints(), controller: 'Humanoid', ...extra }, ctx(studio(), codes));
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/not supported in blox/);
    }
    expect(codes).toEqual([]);
  });
  it('needs a controller with joints', async () => {
    const r = await call({ action: 'rig', model: 'Workspace.Dog', joints: dogJoints() }, ctx(studio()));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/controller/);
  });
});
```

Add to `tests/cliTools.test.ts`, inside `describe('parseFlags / cliArgs', ...)`:

```ts
  it('maps animate rig flags', () => {
    expect(cliArgs('animate', parseFlags(['rig', 'Workspace.Dog', '--suggest', '--plan', 'quadruped']))).toEqual({
      tool: 'animate', args: { action: 'rig', model: 'Workspace.Dog', suggest: true, plan: 'quadruped' },
    });
    expect(cliArgs('animate', parseFlags(['rig', 'Workspace.Dog', '--joints', 'suggested', '--controller', 'Humanoid', '--revision', 'rr1:ab']))).toEqual({
      tool: 'animate', args: { action: 'rig', model: 'Workspace.Dog', joints: 'suggested', controller: 'Humanoid', expected_revision: 'rr1:ab' },
    });
    expect(cliArgs('animate', parseFlags(['rig', 'Workspace.Wolf', '--joints', 'blender', '--blender', 'wolf', '--controller', 'Humanoid']))).toEqual({
      tool: 'animate', args: { action: 'rig', model: 'Workspace.Wolf', joints: 'blender', blender_id: 'wolf', controller: 'Humanoid' },
    });
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/anim.rigbuildtool.test.ts tests/cliTools.test.ts`
Expected: FAIL, `rigTool.js` missing and the cliArgs mismatch.

- [ ] **Step 3: Implement `src/anim/rigTool.ts`**

```ts
// animate rig's suggest and build forms (spec C). The read-only form stays in
// tool.ts. Suggest proposes joints from where the pieces touch and saves them;
// build plans the whole rig offline, makes it in one Studio call, reads it back
// and draws the range sheet: every joint turned a little each way, so a pivot
// in the wrong place shows as a piece swinging off the body.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { ToolCtx, ToolOutput } from '../tools/registry.js';
import { ID_RE, modelDir } from '../model/run.js';
import { describeRig, rangeSheetAnimation } from './animation-tool.js';
import type { BodyPlan } from './body-plans.js';
import { renderContactSheet } from './contact-sheet.js';
import { rigFromModel } from './model-rig.js';
import { modelPath, skippedChecks } from './modelRig.js';
import { compilePoseAnimation } from './pose-compiler.js';
import { builtRigMismatches, parseBuildJoints, planRigBuild } from './rig-build.js';
import { fitBlenderPivots, type BlenderPivots } from './rigBlender.js';
import { buildRig, readPieces, stampRig } from './rigBuild.js';
import { suggestJoints } from './rigSuggest.js';

const err = (text: string, summary: string): ToolOutput => ({ text, isError: true, summary });
const list = (xs: readonly string[]) => xs.map((x) => `  ${x}`).join('\n');

/** Where rig's files for a model live: .blox/anims/_rig/<model path, made file-safe>. */
export function rigDir(projectPath: string, model: string): string {
  return join(projectPath, '.blox', 'anims', '_rig', modelPath(model).replace(/[^A-Za-z0-9_.-]/g, '_'));
}

/** A joint as the agent may echo it from a suggestion: why and loose are explanations, not build input. */
export function stripSuggested(j: unknown): unknown {
  if (typeof j !== 'object' || j === null || Array.isArray(j)) return j;
  const { why: _why, loose: _loose, ...rest } = j as Record<string, unknown>;
  return rest;
}

export async function rigSuggestAction(a: Record<string, unknown>, ctx: ToolCtx): Promise<ToolOutput> {
  const model = a.model as string;
  const plan = (a.plan ?? 'custom') as BodyPlan;
  const read = await readPieces(ctx.session, model);
  if (!read.ok) return err(read.error, read.code ?? 'refused');
  const { reading } = read;
  if (reading.joints.length > 0) {
    return err(`${reading.path} already has ${reading.joints.length} joint${reading.joints.length === 1 ? '' : 's'}; suggest is for loose pieces. Read its rig with animate {action:"rig", model:"${reading.path}"}, or rebuild a rig blox made with joints and expected_revision`, 'already rigged');
  }
  const s = suggestJoints(reading, plan);
  const joints = s.joints.map(stripSuggested);
  const dir = rigDir(ctx.projectPath, reading.path);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'suggest.json'), JSON.stringify({ model: reading.path, revision: reading.revision, plan, joints }, null, 2));
  const lines = [
    `suggested rig for ${reading.path}: trunk ${s.trunk}, ${s.joints.length} joint${s.joints.length === 1 ? '' : 's'} (nothing changed in Studio)`,
    ...s.joints.map((j) => `  ${j.name ?? j.part}: ${j.part} ← ${j.parent} at [${j.pivot.join(', ')}]${j.with?.length ? ` with ${j.with.join(', ')}` : ''} — ${j.why}`),
    ...s.notes.map((n) => `note: ${n}`),
    `joints: ${JSON.stringify(joints)}`,
    `saved ${relative(ctx.projectPath, join(dir, 'suggest.json'))} (revision ${reading.revision})`,
    `Next: animate {action:"rig", model:"${reading.path}", joints:"suggested", controller:"Humanoid" (walks) | "AnimationController" (flies, swims, stays put), plan:"${plan}"} — or pass the joints above edited`,
  ];
  return { text: lines.join('\n'), summary: `${s.joints.length} joints suggested` };
}

export async function rigBuildAction(a: Record<string, unknown>, ctx: ToolCtx): Promise<ToolOutput> {
  const P = ctx.projectPath;
  if (a.replace !== undefined) return err('replace is not supported in blox: blox does not replace an importer\'s rig. Re-import the model without a rig, or rig it in Studio', 'unsupported');
  if (a.pivot_space !== undefined) return err('pivot_space is not supported in blox: pivots are world positions; for a Blender creature use joints:"blender", which fits its pivots to where the pieces are', 'unsupported');
  if (a.controller !== 'Humanoid' && a.controller !== 'AnimationController') {
    return err('rig with joints needs controller: "Humanoid" (a body that walks) or "AnimationController" (one that flies, swims or stays put)', 'no controller');
  }
  if (a.joints === undefined) return err('rig needs joints: [{part, parent, pivot:[x,y,z], name?, with?}], "suggested" (after suggest:true) or "blender" (with blender_id)', 'no joints');
  const model = a.model as string;
  const read = await readPieces(ctx.session, model);
  if (!read.ok) return err(`${read.error}. Nothing was changed.`, read.code ?? 'refused');
  const { reading } = read;
  const dir = rigDir(P, reading.path);
  const notes: string[] = [];

  let raw: unknown;
  if (a.joints === 'suggested') {
    const f = join(dir, 'suggest.json');
    if (!existsSync(f)) return err(`no suggestion saved for ${reading.path}: run animate {action:"rig", model:"${reading.path}", suggest:true} first`, 'not suggested');
    const saved = JSON.parse(readFileSync(f, 'utf8')) as { revision?: string; joints?: unknown };
    if (saved.revision !== reading.revision) return err(`${reading.path} changed since the suggestion (${saved.revision} → ${reading.revision}); suggest again`, 'stale suggestion');
    raw = saved.joints;
  } else if (a.joints === 'blender') {
    const id = a.blender_id;
    if (typeof id !== 'string' || !ID_RE.test(id)) return err('joints:"blender" needs blender_id: the blox model id whose export holds pivots.json', 'no blender_id');
    const f = join(modelDir(P, id), 'export', 'pivots.json');
    if (!existsSync(f)) return err(`${relative(P, f)} not found: build the model with rig_rigid(armature, {bone: [pieces]}) and run model {action:"export", id:"${id}"}`, 'no pivots');
    const fit = fitBlenderPivots(JSON.parse(readFileSync(f, 'utf8')) as BlenderPivots, reading.parts);
    if (!fit.ok) return err(`${reading.path} was not rigged; nothing was changed:\n${list(fit.errors)}`, 'fit failed');
    raw = fit.joints;
    notes.push(...fit.notes);
  } else if (Array.isArray(a.joints)) {
    raw = a.joints.map(stripSuggested);
  } else {
    return err('joints must be an array, "suggested" or "blender"', 'bad joints');
  }

  const joints = parseBuildJoints(raw);
  if (!joints.ok) return err(`the joints are not valid; nothing was changed:\n${list(joints.errors)}`, 'invalid joints');
  const plan = (a.plan ?? 'custom') as BodyPlan;
  const planned = planRigBuild(reading, {
    joints: joints.joints,
    controller: a.controller,
    plan,
    ...(a.declarations ? { declarations: a.declarations as Record<string, unknown> } : {}),
    replaceImporter: false,
    pivotSpace: 'world',
    ...(typeof a.expected_revision === 'string' ? { expectedRevision: a.expected_revision } : {}),
  });
  if (!planned.ok) return err(`${reading.path} was not rigged; nothing was changed (${planned.errorCode}):\n${list(planned.errors)}`, planned.errorCode);

  const built = await buildRig(ctx.session, reading.path, planned.plan, read.fingerprint);
  if (!built.ok) {
    const undo = built.built ? (built.backup ? ` Undo it in Studio, or restore ${built.backup}.` : ' Undo it in Studio (Ctrl+Z).') : '';
    return err(`${built.error}${undo}`, built.code ?? 'studio error');
  }
  const undo = built.recorded ? 'one undo step in Studio (Ctrl+Z)' : `Studio gave no undo step on this thread; ${reading.path} as it was is saved at ${built.backup}`;
  const rig = rigFromModel(built.reading);
  if (!rig.ok) return err(`${reading.path} was rigged, but its rig does not read back as a rig — ${undo} — then rig it again:\n${list(rig.errors)}`, 'read-back failed');

  const mismatches = builtRigMismatches(planned.expected, built.reading);
  if (mismatches.length === 0) {
    const st = await stampRig(ctx.session, reading.path, built.reading.revision, built.fingerprint);
    if (!st.ok) notes.push(`not stamped as built by blox (${st.error}): a rebuild will refuse until it is rigged again`);
  }

  const lines = [
    `rigged ${built.reading.path}: ${planned.plan.joints.length} joints from ${planned.plan.root.name}${planned.plan.root.make ? ' (made, invisible)' : ''}, ${a.controller}${a.controller === 'Humanoid' ? ` (HipHeight ${planned.plan.controller.hipHeight})` : ' (root anchored)'}${planned.plan.welds.length ? `, ${planned.plan.welds.length} riders welded` : ''}`,
    mismatches.length === 0 ? 'read back as planned' : `read back DIFFERENTLY from the plan — ${undo}, then rig again:\n${list(mismatches)}`,
    `undo: ${undo}`,
    ...built.removed.map((r) => `removed ${r}`),
    ...[...notes, ...planned.notes, ...rig.notes].map((n) => `note: ${n}`),
    JSON.stringify(describeRig(rig.rig, []), null, 2),
    ...skippedChecks(rig.rig),
    `revision ${built.reading.revision} — pass it as expected_revision to rig this model again`,
  ];
  const images: ToolOutput['images'] = [];
  const compiled = compilePoseAnimation(rangeSheetAnimation(rig.rig), rig.rig);
  if (compiled.ok) {
    const sheet = renderContactSheet(compiled.sequence, undefined, { rig: rig.rig });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'range.png'), sheet.png);
    images.push({ data: sheet.png.toString('base64'), mimeType: 'image/png' });
    lines.push(`range sheet ${relative(P, join(dir, 'range.png'))}: rest, then every joint +30/-30° about X, then about Z. A piece that swings off the body rather than about its end has its pivot in the wrong place.`);
  } else {
    lines.push(`no range sheet (it does not compile on this rig): ${compiled.errors.join('; ')}`);
  }
  lines.push(`Next: animate {action:"check", animation:{..., rig:"${built.reading.path}"}} — the joints above are what poses may key`);
  return { text: lines.join('\n'), images, isError: mismatches.length > 0, summary: mismatches.length ? 'read-back differs' : `rigged, ${planned.plan.joints.length} joints` };
}
```

- [ ] **Step 4: Wire into `src/anim/tool.ts`**

Add the import:

```ts
import { rigBuildAction, rigSuggestAction } from './rigTool.js';
```

Add to `animateShape` after `declarations`:

```ts
  suggest: z.boolean().optional().describe('rig: propose joints for loose pieces (writes nothing in Studio)'),
  joints: z.union([z.array(z.record(z.string(), z.unknown())), z.enum(['suggested', 'blender'])]).optional().describe('rig: [{part, parent, pivot:[x,y,z], name?, with?}] | "suggested" | "blender"'),
  controller: z.enum(['Humanoid', 'AnimationController']).optional(),
  expected_revision: z.string().optional().describe('rig: the revision rig returned, to rebuild'),
  blender_id: z.string().optional().describe('rig joints:"blender": the blox model id'),
  replace: z.string().optional(),
  pivot_space: z.string().optional(),
```

Replace the start of the `rig` branch:

```ts
  if (a.action === 'rig') {
    if (typeof a.model !== 'string') return err('rig needs model (a model path, e.g. Workspace.Dog)', 'no model');
    if (a.suggest === true) return rigSuggestAction(a, ctx);
    if (a.joints !== undefined || a.controller !== undefined || a.replace !== undefined || a.pivot_space !== undefined) return rigBuildAction(a, ctx);
    const r = await readRig(ctx.session, a.model);
```

In `ANIMATE_DESCRIPTION`, replace `| rig {model} (read a Part+Motor6D model\'s rig: joints, what checks cannot judge) |` with:

```
| rig {model} (read a Part+Motor6D model\'s rig) | rig {model, suggest:true, plan?} (propose joints for loose pieces) | rig {model, joints:[…]|"suggested"|"blender", controller:Humanoid|AnimationController, plan?, declarations?, blender_id?, expected_revision?} (build the rig in one undo step; read-back + range sheet image) |
```

- [ ] **Step 5: Wire the CLI in `src/cliTools.ts`**

Replace

```ts
        case 'rig':
          return { tool: 'animate', args: { action, model: f.rest[1] } };
```

with

```ts
        case 'rig': {
          const joints = typeof o.joints === 'string' ? { joints: o.joints === 'suggested' || o.joints === 'blender' ? o.joints : readJson(o.joints, '--joints') } : {};
          return {
            tool: 'animate',
            args: {
              action, model: f.rest[1], ...flag('suggest'), ...joints, ...str('controller'), ...str('plan'),
              ...(typeof o.revision === 'string' ? { expected_revision: o.revision } : {}),
              ...(typeof o.blender === 'string' ? { blender_id: o.blender } : {}),
            },
          };
        }
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/anim.rigbuildtool.test.ts tests/cliTools.test.ts tests/anim.rigtool.test.ts tests/anim.tool.test.ts`
Expected: PASS. If `cliArgs` puts keys in a different order, `toEqual` ignores key order, so no change is needed.

- [ ] **Step 7: Gate and commit**

Run: `npx tsc --noEmit && npx vitest run`
Expected: clean; full suite green (≈1107 + new tests).

```bash
git add src/anim/rigTool.ts src/anim/tool.ts src/cliTools.ts tests/anim.rigbuildtool.test.ts tests/cliTools.test.ts
git commit -m "animate rig: suggest + build forms with read-back and range sheet (spec C)

Claude-Session: https://claude.ai/code/session_01S9BqaZdZYrotiDVZwjqA1k"
```

---

### Task 6: Blender rigid pieces + pivots.json

**Files:**
- Modify: `tools/blender/blox_model.py` (`rig_rigid`, `rigid_pivots`, `piece_materials`, docstring, `import json`)
- Modify: `tools/blender/model.py` (`cmd_export`)
- Modify: `src/tools/registry.ts:841-852` (export result text)
- Modify: `src/model/run.ts:69` (brief helper list)
- Create: `tests/fixtures/model/rigid-dog.py`
- Test: `tests/e2e/model-blender.test.ts` (new `it`, gated by `BLOX_LIVE_BLENDER=1`)

**Interfaces:**
- Consumes: the existing `rig(name, bones)`, `box(...)`, `reset()`, `bake_vertex_colors`, `export_glb`, `_select_only`.
- Produces: `pivots.json` in exactly the Task 3 `BlenderPivots` shape: `{pieces: [{name, bone, center, size}], joints: [{name, part, parent, pivot}], riders: {part: [names]}}`, in Blender world coordinates. The export result key is `pivots` (a path).

- [ ] **Step 1: Write the fixture and the failing gated test**

`tests/fixtures/model/rigid-dog.py`:

```python
# A blocky dog of separate pieces on a rigid rig: blox model export writes
# pieces-only model.glb + pivots.json for animate rig joints:"blender".
reset()
body = box("Body", (2, 4, 1.2), (0, 0, 2.2), "#a0522d")
head = box("Head", (1.2, 1.4, 1.2), (0, -2.6, 3.0), "#a0522d")
nose = box("Nose", (0.4, 0.4, 0.4), (0, -3.4, 2.9), "#222222")
legs = {}
for name, x, y in (("FrontLeft", -0.7, -1.4), ("FrontRight", 0.7, -1.4), ("HindLeft", -0.7, 1.4), ("HindRight", 0.7, 1.4)):
    legs[name] = box(name, (0.5, 0.5, 1.6), (x, y, 0.8), "#8b4513")
bones = [
    {"name": "Root", "head": (0, 0, 2.2), "tail": (0, 0, 3.0)},
    {"name": "Neck", "head": (0, -2.0, 2.6), "tail": (0, -2.6, 3.4), "parent": "Root"},
]
for name, x, y in (("FrontLeft", -0.7, -1.4), ("FrontRight", 0.7, -1.4), ("HindLeft", -0.7, 1.4), ("HindRight", 0.7, 1.4)):
    bones.append({"name": name + "Hip", "head": (x, y, 1.6), "tail": (x, y, 0.0), "parent": "Root"})
arm = rig("DogRig", bones)
parts = {"Root": [body], "Neck": [head, nose]}
for name, o in legs.items():
    parts[name + "Hip"] = [o]
rig_rigid(arm, parts)
```

Append to `tests/e2e/model-blender.test.ts` inside the `describe`:

```ts
  it('exports a rigid-piece dog: pieces-only GLB + pivots.json', async () => {
    const d = mkdtempSync(join(tmpdir(), 'blox-mdl-rigid-'));
    const blend = join(d, 'model.blend');
    const code = new URL('../fixtures/model/rigid-dog.py', import.meta.url).pathname;
    await runModelPy('run', { blend, code, budget: 2000 }, d);
    const ex = (await runModelPy('export', { blend, out: join(d, 'export') }, d)) as { pivots?: string; upload?: string };
    expect(ex.pivots).toBeTruthy();
    expect(existsSync(ex.upload!)).toBe(true);
    const p = JSON.parse(readFileSync(ex.pivots!, 'utf8')) as { pieces: { name: string; center: number[]; size: number[] }[]; joints: { name: string; part: string; parent: string; pivot: number[] }[]; riders: Record<string, string[]> };
    expect(p.pieces.map((x) => x.name).sort()).toEqual(['Body', 'FrontLeft', 'FrontRight', 'Head', 'HindLeft', 'HindRight', 'Nose']);
    expect(p.joints.map((j) => [j.part, j.parent]).sort()).toEqual([['FrontLeft', 'Body'], ['FrontRight', 'Body'], ['Head', 'Body'], ['HindLeft', 'Body'], ['HindRight', 'Body']]);
    expect(p.riders).toEqual({ Head: ['Nose'] });
    const hip = p.joints.find((j) => j.part === 'FrontLeft')!;
    expect(hip.pivot).toEqual([-0.7, -1.4, 1.6]);
    expect(p.pieces.find((x) => x.name === 'Body')!.size).toEqual([2, 4, 1.2]);
  }, 180_000);
```

- [ ] **Step 2: Run to verify failure**

Run: `BLOX_LIVE_BLENDER=1 npx vitest run tests/e2e/model-blender.test.ts`
Expected: FAIL, with `name 'rig_rigid' is not defined` surfacing from the `run` command.

- [ ] **Step 3: Implement the Blender helpers in `tools/blender/blox_model.py`**

Add `import json` beside `import math`. Add to the module docstring after the `bind_rigid` lines:

```
  rig_rigid(armature, parts)               parts: {bone: [mesh objects]} → each
      piece stays its own object (no join, no skin); model export then writes a
      pieces-only model.glb + pivots.json for a Studio Motor6D rig
      (animate rig joints:"blender"). The biggest piece on a bone carries its
      joint; the rest ride it.
```

Add after `bind_rigid`:

```python
def rig_rigid(armature, parts):
    names = {b.name for b in armature.data.bones}
    m = {}
    for bone, objs in parts.items():
        if bone not in names:
            raise ValueError("rig_rigid: no bone named %s" % bone)
        for o in objs:
            _select_only([o], o)
            bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
            m[o.name] = bone
    armature["blox_rigid"] = json.dumps(m)
    return armature


def rigid_pivots(armature):
    """pivots.json for `animate rig joints:"blender"`: each piece's world
    bounds, and for each bone carrying pieces a joint at the bone's head from
    the nearest ancestor bone's main piece (its biggest). A bone's other pieces
    ride its main piece. On a root bone the extra pieces get their own joint
    to the main piece, at the point of it nearest their centre (the trunk has no
    joint for them to ride)."""
    m = json.loads(armature["blox_rigid"])
    pieces, by_bone, lo_hi = {}, {}, {}
    for name, bone in m.items():
        o = bpy.data.objects[name]
        pts = [o.matrix_world @ v.co for v in o.data.vertices]
        lo = [min(p[i] for p in pts) for i in range(3)]
        hi = [max(p[i] for p in pts) for i in range(3)]
        lo_hi[name] = (lo, hi)
        pieces[name] = {
            "name": name,
            "bone": bone,
            "center": [round((lo[i] + hi[i]) / 2, 6) for i in range(3)],
            "size": [round(hi[i] - lo[i], 6) for i in range(3)],
        }
        by_bone.setdefault(bone, []).append(name)

    def vol(n):
        s = pieces[n]["size"]
        return s[0] * s[1] * s[2]

    for names in by_bone.values():
        names.sort(key=lambda n: (-vol(n), n))
    main = {bone: names[0] for bone, names in by_bone.items()}
    joints, riders = [], {}
    mw = armature.matrix_world
    for b in armature.data.bones:
        if b.name not in main:
            continue
        names = by_bone[b.name]
        anc = b.parent
        while anc is not None and anc.name not in main:
            anc = anc.parent
        if anc is None:
            lo, hi = lo_hi[names[0]]
            for n in names[1:]:
                c = pieces[n]["center"]
                joints.append({"name": n, "part": n, "parent": names[0], "pivot": [round(min(max(c[i], lo[i]), hi[i]), 6) for i in range(3)]})
            continue
        head = mw @ b.head_local
        joints.append({"name": b.name, "part": names[0], "parent": main[anc.name], "pivot": [round(x, 6) for x in head]})
        if len(names) > 1:
            riders[names[0]] = names[1:]
    return {"pieces": list(pieces.values()), "joints": joints, "riders": riders}


def piece_materials(objs):
    """Give each piece its own copy of its first material, named after it: an
    upload makes one MeshPart per material, so this keeps one MeshPart per
    piece (and its name)."""
    for o in objs:
        if o.type != "MESH" or not o.data.materials:
            continue
        mat = o.data.materials[0].copy()
        mat.name = o.name
        o.data.materials[0] = mat
```

- [ ] **Step 4: Use them in `tools/blender/model.py` `cmd_export`**

Replace the tail of `cmd_export`, from `# Last: baking replaces materials ...` to `out(files)`:

```python
    rigid = [arm for arm in arms if "blox_rigid" in arm.keys()]
    if rigid:
        piv = os.path.join(a["out"], "pivots.json")
        with open(piv, "w") as f:
            json.dump(blox_model.rigid_pivots(rigid[0]), f)
        files["pivots"] = piv
    # Last: baking replaces materials in this (unsaved) session only.
    glb = os.path.join(a["out"], "model.glb")
    files["bake"] = blox_model.bake_vertex_colors(meshes())
    if rigid:
        # Pieces only: Studio joins them with Motor6Ds (animate rig joints:"blender").
        blox_model.piece_materials(meshes())
        blox_model.export_glb(glb, meshes())
    else:
        blox_model.export_glb(glb, meshes() + arms)
    files["upload"] = glb
    out(files)
```

`json` is already imported in `model.py` (it uses `json.dump`); confirm with `grep -n "^import json" tools/blender/model.py`.

- [ ] **Step 5: Mention it in the model tool**

`src/tools/registry.ts`, in the export branch: add `pivots?: string` to the `r` type, and add this after the upload line:

```ts
            ...(r.pivots ? [`rig pivots ${rel(r.pivots)}: after upload + insert, animate {action:"rig", model:<inserted model path>, joints:"blender", blender_id:"${id}", controller:"Humanoid"|"AnimationController"}`] : []),
```

`src/model/run.ts:69`: append ` · rig_rigid(armature, {bone: [objs]}) (separate pieces → a Studio Motor6D rig)` inside the helper string, before the closing quote.

- [ ] **Step 6: Run the gated test and the suite**

Run: `BLOX_LIVE_BLENDER=1 npx vitest run tests/e2e/model-blender.test.ts && npx tsc --noEmit && npx vitest run`
Expected: PASS. If headless Blender isn't available in WSL (`snap run blender --version` fails), record "gated test not run: no Blender" in the commit body and rely on Task 8 smoke B.

- [ ] **Step 7: Commit**

```bash
git add tools/blender/blox_model.py tools/blender/model.py src/tools/registry.ts src/model/run.ts tests/fixtures/model/rigid-dog.py tests/e2e/model-blender.test.ts
git commit -m "model: rigid-piece rigs export pieces-only GLB + pivots.json (spec C)

Claude-Session: https://claude.ai/code/session_01S9BqaZdZYrotiDVZwjqA1k"
```

---

### Task 7: Skill docs

**Files:**
- Modify: `skills/blox/animation/character-animation/SKILL.md` (the "A model's own rig" section, lines ~284-308)

**Interfaces:** none (text only).

- [ ] **Step 1: Replace the "not supported yet" sentence and add the rigging section**

In `## A model's own rig`, replace

```
back at rest). Rigging loose parts is not supported yet: rig it in Studio
first.
```

with

```
back at rest). Loose parts get a rig with `rig` (below).
```

Insert before `### DogWalk`:

````markdown
### Rigging loose pieces

1. `animate {action:"rig", model, suggest:true, plan:"quadruped"}` proposes
   which piece hangs from which and where each turns, from where the pieces
   touch. Small leaf pieces (eyes, nose) ride their parent (`with`); a piece
   that touches nothing is flagged `loose`. Nothing changes in Studio.
2. Review it. Edit any joint and pass the array as `joints`, or build it as is:
   `animate {action:"rig", model, joints:"suggested", controller:"Humanoid", plan:"quadruped"}`.
   `Humanoid` for a body that walks; `AnimationController` for one that flies,
   swims or stays put (its root is anchored for a script to move).
3. Look at the range sheet image: every joint turned ±30°. A piece that swings
   off the body instead of about its end has its pivot in the wrong place; fix
   that joint's pivot and rig again with `expected_revision` (the revision the
   result printed).
4. Animate it as any model rig: `check` with `"rig":"<model path>"`.

Name the parts for the plan (`Body`; `FrontLeftUpper`/`FrontLeftLower` …;
`Head`, `Tail`) and the suggestion names the joints (`Neck`, `FrontLeft`,
`FrontLeftKnee`) the way `plan:"quadruped"` declares them.

A Blender creature made with `rig_rigid` (separate pieces, one per bone)
carries its own pivots: export, upload, insert, then
`animate {action:"rig", model, joints:"blender", blender_id:"<model id>", controller:"Humanoid"}`.
blox fits the exported pieces to the inserted ones, so the model may be moved
or turned first.

Refused by name: skinned meshes (use `model animate`), models with an
importer's rig, `replace`, `pivot_space`.
````

- [ ] **Step 2: Check the skill tool still serves it**

Run: `npx vitest run tests/skills*.test.ts` (if present) and `node dist/cli.js tool skill '{"name":"character-animation","section":"Rigging loose pieces"}' --project ~/blox-fw` after `npm run build`. Expected: the section text prints.

- [ ] **Step 3: Commit**

```bash
git add skills/blox/animation/character-animation/SKILL.md
git commit -m "skill: rigging loose pieces with animate rig (spec C)

Claude-Session: https://claude.ai/code/session_01S9BqaZdZYrotiDVZwjqA1k"
```

---

### Task 8: Live spikes + smokes (Studio, human-visible)

**Files:** none unless a fix is needed. Any fix goes in its own commit with a regression test in the owning task's test file.

**Prerequisites:** Studio is open on `~/blox-fw`'s place with the MCP server connected, `npm run build` is done, and Lune is on PATH.

- [ ] **Spike 1: undo step on the MCP thread.** Run smoke A, step 3. The result line `undo:` says either "one undo step" (TryBeginRecording works) or names `ServerStorage.__BloxRigBackup.Dog`. Record which. If it is the backup, delete the folder after the smokes.
- [ ] **Spike 2: Humanoid root binds.** After smoke A step 3, `blox luau 'return workspace.Dog.Humanoid.RootPart and workspace.Dog.Humanoid.RootPart.Name' --project ~/blox-fw` prints `HumanoidRootPart`. If it prints nil, the build still reads back (Task 4 Step 1 fallback); record it and check that smoke A step 6 (verify) passes anyway.
- [ ] **Spike 3: multi-object GLB upload** (needs the user's approval for one Open Cloud upload). Run smoke B through upload and insert, then list the inserted model's children: `blox luau 'local t={} for _,c in workspace.RigidDog:GetDescendants() do if c:IsA("BasePart") then table.insert(t,c.Name) end end return table.concat(t,",")'`. Expected: 7 MeshParts named `Body, Head, Nose, FrontLeft, …`. Other names mean `fitBlenderPivots` matches by position; the result says `matched by position`.

- [ ] **Smoke A: Part dog** (`~/blox-fw`):
  1. Build a Part dog from `tests/fixtures/anim/dog-pieces.ts`'s layout at `(0, 10.2, 20)` under `Workspace.Dog`, using one `blox luau` program that makes the Parts. Copy positions and sizes from `dogPieces({ at: [0, 10.2, 20] })`.
  2. `node dist/cli.js animate rig Workspace.Dog --suggest --plan quadruped --project ~/blox-fw`. Expected: 11 joints, Head `with LeftEar, Nose, RightEar`.
  3. `node dist/cli.js animate rig Workspace.Dog --joints suggested --controller Humanoid --plan quadruped --project ~/blox-fw`. Expected: `read back as planned`, and the range sheet saved. Open `.blox/anims/_rig/Workspace.Dog/range.png` and confirm the legs swing from the hips.
  4. `node dist/cli.js animate check <DogWalk.json> --locomotion --project ~/blox-fw`, using the skill's `DogWalk` recipe with `"rig":"Workspace.Dog"`. Expected: checks pass.
  5. `node dist/cli.js animate build DogWalk --project ~/blox-fw`. Expected: it plays on a copy within tolerance.
  6. `node dist/cli.js animate verify --model Workspace.Dog --project ~/blox-fw`. This plays the built clip with no upload. Expected: walk and idle both pass, or the result names exactly what is missing because no upload exists (that is acceptable per spec).
- [ ] **Smoke C: Rebuild.** Edit the suggestion's `Tail` pivot by +0.2 in y and save it as `/tmp/claude-1000/joints.json`. Then run `animate rig Workspace.Dog --joints /tmp/claude-1000/joints.json --controller Humanoid --plan quadruped --revision <rr1 from step A3>`. Expected: `removed the 11 joints rig built before`, then `read back as planned`. Then run it once more without `--revision`. Expected: refused with `revision_required`. Finally, press Ctrl+Z in Studio (if spike 1 showed a recording) and confirm the previous Tail joint is back via `animate rig Workspace.Dog`.
- [ ] **Smoke B: Blender creature** (only after the user approves the upload):
  1. `blox model` with `tests/fixtures/model/rigid-dog.py` (id `rigiddog`), then export.
  2. Upload `model.glb` through `blox asset approve rigiddog` (human) → `asset upload`.
  3. Insert the asset into Workspace as `RigidDog` at y = 10.
  4. `animate rig Workspace.RigidDog --joints blender --blender rigiddog --controller Humanoid --plan quadruped`. Expected: `fitted … matched by name`, read back as planned, range sheet legs swing at the hips.
  5. `check` and `build` a gait on it. Expected: checks pass and it plays within tolerance.
- [ ] **Record results** in the PR body: spike answers, smoke pass/fail with the exact failing line, and the asset id if smoke B ran.
- [ ] **Final gate and PR:** `npx tsc --noEmit && npx vitest run`, push the branch, then `gh pr create` with the summary, spikes, smokes, and `https://claude.ai/code/session_01S9BqaZdZYrotiDVZwjqA1k`. Then squash-merge, delete the branch, and sync main (standing repo workflow).
