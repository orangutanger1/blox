import type { MetricResult } from '../metrics/gamefeel.js';

// Deterministic UI lint: geometry rules over GUI snapshots taken at emulated
// device sizes (see probe.ts). No vision; every finding names a GUI path.

export interface Device {
  name: string;
  kind: 'phone' | 'tablet' | 'desktop';
  w: number;
  h: number;
  safe: { top: number; left: number; right: number; bottom: number }; // notch / home indicator
}

// Logical pixel sizes as Roblox's device emulator reports them.
export const TOPBAR = 58;
export const DEVICES: Device[] = [
  { name: 'phone-landscape', kind: 'phone', w: 844, h: 390, safe: { top: 0, left: 47, right: 47, bottom: 21 } },
  { name: 'phone-portrait', kind: 'phone', w: 390, h: 844, safe: { top: 47, left: 0, right: 0, bottom: 34 } },
  { name: 'tablet', kind: 'tablet', w: 1024, h: 768, safe: { top: 0, left: 0, right: 0, bottom: 20 } },
  { name: 'desktop', kind: 'desktop', w: 1920, h: 1080, safe: { top: 0, left: 0, right: 0, bottom: 0 } },
];

export interface UiElement {
  path: string; // ScreenGui.Child.… in the player's GUI
  cls: string;
  x: number; // relative to the device's top-left
  y: number;
  w: number;
  h: number;
  button: boolean;
  text?: string;
  textScaled?: boolean;
  textFits?: boolean;
  textHeight?: number; // TextBounds.Y
  clipped?: boolean; // partly hidden by a ClipsDescendants ancestor (e.g. a scrolled list)
  listed?: 'x' | 'y' | 'xy'; // axis a parent UIListLayout/UIGridLayout places it along
  cr?: number; // buttons: corner radius in px (its UICorner, else its depth-stack Shadow's)
  rot?: number; // Rotation in degrees when not 0 (icon pieces drawn from bars)
  surface?: boolean; // something visible is drawn: a background, text, an image or a 3D viewport
  layer?: number; // its ScreenGui's DisplayOrder when not 0 (a modal drawn over the HUD)
}
export interface UiSnapshot {
  device: Device;
  elements: UiElement[];
}
export type UiRule = 'offscreen' | 'safe-area' | 'touch-target' | 'overlap' | 'covered' | 'outside' | 'text-overflow' | 'text-tiny' | 'off-centre' | 'touching' | 'pill';
export const UI_RULES: UiRule[] = ['offscreen', 'safe-area', 'touch-target', 'overlap', 'covered', 'outside', 'text-overflow', 'text-tiny', 'off-centre', 'touching', 'pill'];
export interface UiFinding {
  rule: UiRule;
  severity: 'error' | 'warn';
  device: string;
  path: string;
  detail: string;
}
export interface UiReport {
  ranAt: string;
  devices: string[];
  elements: Record<string, number>;
  findings: UiFinding[];
  results: MetricResult[];
  notes: string[];
}

const TOL = 1; // px of rounding slack
const MIN_TOUCH = { phone: 44, tablet: 44, desktop: 24 };
const MIN_TEXT_PX = 9;
const OVERLAP_FRACTION = 0.25;
const r = (n: number) => Math.round(n);
// Centred-looking but not centred: within NEAR px of the parent's centre, more than CENTRE_TOL off it.
const CENTRE_TOL = 1.5;
const CENTRE_NEAR = 6;
const TOUCH_GAP = 2; // sibling buttons closer than this look stuck together
const DEPTH_PART = /(^|\.)(Shadow|Face|Lift)(\.|$)/; // BloxUI depth stack internals sit offset on purpose
const parentPath = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf('.')));

function intersect(a: UiElement, b: UiElement): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

