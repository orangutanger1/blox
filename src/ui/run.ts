import type { StudioSession } from '../studio/session.js';
import { runLuau } from '../studio/luau.js';
import { startPlay, stopPlay } from '../studio/play.js';
import { installProbe, newRunId, removeHosts, runProbes } from '../testing/playHost.js';
import { DEVICES, lintResults, lintSnapshot, type Device, type UiElement, type UiFinding, type UiReport } from './lint.js';
import { parseProbePage, uiProbeProgram } from './probe.js';

const MAX_PAGES = 50; // per device

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

// Lays the player's GUI out at device d (client context, play mode), page by page.
export async function probeDevice(session: StudioSession, d: Device): Promise<{ elements: UiElement[]; sources: number }> {
  const elements: UiElement[] = [];
  let sources = 0;
  let skip = 0;
  for (let i = 0; ; i++) {
    if (i >= MAX_PAGES) throw new Error(`ui probe: more than ${MAX_PAGES} pages of elements on ${d.name}`);
    const r = await runLuau(session, uiProbeProgram(d, skip), 'client', { chunkName: 'uiProbe', timeoutMs: 60_000 });
    if (!r.ok) throw new Error(`ui probe failed on ${d.name}: ${r.error?.message}`);
    const page = parseProbePage(r.values[0]);
    sources = page.sources;
    elements.push(...page.elements);
    if (page.next === null) return { elements, sources };
    if (page.next <= skip) throw new Error(`ui probe made no progress on ${d.name} at element ${skip}`);
    skip = page.next;
  }
}

export async function runUiLint(session: StudioSession, o: UiLintOptions): Promise<UiReport> {
  const devices = pickDevices(o.devices);
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const notes: string[] = [];
  // prepare runs as an injected probe script (game VM: require() and shared work,
  // e.g. shared.BloxControllers), like playtest's client code, unless the eval
  // bridge is on or a playtest is already running (can't add scripts then).
  const hosted = Boolean(o.prepare) && !session.evalBridge && (await session.state()).mode === 'Edit';
  const runId = newRunId();
  if (hosted) {
    await removeHosts(session);
    await installProbe(session, 'client', o.prepare!, runId);
  }
  const info = await startPlay(session);
  const pages: Record<string, UiElement[]> = {};
  let sources = 0;
  try {
    await sleep(o.seconds * 1000);
    if (o.prepare) {
      const p = hosted
        ? (await runProbes(session, runId, { server: false, client: true }, Date.now() + 30_000, sleep)).client!
        : await runLuau(session, o.prepare, 'client', { chunkName: 'prepare' });
      if (!p.ok) notes.push(`prepare failed: ${p.error?.message}`);
    }
    for (const d of devices) {
      const p = await probeDevice(session, d);
      sources = p.sources;
      pages[d.name] = p.elements;
    }
  } finally {
    const stopped = !info.alreadyRunning && (await stopPlay(session).catch(() => false));
    if (hosted && stopped) await removeHosts(session).catch(() => {});
  }
  const findings: UiFinding[] = [];
  const elements: Record<string, number> = {};
  for (const d of devices) {
    const els = pages[d.name] ?? [];
    elements[d.name] = els.length;
    findings.push(...lintSnapshot({ device: d, elements: els }));
  }
  if (Object.values(elements).every((n) => n === 0)) notes.push(`no visible GUI elements (${sources} enabled ScreenGui(s)) — build the HUD first, or open it with prepare`);
  return { ranAt: new Date().toISOString(), devices: devices.map((d) => d.name), elements, findings, results: lintResults(findings), notes };
}
