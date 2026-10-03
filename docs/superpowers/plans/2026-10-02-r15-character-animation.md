# R15/R6 Character Animation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new `animate` tool takes a plain-words animation for the stock R15/R6 character through compile + motion checks + contact sheet (offline), a verified Studio build, human-approved upload, file-based wiring into every player's `Animate` script, and a playtest verification.

**Architecture:** Roqer's pure-TS animation core is vendored into `src/anim/` unchanged except import paths and test runner. blox glue (`src/anim/store.ts`, `rbxm.ts`, `studio.ts`, `wire.ts`, `tool.ts`) connects it to blox's existing Studio plumbing (`runLuau`, `withPlay`, `pushProject`, the assets manifest, rojo). The registry gets one `animate` tool that delegates to `src/anim/tool.ts`.

**Tech Stack:** TypeScript (NodeNext ESM, strict), vitest, zod, Luau run through Studio MCP `execute_luau`, rojo for `.rbxmx → .rbxm`.

**Spec:** `docs/superpowers/specs/2026-10-02-r15-character-animation-design.md`

## Global Constraints

- Roqer source: `https://github.com/S4US/Roqer` at commit `4dcb9a7fd9b884cae4ed10fe282ee359550c10b4`, path `packages/core/src/animation/` (+ `packages/core/src/png-encoder.ts`). Clone it to the scratchpad: `git clone https://github.com/S4US/Roqer <scratch>/roqer && git -C <scratch>/roqer checkout 4dcb9a7`.
- Vendored files keep Roqer's code and style; only import specifiers and test-runner imports change. Every local change is listed in `src/anim/VENDOR.md`.
- Playback tolerance: build 1.5° / 0.05 studs (`PLAYBACK_TOLERANCE`), live playtest 2° / 0.05 studs (`LIVE_PLAYBACK_TOLERANCE`) — both from Roqer's `animation-tool.ts`, unchanged.
- Animate slots: `idle, walk, run, jump, fall, climb, swim, swimidle, sit` (`ANIMATE_SLOTS`).
- Files on disk per animation: `.blox/anims/<name>/` → `spec.json`, `sequence.json`, `report.json`, `sheet.png`, `anim_<name>.rbxmx`, `anim_<name>.project.json`, `anim_<name>.rbxm`, `verify.json`.
- Wire files (project-relative): `src/ServerScriptService/BloxCharacterAnimate.server.luau` (fixed loader) and `src/ReplicatedStorage/BloxAnimSlots.luau` (generated slot table).
- Studio build target: `ServerStorage.BloxAnimations.<name>` (same folder `model animate` uses).
- No new network path. Upload stays `asset upload` behind `blox asset approve`.
- Agent data reaches Studio Luau only inside a JSON long-string payload (`longString` from `src/studio/luau.ts`).
- Before claiming green: `npx vitest run` and `npx tsc --noEmit` (vitest skips typechecking).
- Commit messages end with `Claude-Session: https://claude.ai/code/session_01S9BqaZdZYrotiDVZwjqA1k`.

## Review Focus

