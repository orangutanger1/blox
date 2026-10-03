import { z } from 'zod';
import type { ToolCtx, ToolOutput } from '../tools/registry.js';
import { compactChecks, prepareAnimation, MOTION_CHECK_IDS, ANIMATE_SLOTS } from './animation-tool.js';
import { renderContactSheet } from './contact-sheet.js';
import { rigFor } from './rigs.js';
import { loadRecipes } from './recipes.js';
import { ANIM_NAME, clearRigReading, loadReport, loadRigReading, saveChecked, saveRigReading } from './store.js';
import { RIGS } from './rigs.js';
import { MODEL_LOADER_PATH, MODEL_TAG, NPC_NAME, npcProgram, planModelLoader, readWired, saveWired, wireModelProgram, writeModelLoader } from './npc.js';
import { LOADER_PACE, MAX_GROUND_SPEED, judgeMovement, type ModelState } from './animation-tool.js';
import { relative } from 'node:path';
import { runLuau } from '../studio/luau.js';
import { addAsset, loadManifest, saveManifest } from '../assets/manifest.js';
import { previewSampleTimes, verifyPlayback } from './animation-tool.js';
import { animDir, loadChecked } from './store.js';
import { buildProgram, commitProgram, type BuildReply } from './studio.js';
import { writeRbxm } from './rbxm.js';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withPlay } from '../studio/play.js';
import { normalizeAnimationId, verifyLivePlayback } from './animation-tool.js';
import { readSlots } from './wire.js';
import { verifyProgram, verifyModelProgram, type VerifyReply, type VerifyModelReply } from './studio.js';
import { pushProject, formatSyncResult } from '../sync/push.js';
import { BODY_PLANS, mergeDeclarations, planDeclarations } from './body-plans.js';
import { MODEL_STATES, describeRig } from './animation-tool.js';
import { rigFromModel } from './model-rig.js';
import { readRig, declareProgram, skippedChecks, parseReply, modelPath, rigForSequence } from './modelRig.js';
import { applyWire, planWire } from './wire.js';
import type { AnimateSlot } from './animation-tool.js';

export const ANIMATE_DESCRIPTION =
  'Character, NPC and model animation (guide: skill {name:"character-animation"}). recipes {name?} (tested starting points) | check {animation, locomotion?, grounded?, waive?} (compile + 7 motion checks + contact sheet image, offline; writes .blox/anims/<name>/) | build {name, force?} (plays it on a stock dummy in Studio, compares with the checked motion, writes ServerStorage.BloxAnimations.<name> + anim_<name>.rbxm, records an animation candidate; a human approves before asset upload) | wire {slot, asset, rig | name, replaces?} (sets an Animate slot for every player via src/ReplicatedStorage/BloxAnimSlots.luau + a fixed loader, then syncs; rig, or the checked animation name, says which rig the slot is for) | verify {name, slot?, asset?} (playtest: plays on the player\'s character, compares with the checked motion, confirms the slot) | rig {model} (read a Part+Motor6D model\'s rig: joints, what checks cannot judge) | declare {model, plan:"quadruped" | declarations} (write its BloxRig: feet, knees, ranges) | npc {name, rig:R15|R6, at:[x,y,z], parent?} (stock NPC body + the BloxModelAnimate loader) | wire {model, state:idle|walk|run, name, asset, force?} (sets the model\'s loader attributes) | verify {model, name?, target?} (playtest server: playback + walks it and checks idle/walk and pace). check takes animation.rig = a model path for a model\'s own rig.';

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

