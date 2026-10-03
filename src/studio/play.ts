import { StudioError, resultText, type StudioSession } from './session.js';
import { runLuau, type LogEntry, type LogLevel } from './luau.js';

// Playtest lifecycle with guarantees the raw start_stop_play tool lacks:
// readiness (a player exists on the server, character spawned on the client),
// idempotent start/stop, and "always stop what you started" via withPlay.

export interface PlayInfo {
  startedAt: number; // unix seconds (Studio clock is the host clock)
  alreadyRunning: boolean;
  players: number;
  character: boolean;
  readyMs: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface PlayOptions {
  readyTimeoutMs?: number;
  waitForCharacter?: boolean;
  sleep?: (ms: number) => Promise<void>;
}

export async function startPlay(session: StudioSession, opts: PlayOptions = {}): Promise<PlayInfo> {
  const sleep = opts.sleep ?? defaultSleep;
  const t0 = Date.now();
  const startedAt = t0 / 1000;
  const st = await session.state();
  const alreadyRunning = st.mode !== 'Edit';
  if (!alreadyRunning) {
    let started = false;
    for (let i = 0; i < 3 && !started; i++) {
      const r = await session.call('start_stop_play', { is_start: true }, 60_000);
      started = /started/i.test(resultText(r)) && !r.isError;
      if (!started) {
        const again = await session.state();
        started = again.mode !== 'Edit';
        if (!started) await sleep(1000);
      }
    }
    if (!started) throw new StudioError('tool_error', 'start_stop_play did not start a playtest');
  }
  // Readiness: server sees a player; client has a character.
  const deadline = Date.now() + (opts.readyTimeoutMs ?? 30_000);
  let players = 0;
  let character = false;
  while (Date.now() < deadline) {
    try {
      const s = await runLuau(session, 'return #game:GetService("Players"):GetPlayers()', 'server', { timeoutMs: 10_000, via: 'mcp' });
      players = Number(s.values[0] ?? 0);
      if (players > 0) {
        if (opts.waitForCharacter === false) break;
        const c = await runLuau(session, 'local p = game:GetService("Players").LocalPlayer return p ~= nil and p.Character ~= nil and p.Character:FindFirstChild("HumanoidRootPart") ~= nil', 'client', { timeoutMs: 10_000, via: 'mcp' });
        character = c.values[0] === true;
        if (character) break;
      }
    } catch {
      /* datamodels still spinning up */
    }
    await sleep(500);
  }
  return { startedAt, alreadyRunning, players, character, readyMs: Date.now() - t0 };
}

export async function stopPlay(session: StudioSession, sleep: (ms: number) => Promise<void> = defaultSleep): Promise<boolean> {
  const st = await session.state();
  if (st.mode === 'Edit') return false;
  for (let i = 0; i < 3; i++) {
    await session.call('start_stop_play', { is_start: false }, 60_000);
    const after = await session.state();
    if (after.mode === 'Edit') return true;
    await sleep(1000);
  }
  throw new StudioError('tool_error', 'playtest did not stop');
}

export async function withPlay<T>(session: StudioSession, fn: (info: PlayInfo) => Promise<T>, opts: PlayOptions = {}): Promise<T> {
  const info = await startPlay(session, opts);
  try {
    return await fn(info);
  } finally {
    if (!info.alreadyRunning) await stopPlay(session).catch(() => {});
  }
}

// --- logs ---------------------------------------------------------------

export interface CollectedLog extends LogEntry {
  context: 'edit' | 'server' | 'client';
  count?: number;
  noise?: boolean;
}

// Environment chatter that is not the game's fault (unshared animation/asset
// permissions in an unpublished place, Studio plugin messages). Kept, but
// flagged so summaries count real problems only.
const NOISE = [
  /doesn't have access permission to use asset id/i,
  /Failed to load animation with sanitized ID/i,
  /joined live editing session/i,
  /^Stack (Begin|End)$/,
  /HTTP \d+ \(Unauthorized\)/i,
];

export function isNoise(message: string): boolean {
  return NOISE.some((r) => r.test(message));
}

function logLuau(since: number, limit: number): string {
  return `local LS = game:GetService("LogService")
local out = {}
for _, e in LS:GetLogHistory() do
	if e.timestamp >= ${since.toFixed(3)} then
		local mt = e.messageType
		local lvl = (mt == Enum.MessageType.MessageError and "error") or (mt == Enum.MessageType.MessageWarning and "warning") or (mt == Enum.MessageType.MessageInfo and "info") or "output"
		table.insert(out, { level = lvl, message = string.sub(e.message, 1, 2000), t = e.timestamp })
	end
end
if #out > ${limit} then
	local keep = {}
	for i = #out - ${limit} + 1, #out do table.insert(keep, out[i]) end
	out = keep
end
return out`;
}

// Fold "Stack Begin / Script '…', Line N / Stack End" info lines into the
// preceding error, and collapse consecutive duplicates into count.
export function foldLogs(entries: LogEntry[], context: CollectedLog['context']): CollectedLog[] {
  const out: CollectedLog[] = [];
  let inStack = false;
  for (const e of entries) {
    if (e.message === 'Stack Begin') { inStack = true; continue; }
    if (e.message === 'Stack End') { inStack = false; continue; }
    const prev = out[out.length - 1];
    if (inStack && prev) {
      prev.message += `\n  ${e.message}`;
      continue;
    }
    if (prev && prev.message === e.message && prev.level === e.level) {
      prev.count = (prev.count ?? 1) + 1;
      continue;
    }
    out.push({ ...e, context, ...(isNoise(e.message) ? { noise: true } : {}) });
  }
  return out;
}

export async function collectLogs(session: StudioSession, context: CollectedLog['context'], sinceUnix: number, limit = 300): Promise<CollectedLog[]> {
  const r = await runLuau(session, logLuau(sinceUnix, limit), context, { timeoutMs: 15_000, freshRequire: false, via: 'mcp' });
  const raw = (r.ok && Array.isArray(r.values[0]) ? r.values[0] : []) as LogEntry[];
  return foldLogs(raw, context);
}

export interface LogSummary {
  errors: CollectedLog[];
  warnings: CollectedLog[];
  output: CollectedLog[]; // tail of output/info
  noise: number;
}

export function summarizeLogs(logs: CollectedLog[], outputTail = 40): LogSummary {
  const real = logs.filter((l) => !l.noise);
  const pick = (lvl: LogLevel) => real.filter((l) => l.level === lvl);
  return {
    errors: pick('error'),
    warnings: pick('warning'),
    output: real.filter((l) => l.level === 'output' || l.level === 'info').slice(-outputTail),
    noise: logs.length - real.length,
  };
}