1. Animation names with path or Luau-hostile characters (`../x`, `a b`, `x"]`) — refused with a clear message before any file write or Studio call (Task 3 test).
2. `build`/`verify` for a name whose `check` never ran — error "run animate check first", no Studio call (Task 5 and Task 7 tests).
3. A slot table edited by hand (no GENERATED header, or unparsable) — `wire` refuses instead of overwriting (Task 6 test).
4. Asset ids in every form people paste (`123`, `"rbxassetid://123"`, `"https://www.roblox.com/asset/?id=123"`, `0`, `"abc"`) — normalized or refused (Task 6 test).
5. A playtest that throws mid-verify — play is stopped (`withPlay`'s `finally`) and the error is reported, not swallowed (Task 7 test).

---

### Task 1: Vendor the animation core

**Files:**
- Create: `src/anim/{rig,r15-rig,r6-rig,rigs,motion,easing,limb-reach,gait,wave,generators,pose-compiler,motion-checks,contact-sheet,box-rig,rig-meshes,skin,model-meshes,animation-tool}.ts`
- Create: `src/anim/png-encoder.ts`
- Create: `src/anim/VENDOR.md`
- Test: `tests/anim.pose-compiler.test.ts`, `tests/anim.motion-checks.test.ts`, `tests/anim.gait.test.ts`, `tests/anim.wave.test.ts`, `tests/anim.contact-sheet.test.ts`

**Interfaces:**
- Produces (used by later tasks, all unchanged Roqer exports):
  - `compilePoseAnimation(input: unknown): PoseCompileResult` and `type KeyframeSequenceDescription`, `type CompiledPose`, `type CompiledKeyframe` — `src/anim/pose-compiler.ts`
  - `checkMotion(seq, {locomotion?, grounded?}, rig): MotionReport`, `type MotionCheckId` — `src/anim/motion-checks.ts`
  - `renderContactSheet(seq, meshes?, {locomotion?, rig?}): ContactSheet` (`png: Buffer`) — `src/anim/contact-sheet.ts`
  - `rigFor(name: string): Rig` — `src/anim/rigs.ts`
  - from `src/anim/animation-tool.ts`: `prepareAnimation(animation, {locomotion?, grounded?, waive?}): PrepareResult`, `compactChecks(report)`, `describeAnimation(seq)`, `previewSampleTimes(seq): number[]`, `verifyPlayback(seq, samples): PlaybackCheck`, `verifyLivePlayback(seq, samples): PlaybackCheck`, `ANIMATE_SLOTS`, `type AnimateSlot`, `normalizeAnimationId(v): string | undefined`, `MOTION_CHECK_IDS`

- [ ] **Step 1: Copy the files**

```bash
S=<scratch>/roqer/packages/core/src
mkdir -p src/anim
for f in rig r15-rig r6-rig rigs motion easing limb-reach gait wave generators pose-compiler motion-checks contact-sheet box-rig rig-meshes skin model-meshes animation-tool; do cp $S/animation/$f.ts src/anim/; done
cp $S/png-encoder.ts src/anim/png-encoder.ts
sed -i "s#from '../png-encoder.js'#from './png-encoder.js'#" src/anim/contact-sheet.ts
sed -i "s#from 'zlib'#from 'node:zlib'#; s#from 'fs'#from 'node:fs'#; s#from 'os'#from 'node:os'#; s#from 'path'#from 'node:path'#; s#from 'crypto'#from 'node:crypto'#" src/anim/*.ts
```

- [ ] **Step 2: Typecheck and fix only import-level breakage**

Run: `npx tsc --noEmit`
Expected: clean. If a file imports something outside the copied set (e.g. `./model-rig.js`), remove that import and the function that needs it, and list the removal in VENDOR.md. Do not restyle code.

- [ ] **Step 3: Port the tests**

```bash
T=<scratch>/roqer/packages/core/src/__tests__
cp $T/pose-compiler.test.ts tests/anim.pose-compiler.test.ts
cp $T/motion-checks.test.ts tests/anim.motion-checks.test.ts
cp $T/gait.test.ts tests/anim.gait.test.ts
cp $T/wave.test.ts tests/anim.wave.test.ts
sed -i "s#'\.\./animation/#'../src/anim/#g; s#from '@jest/globals'#from 'vitest'#" tests/anim.*.test.ts
sed -i "s#\btest(#it(#g; s#\btest\.each(#it.each(#g; s#, test }#, it }#; s#{ describe, expect, test }#{ describe, expect, it }#" tests/anim.*.test.ts
```

Then in each file: add `import { describe, it, expect } from 'vitest';` at the top if missing; delete every `describe`/`it` block that uses `rigFromModel`, `partsDog`, `partsOctopus`, `kneeDeclarations`, `armDeclarations` or imports from `./fixtures/` (model rigs are spec B), and delete those imports. Keep every R15/R6 case.

- [ ] **Step 4: Add the contact-sheet smoke test**

`tests/anim.contact-sheet.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { compilePoseAnimation } from '../src/anim/pose-compiler.js';
import { renderContactSheet } from '../src/anim/contact-sheet.js';
import { rigFor } from '../src/anim/rigs.js';

const wave = {
  name: 'Wave', rig: 'R15', loop: true,
  keyframes: [
    { time: 0, joints: { RightShoulder: { rotation: [0, 0, 150] } } },
    { time: 0.5, joints: { RightShoulder: { rotation: [0, 0, 120] } } },
    { time: 1, joints: { RightShoulder: { rotation: [0, 0, 150] } } },
  ],
};

describe('contact sheet', () => {
  it('renders a PNG of the rig at several moments', () => {
    const c = compilePoseAnimation(wave);
    if (!c.ok) throw new Error(c.errors.join('\n'));
    const sheet = renderContactSheet(c.sequence, undefined, { rig: rigFor('R15') });
    expect(sheet.png.subarray(1, 4).toString()).toBe('PNG');
    expect(sheet.times.length).toBeGreaterThanOrEqual(5);
    expect(sheet.width).toBeGreaterThan(0);
  });
});
```

If `rotation` is not the compiler's key for a joint rotation, read `JointPoseSpec` in `src/anim/pose-compiler.ts:93` and use its field; keep the shape otherwise.

- [ ] **Step 5: Run the anim tests**

Run: `npx vitest run tests/anim.`
Expected: all pass. A failure here is a porting mistake (paths, removed block still referenced), not a reason to change vendored logic.

- [ ] **Step 6: Write `src/anim/VENDOR.md`**

```markdown
# Vendored: Roqer animation core

Source: https://github.com/S4US/Roqer, commit 4dcb9a7fd9b884cae4ed10fe282ee359550c10b4,
`packages/core/src/animation/` and `packages/core/src/png-encoder.ts`.
Reused with the owner's permission. Roqer is AGPL-3.0; the blox owner chose to
proceed with reuse (2026-10-02).

Local changes:
- import specifiers: `../png-encoder.js` → `./png-encoder.js`; Node built-ins
  use the `node:` prefix.
- <list any import/function removed in Step 2, or "none">

Tests ported to tests/anim.*.test.ts (jest → vitest imports); cases for
model-read rigs (parts-dog, parts-octopus fixtures) removed — spec B.

Not vendored (spec B): model-rig, rig-declarations, body-plans, rig-build,
rig-glb, rig-tool.
```

- [ ] **Step 7: Typecheck, full suite, commit**

Run: `npx tsc --noEmit && npx vitest run`
Expected: clean; all pass.

```bash
git add src/anim tests/anim.*.test.ts
git commit -m "anim: vendor Roqer animation core (compiler, checks, contact sheet)"
```

---

### Task 2: Recipes skill + recipe regression test

**Files:**
- Create: `skills/blox/animation/character-animation/SKILL.md`
- Create: `src/anim/recipes.ts`
- Test: `tests/anim.recipes.test.ts`

**Interfaces:**
- Consumes: `compilePoseAnimation`, `checkMotion`, `rigFor` (Task 1); `SKILLS_ROOT` from `src/skills.ts`.
- Produces: `RECIPE_SKILL: string` (path), `loadRecipes(): Map<string, Record<string, unknown>>` keyed by recipe `name` — `src/anim/recipes.ts`.

- [ ] **Step 1: Write the skill file**

Build `SKILL.md` from Roqer's `apps/desktop/agent/skills/roblox-animation-vfx/references/character-animation.md`:
- frontmatter:
  ```
  ---
  name: character-animation
  description: Describe, check, build, wire and verify R15/R6 player-character animations with the animate tool; tested recipes for wave, idle, walk, run, jump (R15) and walk, wave (R6).
  ---
  ```
- keep sections: Format, Markers, Poses, Reaching a point: aimAt, Recipes (Wave, Idle, Walk, Run, Jump), R6 (Walk R6, Wave R6), Reading the result.
- drop: Props, Lunge, Slash, NPCs, Creatures and other models.
- replace the tool name `animation` with `animate` and its actions with blox's: `animate {action:"check", animation, locomotion?, grounded?, waive?}`, `build {name}`, `wire {slot, asset, replaces?}`, `verify {name, slot?, asset?}`. Add after the Format section:

  ```
  ## Loop
  recipes → check (look at the sheet; fix or waive) → build → a human runs
  `blox asset approve <name>` → asset {action:"upload", id:"<name>", confirm:true}
  → wire {slot, asset} → verify {name, slot}.
  ```
- keep every ```json recipe block verbatim.
- add at the end: `Adapted from Roqer (github.com/S4US/Roqer @4dcb9a7), see src/anim/VENDOR.md.`

- [ ] **Step 2: Write the failing recipe test**

`tests/anim.recipes.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { loadRecipes } from '../src/anim/recipes.js';
import { compilePoseAnimation } from '../src/anim/pose-compiler.js';
import { checkMotion } from '../src/anim/motion-checks.js';
import { rigFor } from '../src/anim/rigs.js';
import { listSkills } from '../src/skills.js';

const GAITS = new Set(['Walk', 'Run', 'WalkR6']);

describe('animation recipes', () => {
  const all = loadRecipes();
  it('ships the props-free recipes', () => {
    expect([...all.keys()].sort()).toEqual(['Idle', 'Jump', 'Run', 'Walk', 'WalkR6', 'Wave', 'WaveR6']);
  });
  it.each([...loadRecipes().keys()])('%s compiles and passes every check that applies', (name) => {
    const c = compilePoseAnimation(all.get(name));
    if (!c.ok) throw new Error(c.errors.join('\n'));
    const rig = rigFor(c.sequence.rig);
    const report = checkMotion(c.sequence, { locomotion: GAITS.has(name), grounded: name !== 'Jump' }, rig);
    expect(report.checks.filter((x) => x.status === 'fail').map((x) => `${x.id}: ${x.detail}`)).toEqual([]);
  });
  it('is served by the skill tool', () => {
    expect(listSkills().some((s) => s.name === 'character-animation')).toBe(true);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `npx vitest run tests/anim.recipes.test.ts`
Expected: FAIL — cannot resolve `../src/anim/recipes.js`.

- [ ] **Step 4: Implement `src/anim/recipes.ts`**

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILLS_ROOT } from '../skills.js';

// Tested recipes live in the character-animation skill (one ```json block each),
// so the agent reads the same text the regression test holds them to.
export const RECIPE_SKILL = join(SKILLS_ROOT, 'blox', 'animation', 'character-animation', 'SKILL.md');

export function loadRecipes(file = RECIPE_SKILL): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const m of readFileSync(file, 'utf8').matchAll(/```json\r?\n([\s\S]*?)```/g)) {
    const r = JSON.parse(m[1]) as Record<string, unknown>;
    if (typeof r.name === 'string') out.set(r.name, r);
  }
  return out;
}
```

- [ ] **Step 5: Run it to see it pass**

Run: `npx vitest run tests/anim.recipes.test.ts`
Expected: PASS (9 tests: list, 7 recipes, skill listing). If `listSkills` needs a cache reset, the new skill dir is read on first call — no change needed.

- [ ] **Step 6: Commit**

```bash
git add skills/blox src/anim/recipes.ts tests/anim.recipes.test.ts
git commit -m "anim: character-animation skill with tested R15/R6 recipes"
```

---

### Task 3: `animate` tool — store, `recipes`, `check`

**Files:**
- Create: `src/anim/store.ts`
- Create: `src/anim/tool.ts`
- Modify: `src/tools/registry.ts` (add the `animate` tool entry after the `model` tool, ~line 940; add import)
- Test: `tests/anim.tool.test.ts`

**Interfaces:**
- Consumes: Task 1 exports, `loadRecipes` (Task 2), `ToolCtx`, `ToolOutput` from `src/tools/registry.ts`.
- Produces:
  - `src/anim/store.ts`:
    ```ts
    export const ANIM_NAME: RegExp; // /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
    export function animDir(projectPath: string, name: string): string; // throws on bad name
    export interface StoredAnim {
      spec: Record<string, unknown>;
      sequence: KeyframeSequenceDescription;
      options: { locomotion: boolean; grounded: boolean };
      failing: MotionCheckId[];
      waived: MotionCheckId[];
    }
    export function saveChecked(projectPath: string, a: StoredAnim, report: MotionReport, sheetPng: Buffer): string; // returns dir
    export function loadChecked(projectPath: string, name: string): StoredAnim | null;
    ```
  - `src/anim/tool.ts`: `export async function animateTool(a: Record<string, unknown>, ctx: ToolCtx): Promise<ToolOutput>` dispatching on `a.action`; `export const ANIMATE_DESCRIPTION: string`; `export const animateShape: z.ZodRawShape`.

- [ ] **Step 1: Write the failing tests**

`tests/anim.tool.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findTool, invokeTool, type ToolCtx } from '../src/tools/registry.js';
import { BloxConfigSchema } from '../src/config.js';
import { loadRecipes } from '../src/anim/recipes.js';
import type { StudioSession } from '../src/studio/session.js';

export function ctx(session: Partial<StudioSession> = {}): ToolCtx {
  const projectPath = mkdtempSync(join(tmpdir(), 'blox-anim-'));
  return { session: session as StudioSession, projectPath, config: BloxConfigSchema.parse({ projectPath }), agent: 'test' };
}
const call = (args: Record<string, unknown>, c: ToolCtx) => invokeTool(findTool('animate')!, args, c);
const walk = () => structuredClone(loadRecipes().get('Walk')!);

describe('animate recipes/check', () => {
  it('lists recipes and returns one', async () => {
    const c = ctx();
    expect((await call({ action: 'recipes' }, c)).text).toMatch(/Walk.*WaveR6|WaveR6.*Walk/s);
    const one = await call({ action: 'recipes', name: 'Walk' }, c);
    expect(JSON.parse(one.text).name).toBe('Walk');
    expect((await call({ action: 'recipes', name: 'Nope' }, c)).isError).toBe(true);
  });

  it('check compiles, reports checks, writes the files and returns the sheet image', async () => {
    const c = ctx();
    const r = await call({ action: 'check', animation: walk(), locomotion: true, grounded: true }, c);
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/footSliding/);
    expect(r.images?.[0].mimeType).toBe('image/png');
    for (const f of ['spec.json', 'sequence.json', 'report.json', 'sheet.png']) expect(existsSync(join(c.projectPath, '.blox/anims/Walk', f))).toBe(true);
  });

  it('check reports every compile error at once', async () => {
    const r = await call({ action: 'check', animation: { name: 'Bad', rig: 'R15', keyframes: [{ time: 0, joints: { NoSuchJoint: {} } }, { time: -1, joints: {} }] } }, ctx());
    expect(r.isError).toBe(true);
    expect(r.text.split('\n').filter((l) => l.startsWith('  ')).length).toBeGreaterThanOrEqual(2);
  });

  it('a failed check is listed with its measurement; waiving it records the waiver', async () => {
    const c = ctx();
    const jump = structuredClone(loadRecipes().get('Jump')!);
    const r = await call({ action: 'check', animation: jump, grounded: true }, c);
    expect(r.text).toMatch(/groundContact.*fail|fail.*groundContact/s);
    const w = await call({ action: 'check', animation: jump, grounded: true, waive: ['groundContact'] }, c);
    expect(w.text).toMatch(/waived: groundContact/);
  });

  it('refuses names that are not plain identifiers before writing anything', async () => {
    for (const name of ['../x', 'a b', 'x"]']) {
      const c = ctx();
      const r = await call({ action: 'check', animation: { ...walk(), name } }, c);
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/name/);
      expect(existsSync(join(c.projectPath, '.blox/anims'))).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/anim.tool.test.ts`
Expected: FAIL — `findTool('animate')` is undefined.

- [ ] **Step 3: Implement `src/anim/store.ts`**

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KeyframeSequenceDescription } from './pose-compiler.js';
import type { MotionCheckId, MotionReport } from './motion-checks.js';

// One animation's working files: .blox/anims/<name>/.
export const ANIM_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export function animDir(projectPath: string, name: string): string {
  if (!ANIM_NAME.test(name)) throw new Error(`bad animation name "${name}": letters, digits, _ and -, starting with a letter (max 64)`);
  return join(projectPath, '.blox', 'anims', name);
}

export interface StoredAnim {
  spec: Record<string, unknown>;
  sequence: KeyframeSequenceDescription;
  options: { locomotion: boolean; grounded: boolean };
  failing: MotionCheckId[];
  waived: MotionCheckId[];
}

export function saveChecked(projectPath: string, a: StoredAnim, report: MotionReport, sheetPng: Buffer): string {
  const dir = animDir(projectPath, a.sequence.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'spec.json'), JSON.stringify(a.spec, null, 2));
  writeFileSync(join(dir, 'sequence.json'), JSON.stringify({ sequence: a.sequence, options: a.options, failing: a.failing, waived: a.waived }));
  writeFileSync(join(dir, 'report.json'), JSON.stringify({ checkedAt: new Date().toISOString(), ...report, failing: a.failing, waived: a.waived }, null, 2));
  writeFileSync(join(dir, 'sheet.png'), sheetPng);
  return dir;
}

export function loadChecked(projectPath: string, name: string): StoredAnim | null {
  const dir = animDir(projectPath, name);
  const f = join(dir, 'sequence.json');
  if (!existsSync(f)) return null;
  const s = JSON.parse(readFileSync(f, 'utf8')) as Omit<StoredAnim, 'spec'>;
  return { ...s, spec: JSON.parse(readFileSync(join(dir, 'spec.json'), 'utf8')) as Record<string, unknown> };
}
```

- [ ] **Step 4: Implement `src/anim/tool.ts` (recipes + check; build/wire/verify return "not yet" until Tasks 5–7)**

```ts
import { z } from 'zod';
import type { ToolCtx, ToolOutput } from '../tools/registry.js';
import { compactChecks, prepareAnimation, MOTION_CHECK_IDS, ANIMATE_SLOTS } from './animation-tool.js';
import { renderContactSheet } from './contact-sheet.js';
import { rigFor } from './rigs.js';
import { loadRecipes } from './recipes.js';
import { ANIM_NAME, saveChecked } from './store.js';

export const ANIMATE_DESCRIPTION =
  'R15/R6 player-character animation (guide: skill {name:"character-animation"}). recipes {name?} (tested starting points) | check {animation, locomotion?, grounded?, waive?} (compile + 7 motion checks + contact sheet image, offline; writes .blox/anims/<name>/) | build {name, force?} (plays it on a stock dummy in Studio, compares with the checked motion, writes ServerStorage.BloxAnimations.<name> + anim_<name>.rbxm, records an animation candidate; a human approves before asset upload) | wire {slot, asset, replaces?, rig?} (sets an Animate slot for every player via src/ReplicatedStorage/BloxAnimSlots.luau + a fixed loader, then syncs) | verify {name, slot?, asset?} (playtest: plays on the player\'s character, compares with the checked motion, confirms the slot).';

export const animateShape = {
  action: z.enum(['recipes', 'check', 'build', 'wire', 'verify']),
  name: z.string().optional(),
  animation: z.record(z.string(), z.unknown()).optional().describe('check: the pose description (see the character-animation skill)'),
  locomotion: z.boolean().optional(),
  grounded: z.boolean().optional(),
  waive: z.array(z.enum(MOTION_CHECK_IDS as unknown as [string, ...string[]])).optional(),
  force: z.boolean().optional(),
  slot: z.enum(ANIMATE_SLOTS as unknown as [string, ...string[]]).optional(),
  asset: z.union([z.string(), z.number()]).optional(),
  replaces: z.union([z.string(), z.number()]).optional(),
  rig: z.enum(['R15', 'R6']).optional(),
};

const err = (text: string, summary: string): ToolOutput => ({ text, isError: true, summary });

export async function animateTool(a: Record<string, unknown>, ctx: ToolCtx): Promise<ToolOutput> {
  const P = ctx.projectPath;
  if (a.action === 'recipes') {
    const all = loadRecipes();
    if (typeof a.name !== 'string') return { text: `recipes: ${[...all.keys()].join(', ')}\nanimate {action:"recipes", name} returns one; adapt it, then check.`, summary: `${all.size} recipes` };
    const r = all.get(a.name);
    return r ? { text: JSON.stringify(r, null, 2), summary: a.name } : err(`no recipe ${a.name}; recipes: ${[...all.keys()].join(', ')}`, 'unknown');
  }
  if (a.action === 'check') {
    const spec = a.animation as Record<string, unknown> | undefined;
    if (!spec) return err('check needs animation (start from animate {action:"recipes"})', 'no animation');
    if (typeof spec.name !== 'string' || !ANIM_NAME.test(spec.name)) return err(`animation.name must be letters, digits, _ and -, starting with a letter (max 64); got ${JSON.stringify(spec.name)}`, 'bad name');
    const p = prepareAnimation(spec, { locomotion: a.locomotion, grounded: a.grounded, waive: a.waive });
    if (!p.ok) return err(`does not compile:\n${p.errors.map((e) => `  ${e}`).join('\n')}`, `${p.errors.length} errors`);
    const { sequence, report, failing, waived } = p.value;
    const options = { locomotion: a.locomotion === true, grounded: a.grounded === true };
    const sheet = renderContactSheet(sequence, undefined, { locomotion: options.locomotion, rig: rigFor(sequence.rig) });
    saveChecked(P, { spec, sequence, options, failing, waived }, report, sheet.png);
    const lines = [`${sequence.name} (${sequence.rig}, ${sequence.duration}s${sequence.loop ? ', loop' : ''}, ${sequence.keyframes.length} keyframes):`];
    for (const c of compactChecks(report)) lines.push(`  ${c.status === 'pass' ? '✓' : c.status === 'fail' ? '✗' : '·'} ${c.id} ${c.status}  ${c.detail}${c.measured ? ` ${JSON.stringify(c.measured)}` : ''}`);
    if (waived.length) lines.push(`waived: ${waived.join(', ')}`);
    lines.push(`sheet: columns at ${sheet.times.map((t, i) => `${t.toFixed(2)}s${sheet.labels[i] ? ` (${sheet.labels[i]})` : ''}`).join(', ')}`);
    lines.push(failing.length ? `failing: ${failing.join(', ')} — fix the description, or waive a failure you mean (e.g. groundContact on a jump), then check again` : `Next: animate {action:"build", name:"${sequence.name}"}`);
    return { text: lines.join('\n'), images: [{ data: sheet.png.toString('base64'), mimeType: 'image/png' }], summary: failing.length ? `${failing.length} failing` : 'checks pass' };
  }
  return err(`${String(a.action)}: not implemented yet`, 'todo');
}
```

- [ ] **Step 5: Register the tool in `src/tools/registry.ts`**

Add the import near the other feature imports:

```ts
import { animateTool, animateShape, ANIMATE_DESCRIPTION } from '../anim/tool.js';
```

Add after the `model` tool object:

```ts
  {
    name: 'animate',
    description: ANIMATE_DESCRIPTION,
    shape: animateShape,
    handler: animateTool,
  },
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/anim.tool.test.ts tests/mcp.server.test.ts`
Expected: PASS. If `mcp.server.test.ts` pins the tool list, add `'animate'` to its expected list.

- [ ] **Step 7: Commit**

```bash
git add src/anim/store.ts src/anim/tool.ts src/tools/registry.ts tests/anim.tool.test.ts tests/mcp.server.test.ts
git commit -m "animate tool: recipes + offline check with contact sheet"
```

---

### Task 4: KeyframeSequence `.rbxmx` writer + rbxm build

**Files:**
- Create: `src/anim/rbxm.ts`
- Test: `tests/anim.rbxm.test.ts`

**Interfaces:**
- Consumes: `KeyframeSequenceDescription`, `CompiledPose` (Task 1); `realSpawn`, `rojoBin()` from `src/sync/rojo.ts`.
- Produces:
  ```ts
  export function sequenceXml(seq: KeyframeSequenceDescription): string;
  export async function writeRbxm(dir: string, seq: KeyframeSequenceDescription, spawn?: SpawnLike): Promise<{ file: string } | { error: string }>; // file = absolute path of anim_<name>.rbxm
  ```

- [ ] **Step 1: Write the failing test**

`tests/anim.rbxm.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { compilePoseAnimation } from '../src/anim/pose-compiler.js';
import { loadRecipes } from '../src/anim/recipes.js';
import { sequenceXml } from '../src/anim/rbxm.js';

const seq = () => {
  const c = compilePoseAnimation(loadRecipes().get('Jump'));
  if (!c.ok) throw new Error(c.errors.join());
  return c.sequence;
};

describe('sequenceXml', () => {
  it('writes the KeyframeSequence with nested Poses, weights, easing tokens and priority', () => {
    const s = seq();
    const xml = sequenceXml(s);
    expect(xml).toMatch(/^<roblox /);
    expect(xml.match(/class="Keyframe"/g)!.length).toBe(s.keyframes.length);
    expect(xml.match(/class="Pose"/g)!.length).toBe(s.poseCount);
    expect(xml).toMatch(/<string name="Name">HumanoidRootPart<\/string>/);
    expect(xml).toMatch(/<float name="Weight">0<\/float>/); // hierarchy placeholders
    expect(xml).toContain(`<bool name="Loop">${s.loop}</bool>`);
    expect(xml).toMatch(/<token name="Priority">\d+<\/token>/);
  });
  it('escapes names', () => {
    const s = { ...seq(), name: 'A<&>' };
    expect(sequenceXml(s)).toContain('A&lt;&amp;&gt;');
  });
  it('writes markers as KeyframeMarker items', () => {
    const s = seq();
    s.keyframes[0] = { ...s.keyframes[0], markers: [{ name: 'Hit', value: 'x' }] };
    expect(sequenceXml(s)).toMatch(/class="KeyframeMarker".*<string name="Name">Hit<\/string>.*<string name="Value">x<\/string>/s);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/anim.rbxm.test.ts`
Expected: FAIL — cannot resolve `../src/anim/rbxm.js`.

- [ ] **Step 3: Implement `src/anim/rbxm.ts`**

```ts
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
```

- [ ] **Step 4: Run it to see it pass, then typecheck**

Run: `npx vitest run tests/anim.rbxm.test.ts && npx tsc --noEmit`
Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add src/anim/rbxm.ts tests/anim.rbxm.test.ts
git commit -m "anim: KeyframeSequence rbxmx writer + rojo rbxm build"
```

---

### Task 5: `build` — verified Studio build with rebuild guard

**Files:**
- Create: `src/anim/studio.ts`
- Modify: `src/anim/tool.ts` (add the `build` branch)
- Test: `tests/anim.build.test.ts`

**Interfaces:**
- Consumes: `loadChecked`, `animDir` (Task 3); `previewSampleTimes`, `verifyPlayback` (Task 1); `writeRbxm` (Task 4); `runLuau`, `longString` from `src/studio/luau.ts`; `SOURCE_SUM_LUAU` from `src/sync/push.ts`; `loadManifest`, `saveManifest`, `addAsset` from `src/assets/manifest.ts`.
- Produces:
  ```ts
  export const BUILD_FOLDER = 'BloxAnimations';
  export function buildProgram(seq: KeyframeSequenceDescription, sampleTimes: number[]): string;
  export interface BuildReply { ok: boolean; error?: string; code?: 'not_ours' | 'edited'; length?: number; samples?: { time: number; transforms: Record<string, number[]> }[]; written?: boolean }
  ```
  The program runs twice per build: first with `write=false` (play + sample only); TS compares; then, only when verified, again as `commitProgram(seq, force)` which writes the sequence. Both are in `src/anim/studio.ts`:
  ```ts
  export function commitProgram(seq: KeyframeSequenceDescription, force: boolean): string;
  ```

- [ ] **Step 1: Write the failing tests**

`tests/anim.build.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findTool, invokeTool, type ToolCtx } from '../src/tools/registry.js';
import { BloxConfigSchema } from '../src/config.js';
import { loadRecipes } from '../src/anim/recipes.js';
import { loadChecked } from '../src/anim/store.js';
import { buildTracks, sampleTrack } from '../src/anim/motion.js';
import { previewSampleTimes } from '../src/anim/animation-tool.js';
import { rigFor } from '../src/anim/rigs.js';
import { loadManifest } from '../src/assets/manifest.js';
import type { StudioSession } from '../src/studio/session.js';

const envelope = (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, n: 1, values: { v1: JSON.stringify(v) }, logs: [] }) }] });

