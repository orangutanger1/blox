import { runLuau } from '../studio/luau.js';
import type { StudioSession } from '../studio/session.js';

// An image uploaded through Open Cloud becomes a Decal asset; ImageLabel.Image
// and friends need the Image asset inside it. Loading the decal in Studio and
// reading Decal.Texture gives that id. A fresh upload can take a few seconds to
// clear moderation before it loads, hence the retries.

export function decalImageLuau(decalId: number): string {
  return `local id = ${Math.floor(decalId)}
local ok, model = pcall(function() return game:GetService("InsertService"):LoadAsset(id) end)
if not ok or not model then
	local ok2, objs = pcall(function() return game:GetObjects("rbxassetid://" .. id) end)
	if ok2 and objs and objs[1] then model = objs[1] else error("could not load decal " .. id .. ": " .. tostring(model), 0) end
end
local d = model:IsA("Decal") and model or model:FindFirstChildWhichIsA("Decal", true)
local tex = d and d.Texture or ""
model:Destroy()
return tex`;
}

export function parseImageId(texture: unknown): number | null {
  if (typeof texture !== 'string') return null;
  const m = /(?:rbxassetid:\/\/|[?&]id=)(\d+)/.exec(texture);
  return m ? Number(m[1]) : null;
}

export async function resolveDecalImage(session: StudioSession, decalId: number, o: { attempts?: number; sleep?: (ms: number) => Promise<void>; delayMs?: number } = {}): Promise<number> {
  const attempts = o.attempts ?? 5;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last = '';
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(o.delayMs ?? 3000);
    const r = await runLuau(session, decalImageLuau(decalId), 'edit', { chunkName: 'decalImage' });
    if (r.ok) {
      const id = parseImageId(r.values[0]);
      if (id) return id;
      last = `decal ${decalId} has no image texture (got ${JSON.stringify(r.values[0])})`;
    } else {
      last = r.error?.message ?? 'load failed';
    }
  }
  throw new Error(`could not resolve the image id of decal ${decalId}: ${last}`);
}
