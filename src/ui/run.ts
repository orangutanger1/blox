import type { StudioSession } from '../studio/session.js';
import { runLuau } from '../studio/luau.js';
import { startPlay, stopPlay } from '../studio/play.js';
import { DEVICES, lintResults, lintSnapshot, type Device, type UiFinding, type UiReport } from './lint.js';
import { parseProbe, uiProbeProgram } from './probe.js';

export interface UiLintOptions {
  seconds: number;
  prepare?: string; // client Luau run before the snapshot (open a menu, …)
  devices?: string[];
  sleep?: (ms: number) => Promise<void>;
}

export function pickDevices(names?: string[]): Device[] {
  if (!names?.length) return DEVICES;
  return names.map((n) => {
    const d = DEVICES.find((x) => x.name === n);
    if (!d) throw new Error(`unknown device "${n}" — one of ${DEVICES.map((x) => x.name).join(', ')}`);
    return d;
  });
}

export async function runUiLint(session: StudioSession, o: UiLintOptions): Promise<UiReport> {
  const devices = pickDevices(o.devices);
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const notes: string[] = [];
  const info = await startPlay(session);
  let raw: unknown;
  try {
    await sleep(o.seconds * 1000);
    if (o.prepare) {
      const p = await runLuau(session, o.prepare, 'client', { chunkName: 'prepare' });
      if (!p.ok) notes.push(`prepare failed: ${p.error?.message}`);
    }
    const r = await runLuau(session, uiProbeProgram(devices), 'client', { chunkName: 'uiProbe', timeoutMs: 60_000 });
    if (!r.ok) throw new Error(`ui probe failed: ${r.error?.message}`);
    raw = r.values[0];
  } finally {
    if (!info.alreadyRunning) await stopPlay(session).catch(() => false);
  }
  const probe = parseProbe(raw);
  const findings: UiFinding[] = [];
  const elements: Record<string, number> = {};
  for (const d of devices) {
    const els = probe.devices[d.name] ?? [];
    elements[d.name] = els.length;
    findings.push(...lintSnapshot({ device: d, elements: els }));
  }
  if (Object.values(elements).every((n) => n === 0)) notes.push(`no visible GUI elements (${probe.sources} enabled ScreenGui(s)) — build the HUD first, or open it with prepare`);
  return { ranAt: new Date().toISOString(), devices: devices.map((d) => d.name), elements, findings, results: lintResults(findings), notes };
}