function fakeSession(reply: (code: string) => unknown, codes: string[] = []) {
  return { call: async (_n: string, args: Record<string, unknown>) => { codes.push(String(args.code)); return envelope(reply(String(args.code))); } } as unknown as StudioSession;
}
function ctx(session: StudioSession): ToolCtx {
  const projectPath = mkdtempSync(join(tmpdir(), 'blox-animb-'));
  return { session, projectPath, config: BloxConfigSchema.parse({ projectPath }), agent: 'test' };
}
const call = (args: Record<string, unknown>, c: ToolCtx) => invokeTool(findTool('animate')!, args, c);

// Exact samples of the checked motion: what a faithful Studio playback returns.
function faithful(c: ToolCtx, name: string, skew = 0) {
  const seq = loadChecked(c.projectPath, name)!.sequence;
  const tracks = buildTracks(seq);
  return previewSampleTimes(seq).map((time) => ({
    time,
    transforms: Object.fromEntries(rigFor(seq.rig).joints.map((j) => {
      const f = sampleTrack(tracks.get(j.childPart), time);
      const r = f.r.slice() as number[];
      if (skew) { r[0] = Math.cos(skew); r[1] = -Math.sin(skew); r[3] = Math.sin(skew); r[4] = Math.cos(skew); }
      return [j.childPart, [...f.p, ...r]];
    })),
  }));
}

