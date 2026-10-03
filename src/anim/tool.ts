import { z } from 'zod';
import type { ToolCtx, ToolOutput } from '../tools/registry.js';
import { compactChecks, prepareAnimation, MOTION_CHECK_IDS, ANIMATE_SLOTS } from './animation-tool.js';
import { renderContactSheet } from './contact-sheet.js';
import { rigFor } from './rigs.js';
import { loadRecipes } from './recipes.js';
import { ANIM_NAME, saveChecked } from './store.js';
import { relative } from 'node:path';
import { runLuau } from '../studio/luau.js';
import { addAsset, loadManifest, saveManifest } from '../assets/manifest.js';
import { previewSampleTimes, verifyPlayback } from './animation-tool.js';
import { animDir, loadChecked } from './store.js';
import { buildProgram, commitProgram, type BuildReply } from './studio.js';
import { writeRbxm } from './rbxm.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withPlay } from '../studio/play.js';
import { normalizeAnimationId, verifyLivePlayback } from './animation-tool.js';
import { readSlots } from './wire.js';
import { verifyProgram, type VerifyReply } from './studio.js';
import { pushProject, formatSyncResult } from '../sync/push.js';
import { applyWire, planWire } from './wire.js';
import type { AnimateSlot } from './animation-tool.js';

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
  if (a.action === 'wire') {
    if (typeof a.slot !== 'string') return err(`wire needs slot: ${ANIMATE_SLOTS.join(', ')}`, 'no slot');
    // Which rig the place's players use (Game Settings → Avatar).
    const avatar = await runLuau(ctx.session, 'local ok, v = pcall(function() return game:GetService("StarterPlayer").GameSettingsAvatar.Name end) return ok and v or ""', 'edit', { chunkName: 'avatarType' });
    const placeRig = avatar.ok ? String(avatar.values[0] ?? '') : '';
    const rig = typeof a.rig === 'string' ? a.rig : typeof a.name === 'string' && ANIM_NAME.test(a.name) ? loadChecked(P, a.name)?.sequence.rig : undefined;
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
  return err(`unknown action ${String(a.action)}: recipes, check, build, wire or verify`, 'unknown action');
}