// A model's path in the DataModel (a leading game. is allowed).
const MODEL_PATH = /^(game\.)?[A-Za-z_][\w ]*(\.[\w ]+)+$/;

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
    let rig = RIGS.get(String(spec.rig));
    let notes: string[] = [];
    let animation = spec;
    if (!rig && (typeof spec.rig !== 'string' || !MODEL_PATH.test(spec.rig))) return err(`animation.rig must be R15, R6, or a model path such as Workspace.Dog; got ${JSON.stringify(spec.rig)}`, 'bad rig');
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
    const p = prepareAnimation(animation, { locomotion: a.locomotion, grounded: a.grounded, waive: a.waive }, rig && !RIGS.has(rig.name) ? rig : undefined);
    if (!p.ok) {
      rmSync(join(animDir(P, spec.name), 'sequence.json'), { force: true }); // build only what the last check accepted
      return err(`does not compile:\n${p.errors.map((e) => `  ${e}`).join('\n')}`, `${p.errors.length} errors`);
    }
    const { sequence, report, failing, waived } = p.value;
    const options = { locomotion: a.locomotion === true, grounded: a.grounded === true };
    const sheet = renderContactSheet(sequence, undefined, { locomotion: options.locomotion, rig: rig ?? rigFor(sequence.rig) });
    saveChecked(P, { spec: animation, sequence, options, failing, waived }, report, sheet.png);
    const lines = [`${sequence.name} (${sequence.rig}, ${sequence.duration}s${sequence.loop ? ', loop' : ''}, ${sequence.keyframes.length} keyframes):`];
    for (const c of compactChecks(report)) lines.push(`  ${c.status === 'pass' ? '✓' : c.status === 'fail' ? '✗' : '·'} ${c.id} ${c.status}  ${c.detail}${c.measured ? ` ${JSON.stringify(c.measured)}` : ''}`);
    if (waived.length) lines.push(`waived: ${waived.join(', ')}`);
    if (rig && !RIGS.has(rig.name)) lines.push(...notes.map((n) => `note: ${n}`), ...skippedChecks(rig), 'note: the sheet draws each part as its box');
    lines.push(`sheet: columns at ${sheet.times.map((t, i) => `${t.toFixed(2)}s${sheet.labels[i] ? ` (${sheet.labels[i]})` : ''}`).join(', ')}`);
    lines.push(failing.length ? `failing: ${failing.join(', ')} — fix the description, or waive a failure you mean (e.g. groundContact on a jump), then check again` : `Next: animate {action:"build", name:"${sequence.name}"}`);
    return { text: lines.join('\n'), images: [{ data: sheet.png.toString('base64'), mimeType: 'image/png' }], summary: failing.length ? `${failing.length} failing` : 'checks pass' };
  }
  if (a.action === 'build') {
    if (typeof a.name !== 'string' || !ANIM_NAME.test(a.name)) return err('build needs name (the animation\'s name from check)', 'no name');
    const stored = loadChecked(P, a.name);
    if (!stored) return err(`no checked animation ${a.name}: run animate check first`, 'not checked');
    if (stored.failing.length) return err(`${a.name} has failing checks (${stored.failing.join(', ')}): fix them or waive the ones you mean, then check again`, 'failing');
    const seq = stored.sequence;
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
    const play = await runLuau(ctx.session, buildProgram(seq, previewSampleTimes(seq), model), 'edit', { chunkName: 'animateBuild', timeoutMs: 120_000 });
    if (!play.ok) return err(`build failed in Studio: ${play.error?.message}`, 'studio error');
    const pr = parseReply(play.values, 'build');
    if (!pr.ok) return err(pr.error, 'studio error');
    const reply = pr.value as unknown as BuildReply;
    if (!reply.ok) return err(`build failed in Studio: ${reply.error}`, 'studio error');
    const v = verifyPlayback(seq, reply.samples, rig);
    if (!v.verified) return err(`not written: ${v.reason}${v.worst ? ` (worst: ${v.worst.part} at ${v.worst.time}s)` : ''}`, 'mismatch');
    const commit = await runLuau(ctx.session, commitProgram(seq, a.force === true), 'edit', { chunkName: 'animateCommit', timeoutMs: 60_000 });
    if (!commit.ok) return err(`write failed in Studio: ${commit.error?.message}`, 'studio error');
    const pc = parseReply(commit.values, 'commit');
    if (!pc.ok) return err(pc.error, 'studio error');
    const c = pc.value as unknown as BuildReply;
    if (!c.ok) return err(`${c.error}; rebuild with force:true to replace it${c.code === 'edited' ? ' (discards the Studio edits)' : ''}`, c.code ?? 'refused');
    const taken = loadManifest(P).assets.find((x) => x.id === seq.name && x.kind !== 'animation');
    if (taken) return err(`asset id ${seq.name} is already a ${taken.kind} in .blox/assets.json; rename the animation (its name is the asset id)`, 'id taken');
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
      text: `${seq.name}: played on ${model ? `a copy of ${model.path}` : `a stock ${seq.rig} dummy`} within ${v.maxDegrees}° / ${v.maxStuds} studs of the checked motion (${v.samples} samples); written to ServerStorage.BloxAnimations.${seq.name} and ${file}, recorded as candidate "${seq.name}".\nNext: a human runs \`blox asset approve ${seq.name}\`, then asset {action:"upload", id:"${seq.name}", confirm:true}, then animate {action:"wire", ${model ? `model:"${model.path}", state, name:"${seq.name}"` : 'slot'}, asset:<uploaded id>}.`,
      summary: 'built',
    };
  }
  if (a.action === 'wire') {
    if (typeof a.model === 'string') {
      if (a.slot !== undefined) return err('wire takes slot (a player character) or model + state (an NPC or model), not both', 'ambiguous');
      return wireModel(a, ctx);
    }
    if (typeof a.slot !== 'string') return err(`wire needs slot: ${ANIMATE_SLOTS.join(', ')}`, 'no slot');
    // The place's avatar type (StarterPlayer.GameSettingsAvatar) is not readable
    // from Studio's edit thread, so the rig comes from the caller or the checked
    // animation; a character on the other rig shows up at verify.
    const checkedRig = typeof a.name === 'string' && ANIM_NAME.test(a.name) ? loadChecked(P, a.name)?.sequence.rig : undefined;
    const rig = typeof a.rig === 'string' ? a.rig : checkedRig;
    if (!rig) return err('wire needs rig:"R15" or rig:"R6", or name (a checked animation) to know which rig the slot is for', 'rig unknown');
    if (checkedRig && rig !== checkedRig) return err(`${String(a.name)} is an ${checkedRig} animation, not ${rig}`, 'rig mismatch');
    if (rig !== 'R15' && rig !== 'R6') return err('wire with slot takes rig:"R15" or rig:"R6"', 'bad rig');
    const plan = planWire(P, { slot: a.slot as AnimateSlot, asset: a.asset, replaces: a.replaces });
    if (!plan.ok) return err(plan.error, 'refused');
    applyWire(P, plan.slots, plan.writeLoader);
    const lines = [`wired ${a.slot} = ${plan.slots[a.slot as AnimateSlot]}${plan.writeLoader ? ' (loader created)' : ''}`];
    lines.push(`note: an ${rig} animation plays only on ${rig} characters (Game Settings → Avatar)`);
    const s = await pushProject(ctx.session, P);
    lines.push(formatSyncResult(s));
    lines.push(`Next: animate {action:"verify", name, slot:"${a.slot}"}`);
    return { text: lines.join('\n'), isError: !s.ok, summary: s.ok ? `wired ${a.slot}` : 'sync failed' };
  }
  if (a.action === 'verify') {
    if (typeof a.model === 'string') return verifyModel(a, ctx);
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
        const v = r.values[0];
        return (typeof v === 'string' ? JSON.parse(v) : v) as VerifyReply;
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
      lines.push(`wrote ${MODEL_LOADER_PATH}`);
      if (!(await syncLoader(ctx, lines))) return { text: lines.join('\n'), isError: true, summary: 'sync failed' };
    }
    lines.push(`Next: wire its idle and walk: animate {action:"wire", model:"${String(p.value.path)}", state:"walk", name, asset} (an ${a.rig} animation, checked with locomotion:true)`);
    return { text: lines.join('\n'), summary: 'npc made' };
  }
  return err(`unknown action ${String(a.action)}: recipes, check, build, wire, verify, rig, declare or npc`, 'unknown action');
}