describe('animate build', () => {
  it('refuses without a prior check, without calling Studio', async () => {
    const codes: string[] = [];
    const r = await call({ action: 'build', name: 'Walk' }, ctx(fakeSession(() => ({}), codes)));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/animate check first/);
    expect(codes).toEqual([]);
  });

  it('refuses while a check fails unwaived', async () => {
    const c = ctx(fakeSession(() => ({})));
    await call({ action: 'check', animation: structuredClone(loadRecipes().get('Jump')!), grounded: true }, c);
    const r = await call({ action: 'build', name: 'Jump' }, c);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/groundContact/);
  });

  it('plays, compares, commits, writes the rbxm and records a candidate', async () => {
    let c!: ToolCtx;
    const codes: string[] = [];
    c = ctx(fakeSession((code) => (code.includes('local WRITE = true') ? { ok: true, written: true } : { ok: true, length: 1, samples: faithful(c, 'Wave') }), codes));
    await call({ action: 'check', animation: structuredClone(loadRecipes().get('Wave')!) }, c);
    const r = await call({ action: 'build', name: 'Wave' }, c);
    expect(r.isError, r.text).toBeFalsy();
    expect(codes.filter((x) => x.includes('local WRITE = true')).length).toBe(1);
    expect(codes.every((x) => !x.includes('"name":"Wave"') || x.includes('local PAYLOAD = '))).toBe(true); // agent data only inside the payload
    expect(existsSync(join(c.projectPath, '.blox/anims/Wave/anim_Wave.rbxm'))).toBe(true);
    const m = loadManifest(c.projectPath).assets.find((x) => x.id === 'Wave');
    expect(m).toMatchObject({ kind: 'animation', status: 'candidate', ref: { file: '.blox/anims/Wave/anim_Wave.rbxm' } });
  });

  it('a playback mismatch writes nothing and names the worst joint', async () => {
    let c!: ToolCtx;
    const codes: string[] = [];
    c = ctx(fakeSession(() => ({ ok: true, length: 1, samples: faithful(c, 'Wave', 0.2) }), codes));
    await call({ action: 'check', animation: structuredClone(loadRecipes().get('Wave')!) }, c);
    const r = await call({ action: 'build', name: 'Wave' }, c);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/°/);
    expect(codes.some((x) => x.includes('local WRITE = true'))).toBe(false);
  });

  it('reports the rebuild guard refusals', async () => {
    let c!: ToolCtx;
    c = ctx(fakeSession((code) => (code.includes('local WRITE = true') ? { ok: false, code: 'edited', error: 'edited in Studio' } : { ok: true, length: 1, samples: faithful(c, 'Wave') })));
    await call({ action: 'check', animation: structuredClone(loadRecipes().get('Wave')!) }, c);
    const r = await call({ action: 'build', name: 'Wave' }, c);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/edited in Studio.*force:true/s);
  });
});
```

The rbxm assertion needs rojo on PATH (`~/.local/bin/rojo` or `BLOX_ROJO`); the suite already depends on it elsewhere. If it is missing in CI, guard that one `expect` with `if (process.env.BLOX_ROJO || hasRojo)` following how `tests/model*.test.ts` guards rojo.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/anim.build.test.ts`
Expected: FAIL — build returns "not implemented yet".

- [ ] **Step 3: Implement `src/anim/studio.ts`**

```ts
import { longString } from '../studio/luau.js';
import { SOURCE_SUM_LUAU } from '../sync/push.js';
import type { KeyframeSequenceDescription } from './pose-compiler.js';

// Fixed Luau for the animate tool. Agent data arrives only as JSON in PAYLOAD.
export const BUILD_FOLDER = 'BloxAnimations';

export interface BuildReply {
  ok: boolean;
  error?: string;
  code?: 'not_ours' | 'edited';
  length?: number;
  samples?: { time: number; transforms: Record<string, number[]> }[];
  written?: boolean;
}

// Shared: KeyframeSequence from the compiled description (port of Roqer's
// buildSequence/buildPose/buildMarkers), joint map, revision of a sequence.
const SEQUENCE_LUAU = `${SOURCE_SUM_LUAU}local HS = game:GetService("HttpService")
local P = HS:JSONDecode(PAYLOAD)
local function cf(c) return CFrame.new(c[1], c[2], c[3], c[4], c[5], c[6], c[7], c[8], c[9], c[10], c[11], c[12]) end
local function pose(d, parent)
	local p = Instance.new("Pose")
	p.Name = d.part
	p.Weight = d.weight
	p.CFrame = cf(d.cframe)
	p.EasingStyle = Enum.PoseEasingStyle[d.easingStyle]
	p.EasingDirection = Enum.PoseEasingDirection[d.easingDirection]
	for _, c in d.children do pose(c, p) end
	p.Parent = parent
end
local function buildSequence(s)
	local ks = Instance.new("KeyframeSequence")
	ks.Name = s.name
	ks.Loop = s.loop
	ks.Priority = Enum.AnimationPriority[s.priority]
	for _, k in s.keyframes do
		local kf = Instance.new("Keyframe")
		kf.Time = k.time
		if k.name then kf.Name = k.name end
		pose(k.root, kf)
		for _, m in k.markers or {} do
			local mk = Instance.new("KeyframeMarker")
			mk.Name = m.name
			mk.Value = m.value
			mk.Parent = kf
		end
		kf.Parent = ks
	end
	return ks
end
local function r6(v) return math.round(v * 1e6) / 1e6 end
local function describe(inst, out)
	table.insert(out, inst.ClassName .. ":" .. inst.Name)
	if inst:IsA("Keyframe") then table.insert(out, tostring(r6(inst.Time))) end
	if inst:IsA("Pose") then
		table.insert(out, tostring(inst.Weight) .. inst.EasingStyle.Name .. inst.EasingDirection.Name)
		for _, v in { inst.CFrame:GetComponents() } do table.insert(out, tostring(r6(v))) end
	end
	if inst:IsA("KeyframeMarker") then table.insert(out, inst.Value) end
	local kids = inst:GetChildren()
	table.sort(kids, function(a, b)
		if a:IsA("Keyframe") and b:IsA("Keyframe") then return a.Time < b.Time end
		return a.Name < b.Name
	end)
	for _, c in kids do describe(c, out) end
end
local function revision(ks)
	local out = {}
	describe(ks, out)
	return __bloxSum(table.concat(out, "|"))
end
`;

// Play the compiled sequence on a stock dummy in a non-archivable temp folder
// and sample each joint's Transform at the given times (Animator:StepAnimations).
const PLAY_LUAU = `local Players = game:GetService("Players")
local function components(c) local o = {} for _, v in { c:GetComponents() } do table.insert(o, r6(v)) end return o end
local function joints(rig)
	local j = {}
	for _, d in rig:GetDescendants() do
		if d:IsA("AnimationConstraint") and d.Attachment1 and d.Attachment1.Parent then j[d.Attachment1.Parent.Name] = d
		elseif d:IsA("Motor6D") and d.Part1 then j[d.Part1.Name] = d end
	end
	return j
