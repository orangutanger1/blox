// src/onboard/pull.ts
import type { StudioLaunch } from '../bridge/types.js';
import { probeExecuteLuau, type McpClientFactory, type DoctorOptions } from '../doctor.js';

export interface PulledScript {
  fullName: string;
  className: 'Script' | 'LocalScript' | 'ModuleScript';
  source: string;
}

// One page of a paginated dump: the scripts collected this round, plus the
// index to resume from on the next page (< 0 means the walk is complete).
export interface DumpPage {
  scripts: PulledScript[];
  next: number;
}

// Encoded-byte budget per page. execute_luau output is capped by the transport
// (~100KB observed), which truncates a single full dump mid-string on large
// places. The budget is compared against an *estimate of JSON-encoded* size
// (see dumpPageLuau), so it must stay well under the cap once envelope + key
// overhead is added.
export const DUMP_PAGE_BUDGET = 80000;

// Luau run inside Studio (edit mode). Walks game:GetDescendants() counting only
// LuaSourceContainer instances; skips the first `start`, then collects until the
// byte budget is hit. Returns {scripts, next} where next is the index of the
// first uncollected script (or -1 when the walk finished). At least one script
// per page is always emitted so an oversized single source still makes progress.
export function dumpPageLuau(start: number, budget: number): string {
  return `local start, budget = ${start}, ${budget}
local HttpService = game:GetService("HttpService")
local scripts = {}
local idx = 0
local used = 0
local nextStart = -1
for _, inst in ipairs(game:GetDescendants()) do
  if inst:IsA("LuaSourceContainer") then
    if idx >= start then
      local src = inst.Source
      -- *2 approximates worst-case JSON escaping (every char -> \\x) so a page's
      -- encoded size stays under the transport cap; +64 covers key/quote overhead.
      -- ponytail: a single script whose encoded source alone exceeds the ~100KB
      -- cap still truncates (it's emitted whole to guarantee progress). Chunk a
      -- single Source across pages if such places turn up.
      local cost = #src * 2 + #inst:GetFullName() + #inst.ClassName + 64
      if #scripts > 0 and used + cost > budget then
        nextStart = idx
        break
      end
      table.insert(scripts, { fullName = inst:GetFullName(), className = inst.ClassName, source = src })
      used = used + cost
    end
    idx = idx + 1
  end
end
return HttpService:JSONEncode({ scripts = scripts, next = nextStart })`;
}

const KINDS = new Set(['Script', 'LocalScript', 'ModuleScript']);

function parseEntry(raw: unknown, i: number): PulledScript {
  const r = raw as Record<string, unknown>;
  if (typeof r.fullName !== 'string' || typeof r.source !== 'string' || typeof r.className !== 'string' || !KINDS.has(r.className)) {
    throw new Error(`invalid dump entry at index ${i}`);
  }
  return { fullName: r.fullName, className: r.className as PulledScript['className'], source: r.source };
}

export function parseDump(text: string): PulledScript[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`failed to parse script dump: ${(e as Error).message}`);
  }
  if (!Array.isArray(data)) throw new Error('invalid dump: expected a JSON array');
  return data.map(parseEntry);
}

export function parseDumpPage(text: string): DumpPage {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`failed to parse script dump: ${(e as Error).message}`);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('invalid dump page: expected an object envelope');
  }
  const env = data as Record<string, unknown>;
  if (!Array.isArray(env.scripts) || typeof env.next !== 'number') {
    throw new Error('invalid dump page: missing scripts[] or next');
  }
  return { scripts: env.scripts.map(parseEntry), next: env.next };
}

export async function pullScripts(
  launch: StudioLaunch,
  factory?: McpClientFactory,
  opts: DoctorOptions = {},
): Promise<PulledScript[]> {
  const all: PulledScript[] = [];
  let start = 0;
  // Each page opens a fresh execute_luau probe (own connect/attach-retry).
  // The page-count ceiling is a backstop; the real loop exit is next < 0.
  for (let pages = 0; pages < 100000; pages++) {
    const res = await probeExecuteLuau(launch, dumpPageLuau(start, DUMP_PAGE_BUDGET), factory, opts);
    if (!res.attached || res.isError) {
      throw new Error(`could not read scripts from Studio: ${res.text}`);
    }
    const page = parseDumpPage(res.text);
    all.push(...page.scripts);
    if (page.next < 0) return all;
    if (page.next <= start) {
      throw new Error(`script dump did not make progress (next=${page.next}, start=${start})`);
    }
    start = page.next;
  }
  throw new Error('script dump exceeded maximum page count');
}

// Canned sample for `blox init --mock` and tests — exercises nesting + all kinds.
export function mockPulledScripts(): PulledScript[] {
  return [
    { fullName: 'ReplicatedStorage.Greeter', className: 'ModuleScript', source: 'return function() return "hi" end' },
    { fullName: 'ServerScriptService.Hello', className: 'Script', source: 'print("hello")' },
    { fullName: 'StarterPlayer.StarterPlayerScripts.Controller', className: 'LocalScript', source: 'print("client")' },
  ];
}
