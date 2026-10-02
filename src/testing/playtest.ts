import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { runLuau, type LuauResult } from '../studio/luau.js';
import { resultText, type StudioSession } from '../studio/session.js';
import { collectLogs, startPlay, stopPlay, summarizeLogs, type LogSummary, type PlayInfo } from '../studio/play.js';

// One call = one observed playtest: start → wait until a player/character is
// ready → let the game run → optional scripted input → probe server/client
// state → optional screenshot → collect typed logs from both sides → stop.
// Replaces ~8 raw tool calls the agent used to sequence by hand (and often
// forgot the final stop, leaving Studio stuck in play mode).

export interface Screenshot {
  path: string; // project-relative
  mimeType: string;
  data: string; // base64
}

export interface InputStep {
  kind: 'navigate' | 'keyboard' | 'mouse' | 'click' | 'luau' | 'wait';
  // navigate: {x,y,z} or {instance_path}; keyboard/mouse: {actions:[…]} (raw
  // Studio schema); click: {target} (a GuiButton path); luau: {context, code}
  // (arrange or check state between inputs); wait: {seconds}
  args: Record<string, unknown>;
}

export interface PlaytestOptions {
  seconds?: number; // game time before probes (default 3)
  serverCode?: string;
  clientCode?: string;
  inputs?: InputStep[];
  screenshot?: boolean;
  camera?: { position: [number, number, number]; lookAt: [number, number, number] };
  keepRunning?: boolean; // leave the playtest running (for follow-up probes)
}