end
local folder, track, ks
local ok, res = pcall(function()
	for _, c in workspace:GetChildren() do if c.Name == "__BloxAnimPreview" then c:Destroy() end end
	ks = buildSequence(P.sequence)
	local id = game:GetService("AnimationClipProvider"):RegisterAnimationClip(ks)
	folder = Instance.new("Folder")
	folder.Name = "__BloxAnimPreview"
	folder.Archivable = false
	folder.Parent = workspace
	local rig = Players:CreateHumanoidModelFromDescription(Instance.new("HumanoidDescription"), P.sequence.rig == "R6" and Enum.HumanoidRigType.R6 or Enum.HumanoidRigType.R15)
	rig.Archivable = false
	rig:PivotTo(CFrame.new(0, 100000, 0))
	rig.HumanoidRootPart.Anchored = true
	rig.Parent = folder
	local hum = rig:FindFirstChildOfClass("Humanoid")
	local animator = hum:FindFirstChildOfClass("Animator") or Instance.new("Animator", hum)
	local anim = Instance.new("Animation")
	anim.AnimationId = tostring(id)
	track = animator:LoadAnimation(anim)
	track:Play(0)
	local deadline = os.clock() + 10
	while track.Length == 0 and os.clock() < deadline do task.wait(0.05) end
	if track.Length == 0 then error("the animation never loaded on the dummy") end
	local js = joints(rig)
	local samples = {}
	animator:StepAnimations(0)
	local now = 0
	for _, t in P.times do
		if t > now then animator:StepAnimations(t - now) end
		now = t
		local tr = {}
		for part, j in js do tr[part] = components(j.Transform) end
		table.insert(samples, { time = track.TimePosition, transforms = tr })
	end
	return { ok = true, length = track.Length, samples = samples }
end)
if track then pcall(function() track:Stop(0) end) end
if folder then folder:Destroy() end
if ks then ks:Destroy() end
if not ok then return HS:JSONEncode({ ok = false, error = tostring(res) }) end
return HS:JSONEncode(res)`;

// Write ServerStorage.BloxAnimations.<name> in one undo step, refusing to
// replace a sequence blox did not build or one edited since (unless FORCE).
const COMMIT_LUAU = `local SS = game:GetService("ServerStorage")
local CHS = game:GetService("ChangeHistoryService")
local folder = SS:FindFirstChild("${BUILD_FOLDER}")
local old = folder and folder:FindFirstChild(P.sequence.name)
if old and not FORCE then
	local rev = old:GetAttribute("BloxAnimRev")
	if typeof(rev) ~= "string" then return HS:JSONEncode({ ok = false, code = "not_ours", error = old:GetFullName() .. " was not built by blox" }) end
	if revision(old) ~= rev then return HS:JSONEncode({ ok = false, code = "edited", error = old:GetFullName() .. " was edited in Studio since its build" }) end
end
local rec
pcall(function() rec = CHS:TryBeginRecording("blox animate build") end)
if not folder then
	folder = Instance.new("Folder")
	folder.Name = "${BUILD_FOLDER}"
	folder.Parent = SS
end
if old then old:Destroy() end
local ks = buildSequence(P.sequence)
ks:SetAttribute("BloxAnimRev", revision(ks))
ks.Parent = folder
if rec then pcall(function() CHS:FinishRecording(rec, Enum.FinishRecordingOperation.Commit) end) end
return HS:JSONEncode({ ok = true, written = true })`;

export function buildProgram(seq: KeyframeSequenceDescription, sampleTimes: number[]): string {
  return `local WRITE = false\nlocal PAYLOAD = ${longString(JSON.stringify({ sequence: seq, times: sampleTimes }))}\n${SEQUENCE_LUAU}${PLAY_LUAU}`;
}

export function commitProgram(seq: KeyframeSequenceDescription, force: boolean): string {
  return `local WRITE = true\nlocal FORCE = ${force}\nlocal PAYLOAD = ${longString(JSON.stringify({ sequence: seq }))}\n${SEQUENCE_LUAU}${COMMIT_LUAU}`;
}
```

- [ ] **Step 4: Add the `build` branch to `src/anim/tool.ts`**

Add imports:

```ts
import { relative } from 'node:path';
import { runLuau } from '../studio/luau.js';
import { addAsset, loadManifest, saveManifest } from '../assets/manifest.js';
import { previewSampleTimes, verifyPlayback } from './animation-tool.js';
import { animDir, loadChecked } from './store.js';
import { buildProgram, commitProgram, type BuildReply } from './studio.js';
import { writeRbxm } from './rbxm.js';
```

Before the final `return err(... not implemented ...)`:

```ts
  if (a.action === 'build') {
    if (typeof a.name !== 'string' || !ANIM_NAME.test(a.name)) return err('build needs name (the animation\'s name from check)', 'no name');
    const stored = loadChecked(P, a.name);
    if (!stored) return err(`no checked animation ${a.name}: run animate check first`, 'not checked');
    if (stored.failing.length) return err(`${a.name} has failing checks (${stored.failing.join(', ')}): fix them or waive the ones you mean, then check again`, 'failing');
    const seq = stored.sequence;
    const play = await runLuau(ctx.session, buildProgram(seq, previewSampleTimes(seq)), 'edit', { chunkName: 'animateBuild', timeoutMs: 120_000 });
    if (!play.ok) return err(`build failed in Studio: ${play.error?.message}`, 'studio error');
    const reply = JSON.parse(String(play.values[0])) as BuildReply;
    if (!reply.ok) return err(`build failed in Studio: ${reply.error}`, 'studio error');
    const v = verifyPlayback(seq, reply.samples);
    if (!v.verified) return err(`not written: ${v.reason}${v.worst ? ` (worst: ${v.worst.part} at ${v.worst.time}s)` : ''}`, 'mismatch');
    const commit = await runLuau(ctx.session, commitProgram(seq, a.force === true), 'edit', { chunkName: 'animateCommit', timeoutMs: 60_000 });
    if (!commit.ok) return err(`write failed in Studio: ${commit.error?.message}`, 'studio error');
    const c = JSON.parse(String(commit.values[0])) as BuildReply;
    if (!c.ok) return err(`${c.error}; rebuild with force:true to replace it${c.code === 'edited' ? ' (discards the Studio edits)' : ''}`, c.code ?? 'refused');
    const dir = animDir(P, seq.name);
    const rb = await writeRbxm(dir, seq);
    if ('error' in rb) return err(`built in Studio (ServerStorage.BloxAnimations.${seq.name}) but ${rb.error}`, 'rbxm failed');
    const file = relative(P, rb.file).replace(/\\/g, '/');
    const m = loadManifest(P);
    const existing = m.assets.find((x) => x.id === seq.name);
    if (existing) {
      existing.ref = { ...existing.ref, file };
      if (existing.status === 'approved') existing.status = 'candidate';
      saveManifest(P, m);
    } else {
      const added = addAsset(P, { id: seq.name, kind: 'animation', source: 'generated', licence: 'owned', ref: { file }, provenance: { tool: 'blox animate', createdAt: new Date().toISOString() } });
      if (!added.ok) return err(`built, but not recorded in assets.json: ${added.errors.join('; ')}`, 'not recorded');
    }
    return {
      text: `${seq.name}: played on a stock ${seq.rig} dummy within ${v.maxDegrees}° / ${v.maxStuds} studs of the checked motion (${v.samples} samples); written to ServerStorage.BloxAnimations.${seq.name} and ${file}, recorded as candidate "${seq.name}".\nNext: a human runs \`blox asset approve ${seq.name}\`, then asset {action:"upload", id:"${seq.name}", confirm:true}, then animate {action:"wire", slot, asset:<uploaded id>}.`,
      summary: 'built',
    };
  }
```

- [ ] **Step 5: Run the tests, typecheck**

Run: `npx vitest run tests/anim.build.test.ts tests/anim.tool.test.ts && npx tsc --noEmit`
Expected: PASS; clean. If `addAsset` rejects `source: 'generated'` or `licence: 'owned'` for kind animation, use the exact values `model animate` uses (`src/tools/registry.ts`, the `animate` branch of the `model` tool) — they are the same here.

- [ ] **Step 6: Commit**

```bash
git add src/anim/studio.ts src/anim/tool.ts tests/anim.build.test.ts
git commit -m "animate build: verified Studio build, rebuild guard, rbxm + asset candidate"
```

---

### Task 6: `wire` — loader + slot table, then sync

**Files:**
- Create: `src/anim/wire.ts`
- Modify: `src/anim/tool.ts` (add the `wire` branch)
- Test: `tests/anim.wire.test.ts`

**Interfaces:**
- Consumes: `normalizeAnimationId`, `ANIMATE_SLOTS`, `type AnimateSlot` (Task 1); `runLuau` (edit); `pushProject`, `formatSyncResult` from `src/sync/push.ts`.
- Produces:
  ```ts
  export const LOADER_PATH = 'src/ServerScriptService/BloxCharacterAnimate.server.luau';
  export const SLOTS_PATH = 'src/ReplicatedStorage/BloxAnimSlots.luau';
  export const LOADER_SOURCE: string;
  export function readSlots(projectPath: string): { ok: true; slots: Partial<Record<AnimateSlot, string>> } | { ok: false; error: string };
  export function renderSlots(slots: Partial<Record<AnimateSlot, string>>): string;
  export function planWire(projectPath: string, o: { slot: AnimateSlot; asset: unknown; replaces?: unknown }): { ok: true; slots: Partial<Record<AnimateSlot, string>>; writeLoader: boolean } | { ok: false; error: string };
  export function applyWire(projectPath: string, slots: Partial<Record<AnimateSlot, string>>, writeLoader: boolean): void;
  ```

- [ ] **Step 1: Write the failing tests**

`tests/anim.wire.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { applyWire, LOADER_PATH, LOADER_SOURCE, planWire, readSlots, renderSlots, SLOTS_PATH } from '../src/anim/wire.js';

const project = () => mkdtempSync(join(tmpdir(), 'blox-wire-'));
const write = (P: string, rel: string, s: string) => { mkdirSync(dirname(join(P, rel)), { recursive: true }); writeFileSync(join(P, rel), s); };

