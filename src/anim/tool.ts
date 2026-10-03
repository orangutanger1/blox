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
