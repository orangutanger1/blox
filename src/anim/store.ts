import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelRigReading } from './model-rig.js';
import type { KeyframeSequenceDescription } from './pose-compiler.js';
import type { MotionCheckId, MotionReport } from './motion-checks.js';

// One animation's working files: .blox/anims/<name>/.
export const ANIM_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export function animDir(projectPath: string, name: string): string {
  if (!ANIM_NAME.test(name)) throw new Error(`bad animation name "${name}": letters, digits, _ and -, starting with a letter (max 64)`);
  return join(projectPath, '.blox', 'anims', name);
}

export interface StoredAnim {
  spec: Record<string, unknown>;
  sequence: KeyframeSequenceDescription;
  options: { locomotion: boolean; grounded: boolean };
  failing: MotionCheckId[];
  waived: MotionCheckId[];
}

export function saveChecked(projectPath: string, a: StoredAnim, report: MotionReport, sheetPng: Buffer): string {
  const dir = animDir(projectPath, a.sequence.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'spec.json'), JSON.stringify(a.spec, null, 2));
  writeFileSync(join(dir, 'sequence.json'), JSON.stringify({ sequence: a.sequence, options: a.options, failing: a.failing, waived: a.waived }));
  writeFileSync(join(dir, 'report.json'), JSON.stringify({ checkedAt: new Date().toISOString(), ...report, failing: a.failing, waived: a.waived }, null, 2));
  writeFileSync(join(dir, 'sheet.png'), sheetPng);
  return dir;
}

export function loadChecked(projectPath: string, name: string): StoredAnim | null {
  const dir = animDir(projectPath, name);
  const f = join(dir, 'sequence.json');
  if (!existsSync(f)) return null;
  const s = JSON.parse(readFileSync(f, 'utf8')) as Omit<StoredAnim, 'spec'>;
  return { ...s, spec: JSON.parse(readFileSync(join(dir, 'spec.json'), 'utf8')) as Record<string, unknown> };
}


// A model rig's reading as check saw it: build and wire compare its revision.
export function saveRigReading(projectPath: string, name: string, reading: ModelRigReading): void {
  const dir = animDir(projectPath, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'rig.json'), JSON.stringify(reading, null, 2));
}

export function loadRigReading(projectPath: string, name: string): ModelRigReading | null {
  const f = join(animDir(projectPath, name), 'rig.json');
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as ModelRigReading) : null;
}

export function clearRigReading(projectPath: string, name: string): void {
  rmSync(join(animDir(projectPath, name), 'rig.json'), { force: true });
}

export function loadReport(projectPath: string, name: string): { groundSpeed?: number } | null {
  const f = join(animDir(projectPath, name), 'report.json');
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as { groundSpeed?: number }) : null;
}