// Push the loader file; the Studio change before it stands either way, so a
// failed sync is reported in lines, not thrown.
async function syncLoader(ctx: ToolCtx, lines: string[]): Promise<boolean> {
  try {
    const s = await pushProject(ctx.session, ctx.projectPath);
    lines.push(formatSyncResult(s));
    return s.ok;
  } catch (e) {
    lines.push(`sync failed: ${(e as Error).message}; run blox sync to push the loader`);
    return false;
  }
}

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
    if (typeof gs !== 'number' || gs <= 0) {
      // Ground speed is measured from planted feet: a model rig needs them declared.
      const noFeet = !RIGS.has(seq.rig) && (loadRigReading(P, seq.name) ? (() => { try { return rigForSequence(P, seq).feet.length === 0; } catch { return false; } })() : false);
      if (noFeet) return err(`${seq.name} has no ground speed: ${seq.rig} has no feet declared, so none can be measured; animate {action:"declare", model:"${seq.rig}", plan:"quadruped"} (or declarations.feet), then check it again with locomotion:true`, 'no ground speed');
      return err(`${seq.name} has no ground speed: check it with locomotion:true so the loader can pace its feet`, 'no ground speed');
    }
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
  const r = await runLuau(ctx.session, wireModelProgram({ path, state, id, speed, allowed: [...new Set([prior, ...Object.values(wired).map((w) => w[state])].filter((x): x is string => typeof x === 'string'))], force: a.force === true, rigType: stock }), 'edit', { chunkName: 'animateWireModel', timeoutMs: 60_000 });
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
    lines.push(`wrote ${MODEL_LOADER_PATH}`);
    const s = await syncLoader(ctx, lines);
    if (!s) return { text: lines.join('\n'), isError: true, summary: 'sync failed' };
  }
  lines.push(`Next: animate {action:"verify", model:"${at}", name:"${seq.name}"}`);
  return { text: lines.join('\n'), summary: `wired ${state}` };
}
const round2 = (n: number) => Math.round(n * 100) / 100;

