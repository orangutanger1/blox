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
  if (verb && object) add(`${cap(verb)} ${/^[aeiou]/i.test(object) ? 'An' : 'A'} ${titleCase(object)}`);
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
  if (d.economy.offline && income) lines.push(`💤 Your ${gens ? 'collection earns' : 'progress keeps earning'} ${cap(income)} even while OFFLINE!`);
  if (d.economy.rebirth) lines.push(`♻️ Rebirth for a permanent x${d.economy.rebirth.mult.per} boost!`);
  if (d.meta.serverSize && d.meta.serverSize > 1) lines.push(`👥 Play with up to ${d.meta.serverSize} friends per server!`);
  lines.push('🎮 Supports Desktop, Console, Mobile, and Tablet');
  return lines.join('\n').slice(0, 1000);
}

// Five thumbnails with different themes and framings around a subject at the
// spawn, plus a tight icon shot. Positions assume the spawn near the origin
// facing -Z (kits); adjust per game.
export function defaultShots(d: DesignDoc): Shot[] {
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