export function lintSnapshot(s: UiSnapshot): UiFinding[] {
  const d = s.device;
  const out: UiFinding[] = [];
  const add = (rule: UiRule, severity: UiFinding['severity'], e: UiElement, detail: string) => out.push({ rule, severity, device: d.name, path: e.path, detail });
  const buttons: UiElement[] = [];
  for (const e of s.elements) {
    if (e.w <= 0 || e.h <= 0) {
      // a label squeezed out by its row (Size (1, -N) with N > the row's width)
      if (e.text) add('text-overflow', 'error', e, `"${e.text.slice(0, 30)}" has no room: ${r(e.w)}×${r(e.h)}px`);
      else if (e.surface) add('outside', 'error', e, `${e.cls} has no room: ${r(e.w)}×${r(e.h)}px`);
      continue;
    }
    if (e.clipped) continue; // scrolled partly out of view: judged when scrolled in
    const off = e.x < -TOL || e.y < -TOL || e.x + e.w > d.w + TOL || e.y + e.h > d.h + TOL;
    if (off) add('offscreen', e.button ? 'error' : 'warn', e, `${e.cls} at (${r(e.x)},${r(e.y)}) ${r(e.w)}×${r(e.h)} leaves the ${d.w}×${d.h} screen`);
    if (e.button) {
      buttons.push(e);
      if (!off) {
        const top = Math.max(TOPBAR, d.safe.top);
        const unsafe =
          e.y < top - TOL ? `under the ${top}px top bar` :
          e.x < d.safe.left - TOL ? `in the left ${d.safe.left}px unsafe inset` :
          e.x + e.w > d.w - d.safe.right + TOL ? `in the right ${d.safe.right}px unsafe inset` :
          e.y + e.h > d.h - d.safe.bottom + TOL ? `in the bottom ${d.safe.bottom}px unsafe inset` : null;
        if (unsafe) add('safe-area', 'error', e, `button ${unsafe}`);
      }
      const min = MIN_TOUCH[d.kind];
      if (Math.min(e.w, e.h) < min - TOL) add('touch-target', 'error', e, `button ${r(e.w)}×${r(e.h)}px, needs >= ${min}px`);
    }
    if (e.text) {
      if (e.textFits === false && !e.textScaled) add('text-overflow', 'error', e, `"${e.text.slice(0, 30)}" does not fit ${r(e.w)}×${r(e.h)}px (TextFits=false)`);
      if (d.kind === 'phone' && e.textHeight !== undefined && e.textHeight > 0 && e.textHeight < MIN_TEXT_PX)
        add('text-tiny', 'warn', e, `text renders ${r(e.textHeight)}px tall (< ${MIN_TEXT_PX}px)`);
    }
  }
  for (let i = 0; i < buttons.length; i++)
    for (let j = 0; j < i; j++) {
      const a = buttons[j];
      const b = buttons[i];
      if (a.path.startsWith(b.path + '.') || b.path.startsWith(a.path + '.')) continue;
      const area = intersect(a, b);
      if (area > OVERLAP_FRACTION * Math.min(a.w * a.h, b.w * b.h)) add('overlap', 'error', b, `overlaps ${a.path} (${r((100 * area) / Math.min(a.w * a.h, b.w * b.h))}% of the smaller)`);
      else if (area === 0 && parentPath(a.path) === parentPath(b.path)) {
        const gx = Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w);
        const gy = Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h);
        const gap = gx >= 0 && gy < 0 ? gx : gy >= 0 && gx < 0 ? gy : null; // side by side or stacked
        if (gap !== null && gap < TOUCH_GAP) add('touching', 'warn', b, `${r(gap)}px from ${a.path} — leave a visible gap`);
      }
    }
  // covered: visible surfaces of two different widgets (ScreenGui.Child) on the same layer drawn over each other
  const widget = (p: string) => p.split('.').slice(0, 2).join('.');
  const surfaces = s.elements.filter((e) => e.surface && e.w > 0 && e.h > 0 && !e.clipped);
  const coveredSeen = new Set<string>();
  for (let i = 0; i < surfaces.length; i++)
    for (let j = 0; j < i; j++) {
      const a = surfaces[j];
      const b = surfaces[i];
      if ((a.layer ?? 0) !== (b.layer ?? 0) || widget(a.path) === widget(b.path) || coveredSeen.has(b.path)) continue;
      const area = intersect(a, b);
      if (area > OVERLAP_FRACTION * Math.min(a.w * a.h, b.w * b.h)) {
        coveredSeen.add(b.path);
        add('covered', 'error', b, `drawn over ${a.path} (${r((100 * area) / Math.min(a.w * a.h, b.w * b.h))}% of the smaller)`);
      }
    }
  // outside: a visible element mostly outside its parent element (a Size (1, -N) offset gone negative)
  const parents = new Map(s.elements.map((e) => [e.path, e]));
  for (const e of surfaces) {
    const p = parents.get(parentPath(e.path));
    if (!p || p.w <= 0 || p.h <= 0) continue;
    const inside = intersect(e, p);
    if (inside < (1 - OVERLAP_FRACTION) * e.w * e.h) add('outside', 'error', e, `${r((100 * (e.w * e.h - inside)) / (e.w * e.h))}% outside ${p.path}`);
  }
  for (const b of buttons) {
    if (b.cr !== undefined && b.cr >= b.h / 2 - 1 && b.w >= 1.3 * b.h) add('pill', 'warn', b, `pill-shaped (radius ${r(b.cr)}px on ${r(b.w)}×${r(b.h)}) — use square-ish corners (BloxUI Theme.radius)`);
  }
  const byPath = new Map(s.elements.map((e) => [e.path, e]));
  for (const e of s.elements) {
    if (DEPTH_PART.test(e.path) || e.w <= 0 || e.h <= 0 || e.rot) continue;
    const p = byPath.get(parentPath(e.path));
    if (!p) continue;
    const dx = Math.abs(e.x + e.w / 2 - (p.x + p.w / 2));
    const dy = Math.abs(e.y + e.h / 2 - (p.y + p.h / 2));
    const nearX = !e.listed?.includes('x') && dx > CENTRE_TOL && dx < CENTRE_NEAR;
    const nearY = !e.listed?.includes('y') && dy > CENTRE_TOL && dy < CENTRE_NEAR;
    const off = [nearX ? `${dx.toFixed(1)}px across` : '', nearY ? `${dy.toFixed(1)}px down` : ''].filter(Boolean);
    if (off.length) add('off-centre', 'warn', e, `nearly centred in ${p.path} but ${off.join(' and ')} off`);
  }
  return out;
}

