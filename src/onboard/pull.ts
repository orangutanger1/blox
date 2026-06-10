// src/onboard/pull.ts
import type { StudioLaunch } from '../bridge/types.js';
import { probeExecuteLuau, type McpClientFactory, type DoctorOptions } from '../doctor.js';

export interface PulledScript {
  fullName: string;
  className: 'Script' | 'LocalScript' | 'ModuleScript';
  source: string;
}

// Luau run inside Studio (edit mode) that walks the DataModel and JSON-encodes
// every script instance. execute_luau returns this string as its text output.
export const DUMP_LUAU = `local HttpService = game:GetService("HttpService")
local out = {}
for _, inst in ipairs(game:GetDescendants()) do
  if inst:IsA("LuaSourceContainer") then
    table.insert(out, { fullName = inst:GetFullName(), className = inst.ClassName, source = inst.Source })
  end
end
return HttpService:JSONEncode(out)`;

const KINDS = new Set(['Script', 'LocalScript', 'ModuleScript']);

export function parseDump(text: string): PulledScript[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`failed to parse script dump: ${(e as Error).message}`);
  }
  if (!Array.isArray(data)) throw new Error('invalid dump: expected a JSON array');
  return data.map((raw, i) => {
    const r = raw as Record<string, unknown>;
    if (typeof r.fullName !== 'string' || typeof r.source !== 'string' || typeof r.className !== 'string' || !KINDS.has(r.className)) {
      throw new Error(`invalid dump entry at index ${i}`);
    }
    return { fullName: r.fullName, className: r.className as PulledScript['className'], source: r.source };
  });
}

export async function pullScripts(
  launch: StudioLaunch,
  factory?: McpClientFactory,
  opts: DoctorOptions = {},
): Promise<PulledScript[]> {
  const res = await probeExecuteLuau(launch, DUMP_LUAU, factory, opts);
  if (!res.attached || res.isError) {
    throw new Error(`could not read scripts from Studio: ${res.text}`);
  }
  return parseDump(res.text);
}

// Canned sample for `blox init --mock` and tests — exercises nesting + all kinds.
export function mockPulledScripts(): PulledScript[] {
  return [
    { fullName: 'ReplicatedStorage.Greeter', className: 'ModuleScript', source: 'return function() return "hi" end' },
    { fullName: 'ServerScriptService.Hello', className: 'Script', source: 'print("hello")' },
    { fullName: 'StarterPlayer.StarterPlayerScripts.Controller', className: 'LocalScript', source: 'print("client")' },
  ];
}
