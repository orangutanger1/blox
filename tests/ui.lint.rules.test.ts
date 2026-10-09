import { describe, expect, it } from 'vitest';
import { DEVICES, lintResults, lintSnapshot, type UiElement } from '../src/ui/lint.js';

const device = DEVICES.find((d) => d.name === 'desktop')!;
const el = (path: string, x: number, y: number, w: number, h: number, extra: Partial<UiElement> = {}): UiElement => ({ path, cls: 'Frame', x, y, w, h, button: false, ...extra });
const rules = (els: UiElement[]) => lintSnapshot({ device, elements: els }).map((f) => `${f.rule}:${f.path}`);

describe('off-centre', () => {
  const parent = el('HUD.Panel', 100, 100, 400, 200);
  it('flags a child a few px off its parent centre', () => {
    expect(rules([parent, el('HUD.Panel.Title', 203, 150, 200, 40)])).toContain('off-centre:HUD.Panel.Title');
  });
  it('allows half a pixel, and clearly off-centre layouts', () => {
    expect(rules([parent, el('HUD.Panel.Title', 200.5, 150, 200, 40)])).toEqual([]);
    expect(rules([parent, el('HUD.Panel.Left', 110, 110, 100, 40)])).toEqual([]);
  });
  it('ignores the depth stack shadow and face', () => {
    expect(rules([parent, el('HUD.Panel.Shadow', 100, 104, 400, 200), el('HUD.Panel.Shadow.Face', 100, 100, 400, 200)])).toEqual([]);
  });
});

describe('touching', () => {
  const b = (path: string, x: number) => el(path, x, 300, 100, 50, { button: true });
  it('flags sibling buttons less than 2 px apart', () => {
    expect(rules([b('HUD.Bar.A', 100), b('HUD.Bar.B', 201)])).toContain('touching:HUD.Bar.B');
  });
  it('allows a real gap, and nested buttons', () => {
    expect(rules([b('HUD.Bar.A', 100), b('HUD.Bar.B', 206)])).toEqual([]);
    expect(rules([b('HUD.Bar.A', 100), b('HUD.Other.B', 201)])).toEqual([]);
  });
});

describe('pill', () => {
  const btn = (w: number, h: number, cr: number) => el('HUD.Buy', 500, 500, w, h, { button: true, cr });
  it('flags a wide button rounded to half its height', () => {
    expect(rules([btn(200, 50, 25)])).toContain('pill:HUD.Buy');
  });
  it('allows circles and square-ish corners', () => {
    expect(rules([btn(50, 50, 25)])).toEqual([]);
    expect(rules([btn(200, 50, 8)])).toEqual([]);
  });
});

it('results include the new rules as warnings only', () => {
  const ids = lintResults(lintSnapshot({ device, elements: [el('HUD.Buy', 500, 500, 200, 50, { button: true, cr: 25 })] }));
  expect(ids.map((r) => r.id)).toEqual(expect.arrayContaining(['ui:off-centre', 'ui:touching', 'ui:pill']));
  expect(ids.every((r) => r.ok)).toBe(true);
});

it('off-centre skips rotated elements (pieces of a drawn icon are placed by eye)', () => {
  const parent = el('HUD.Btn', 100, 100, 48, 48);
  expect(rules([parent, el('HUD.Btn.Blade', 101, 106, 40, 40, { rot: 35 })])).toEqual([]);
  expect(rules([parent, el('HUD.Btn.Blade', 101, 106, 40, 40)])).toContain('off-centre:HUD.Btn.Blade');
});

it('off-centre skips the axis a list layout places the element along', () => {
  const parent = el('HUD.List', 100, 100, 400, 400);
  expect(rules([parent, el('HUD.List.Row', 100, 297, 400, 10, { listed: 'y' })])).toEqual([]);
  expect(rules([parent, el('HUD.List.Row', 103, 297, 394, 10, { listed: 'y' })])).toEqual([]);
  expect(rules([parent, el('HUD.List.Row', 97, 0, 400, 10, { listed: 'y' })])).toContain('off-centre:HUD.List.Row');
});