export function lintResults(findings: UiFinding[]): MetricResult[] {
  return UI_RULES.map((rule) => {
    const errs = findings.filter((f) => f.rule === rule && f.severity === 'error');
    const warns = findings.filter((f) => f.rule === rule && f.severity === 'warn').length;
    return {
      id: `ui:${rule}`,
      ok: errs.length === 0,
      actual: errs.length,
      detail: errs.length ? `${errs.length} error(s), e.g. [${errs[0].device}] ${errs[0].path}: ${errs[0].detail}` : `clean${warns ? ` (${warns} warning(s))` : ''}`,
    };
  });
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function formatUiReport(rep: UiReport, maxFindings = 25): string {
  const pass = rep.results.filter((x) => x.ok).length;
  const errs = rep.findings.filter((f) => f.severity === 'error');
  const warns = rep.findings.filter((f) => f.severity === 'warn');
  const lines = [`ui lint (${rep.devices.join(', ')}): ${pass}/${rep.results.length} rules pass, ${plural(errs.length, 'error')}, ${plural(warns.length, 'warning')}`];
  for (const x of rep.results) lines.push(`  ${x.ok ? '✓' : '✗'} ${x.id}  ${x.detail}`);
  for (const f of [...errs, ...warns].slice(0, maxFindings)) lines.push(`  ${f.severity === 'error' ? 'ERROR' : 'WARN '} ${f.rule} [${f.device}] ${f.path}: ${f.detail}`);
  if (errs.length + warns.length > maxFindings) lines.push(`  … ${errs.length + warns.length - maxFindings} more in .blox/ui-report.json`);
  for (const n of rep.notes) lines.push(`  note: ${n}`);
  return lines.join('\n');
}
