import { runLaneJob, type LaneRunOptions } from '../multiplayer/lane.js';
import { wrapLuau, type LuauResult, type LogEntry } from './luau.js';
import { StudioError } from './session.js';

// Plugin eval bridge (opt-in: blox.config.json "bridge": { "eval": true }).
//
// Since the 2026-09-30 Studio build, execute_luau in play server/client runs in
// a reduced-capability thread: no require() of game modules, no loadstring. The
// bridge hands server/client probes to the blox dock plugin over the lane
// port; the plugin instance in the play server injects a one-shot Script (or a
// LocalScript under the player's PlayerGui, for client) in a single
// __BloxBridge folder, which runs the code at ordinary game-script identity
// (not plugin identity) and is destroyed after.
//
// Guardrails, all enforced here before anything reaches Studio, plus the
// plugin's own checks (context, size, timeout, fixed container, HttpEnabled off
// on the server while the probe runs):
// - no HTTP / external endpoints, no dynamic code loading, no asset-id require
//   (remote code), no persistent-store services (Studio play talks to the
//   experience's real DataStores), no non-literal GetService/FindService (the
//   usual way to dodge the name checks). This is a lint, not a sandbox: the
//   bridge only exists when the project owner opts in.

export const BRIDGE_MAX_SOURCE = 256 * 1024;
export const BRIDGE_MAX_TIMEOUT_MS = 120_000;
const BRIDGE_CHUNK = /[\w.]*__BloxBridge\.BloxEval:(\d+)/g;

const DENY: [RegExp, string][] = [
  [/HttpService|HttpGet|HttpPost|RequestAsync|PostAsync/i, 'external HTTP (HttpService/HttpGet)'],
  [/\b(loadstring|getfenv|setfenv)\b/, 'dynamic code loading (loadstring/getfenv/setfenv)'],
  [/\brequire\s*\(\s*\d/, 'require() by asset id (loads remote code)'],
  [/DataStoreService|MemoryStoreService|MessagingService|OrderedDataStore/, 'persistent stores (Studio play writes the real DataStores)'],
  [/\b(GetService|FindService)\s*\(\s*[^"'\s)]/, 'GetService/FindService with a non-literal name'],
  [/\b(GetService|FindService)\s*\(\s*["'][^"']*["']\s*\.\./, 'GetService/FindService with a concatenated name'],
];

// True for an error that is the bridge's own (lane down, no plugin, timeout,
// guardrail, garbled reply) rather than the probe's: callers fall back to
// injected scripts only for these.
export function isBridgeFailure(message: string): boolean {
  return /^(eval bridge|blocked by the eval bridge guardrail|unexpected eval bridge output)/.test(message);
}

export function bridgeDenyReason(code: string): string | null {
  for (const [re, why] of DENY) if (re.test(code)) return `blocked by the eval bridge guardrail: ${why}`;
  if (code.length > BRIDGE_MAX_SOURCE / 2) return `blocked by the eval bridge guardrail: probe longer than ${BRIDGE_MAX_SOURCE / 2} chars`;
  return null;
}

// Script source the plugin injects: the standard runLuau envelope program
// inside a function, its JSON handed back through the sibling Done event
// (BindableEvent on the server, RemoteEvent from the client).
const HEAD = 'local __done = script:WaitForChild("Done")\nlocal function __prog()\n';
const HEAD_LINES = 2;
export function bridgeSource(code: string): { source: string; userLineOffset: number } {
  const { program, userLineOffset } = wrapLuau(code, { freshRequire: false });
  return {
    source: `${HEAD}${program}\nend\nlocal __ok, __out = pcall(__prog)\nif __done:IsA("RemoteEvent") then __done:FireServer(__ok, __out) else __done:Fire(__ok, __out) end\n`,
    userLineOffset: userLineOffset + HEAD_LINES,
  };
}

export function mapBridgeLines(text: string, offset: number, chunk: string, userLines: number): string {
  return text.replace(BRIDGE_CHUNK, (_m, n: string) => {
    const line = Number(n) - offset;
    return line >= 1 && line <= userLines ? `${chunk}:${line}` : '<blox-wrapper>';
  });
}

// One lane port, one job at a time: queue bridge calls.
let queue: Promise<unknown> = Promise.resolve();

export interface BridgeOptions extends Partial<Pick<LaneRunOptions, 'port' | 'pickupMs'>> {
  chunkName?: string;
  timeoutMs?: number;
}

export function runLuauViaBridge(code: string, context: 'server' | 'client', o: BridgeOptions = {}): Promise<LuauResult> {
  const run = queue.then(() => runOnce(code, context, o));
  queue = run.catch(() => undefined);
  return run;
}

async function runOnce(code: string, context: 'server' | 'client', o: BridgeOptions): Promise<LuauResult> {
  const t0 = Date.now();
  const fail = (message: string): LuauResult => ({ ok: false, values: [], logs: [], error: { message }, durationMs: Date.now() - t0 });
  const denied = bridgeDenyReason(code);
  if (denied) return fail(denied);
  const chunk = o.chunkName ?? 'luau';
  const { source, userLineOffset } = bridgeSource(code);
  const timeoutMs = Math.min(BRIDGE_MAX_TIMEOUT_MS, o.timeoutMs ?? 60_000);
  const lane = await runLaneJob(
    { kind: 'eval', context, source, timeoutMs },
    {
      port: o.port,
      pickupMs: o.pickupMs ?? 6_000,
      timeoutMs: timeoutMs + 10_000,
      label: 'eval bridge',
      pickupHint: `${context} context needs a running playtest (play {action:"start"}) and the current blox dock plugin (blox panel install, then restart Studio) with HTTP requests allowed`,
    },
  ).catch((e: Error) => {
    throw new StudioError(/pick up/.test(e.message) ? 'wrong_mode' : 'timeout', `eval bridge: ${e.message}`);
  });
  const map = (t: string) => mapBridgeLines(t, userLineOffset, chunk, code.split('\n').length);
  if (!lane.ok) return fail(map(`eval bridge: ${lane.error ?? 'failed'}`));
  let env: { ok: boolean; values?: Record<string, unknown>; n?: number; logs?: LogEntry[]; error?: { message: string; traceback?: string } };
  try {
    env = JSON.parse(String(lane.result));
  } catch {
    return fail(`unexpected eval bridge output: ${String(lane.result).slice(0, 500)}`);
  }
  const values: unknown[] = [];
  for (let i = 1; i <= (env.n ?? 0); i++) values.push(env.values?.[`v${i}`] ?? null);
  return {
    ok: env.ok,
    values,
    logs: (env.logs ?? []).map((l) => ({ ...l, message: map(l.message) })),
    ...(env.error ? { error: { message: map(env.error.message), ...(env.error.traceback ? { traceback: map(env.error.traceback) } : {}) } } : {}),
    durationMs: Date.now() - t0,
  };
}
