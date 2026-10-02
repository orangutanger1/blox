import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MetricResult } from '../metrics/gamefeel.js';
import { imageSize } from './image.js';
import type { Presentation } from './schema.js';

// Store-page policy + quality lint. Text rules follow Roblox's metadata rules
// (9+ rating, no "Roblox" in titles, no off-platform links, no scams) and the
// research report's findings; shot rules enforce five distinct, truthful,
// correctly-shaped thumbnails and a 64 px-readable icon.

export type PresentRule =
  | 'title-length' | 'title-roblox' | 'title-tags' | 'title-caps'
  | 'desc-length' | 'desc-links' | 'scam' | 'claims' | 'engagement-bait' | 'emoji-spam' | 'mature'
  | 'thumb-count' | 'thumb-variety' | 'thumb-rendered' | 'thumb-aspect' | 'thumb-duplicate' | 'icon';
export const PRESENT_RULES: PresentRule[] = [
  'title-length', 'title-roblox', 'title-tags', 'title-caps',
  'desc-length', 'desc-links', 'scam', 'claims', 'engagement-bait', 'emoji-spam', 'mature',
  'thumb-count', 'thumb-variety', 'thumb-rendered', 'thumb-aspect', 'thumb-duplicate', 'icon',
];
export interface PresentFinding {
  rule: PresentRule;
  severity: 'error' | 'warn';
  where: string;
  detail: string;
}

