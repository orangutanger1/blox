import type { StudioSession } from '../studio/session.js';
import { runLuau } from '../studio/luau.js';
import { startPlay, stopPlay } from '../studio/play.js';
import { installProbe, newRunId, removeHosts, runProbe, runProbes } from '../testing/playHost.js';
import { DEVICES, lintResults, lintSnapshot, type Device, type UiElement, type UiFinding, type UiReport } from './lint.js';
import { parseProbePage, uiProbeProgram } from './probe.js';
import { mountProgram, previewProgram, UNSTAGE } from './stage.js';
import { composeSheet, cropJpeg } from './sheet.js';
import { restoreFor } from '../studio/host.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MAX_PAGES = 50; // per device

export interface UiLintOptions {
  seconds: number;
  prepare?: string; // client Luau run before the snapshot (open a menu, …)
  // play states: per state, server Luau then client Luau (luau), then every device
  // is linted as <device>@<name>
  states?: UiState[];
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
export async function probeDevice(session: StudioSession, d: Device, root: 'player' | 'edit' = 'player'): Promise<{ elements: UiElement[]; sources: number }> {
  const elements: UiElement[] = [];
  let sources = 0;
  let skip = 0;
  for (let i = 0; ; i++) {
    if (i >= MAX_PAGES) throw new Error(`ui probe: more than ${MAX_PAGES} pages of elements on ${d.name}`);
    const r = await runLuau(session, uiProbeProgram(d, skip, undefined, root), root === 'edit' ? 'edit' : 'client', { chunkName: 'uiProbe', timeoutMs: 60_000 });
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
  if (o.states?.length) return runUiLintStates(session, o, statesOf(o));
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

// Play mode, several screen states in one playtest: each state's server and
// client Luau run as steps of injected probe scripts (game VM: require, shared),
// or through the eval bridge when it is on.
async function runUiLintStates(session: StudioSession, o: UiLintOptions, states: UiState[]): Promise<UiReport> {
  const devices = pickDevices(o.devices);
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const notes: string[] = [];
  const hasServer = states.some((s) => s.server);
  const hosted = !session.evalBridge && (await session.state()).mode === 'Edit';
  const runId = newRunId();
  if (hosted) {
    await removeHosts(session);
    if (hasServer) await installProbe(session, 'server', states.map((s) => s.server ?? ''), runId);
    await installProbe(session, 'client', states.map((s) => s.luau ?? ''), runId);
  }
  const info = await startPlay(session);
  const pages: Record<string, UiElement[]> = {};
  const keys: string[] = [];
  let sources = 0;
  try {
    await sleep(o.seconds * 1000);
    for (const [k, st] of states.entries()) {
      for (const [ctx, code] of [['server', st.server], ['client', st.luau]] as const) {
        if (!code && !(hosted && ctx === 'client')) continue;
        if (ctx === 'server' && !hasServer) continue;
        const r = hosted ? await runProbe(session, ctx, runId, Date.now() + 30_000, sleep, k + 1) : await runLuau(session, code!, ctx, { chunkName: `state-${st.name}` });
        if (!r.ok) notes.push(`state "${st.name}" ${ctx} failed: ${r.error?.message}`);
      }
      await sleep((st.settle ?? 1) * 1000);
      for (const d of devices) {
        const key = `${d.name}@${st.name}`;
        const p = await probeDevice(session, d);
        sources = p.sources;
        pages[key] = p.elements;
        keys.push(key);
      }
    }
  } finally {
    const stopped = !info.alreadyRunning && (await stopPlay(session).catch(() => false));
    if (hosted && stopped) await removeHosts(session).catch(() => {});
  }
  const findings: UiFinding[] = [];
  const elements: Record<string, number> = {};
  for (const st of states)
    for (const d of devices) {
      const key = `${d.name}@${st.name}`;
      const els = pages[key] ?? [];
      elements[key] = els.length;
      findings.push(...lintSnapshot({ device: { ...d, name: key }, elements: els }));
    }
  if (Object.values(elements).every((n) => n === 0)) notes.push(`no visible GUI elements (${sources} enabled ScreenGui(s))`);
  return { ranAt: new Date().toISOString(), devices: keys, elements, findings, results: lintResults(findings), notes };
}

// --- edit mode (no Play) -----------------------------------------------

export interface UiState {
  name: string;
  luau?: string; // edit: run after the mount, with `host` in scope (open the shop, …); play: client Luau
  server?: string; // play only: server Luau run before the client step (start a wave, set a boss)
  settle?: number; // play only: seconds to wait after the state's code (default 1)
}
export interface UiEditOptions {
  mount?: string; // Luau that builds the UI under `host`; default: StarterGui's ScreenGuis
  states?: UiState[];
  devices?: string[];
}

function statesOf(o: UiEditOptions): UiState[] {
  const states = o.states?.length ? o.states : [{ name: 'default' }];
  const seen = new Set<string>();
  for (const s of states) {
    if (!s.name || !/^[\w-]+$/.test(s.name)) throw new Error(`ui state names are letters, digits, - and _ ("${s.name}")`);
    if (seen.has(s.name)) throw new Error(`duplicate state name "${s.name}"`);
    seen.add(s.name);
  }
  return states;
}

async function editOnly(session: StudioSession): Promise<void> {
  if ((await session.state()).mode !== 'Edit') throw new Error('edit-mode UI tools stage the UI in the edit DataModel: stop the playtest first');
}

async function mountState(session: StudioSession, o: UiEditOptions, st: UiState, notes: string[]): Promise<void> {
  const r = await runLuau(session, mountProgram(o.mount, st.luau), 'edit', { chunkName: `uiMount-${st.name}`, timeoutMs: 60_000 });
  if (!r.ok) throw new Error(`ui mount failed (state "${st.name}"): ${r.error?.message}`);
  if (Number(r.values[0] ?? 0) === 0)
    notes.push(`state "${st.name}": no ScreenGui under host — parent your ScreenGuis to host (UI.screen("HUD", host)), or put them in StarterGui`);
}

const unstage = (session: StudioSession) => runLuau(session, UNSTAGE, 'edit', { chunkName: 'uiUnstage' }).catch(() => undefined);

// Lint without Play: device names in the report are <device>@<state> when states are given.
export async function runUiLintEdit(session: StudioSession, o: UiEditOptions): Promise<UiReport> {
  const states = statesOf(o);
  const devices = pickDevices(o.devices);
  await editOnly(session);
  const named = Boolean(o.states?.length);
  const notes: string[] = ['edit mode: UI that sizes itself from Camera.ViewportSize is not measured truly; parent-size (Scale, AbsoluteSize, BloxUI.fit) UI is'];
  const findings: UiFinding[] = [];
  const elements: Record<string, number> = {};
  const keys: string[] = [];
  await unstage(session);
  try {
    for (const st of states) {
      await mountState(session, o, st, notes);
      for (const d of devices) {
        const key = named ? `${d.name}@${st.name}` : d.name;
        const p = await probeDevice(session, d, 'edit');
        keys.push(key);
        elements[key] = p.elements.length;
        findings.push(...lintSnapshot({ device: { ...d, name: key }, elements: p.elements }));
      }
    }
  } finally {
    await unstage(session);
  }
  if (Object.values(elements).every((n) => n === 0)) notes.push('no visible GUI elements — check the mount');
  return { ranAt: new Date().toISOString(), devices: keys, elements, findings, results: lintResults(findings), notes };
}

export interface UiPreview {
  sheets: { state: string; path: string; data: string }[]; // data: base64 JPEG
  notes: string[];
}

// One contact sheet per state, devices left to right (in `devices` order).
export async function runUiPreview(session: StudioSession, projectPath: string, o: UiEditOptions): Promise<UiPreview> {
  const states = statesOf(o);
  const devices = pickDevices(o.devices);
  await editOnly(session);
  await restoreFor(session);
  const notes: string[] = [];
  const sheets: UiPreview['sheets'] = [];
  const dir = join(projectPath, '.blox/ui-preview');
  mkdirSync(dir, { recursive: true });
  await unstage(session);
  try {
    for (const st of states) {
      await mountState(session, o, st, notes);
      const row: (Buffer | null)[] = [];
      for (const d of devices) {
        const r = await runLuau(session, previewProgram(d), 'edit', { chunkName: `uiPreview-${d.name}`, timeoutMs: 60_000 });
        if (!r.ok) throw new Error(`ui preview failed on ${d.name}: ${r.error?.message}`);
        const rect = JSON.parse(String(r.values[0])) as { vw: number; x: number; y: number; w: number; h: number };
        const cap = await session.call('screen_capture', { capture_id: `ui-preview-${st.name}-${d.name}` }, 30_000);
        const img = (cap.content ?? []).find((b) => b.type === 'image' && b.data);
        const crop = img?.data ? cropJpeg(Buffer.from(img.data, 'base64'), rect, rect.vw) : null;
        if (!crop) notes.push(`${st.name}/${d.name}: no capture (is the Studio window visible?)`);
        row.push(crop);
      }
      const sheet = composeSheet([row]);
      const path = join(dir, `${st.name}.jpg`);
      writeFileSync(path, sheet);
      sheets.push({ state: st.name, path: `.blox/ui-preview/${st.name}.jpg`, data: sheet.toString('base64') });
    }
  } finally {
    await unstage(session);
  }
  return { sheets, notes };
}