async function verifyModel(a: Record<string, unknown>, ctx: ToolCtx): Promise<ToolOutput> {
  const P = ctx.projectPath;
  const path = modelPath(a.model as string);
  const stored = typeof a.name === 'string' && ANIM_NAME.test(a.name) ? loadChecked(P, a.name) : null;
  if (typeof a.name === 'string' && !stored) return err(`no checked animation ${a.name}: run animate check first`, 'not checked');
  if (a.slot !== undefined) return err('slot is for the player\'s character (verify {name, slot}); a model\'s states are its wired attributes', 'ambiguous');
  // asset: play the uploaded id against the checked motion; otherwise the
  // checked motion plays as a temporary clip. Either way the wired ids are
  // verified by watching the loader play them below.
  const playId = a.asset !== undefined ? normalizeAnimationId(a.asset) ?? null : null;
  if (a.asset !== undefined && !playId) return err(`asset must be an asset id; got ${JSON.stringify(a.asset)}`, 'bad asset');
  if (playId && !stored) return err('verify with asset needs name (the checked animation to compare it with)', 'no name');
  // The rig the checked motion is compared on, and (for a model rig) that this
  // model is still that rig: both settled before a playtest starts.
  let rig: ReturnType<typeof rigForSequence> | null = null;
  if (stored) {
    try {
      rig = rigForSequence(P, stored.sequence);
    } catch (e) {
      return err((e as Error).message, 'not checked');
    }
    if (!RIGS.has(stored.sequence.rig)) {
      const saved = loadRigReading(P, stored.sequence.name);
      const now = await readRig(ctx.session, path);
      if (!now.ok) return err(now.error, now.code ?? 'refused');
      if (now.reading.revision !== saved?.revision) return err(`${now.reading.path} is not the rig ${stored.sequence.name} was checked on (${stored.sequence.rig}); check the animation on this model`, 'rig mismatch');
    }
  }
  const loader = planModelLoader(P);
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
  if (stored && reply.rigType && RIGS.has(stored.sequence.rig) && reply.rigType !== stored.sequence.rig) problems.push(`${path} is ${reply.rigType}; ${stored.sequence.name} is an ${stored.sequence.rig} animation`);
  if (stored && rig && reply.ok) {
    const check = verifyLivePlayback(stored.sequence, reply.samples, rig);
    lines.push(`${check.verified ? '✓' : '✗'} ${stored.sequence.name} on ${path}${playId ? ` (${playId})` : ' (temporary clip)'} within ${check.maxDegrees}° / ${check.maxStuds} studs over ${check.samples} samples`);
    if (!check.verified) problems.push(check.reason ?? 'played differently from the checked motion');
  }
  if (reply.ok && reply.skipped) lines.push(`· ${reply.skipped}`);
  if (reply.ok && !stored && !reply.observation) problems.push(`nothing was verified: ${reply.skipped ?? 'no playback and no movement'}`);
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