const EMOJI = /\p{Extended_Pictographic}/gu;
const TEXT_RULES: { rule: PresentRule; severity: 'error' | 'warn'; re: RegExp; why: string }[] = [
  { rule: 'desc-links', severity: 'error', re: /https?:\/\/|www\.|discord\.(gg|com\/invite)|\b[a-z0-9-]+\.(com|net|org|gg|io)\b/i, why: 'off-platform links are not allowed in descriptions (use the experience social links)' },
  { rule: 'scam', severity: 'error', re: /free\s*robux|robux\s*generator|\bhacks?\b|\bexploits?\b/i, why: 'scam/exploit wording violates Roblox policy' },
  { rule: 'claims', severity: 'warn', re: /#\s*1\b|number one|\bbest game\b|\bofficial\b/i, why: 'unverifiable superlatives can read as misleading' },
  { rule: 'engagement-bait', severity: 'warn', re: /\b(like|favou?rite|follow|join)\b[^.!\n]{0,40}\bfor\b[^.!\n]{0,20}\bfree\b/i, why: 'rewards for likes/favourites/joins — a human should confirm this is allowed' },
  { rule: 'mature', severity: 'warn', re: /\b(blood|gore|gory|decapitat\w*|dismember\w*|tortur\w*)\b/i, why: 'mature wording — titles/descriptions must stay All Ages/9+' },
];
const MAX_TITLE = 50;
const MAX_DESC = 1000;
const MIN_THUMBS = 5;
const SAME_CAMERA_STUDS = 5;
const ASPECT = 16 / 9;
const ASPECT_TOL = 0.05;

const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export function lintPresentation(doc: Presentation, projectPath: string): PresentFinding[] {
  const out: PresentFinding[] = [];
  const add = (rule: PresentRule, severity: PresentFinding['severity'], where: string, detail: string) => out.push({ rule, severity, where, detail });
  const t = doc.title;
  if (t.length > MAX_TITLE || !t.trim()) add('title-length', 'error', 'title', `${t.length} chars (1–${MAX_TITLE})`);
  if (/roblox/i.test(t)) add('title-roblox', 'error', 'title', 'titles must not contain "Roblox"');
  const tags = (t.match(/[[(][^\])]*[\])]/g) ?? []).length;
  const emoji = (t.match(EMOJI) ?? []).length;
  if (tags > 1 || emoji > 2) add('title-tags', 'error', 'title', `${tags} tag(s), ${emoji} emoji — use at most one tag slot (rotate it per update)`);
  const letters = t.replace(/[^A-Za-z]/g, '');
  if (letters.length > 8 && letters.replace(/[^A-Z]/g, '').length / letters.length > 0.6) add('title-caps', 'error', 'title', 'mostly capitals reads as shouting/spam');
  const d = doc.description;
  if (d.length > MAX_DESC) add('desc-length', 'error', 'description', `${d.length} chars (max ${MAX_DESC})`);
  for (const r of TEXT_RULES) {
    const m = r.re.exec(`${t}\n${d}`);
    if (m) add(r.rule, r.severity, 'title/description', `"${m[0]}" — ${r.why}`);
  }
  if ((d.match(EMOJI) ?? []).length > 15) add('emoji-spam', 'warn', 'description', `${(d.match(EMOJI) ?? []).length} emoji (keep it <= 15)`);

  const thumbs = doc.shots.filter((s) => s.kind === 'thumbnail');
  if (!thumbs.length) add('thumb-count', 'error', 'shots', 'no thumbnails');
  else if (thumbs.length < MIN_THUMBS) add('thumb-count', 'warn', 'shots', `${thumbs.length} thumbnail(s); personalization tests up to ${MIN_THUMBS} distinct variants`);
  thumbs.forEach((s, i) => {
    const twin = thumbs.slice(0, i).find((o) => o.theme === s.theme && dist(o.camera.position, s.camera.position) < SAME_CAMERA_STUDS);
    if (twin) add('thumb-variety', 'error', s.id, `same theme "${s.theme}" and framing as ${twin.id} — variants must differ (action vs exploration vs character…)`);
  });
  const hashes = new Map<string, string>();
  for (const s of thumbs) {
    const file = s.file ? join(projectPath, s.file) : null;
    if (!file || !existsSync(file)) {
      add('thumb-rendered', 'error', s.id, 'not rendered yet — present {action:"render"}');
      continue;
    }
    if (s.provenance === 'generated' || !s.provenance)
      add('thumb-rendered', 'error', s.id, `provenance "${s.provenance ?? 'unknown'}": thumbnails must show the real game (render) or be human-approved`);
    const buf = readFileSync(file);
    const size = imageSize(buf);
    if (!size) add('thumb-aspect', 'error', s.id, 'unreadable image header');
    else if (Math.abs(size.w / size.h - ASPECT) / ASPECT > ASPECT_TOL)
      add('thumb-aspect', 'error', s.id, `${size.w}×${size.h} is not 16:9 — size the Studio viewport 16:9 before rendering (ideal 1920×1080)`);
    const h = createHash('sha256').update(buf).digest('hex');
    const dup = hashes.get(h);
    if (dup) add('thumb-duplicate', 'error', s.id, `identical image to ${dup}`);
    else hashes.set(h, s.id);
  }
  const icons = doc.shots.filter((s) => s.kind === 'icon');
  if (icons.length !== 1) add('icon', 'error', 'shots', `${icons.length} icon shots (need exactly 1)`);
  else {
    const text = icons[0].overlay?.text ?? '';
    if (text.length > 12 || text.split(/\s+/).filter(Boolean).length > 2) add('icon', 'error', icons[0].id, `icon text "${text}" will not read at 64 px (<= 12 chars, <= 2 words)`);
  }
  return out;
}

export function presentResults(findings: PresentFinding[]): MetricResult[] {
  return PRESENT_RULES.map((rule) => {
    const errs = findings.filter((f) => f.rule === rule && f.severity === 'error');
    const warns = findings.filter((f) => f.rule === rule && f.severity === 'warn').length;
    return { id: `present:${rule}`, ok: errs.length === 0, actual: errs.length, detail: errs.length ? `${errs[0].where}: ${errs[0].detail}` : warns ? `${warns} warning(s)` : 'ok' };
  });
}

export function formatPresentLint(findings: PresentFinding[], results: MetricResult[]): string {
  const pass = results.filter((r) => r.ok).length;
  const lines = [`present lint: ${pass}/${results.length} rules pass`];
  for (const f of findings) lines.push(`  ${f.severity === 'error' ? 'ERROR' : 'WARN '} ${f.rule} [${f.where}] ${f.detail}`);
  return lines.join('\n');
}