describe('wire', () => {
  it('first wire writes the loader and the slot table', () => {
    const P = project();
    const p = planWire(P, { slot: 'walk', asset: 507777826 });
    expect(p).toMatchObject({ ok: true, writeLoader: true, slots: { walk: 'rbxassetid://507777826' } });
    if (!p.ok) return;
    applyWire(P, p.slots, p.writeLoader);
    expect(readFileSync(join(P, LOADER_PATH), 'utf8')).toBe(LOADER_SOURCE);
    expect(readSlots(P)).toEqual({ ok: true, slots: { walk: 'rbxassetid://507777826' } });
  });

  it('normalizes every id form and refuses junk', () => {
    const P = project();
    for (const a of ['123', 'rbxassetid://123', 'https://www.roblox.com/asset/?id=123', 123]) expect(planWire(P, { slot: 'run', asset: a })).toMatchObject({ ok: true, slots: { run: 'rbxassetid://123' } });
    for (const a of [0, 'abc', '', -5, 1.5]) expect(planWire(P, { slot: 'run', asset: a }).ok).toBe(false);
  });

  it('replacing a filled slot needs replaces: <current id>', () => {
    const P = project();
    applyWire(P, { walk: 'rbxassetid://1' }, true);
    expect(planWire(P, { slot: 'walk', asset: 2 })).toMatchObject({ ok: false, error: expect.stringMatching(/replaces/) });
    expect(planWire(P, { slot: 'walk', asset: 2, replaces: 9 })).toMatchObject({ ok: false, error: expect.stringMatching(/holds rbxassetid:\/\/1/) });
    expect(planWire(P, { slot: 'walk', asset: 2, replaces: 'rbxassetid://1' })).toMatchObject({ ok: true, writeLoader: false, slots: { walk: 'rbxassetid://2' } });
  });

  it('leaves a hand-edited loader or slot table alone', () => {
    const P = project();
    write(P, LOADER_PATH, LOADER_SOURCE + '\n-- my tweak\n');
    expect(planWire(P, { slot: 'idle', asset: 1 })).toMatchObject({ ok: false, error: expect.stringMatching(/loader.*edited/) });
    const Q = project();
    write(Q, SLOTS_PATH, 'return { walk = "rbxassetid://1" }\n');
    expect(planWire(Q, { slot: 'idle', asset: 1 })).toMatchObject({ ok: false, error: expect.stringMatching(/not generated by blox/) });
  });

  it('renders a parseable, sorted table', () => {
    const s = renderSlots({ walk: 'rbxassetid://2', idle: 'rbxassetid://1' });
    expect(s).toMatch(/^-- GENERATED by blox animate wire/);
    expect(s.indexOf('idle')).toBeLessThan(s.indexOf('walk'));
  });
});
```

Add to `tests/anim.tool.test.ts` (rig check + sync go through Studio):

```ts
describe('animate wire (tool)', () => {
  it('refuses an R6 animation for an R15-only place, and syncs after writing', async () => {
    const calls: string[] = [];
    const session = {
      call: async (name: string, args: Record<string, unknown>) => {
        calls.push(name);
        const code = String(args.code ?? '');
        const v = code.includes('GameSettingsAvatar') ? 'R15' : '{}';
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, n: 1, values: { v1: v }, logs: [] }) }] };
      },
    } as unknown as StudioSession;
    const c = ctx(session);
    const bad = await call({ action: 'wire', slot: 'walk', asset: 1, rig: 'R6' }, c);
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/R15/);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/anim.wire.test.ts`
Expected: FAIL — cannot resolve `../src/anim/wire.js`.

- [ ] **Step 3: Implement `src/anim/wire.ts`**

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ANIMATE_SLOTS, normalizeAnimationId, type AnimateSlot } from './animation-tool.js';

// Wiring is two project files: a fixed loader that never changes and a
// generated slot table. Sync ships both; nothing is written into Studio here.
export const LOADER_PATH = 'src/ServerScriptService/BloxCharacterAnimate.server.luau';
export const SLOTS_PATH = 'src/ReplicatedStorage/BloxAnimSlots.luau';
const HEADER = '-- GENERATED by blox animate wire. Edit with animate {action:"wire"}; hand edits stop blox managing it.';

export const LOADER_SOURCE = `-- Built by blox (animate wire). Sets each character's default Animate script
-- to the animation ids in ReplicatedStorage.BloxAnimSlots, one per slot (idle,
-- walk, run, jump, fall, climb, swim, swimidle, sit). The ids change; this code
-- does not.
local Players = game:GetService("Players")
local slots = require(game:GetService("ReplicatedStorage"):WaitForChild("BloxAnimSlots"))

local function apply(character)
	local animate = character:WaitForChild("Animate", 10)
	if not animate then
		return
	end
	for slot, id in slots do
		local folder = animate:FindFirstChild(slot)
		if folder then
			for _, child in folder:GetChildren() do
				if child:IsA("Animation") then
					child.AnimationId = id
				end
			end
		end
	end
end

local function watch(player)
	player.CharacterAdded:Connect(apply)
	if player.Character then
		task.spawn(apply, player.Character)
	end
end

Players.PlayerAdded:Connect(watch)
for _, player in Players:GetPlayers() do
	watch(player)
end
`;

type Slots = Partial<Record<AnimateSlot, string>>;

export function readSlots(projectPath: string): { ok: true; slots: Slots } | { ok: false; error: string } {
  const f = join(projectPath, SLOTS_PATH);
  if (!existsSync(f)) return { ok: true, slots: {} };
  const text = readFileSync(f, 'utf8');
  if (!text.startsWith(HEADER)) return { ok: false, error: `${SLOTS_PATH} was not generated by blox (or was edited); move your changes out and delete it, then wire again` };
  const slots: Slots = {};
  for (const m of text.matchAll(/^\t(\w+) = "(rbxassetid:\/\/\d+)",$/gm)) {
    if (!(ANIMATE_SLOTS as readonly string[]).includes(m[1])) return { ok: false, error: `${SLOTS_PATH} names an unknown slot ${m[1]}` };
    slots[m[1] as AnimateSlot] = m[2];
  }
  if (renderSlots(slots) !== text) return { ok: false, error: `${SLOTS_PATH} was edited by hand; restore it or delete it, then wire again` };
  return { ok: true, slots };
}

export function renderSlots(slots: Slots): string {
  const lines = ANIMATE_SLOTS.filter((s) => slots[s]).map((s) => `\t${s} = "${slots[s]}",`);
  return `${HEADER}\nreturn {\n${lines.join('\n')}${lines.length ? '\n' : ''}}\n`;
}

export function planWire(projectPath: string, o: { slot: AnimateSlot; asset: unknown; replaces?: unknown }): { ok: true; slots: Slots; writeLoader: boolean } | { ok: false; error: string } {
  const id = normalizeAnimationId(o.asset);
  if (!id) return { ok: false, error: `asset must be an asset id (123, rbxassetid://123 or a roblox.com asset link); got ${JSON.stringify(o.asset)}` };
  const loader = join(projectPath, LOADER_PATH);
  const writeLoader = !existsSync(loader);
  if (!writeLoader && readFileSync(loader, 'utf8') !== LOADER_SOURCE) return { ok: false, error: `${LOADER_PATH} was edited by hand, so blox leaves the loader alone; restore it (delete the file and wire again) to let blox manage slots` };
  const cur = readSlots(projectPath);
  if (!cur.ok) return cur;
  const held = cur.slots[o.slot];
  if (held && held !== id) {
    if (o.replaces === undefined) return { ok: false, error: `slot ${o.slot} holds ${held}; pass replaces:"${held}" to replace it` };
    if (normalizeAnimationId(o.replaces) !== held) return { ok: false, error: `slot ${o.slot} holds ${held}, not ${JSON.stringify(o.replaces)}` };
  }
  return { ok: true, slots: { ...cur.slots, [o.slot]: id }, writeLoader };
}

export function applyWire(projectPath: string, slots: Slots, writeLoader: boolean): void {
  for (const [rel, text] of [[SLOTS_PATH, renderSlots(slots)], ...(writeLoader ? [[LOADER_PATH, LOADER_SOURCE]] : [])] as [string, string][]) {
    const f = join(projectPath, rel);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, text);
  }
}
```

- [ ] **Step 4: Add the `wire` branch to `src/anim/tool.ts`**

Add imports:

```ts
import { pushProject, formatSyncResult } from '../sync/push.js';
import { applyWire, planWire } from './wire.js';
import type { AnimateSlot } from './animation-tool.js';
```

Branch:

```ts
  if (a.action === 'wire') {
    if (typeof a.slot !== 'string') return err(`wire needs slot: ${ANIMATE_SLOTS.join(', ')}`, 'no slot');
    // Which rig the place's players use (Game Settings → Avatar).
    const avatar = await runLuau(ctx.session, 'local ok, v = pcall(function() return game:GetService("StarterPlayer").GameSettingsAvatar.Name end) return ok and v or ""', 'edit', { chunkName: 'avatarType' });
    const placeRig = avatar.ok ? String(avatar.values[0] ?? '') : '';
    const rig = typeof a.rig === 'string' ? a.rig : undefined;
    if (!placeRig && !rig) return err('could not read the place\'s avatar type; pass rig:"R15" or rig:"R6" (the rig the animation was made for)', 'rig unknown');
    if (rig && (placeRig === 'R15' || placeRig === 'R6') && rig !== placeRig) return err(`this place's players are ${placeRig}; an ${rig} animation does not play on them`, 'rig mismatch');
    const plan = planWire(P, { slot: a.slot as AnimateSlot, asset: a.asset, replaces: a.replaces });
    if (!plan.ok) return err(plan.error, 'refused');
    applyWire(P, plan.slots, plan.writeLoader);
    const lines = [`wired ${a.slot} = ${plan.slots[a.slot as AnimateSlot]}${plan.writeLoader ? ' (loader created)' : ''}`];
    if (placeRig === 'PlayerChoice') lines.push(`note: players choose R6 or R15 here; this animation plays only on ${rig ?? 'the rig it was made for'}`);
    const s = await pushProject(ctx.session, P);
    lines.push(formatSyncResult(s));
    lines.push(`Next: animate {action:"verify", name, slot:"${a.slot}"}`);
    return { text: lines.join('\n'), isError: !s.ok, summary: s.ok ? `wired ${a.slot}` : 'sync failed' };
  }
```

The `rig` arg check compares with the animation's rig only when given; when `name` is given too, read `loadChecked(P, a.name)?.sequence.rig` as `rig` if `a.rig` is absent:

```ts
    const rig = typeof a.rig === 'string' ? a.rig : typeof a.name === 'string' && ANIM_NAME.test(a.name) ? loadChecked(P, a.name)?.sequence.rig : undefined;
