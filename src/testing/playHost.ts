import { randomBytes } from 'node:crypto';
import { longString } from '../studio/luau.js';
import { StudioError, resultText, type StudioSession } from '../studio/session.js';

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

export function newRunId(): string {
  return randomBytes(4).toString('hex');
}

// Host script source. `program` is testProgram() output (top-level code ending
// in `return { results, fileErrors }`). It is wrapped on the SAME first line so
// host line N == program line N and spec positions map unchanged.
export function hostSource(program: string, ctx: PlayContext, runId: string): string {
  const wait = ctx === 'server'
    ? `local Players = game:GetService("Players")
local t0 = os.clock()
while #Players:GetPlayers() == 0 and os.clock() - t0 < 30 do task.wait(0.1) end
local p = Players:GetPlayers()[1]
if p and not p.Character then p.CharacterAdded:Wait() end`
    : `local p = game:GetService("Players").LocalPlayer
if not p.Character then p.CharacterAdded:Wait() end`;
  return `local function __blox_run() ${program}
end
${wait}
local ok, out = pcall(__blox_run)
if not ok then out = { results = {}, fileErrors = { { file = "<host>", message = tostring(out) } } } end
local json = game:GetService("HttpService"):JSONEncode(out)
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
  return s;
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

export async function removeHosts(session: StudioSession): Promise<void> {
  const paths = Object.values(HOSTS).map((h) => h.path);
  await luauText(session, `for _, p in game:GetService("HttpService"):JSONDecode(${longString(JSON.stringify(paths))}) do
	local cur = game:GetService(p[1])
	for i = 2, #p do cur = cur and cur:FindFirstChild(p[i]) end
	if cur then cur:Destroy() end
end
return "ok"`, 'Edit');
}

export async function installHost(session: StudioSession, ctx: PlayContext, source: string): Promise<void> {
  const h = HOSTS[ctx];
  const r = await session.call('multi_edit', {
    file_path: `game.${h.path.join('.')}`,
    className: h.className,
    datamodel_type: 'Edit',
    edits: [{ old_string: '', new_string: source }],
  });
  if (r.isError) throw new StudioError('tool_error', `could not install the ${ctx} test host via multi_edit: ${resultText(r).slice(0, 300)}`);
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
