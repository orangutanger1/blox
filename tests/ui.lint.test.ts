import { describe, it, expect } from 'vitest';
import { DEVICES, lintSnapshot, lintResults, formatUiReport, type UiElement, type UiSnapshot } from '../src/ui/lint.js';

const phone = DEVICES.find((d) => d.name === 'phone-landscape')!;
const desktop = DEVICES.find((d) => d.name === 'desktop')!;
const el = (o: Partial<UiElement>): UiElement => ({ path: 'HUD.X', cls: 'Frame', x: 100, y: 100, w: 60, h: 60, button: false, ...o });
const snap = (elements: UiElement[], device = phone): UiSnapshot => ({ device, elements });
const rules = (s: UiSnapshot) => lintSnapshot(s).map((f) => `${f.rule}:${f.severity}:${f.path}`);

describe('lintSnapshot', () => {
  it('a well-placed button is clean', () => {
    expect(rules(snap([el({ button: true, cls: 'TextButton' })]))).toEqual([]);
  });
  it('offscreen: error for buttons, warn for others', () => {
    expect(rules(snap([el({ path: 'A', button: true, x: 820 }), el({ path: 'B', x: -30 })]))).toEqual(['offscreen:error:A', 'offscreen:warn:B']);
  });
  it('safe-area: buttons under the topbar or in the notch', () => {
    expect(rules(snap([el({ path: 'Top', button: true, y: 10 }), el({ path: 'Notch', button: true, x: 5, y: 150 })]))).toEqual(['safe-area:error:Top', 'safe-area:error:Notch']);
    expect(rules(snap([el({ path: 'Frame', y: 10 })]))).toEqual([]); // decoration may sit there
  });
  it('touch-target: 44 px on phones, 24 px on desktop', () => {
    expect(rules(snap([el({ path: 'S', button: true, w: 40, h: 60 })]))).toEqual(['touch-target:error:S']);
    expect(rules(snap([el({ path: 'S', button: true, w: 30, h: 30 })], desktop))).toEqual([]);
    expect(rules(snap([el({ path: 'S', button: true, w: 20, h: 30 })], desktop))).toEqual(['touch-target:error:S']);
  });
  it('overlap: buttons overlapping more than 25% of the smaller, not ancestors', () => {
    const a = el({ path: 'HUD.A', button: true });
    expect(rules(snap([a, el({ path: 'HUD.B', button: true, x: 110, y: 110 })]))).toEqual(['overlap:error:HUD.B']);
    expect(rules(snap([a, el({ path: 'HUD.C', button: true, x: 150, y: 150 })]))).toEqual([]); // 10x10 of 60x60
    expect(rules(snap([a, el({ path: 'HUD.A.Inner', button: true, x: 110, y: 110 })]))).toEqual([]);
  });
  it('text-overflow and text-tiny', () => {
    expect(rules(snap([el({ path: 'T', cls: 'TextLabel', text: 'long', textFits: false })]))).toEqual(['text-overflow:error:T']);
    expect(rules(snap([el({ path: 'T', cls: 'TextLabel', text: 'ok', textFits: false, textScaled: true, textHeight: 12 })]))).toEqual([]);
    expect(rules(snap([el({ path: 'T', cls: 'TextLabel', text: 'tiny', textScaled: true, textHeight: 6 })]))).toEqual(['text-tiny:warn:T']);
    expect(rules(snap([el({ path: 'T', cls: 'TextLabel', text: '', textFits: false })]))).toEqual([]);
  });
});

describe('lintResults + format', () => {
  it('one synthetic result per rule, failing only on errors', () => {
    const findings = [
      ...lintSnapshot(snap([el({ path: 'S', button: true, w: 30, h: 60 }), el({ path: 'B', x: -30 })])),
    ];
    const r = lintResults(findings);
    expect(r.find((x) => x.id === 'ui:touch-target')).toMatchObject({ ok: false, actual: 1 });
    expect(r.find((x) => x.id === 'ui:offscreen')).toMatchObject({ ok: true }); // warn only
    expect(r.map((x) => x.id)).toEqual(['ui:offscreen', 'ui:safe-area', 'ui:touch-target', 'ui:overlap', 'ui:text-overflow', 'ui:text-tiny']);
    const text = formatUiReport({ ranAt: 'x', devices: ['phone-landscape'], elements: { 'phone-landscape': 2 }, findings, results: r, notes: [] });
    expect(text).toMatch(/^ui lint \(phone-landscape\): 5\/6 rules pass, 1 error, 1 warning/);
    expect(text).toMatch(/ERROR touch-target \[phone-landscape\] S/);
  });
});
