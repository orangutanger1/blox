import { randomBytes } from 'node:crypto';
import { longString } from '../studio/luau.js';
import { StudioError, resultText, type StudioSession } from '../studio/session.js';
import type { LuauResult } from '../studio/luau.js';

// Server/client specs run as injected scripts, not through execute_luau.
//
// Since the Sep 2026 Studio build the execute_luau thread runs with reduced
// script capabilities: in a playtest it cannot require() place modules (nor
// invoke into game code), so specs that require game modules fail. Scripts
// created by Studio's multi_edit tool get normal capabilities, so the runner
// injects the inlined test program as ServerScriptService.BloxTestHost (and a
// LocalScript in StarterPlayerScripts for client specs), starts Play, and reads
// the results the hosts print (chunked, tagged with a run id) back from each
// context's LogService history. This is the flow Roblox's own unit-test skill
// documents (create scripts, Play, read the console), automated.

export type PlayContext = 'server' | 'client';

export const HOSTS: Record<PlayContext, { path: string[]; className: string }> = {
  server: { path: ['ServerScriptService', 'BloxTestHost'], className: 'Script' },
  client: { path: ['StarterPlayer', 'StarterPlayerScripts', 'BloxTestHostClient'], className: 'LocalScript' },
};

const MARK = 'BLOXTEST';
const CHUNK = 3000;

// Studio's output (print → LogService, server and client) collapses runs like
// \"x\" to a lone quote (seen 2026-10-07: `print('a \\"x\\", b')` logs `a ", b`),
// so JSON with escaped quotes in failure messages stopped parsing and the run
// reported "no results". Hosts percent-encode \ and % before printing;
// assembleChunks decodes them.
const ESCAPE_MARKER = `local function escapeMarker(s: string): string
	return (string.gsub(s, "[%%\\\\]", function(c) return if c == "%" then "%25" else "%5C" end))
end`;

export function newRunId(): string {
  return randomBytes(4).toString('hex');
}

// Host script source. `program` is testProgram() output (top-level code ending
// in `return { results, fileErrors }`). It is wrapped on the SAME first line so
// host line N == program line N and spec positions map unchanged.
// Avatar accessories load after CharacterAdded and can shift the character
// (seen 2026-10-05: a wheelchair accessory made specs that teleport the
// character miss touches). Specs start once the appearance is in, capped at 10s.
export const APPEARANCE_WAIT = `if p then local t1 = os.clock() while not p:HasAppearanceLoaded() and os.clock() - t1 < 10 do task.wait(0.1) end end`;

export function hostSource(program: string, ctx: PlayContext, runId: string): string {
  const wait = ctx === 'server'
    ? `local Players = game:GetService("Players")
local t0 = os.clock()
while #Players:GetPlayers() == 0 and os.clock() - t0 < 30 do task.wait(0.1) end
local p = Players:GetPlayers()[1]
if p and not p.Character then p.CharacterAdded:Wait() end
${APPEARANCE_WAIT}`
    : `local p = game:GetService("Players").LocalPlayer
if not p.Character then p.CharacterAdded:Wait() end
${APPEARANCE_WAIT}`;
  return `local function __blox_run() ${program}
end
${wait}
local ok, out = pcall(__blox_run)
if not ok then out = { results = {}, fileErrors = { { file = "<host>", message = tostring(out) } } } end
${ESCAPE_MARKER}
local json = escapeMarker(game:GetService("HttpService"):JSONEncode(out))
local n = math.max(1, math.ceil(#json / ${CHUNK}))
for i = 1, n do
	print("${MARK}:${runId}:${ctx}:" .. i .. "/" .. n .. ":" .. string.sub(json, (i - 1) * ${CHUNK} + 1, i * ${CHUNK}))
end
`;
}

// Luau (run in the play context) returning this run's marker lines.
export function readMarkersLuau(runId: string, ctx: PlayContext): string {
  const prefix = `${MARK}:${runId}:${ctx}:`;
  return `local out = {}
for _, e in game:GetService("LogService"):GetLogHistory() do
	if string.sub(e.message, 1, ${prefix.length}) == ${longString(prefix)} then table.insert(out, string.sub(e.message, ${prefix.length + 1})) end
end
return table.concat(out, "\\n")`;
}