```

(use this line in place of the `const rig = ...` line above).

- [ ] **Step 5: Run the tests, typecheck**

Run: `npx vitest run tests/anim.wire.test.ts tests/anim.tool.test.ts && npx tsc --noEmit`
Expected: PASS; clean.

- [ ] **Step 6: Commit**

```bash
git add src/anim/wire.ts src/anim/tool.ts tests/anim.wire.test.ts tests/anim.tool.test.ts
git commit -m "animate wire: fixed loader + generated slot table, rig check, sync"
```

---

### Task 7: `verify` — playtest probe on the player's character

**Files:**
- Modify: `src/anim/studio.ts` (add `verifyProgram`)
- Modify: `src/anim/tool.ts` (add the `verify` branch)
- Test: `tests/anim.verify.test.ts`

**Interfaces:**
- Consumes: `loadChecked`, `animDir` (Task 3); `verifyLivePlayback`, `normalizeAnimationId` (Task 1); `readSlots` (Task 6); `withPlay` from `src/studio/play.ts`; `runLuau` (client context — goes through the eval bridge when `bridge.eval` is on, else execute_luau Client).
- Produces:
  ```ts
  export function verifyProgram(seq: KeyframeSequenceDescription | null, animationId: string | null, slot: string | null): string;
  export interface VerifyReply { ok: boolean; error?: string; rigType?: string; length?: number; samples?: { time: number; transforms: Record<string, number[]> }[]; wiredIds?: string[] }
  ```

Deviation from the spec, recorded here: without the eval bridge the probe runs in execute_luau's Client thread directly (it needs no `require`), not through multi_edit injection.

- [ ] **Step 1: Write the failing tests**

`tests/anim.verify.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findTool, invokeTool, type ToolCtx } from '../src/tools/registry.js';
import { BloxConfigSchema } from '../src/config.js';
import { loadRecipes } from '../src/anim/recipes.js';
import { loadChecked } from '../src/anim/store.js';
import { buildTracks, sampleTrack } from '../src/anim/motion.js';
import { rigFor } from '../src/anim/rigs.js';
import { applyWire } from '../src/anim/wire.js';
import type { StudioSession } from '../src/studio/session.js';

const play = vi.hoisted(() => ({ stopped: 0 }));
vi.mock('../src/studio/play.js', async (orig) => ({
  ...(await orig<typeof import('../src/studio/play.js')>()),
  withPlay: async <T,>(_s: unknown, fn: (i: unknown) => Promise<T>) => { try { return await fn({ alreadyRunning: false }); } finally { play.stopped++; } },
}));

const envelope = (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, n: 1, values: { v1: JSON.stringify(v) }, logs: [] }) }] });
function ctx(reply: (code: string) => unknown): ToolCtx {
  const projectPath = mkdtempSync(join(tmpdir(), 'blox-animv-'));
  const session = { evalBridge: false, call: async (_n: string, args: Record<string, unknown>) => { const r = reply(String(args.code)); if (r instanceof Error) throw r; return envelope(r); } } as unknown as StudioSession;
  return { session, projectPath, config: BloxConfigSchema.parse({ projectPath }), agent: 'test' };
}
const call = (args: Record<string, unknown>, c: ToolCtx) => invokeTool(findTool('animate')!, args, c);
function live(c: ToolCtx) {
  const seq = loadChecked(c.projectPath, 'Wave')!.sequence;
  const tracks = buildTracks(seq);
  return [0.1, 0.3, 0.5].map((time) => ({ time, transforms: Object.fromEntries(rigFor('R15').joints.map((j) => { const f = sampleTrack(tracks.get(j.childPart), time); return [j.childPart, [...f.p, ...f.r]]; })) }));
}

describe('animate verify', () => {
  it('needs a prior check', async () => {
    const r = await call({ action: 'verify', name: 'Wave' }, ctx(() => ({})));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/animate check first/);
  });

  it('plays on the character, compares, confirms the slot and writes verify.json', async () => {
    let c!: ToolCtx;
    c = ctx(() => ({ ok: true, rigType: 'R15', length: 1, samples: live(c), wiredIds: ['rbxassetid://55'] }));
    await call({ action: 'check', animation: structuredClone(loadRecipes().get('Wave')!) }, c);
    applyWire(c.projectPath, { idle: 'rbxassetid://55' }, true);
    const r = await call({ action: 'verify', name: 'Wave', slot: 'idle' }, c);
    expect(r.isError, r.text).toBeFalsy();
    expect(r.text).toMatch(/slot idle holds rbxassetid:\/\/55/);
  });

  it('flags a character on the other rig and a slot that does not hold the id', async () => {
    let c!: ToolCtx;
    c = ctx(() => ({ ok: true, rigType: 'R6', length: 1, samples: live(c), wiredIds: ['rbxassetid://1'] }));
    await call({ action: 'check', animation: structuredClone(loadRecipes().get('Wave')!) }, c);
    applyWire(c.projectPath, { idle: 'rbxassetid://55' }, true);
    const r = await call({ action: 'verify', name: 'Wave', slot: 'idle' }, c);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/R6/);
  });

  it('stops play and reports the error when the probe throws', async () => {
    const before = play.stopped;
    const c = ctx((code) => (code.includes('LocalPlayer') ? new Error('probe exploded') : {}));
    await call({ action: 'check', animation: structuredClone(loadRecipes().get('Wave')!) }, c);
    const r = await call({ action: 'verify', name: 'Wave' }, c);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/probe exploded/);
    expect(play.stopped).toBe(before + 1);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/anim.verify.test.ts`
Expected: FAIL — verify returns "not implemented yet".

- [ ] **Step 3: Add `verifyProgram` to `src/anim/studio.ts`**

```ts
export interface VerifyReply {
  ok: boolean;
  error?: string;
  rigType?: string;
  length?: number;
  samples?: { time: number; transforms: Record<string, number[]> }[];
  wiredIds?: string[];
}

// Playtest client: read the character's Animate slot, then play the animation
// (an asset id, or a temporary clip from the compiled sequence) above whatever
// else runs and sample its joints on the Animator's clock.
const VERIFY_LUAU = `local Players = game:GetService("Players")
local function components(c) local o = {} for _, v in { c:GetComponents() } do table.insert(o, r6(v)) end return o end
local player = Players.LocalPlayer
if not player then return HS:JSONEncode({ ok = false, error = "not a playtest client" }) end
local character = player.Character or player.CharacterAdded:Wait()
local hum = character:WaitForChild("Humanoid", 10)
local animator = hum and hum:WaitForChild("Animator", 10)
if not animator then return HS:JSONEncode({ ok = false, error = "the character has no Humanoid with an Animator" }) end
local wired
if P.slot then
	wired = {}
	task.wait(1) -- the loader sets the slot on CharacterAdded
	local folder = character:FindFirstChild("Animate") and character.Animate:FindFirstChild(P.slot)
	for _, c in folder and folder:GetChildren() or {} do if c:IsA("Animation") then table.insert(wired, c.AnimationId) end end
end
local js = {}
for _, d in character:GetDescendants() do
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
	local deadline = os.clock() + 10
	while track.Length == 0 and os.clock() < deadline do task.wait(0.05) end
	if track.Length == 0 then error("the animation never loaded on the character (not owned by this place's owner?)") end
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
if not ok then return HS:JSONEncode({ ok = false, error = tostring(res), rigType = hum.RigType.Name, wiredIds = wired }) end
return HS:JSONEncode({ ok = true, rigType = hum.RigType.Name, length = res.length, samples = res.samples, wiredIds = wired })`;

export function verifyProgram(seq: KeyframeSequenceDescription | null, animationId: string | null, slot: string | null): string {
  return `local PAYLOAD = ${longString(JSON.stringify({ sequence: seq, animationId, slot }))}\n${SEQUENCE_LUAU}${VERIFY_LUAU}`;
}
```

`SEQUENCE_LUAU` starts with `SOURCE_SUM_LUAU` and decodes `PAYLOAD` into `P`, defines `HS`, `buildSequence` and `r6` — all used above.

- [ ] **Step 4: Add the `verify` branch to `src/anim/tool.ts`**

Add imports:

```ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withPlay } from '../studio/play.js';
import { normalizeAnimationId, verifyLivePlayback } from './animation-tool.js';
import { readSlots } from './wire.js';
import { verifyProgram, type VerifyReply } from './studio.js';
```

Branch:

```ts
  if (a.action === 'verify') {
    if (typeof a.name !== 'string' || !ANIM_NAME.test(a.name)) return err('verify needs name (the animation\'s name from check)', 'no name');
    const stored = loadChecked(P, a.name);
    if (!stored) return err(`no checked animation ${a.name}: run animate check first`, 'not checked');
    const seq = stored.sequence;
    const slot = typeof a.slot === 'string' ? (a.slot as AnimateSlot) : null;
    const slots = readSlots(P);
    const expectedId = a.asset !== undefined ? normalizeAnimationId(a.asset) : slot && slots.ok ? slots.slots[slot] : undefined;
    if (a.asset !== undefined && !expectedId) return err(`asset must be an asset id; got ${JSON.stringify(a.asset)}`, 'bad asset');
    let reply: VerifyReply;
    try {
      reply = await withPlay(ctx.session, async () => {
        const r = await runLuau(ctx.session, verifyProgram(expectedId ? null : seq, expectedId ?? null, slot), 'client', { chunkName: 'animateVerify', timeoutMs: 90_000 });
        if (!r.ok) throw new Error(r.error?.message ?? 'probe failed');
        return JSON.parse(String(r.values[0])) as VerifyReply;
      });
    } catch (e) {
      return err(`verify failed: ${(e as Error).message}`, 'probe failed');
    }
    const problems: string[] = [];
    if (reply.rigType && reply.rigType !== seq.rig) problems.push(`the player's character is ${reply.rigType}; ${seq.name} is an ${seq.rig} animation`);
    if (!reply.ok) problems.push(reply.error ?? 'the probe failed');
    const check = reply.ok ? verifyLivePlayback(seq, reply.samples) : null;
    if (check && !check.verified) problems.push(check.reason ?? 'played differently from the checked motion');
    const lines = [`${seq.name} on the player's character${expectedId ? ` (${expectedId})` : ' (temporary clip)'}: ${check ? `${check.verified ? '✓' : '✗'} within ${check.maxDegrees}° / ${check.maxStuds} studs over ${check.samples} samples` : '✗ not played'}`];
    if (slot) {
      const holds = reply.wiredIds ?? [];
      const okSlot = !!expectedId && holds.length > 0 && holds.every((x) => normalizeAnimationId(x) === expectedId);
      lines.push(`${okSlot ? '✓' : '✗'} slot ${slot} holds ${holds.join(', ') || '(nothing)'}${okSlot ? '' : `; expected ${expectedId ?? '(nothing wired: animate wire first)'}`}`);
      if (!okSlot) problems.push(`slot ${slot} is not wired to ${expectedId ?? 'an id'}`);
    }
    lines.push(...problems.map((p) => `  ${p}`));
    writeFileSync(join(animDir(P, seq.name), 'verify.json'), JSON.stringify({ at: new Date().toISOString(), slot, expectedId, reply: { ...reply, samples: reply.samples?.length }, check, problems }, null, 2));
    return { text: lines.join('\n'), isError: problems.length > 0, summary: problems.length ? 'verify failed' : 'verified' };
  }
