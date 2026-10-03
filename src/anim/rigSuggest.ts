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