// Reassembles "i/n:payload" lines; null until every chunk is present.
export function assembleChunks(text: string): string | null {
  const parts = new Map<number, string>();
  let total = 0;
  for (const line of text.split('\n')) {
    const m = /^(\d+)\/(\d+):([\s\S]*)$/.exec(line);
    if (!m) continue;
    total = Number(m[2]);
    parts.set(Number(m[1]), m[3]);
  }
  if (!total || parts.size < total) return null;
  let s = '';
  for (let i = 1; i <= total; i++) s += parts.get(i) ?? '';
  return s.replace(/%(5C|25)/g, (m) => (m === '%5C' ? '\\' : '%'));
}

// Host error positions ("ServerScriptService.BloxTestHost:12:",
// "Players.X.PlayerScripts.BloxTestHostClient:12:") → "AssistantCommand:12:"
// so the runner's existing position mapping (offset 0) applies.
export function normalizeHostPositions(msg: string): string {
  return msg.replace(/[\w. -]*BloxTestHost(?:Client)?:(\d+)/g, 'AssistantCommand:$1');
}

async function luauText(session: StudioSession, code: string, dm: 'Edit' | 'Server' | 'Client'): Promise<string> {
  const r = await session.call('execute_luau', { code, datamodel_type: dm });
  const text = resultText(r);
  if (r.isError) throw new StudioError('tool_error', `execute_luau (${dm}) failed: ${text.slice(0, 500)}`);
  return text;
}

// Server Script that runs a metrics bot (see metrics/run.ts botProgram).
export const BOT_HOST = { path: ['ServerScriptService', 'BloxBotHost'], className: 'Script' };

// playtest server_code/client_code without the eval bridge: the probe runs in
// an injected Script/LocalScript (full capabilities, same VM as the game, so
// require() and shared work), waits until runProbe sets its BloxGo attribute
// (after the playtest's wait and inputs), and prints its result as markers.
export const PROBE_HOSTS: Record<PlayContext, { path: string[]; className: string }> = {
  server: { path: ['ServerScriptService', 'BloxProbeHost'], className: 'Script' },
  client: { path: ['StarterPlayer', 'StarterPlayerScripts', 'BloxProbeHostClient'], className: 'LocalScript' },
};

const PROBE_SERIALIZE = `local function __ser(v, depth)
	local t = typeof(v)
	if t == "nil" or t == "boolean" or t == "string" then return v end
	if t == "number" then return if v ~= v or v == math.huge or v == -math.huge then tostring(v) else v end
	if t == "Instance" then return v:GetFullName() end
	if t == "table" then
		if depth > 3 then return "<table>" end
		local out, n = {}, 0
		for k, x in v do
			n += 1
			if n > 200 then break end
			out[if type(k) == "number" then k else tostring(k)] = __ser(x, depth + 1)
		end
		return out
	end
	return tostring(v)
end`;

export function probeHostSource(code: string, ctx: PlayContext, runId: string): string {
  return `local function __blox_probe() ${code}
end
${PROBE_SERIALIZE}
while not script:GetAttribute("BloxGo") do task.wait(0.05) end
local packed = table.pack(pcall(__blox_probe))
local out
if packed[1] then
	local values = {}
	for i = 2, packed.n do values[i - 1] = __ser(packed[i], 0) end
	out = { ok = true, values = values }
else
	out = { ok = false, error = tostring(packed[2]) }
end
${ESCAPE_MARKER}
local json = escapeMarker(game:GetService("HttpService"):JSONEncode(out))
local n = math.max(1, math.ceil(#json / ${CHUNK}))
for i = 1, n do
	print("${MARK}:${runId}:probe-${ctx}:" .. i .. "/" .. n .. ":" .. string.sub(json, (i - 1) * ${CHUNK} + 1, i * ${CHUNK}))
end
`;
}

export async function installProbe(session: StudioSession, ctx: PlayContext, code: string, runId: string): Promise<void> {
  await installScript(session, PROBE_HOSTS[ctx], probeHostSource(code, ctx, runId), `${ctx} probe host`);
}

