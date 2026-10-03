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