```

- [ ] **Step 5: Run the tests, typecheck**

Run: `npx vitest run tests/anim. && npx tsc --noEmit`
Expected: PASS; clean.

- [ ] **Step 6: Commit**

```bash
git add src/anim/studio.ts src/anim/tool.ts tests/anim.verify.test.ts
git commit -m "animate verify: playtest probe on the player's character + slot readback"
```

---

### Task 8: CLI mapping, agent guide, full suite

**Files:**
- Modify: `src/cliTools.ts` (add `case 'animate'` to `cliArgs`, add `'animate'` to `TOOL_COMMANDS`, add HELP lines)
- Modify: `src/agentGuide.ts` (one line)
- Test: `tests/anim.tool.test.ts` (CLI mapping case)

**Interfaces:**
- Consumes: `cliArgs`, `parseFlags` from `src/cliTools.ts`.
- Produces: `blox animate recipes [name] | check <file.json> [--locomotion] [--grounded] [--waive a,b] | build <name> [--force] | wire <slot> <asset> [--replaces id] [--rig R15|R6] | verify <name> [--slot s] [--asset id]`.

- [ ] **Step 1: Write the failing test** (append to `tests/anim.tool.test.ts`)

```ts
import { cliArgs, parseFlags } from '../src/cliTools.js';
import { writeFileSync as wf } from 'node:fs';

describe('animate cli', () => {
  it('maps subcommands', () => {
    expect(cliArgs('animate', parseFlags(['recipes', 'Walk']))).toEqual({ tool: 'animate', args: { action: 'recipes', name: 'Walk' } });
    expect(cliArgs('animate', parseFlags(['build', 'Walk', '--force']))).toEqual({ tool: 'animate', args: { action: 'build', name: 'Walk', force: true } });
    expect(cliArgs('animate', parseFlags(['wire', 'walk', '123', '--replaces', '9']))).toEqual({ tool: 'animate', args: { action: 'wire', slot: 'walk', asset: '123', replaces: '9' } });
    expect(cliArgs('animate', parseFlags(['verify', 'Walk', '--slot', 'walk']))).toEqual({ tool: 'animate', args: { action: 'verify', name: 'Walk', slot: 'walk' } });
  });
  it('check reads the description from a JSON file', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'blox-animcli-')), 'walk.json');
    wf(f, JSON.stringify({ name: 'Walk', rig: 'R15' }));
    expect(cliArgs('animate', parseFlags(['check', f, '--locomotion', '--waive', 'groundContact,footSliding']))).toEqual({ tool: 'animate', args: { action: 'check', animation: { name: 'Walk', rig: 'R15' }, locomotion: true, waive: ['groundContact', 'footSliding'] } });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/anim.tool.test.ts -t "animate cli"`
Expected: FAIL — `cliArgs` has no `animate` case.

- [ ] **Step 3: Implement the CLI case**

In `src/cliTools.ts`, inside `cliArgs`'s switch, next to `case 'model'` (read that case first and match its variable names `f`, `o`):

```ts
    case 'animate': {
      const action = f.rest[0] ?? 'recipes';
      const flag = (k: string) => (o[k] === true ? { [k]: true } : {});
      const str = (k: string) => (typeof o[k] === 'string' ? { [k]: o[k] as string } : {});
      switch (action) {
        case 'recipes':
          return { tool: 'animate', args: { action, ...(f.rest[1] ? { name: f.rest[1] } : {}) } };
        case 'check': {
          const file = f.rest[1];
          if (!file) throw new Error('usage: blox animate check <description.json> [--locomotion] [--grounded] [--waive id,id]');
          return { tool: 'animate', args: { action, animation: JSON.parse(readFileSync(file, 'utf8')), ...flag('locomotion'), ...flag('grounded'), ...(typeof o.waive === 'string' ? { waive: o.waive.split(',').map((x) => x.trim()).filter(Boolean) } : {}) } };
        }
        case 'build':
          return { tool: 'animate', args: { action, name: f.rest[1], ...flag('force') } };
        case 'wire':
          return { tool: 'animate', args: { action, slot: f.rest[1], asset: f.rest[2], ...str('replaces'), ...str('rig') } };
        case 'verify':
          return { tool: 'animate', args: { action, name: f.rest[1], ...str('slot'), ...str('asset') } };
        default:
          throw new Error(`unknown animate action ${action}`);
      }
    }
```

`readFileSync` is already imported in `src/cliTools.ts`. Add `'animate'` to `TOOL_COMMANDS`. Add to HELP, after the `model` lines:

```
           blox animate recipes [name] | check <desc.json> [--locomotion] [--grounded] [--waive ids]
                        build <name> [--force] | wire <slot> <asset> [--replaces id] [--rig R15|R6] | verify <name> [--slot s] [--asset id]
```

If `parseFlags` treats a bare `--locomotion` as `true`, the mapping above works; if it stores `'true'`, compare with `o[k] === true || o[k] === 'true'` in `flag`.

- [ ] **Step 4: Agent guide line**

In `src/agentGuide.ts`, after the custom-models paragraph (the line ending `rigged ones: model animate → upload → BloxAnimate.`), add:

```
Player-character animation (R15/R6): animate recipes → check (look at the sheet) → build →
human approves → asset upload → animate wire {slot, asset} → verify. Guide: skill character-animation.
```

- [ ] **Step 5: Full suite and typecheck**

Run: `npx tsc --noEmit && npx vitest run`
Expected: clean; all pass (previous 915 + new anim tests). Fix any guide-size or tool-list snapshot test by updating its expectation to include the new line/tool.

- [ ] **Step 6: Commit**

```bash
git add src/cliTools.ts src/agentGuide.ts tests/
git commit -m "animate: CLI mapping + agent guide line"
```

---

### Task 9: Live smoke in Studio (`~/blox-fw`) and PR

No code unless a smoke exposes a bug (then: failing test first, fix, re-run). Studio must have `~/blox-fw` open (`node ~/blox/dist/cli.js status` shows `attached`). Build first: `npm run build`.

- [ ] **Step 1: R15 walk** — in `~/blox-fw`: `node ~/blox/dist/cli.js animate recipes Walk > /tmp/walk.json` (strip to the JSON), `animate check /tmp/walk.json --locomotion --grounded`, then `animate build Walk`. Expected: checks pass; build reports within 1.5°/0.05 studs; `ServerStorage.BloxAnimations.Walk` exists (`blox luau 'return game.ServerStorage.BloxAnimations.Walk.ClassName'` → `KeyframeSequence`); `.blox/anims/Walk/anim_Walk.rbxm` exists. If `RegisterAnimationClip` or `StepAnimations` errors from the MCP thread, record the exact error and stop to report — that is a design-level finding.
- [ ] **Step 2: R6 wave** — same with `WaveR6`. Expected: built.
- [ ] **Step 3: Broken description** — copy walk.json, set a knee (`RightKnee` or the R15 hinge joint name used in the recipe) to bend 170° backwards in one keyframe; `check` → `jointLimits` fails; `build` → refused naming the failing check.
- [ ] **Step 4: Rebuild guard** — `blox luau 'game.ServerStorage.BloxAnimations.Walk:GetChildren()[1].Time = 0.01'`; `animate build Walk` → refused "edited in Studio"; `animate build Walk --force` → rebuilt.
- [ ] **Step 5: Avatar type read** — `blox luau 'return game:GetService("StarterPlayer").GameSettingsAvatar.Name'`. Record the result. If it errors, `wire` must be called with `--rig`; confirm the error message says so.
- [ ] **Step 6: Wire + verify with Roblox's default R15 walk** — `animate wire walk 507777826 --rig R15` (syncs), then `animate verify Walk --slot walk --asset 507777826`. Expected: slot readback ✓ (`rbxassetid://507777826`). The playback comparison against our Walk will fail (different motion) — that is expected for this id; it proves the probe, the loader and the readback. Then `animate verify Walk` (no asset: temporary clip on the client). Expected: ✓ within 2°/0.05 studs. If client `RegisterAnimationClip` is refused in the playtest thread, record it; `verify` then requires an uploaded id — report to the user.
- [ ] **Step 7: Clean up the test place** — delete `src/ServerScriptService/BloxCharacterAnimate.server.luau`, `src/ReplicatedStorage/BloxAnimSlots.luau`, `.blox/anims/`, the assets.json entries added (`Walk`, `WaveR6`), sync; `blox luau 'game.ServerStorage.BloxAnimations:Destroy()'` only if the folder holds nothing but these tests' sequences (check first with `GetChildren`).
- [ ] **Step 8: Optional real upload** — only if the user approves in chat: `blox asset approve Walk`, `asset upload Walk --confirm`, `animate wire walk <id> --rig R15`, `animate verify Walk --slot walk`. Expected: all ✓.
- [ ] **Step 9: PR** — `npx tsc --noEmit && npx vitest run` green; push branch `feat/r15-character-animation`; `gh pr create` with summary, test counts, live-smoke results (including anything that did not run); then squash-merge, delete branch, sync main (repo rule: merge right after creating the PR).