export async function runProbe(
  session: StudioSession,
  ctx: PlayContext,
  runId: string,
  deadlineMs: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<LuauResult> {
  const t0 = Date.now();
  const dm = ctx === 'server' ? 'Server' : 'Client';
  const name = PROBE_HOSTS[ctx].path[PROBE_HOSTS[ctx].path.length - 1];
  const holder = ctx === 'server' ? 'game:GetService("ServerScriptService")' : 'game:GetService("Players").LocalPlayer:FindFirstChild("PlayerScripts")';
  const chunk = ctx === 'server' ? 'serverCode' : 'clientCode';
  await luauText(session, `local h = ${holder}
local s = h and h:FindFirstChild("${name}")
if s then s:SetAttribute("BloxGo", true) end
return s ~= nil`, dm).catch(() => '');
  const prefix = `${MARK}:${runId}:probe-${ctx}:`;
  const read = `local out = {}
for _, e in game:GetService("LogService"):GetLogHistory() do
	if string.sub(e.message, 1, ${prefix.length}) == ${longString(prefix)} then table.insert(out, string.sub(e.message, ${prefix.length + 1})) end
end
return table.concat(out, "\\n")`;
  while (true) {
    const json = assembleChunks(await luauText(session, read, dm).catch(() => ''));
    if (json !== null) {
      try {
        const v = JSON.parse(json) as { ok?: boolean; values?: unknown[]; error?: string };
        const mapped = (m: string) => m.replace(/[\w. -]*BloxProbeHost(?:Client)?:(\d+)/g, `${chunk}:$1`);
        return v.ok
          ? { ok: true, values: Array.isArray(v.values) ? v.values : [], logs: [], durationMs: Date.now() - t0 }
          : { ok: false, values: [], logs: [], error: { message: mapped(String(v.error ?? 'probe failed')) }, durationMs: Date.now() - t0 };
      } catch {
        break;
      }
    }
    if (Date.now() >= deadlineMs) break;
    await sleep(500);
  }
  return { ok: false, values: [], logs: [], error: { message: `no result from the ${ctx} probe script (did it yield forever or error before reporting? see logs)` }, durationMs: Date.now() - t0 };
}

// Removes every blox-injected host script (stale ones from a crashed run too).
export async function removeHosts(session: StudioSession): Promise<void> {
  const paths = [...Object.values(HOSTS), ...Object.values(PROBE_HOSTS), BOT_HOST].map((h) => h.path);
  await luauText(session, `for _, p in game:GetService("HttpService"):JSONDecode(${longString(JSON.stringify(paths))}) do
	local cur = game:GetService(p[1])
	for i = 2, #p do cur = cur and cur:FindFirstChild(p[i]) end
	if cur then cur:Destroy() end
end
return "ok"`, 'Edit');
}

export async function installHost(session: StudioSession, ctx: PlayContext, source: string): Promise<void> {
  await installScript(session, HOSTS[ctx], source, `${ctx} test host`);
}

// Creates a script with normal capabilities via Studio's multi_edit.
export async function installScript(session: StudioSession, h: { path: string[]; className: string }, source: string, what: string): Promise<void> {
  const r = await session.call('multi_edit', {
    file_path: `game.${h.path.join('.')}`,
    className: h.className,
    datamodel_type: 'Edit',
    edits: [{ old_string: '', new_string: source }],
  });
  if (r.isError) throw new StudioError('tool_error', `could not install the ${what} via multi_edit: ${resultText(r).slice(0, 300)}`);
}

export async function pollResults(
  session: StudioSession,
  runId: string,
  ctx: PlayContext,
  deadlineMs: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<unknown | null> {
  const dm = ctx === 'server' ? 'Server' : 'Client';
  while (Date.now() < deadlineMs) {
    const text = await luauText(session, readMarkersLuau(runId, ctx), dm).catch(() => '');
    const json = assembleChunks(text);
    if (json !== null) {
      try {
        return JSON.parse(json);
      } catch {
        return null;
      }
    }
    await sleep(1000);
  }
  return null;
}