export interface PlaytestResult {
  ok: boolean; // ready, probes ok, no runtime errors
  ready: Pick<PlayInfo, 'players' | 'character' | 'readyMs'>;
  server?: LuauResult;
  client?: LuauResult;
  inputs: { kind: string; ok: boolean; text: string }[];
  logs: LogSummary;
  screenshot?: Screenshot;
  stopped: boolean;
  durationMs: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function saveArtifact(projectPath: string, label: string, mimeType: string, base64: string): string {
  const dir = join(projectPath, '.blox', 'artifacts');
  mkdirSync(dir, { recursive: true });
  const ext = mimeType.includes('png') ? 'png' : 'jpg';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(dir, `${stamp}-${label.replace(/[^\w-]/g, '_')}.${ext}`);
  writeFileSync(file, Buffer.from(base64, 'base64'));
  return relative(projectPath, file).replace(/\\/g, '/');
}

export async function captureScreenshot(
  session: StudioSession,
  projectPath: string,
  label: string,
  camera?: PlaytestOptions['camera'],
): Promise<Screenshot | null> {
  const r = await session.call('screen_capture', {
    capture_id: label,
    ...(camera ? { camera_position: camera.position, look_at_position: camera.lookAt } : {}),
  }, 30_000);
  const img = (r.content ?? []).find((b) => b.type === 'image' && b.data);
  if (!img?.data) return null;
  const mimeType = img.mimeType ?? 'image/jpeg';
  return { path: saveArtifact(projectPath, label, mimeType, img.data), mimeType, data: img.data };
}

const INPUT_TOOL: Record<'navigate' | 'keyboard' | 'mouse', string> = {
  navigate: 'character_navigation',
  keyboard: 'user_keyboard_input',
  mouse: 'user_mouse_input',
};

// Studio's input tools resolve instance paths from LocalPlayer
// ("LocalPlayer.PlayerGui.HUD.Button"); agents naturally write the DataModel
// path ("game.Players.LocalPlayer…", "Players.LocalPlayer…") or start at PlayerGui.
export function clientPath(p: string): string {
  const s = p.trim().replace(/^game\./, '').replace(/^Players\./, '');
  if (s.startsWith('LocalPlayer.') || s.startsWith('Workspace.') || s.startsWith('game.')) return s;
  if (/^(PlayerGui|PlayerScripts|Backpack|Character)\b/.test(s)) return `LocalPlayer.${s}`;
  return s;
}

function normalizeInputArgs(step: InputStep): Record<string, unknown> {
  const args = { ...step.args };
  if (typeof args.instance_path === 'string') args.instance_path = clientPath(args.instance_path);
  if (Array.isArray(args.actions)) {
    args.actions = args.actions.map((a) =>
      a && typeof a === 'object' && typeof (a as { instance_path?: unknown }).instance_path === 'string'
        ? { ...a, instance_path: clientPath((a as { instance_path: string }).instance_path) }
        : a);
  }
  return args;
}

// Explain the one click failure agents can't diagnose from the raw text.
function clickText(raw: string): string {
  return /hits CoreGUI/i.test(raw)
    ? `${raw} — the click landed on Roblox's own UI (top bar/menus), not the game's button; move the button out of that area`
    : raw;
}

export async function runInput(session: StudioSession, step: InputStep): Promise<{ kind: string; ok: boolean; text: string }> {
  if (step.kind === 'wait') {
    await sleep(Math.min(30, Number(step.args.seconds ?? 1)) * 1000);
    return { kind: 'wait', ok: true, text: `waited ${step.args.seconds ?? 1}s` };
  }
  if (step.kind === 'luau') {
    const ctx = step.args.context === 'client' ? 'client' : 'server';
    const r = await runLuau(session, String(step.args.code ?? ''), ctx, { chunkName: 'inputLuau' });
    return { kind: `luau ${ctx}`, ok: r.ok, text: r.ok ? JSON.stringify(r.values) : `ERROR: ${r.error?.message}` };
  }
  if (step.kind === 'click') {
    const target = clientPath(String(step.args.target ?? step.args.instance_path ?? ''));
    const r = await session.call('user_mouse_input', {
      datamodel_type: 'Client',
      actions: [{ action: 'mouseButtonClick', mouse_button: 'left', instance_path: target }],
    }, 60_000);
    const text = clickText(resultText(r));
    // Let the click's handlers (and any remote round trip) run before the next step.
    await sleep(Math.min(10, Number(step.args.settle ?? 0.5)) * 1000);
    return { kind: `click ${target}`, ok: !r.isError && !/hits CoreGUI/i.test(text), text: text.slice(0, 300) };
  }
  const r = await session.call(INPUT_TOOL[step.kind], { datamodel_type: 'Client', ...normalizeInputArgs(step) }, 60_000);
  const text = step.kind === 'mouse' ? clickText(resultText(r)) : resultText(r);
  return { kind: step.kind, ok: !r.isError && !/hits CoreGUI/i.test(text), text: text.slice(0, 300) };
}

export async function playtest(session: StudioSession, projectPath: string, opts: PlaytestOptions = {}): Promise<PlaytestResult> {
  const t0 = Date.now();
  const info = await startPlay(session);
  const result: PlaytestResult = {
    ok: false,
    ready: { players: info.players, character: info.character, readyMs: info.readyMs },
    inputs: [],
    logs: { errors: [], warnings: [], output: [], noise: 0 },
    stopped: false,
    durationMs: 0,
  };
  try {
    await sleep(Math.max(0, (opts.seconds ?? 3) * 1000));
    for (const step of opts.inputs ?? []) result.inputs.push(await runInput(session, step));
    if (opts.serverCode) result.server = await runLuau(session, opts.serverCode, 'server', { chunkName: 'serverCode' });
    if (opts.clientCode) result.client = await runLuau(session, opts.clientCode, 'client', { chunkName: 'clientCode' });
    if (opts.screenshot) {
      result.screenshot = (await captureScreenshot(session, projectPath, 'playtest', opts.camera).catch(() => null)) ?? undefined;
    }
    const since = info.startedAt - 1;
    const [sl, cl] = await Promise.all([
      collectLogs(session, 'server', since).catch(() => []),
      collectLogs(session, 'client', since).catch(() => []),
    ]);
    result.logs = summarizeLogs([...sl, ...cl]);
  } finally {
    if (!opts.keepRunning && !info.alreadyRunning) {
      result.stopped = await stopPlay(session).catch(() => false);
    }
  }
  result.ok =
    info.players > 0 &&
    (result.server?.ok ?? true) &&
    (result.client?.ok ?? true) &&
    result.inputs.every((i) => i.ok) &&
    result.logs.errors.length === 0;
  result.durationMs = Date.now() - t0;
  return result;
}

export function formatPlaytest(r: PlaytestResult): string {
  const lines = [
    `playtest ${r.ok ? 'OK' : 'PROBLEMS'} (${r.durationMs}ms): players=${r.ready.players} character=${r.ready.character} ready=${r.ready.readyMs}ms${r.stopped ? ', stopped' : ''}`,
  ];
  const probe = (label: string, p?: LuauResult) => {
    if (!p) return;
    lines.push(`  ${label}: ${p.ok ? 'ok' : 'ERROR'} → ${p.ok ? JSON.stringify(p.values) : p.error?.message}`);
    for (const l of p.logs) lines.push(`    [${l.level}] ${l.message}`);
  };
  probe('server', r.server);
  probe('client', r.client);
  for (const i of r.inputs) lines.push(`  input ${i.kind}: ${i.ok ? 'ok' : 'FAILED'} ${i.text}`);
  lines.push(`  runtime errors: ${r.logs.errors.length}, warnings: ${r.logs.warnings.length} (${r.logs.noise} env-noise lines hidden)`);
  for (const e of r.logs.errors.slice(0, 15)) lines.push(`    ERROR [${e.context}] ${e.message}${e.count ? ` (x${e.count})` : ''}`);
  for (const w of r.logs.warnings.slice(0, 10)) lines.push(`    WARN  [${w.context}] ${w.message}${w.count ? ` (x${w.count})` : ''}`);
  if (r.logs.output.length) {
    lines.push('  output (tail):');
    for (const o of r.logs.output.slice(-15)) lines.push(`    [${o.context}] ${o.message}`);
  }
  if (r.screenshot) lines.push(`  screenshot: ${r.screenshot.path}`);
  return lines.join('\n');
}
