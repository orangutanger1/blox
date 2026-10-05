import type { DesignDoc } from '../design/schema.js';
import type { POSES, Shot } from './schema.js';

// Deterministic drafts of store copy and shots from design.json. The agent
// edits them; a human picks the final title and art.

const MAX_TITLE = 50;
const cap = (w: string) => (w ? w[0].toUpperCase() + w.slice(1) : w);
const titleCase = (s: string) => s.split(/\s+/).filter(Boolean).map(cap).join(' ');

export function titleCandidates(d: DesignDoc): string[] {
  const out: string[] = [];
  const add = (t: string) => {
    const s = t.trim().slice(0, MAX_TITLE).trim();
    if (s && !out.includes(s)) out.push(s);
  };
  const { verb, object } = d.meta;
  // "Steal A Brainrot" works for things; a stat or the verb itself gives "Jump A Jump".
  const isStat = (w: string) => d.economy.resources.some((r) => r.id.toLowerCase() === w.toLowerCase());
  if (verb && object && object.toLowerCase() !== verb.toLowerCase() && !isStat(object))
    add(`${cap(verb)} ${/^[aeiou]/i.test(object) ? 'An' : 'A'} ${titleCase(object)}`);
  if (d.meta.format === 'incremental') {
    const stat = d.economy.resources.find((r) => !r.spendable)?.id;
    if (stat && object && object.toLowerCase() !== stat.toLowerCase()) add(`+1 ${cap(stat)} ${titleCase(object)}`);
  }
  add(d.meta.title);
  return out;
}

const BULLETS = ['🏃', '💥', '🥚', '💰', '⬆️', '🔓', '🏆', '⚡', '🎁'];

export function describe(d: DesignDoc): string {
  const lines = [`⭐ Welcome to ${d.meta.title}!`, 'How to Play:'];
  d.loop.slice(0, 9).forEach((step, i) => lines.push(`${BULLETS[i % BULLETS.length]} ${cap(step)}`));
  const gens = d.economy.generators.length ? d.economy.generators : null;
  const income = d.economy.resources.find((r) => r.spendable)?.id;
  // Only claim offline earning when it exists: a fraction and a cap above 0, and
  // a generator that produces the currency (offline accrual is generators only).
  const off = d.economy.offline;
  const earnsOffline = !!income && !!off && off.fraction > 0 && off.capSec > 0 && !!gens?.some((g) => (g.produces[income] ?? 0) > 0);
  if (earnsOffline) lines.push(`💤 Your collection earns ${cap(income!)} even while OFFLINE!`);
  const rb = d.economy.rebirth;
  if (rb) lines.push(`♻️ Rebirth for a permanent x${rb.mult.per} ${rb.mult.target === '*' ? '' : `${cap(rb.mult.target)} `}boost!`);
  if (d.meta.serverSize && d.meta.serverSize > 1) lines.push(`👥 Play with up to ${d.meta.serverSize} friends per server!`);
  lines.push('🎮 Supports Desktop, Console, Mobile, and Tablet');
  return lines.join('\n').slice(0, 1000);
}

// Five thumbnails with different themes and framings around a subject at the
// spawn, plus a tight icon shot. Positions are relative to `origin` (the top of
// the spawn; the tool passes the place's SpawnLocation) facing -Z; adjust per game.
export function defaultShots(d: DesignDoc, origin: [number, number, number] = [0, 0, 0]): Shot[] {
  const at = (v: [number, number, number]): [number, number, number] => [v[0] + origin[0], v[1] + origin[1], v[2] + origin[2]];
  return relShots(d).map((s) => ({ ...s, camera: { position: at(s.camera.position), lookAt: at(s.camera.lookAt) }, ...(s.subject ? { subject: { ...s.subject, at: at(s.subject.at) } } : {}) }));
}

function relShots(d: DesignDoc): Shot[] {
  const verb = (d.meta.verb ?? 'Play').toUpperCase();
  const subject = (pose: (typeof POSES)[number], yaw = 180) => ({ at: [0, 3, -12] as [number, number, number], yaw, pose });
  return [
    { id: 'action', kind: 'thumbnail', theme: 'action', camera: { position: [7, 5, -2], lookAt: [0, 3, -12] }, subject: subject('punch'), overlay: { text: `${verb}!`, color: '#FFD23F' } },
    { id: 'explore', kind: 'thumbnail', theme: 'exploration', camera: { position: [0, 30, 25], lookAt: [0, 0, -60] }, subject: subject('run'), overlay: { text: 'NEW AREAS', color: '#4FC3F7' } },
    { id: 'hero', kind: 'thumbnail', theme: 'character', camera: { position: [0, 4.5, -3], lookAt: [0, 3.5, -12] }, subject: subject('cheer'), overlay: { text: 'YOU', color: '#FF4F4F' } },
    { id: 'reward', kind: 'thumbnail', theme: 'reward', camera: { position: [-6, 4, -4], lookAt: [0, 3, -12] }, subject: subject('carry', 150), overlay: { text: 'MYTHIC', sub: '1 in 500', color: '#C77DFF' } },
    { id: 'social', kind: 'thumbnail', theme: 'social', camera: { position: [12, 9, 6], lookAt: [0, 2, -12] }, subject: subject('point', 210), overlay: { text: 'PLAY WITH FRIENDS', color: '#7CFC00' } },
    { id: 'icon', kind: 'icon', theme: 'logo', camera: { position: [0, 4, -6.5], lookAt: [0, 3.6, -12] }, subject: subject('cheer'), overlay: { text: verb.slice(0, 12), color: '#FFD23F' } },
  ];
}
