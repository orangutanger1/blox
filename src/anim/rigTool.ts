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
    if (!fit.ok) return err(`rig refused for ${reading.path}; nothing was changed:\n${list(fit.errors)}`, 'fit failed');
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
  if (!planned.ok) return err(`rig refused for ${reading.path}; nothing was changed (${planned.errorCode}):\n${list(planned.errors)}`, planned.errorCode);

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
