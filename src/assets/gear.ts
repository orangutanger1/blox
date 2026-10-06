import type { FetchLike } from './scoutWeb.js';

// Roblox gears (catalog AssetTypeId 19) are not free, so scout never inserts
// them, but their XML is public on assetdelivery and their Handle mesh and
// texture can be used by id (SpecialMesh.MeshId / TextureId). This reads what a
// game needs to rebuild one: the Tool's Grip, the Handle's size and its mesh.

export const GEAR_TYPE_ID = 19;

export interface GearInfo {
  name: string;
  // Tool.Grip as X, Y, Z, R00..R22 (CFrame.new(...) order).
  grip: number[];
  handleSize: number[];
  mesh: { meshId: number; textureId?: number; scale: number[]; offset: number[] };
}

interface Node { cls: string; props: Record<string, string>; children: Node[] }

// Items nest, and each one's own properties come before its children, so one
// pass over <Item ...> / </Item> tokens rebuilds the tree.
function tree(xml: string): Node[] {
  const roots: Node[] = [];
  const stack: Node[] = [];
  const tok = /<Item class="([^"]+)"[^>]*>|<\/Item>/g;
  for (let m = tok.exec(xml); m; m = tok.exec(xml)) {
    if (!m[1]) {
      stack.pop();
      continue;
    }
    const node: Node = { cls: m[1], props: {}, children: [] };
    const rest = xml.slice(tok.lastIndex);
    const p = /^\s*<Properties>([\s\S]*?)<\/Properties>/.exec(rest);
    if (p) for (const q of p[1].matchAll(/<(\w+) name="(\w+)">([\s\S]*?)<\/\1>/g)) node.props[q[2].toLowerCase()] = q[3];
    (stack.length ? stack[stack.length - 1].children : roots).push(node);
    stack.push(node);
  }
  return roots;
}

const nums = (body: string | undefined, keys: string[]): number[] | null => {
  if (!body) return null;
  const out = keys.map((k) => Number(new RegExp(`<${k}>([^<]*)</${k}>`).exec(body)?.[1]));
  return out.every((n) => Number.isFinite(n)) ? out : null;
};
const CF = ['X', 'Y', 'Z', 'R00', 'R01', 'R02', 'R10', 'R11', 'R12', 'R20', 'R21', 'R22'];
const V3 = ['X', 'Y', 'Z'];
const contentId = (body: string | undefined): number | undefined => {
  const url = body && /<url>([^<]*)<\/url>/.exec(body)?.[1];
  const id = url && /(?:id=|rbxassetid:\/\/)(\d+)/.exec(url)?.[1];
  return id ? Number(id) : undefined;
};
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const text = (body: string | undefined) =>
  (body ?? '').trim().replace(/&(amp|lt|gt|quot|apos|#(\d+));/g, (_, e: string, n?: string) => (n ? String.fromCharCode(Number(n)) : ENTITIES[e]));

export function parseGearXml(xml: string): GearInfo | null {
  const tool = tree(xml).find((n) => n.cls === 'Tool');
  if (!tool) return null;
  const handle = tool.children.find((c) => (c.cls === 'Part' || c.cls === 'MeshPart') && text(c.props.name) === 'Handle');
  const grip = nums(tool.props.grip, CF);
  const size = handle && nums(handle.props.size, V3);
  if (!handle || !grip || !size) return null;
  let mesh: GearInfo['mesh'] | null = null;
  const special = handle.children.find((c) => c.cls === 'SpecialMesh' || c.cls === 'FileMesh');
  if (special) {
    const meshId = contentId(special.props.meshid);
    if (meshId) {
      const textureId = contentId(special.props.textureid);
      mesh = { meshId, ...(textureId ? { textureId } : {}), scale: nums(special.props.scale, V3) ?? [1, 1, 1], offset: nums(special.props.offset, V3) ?? [0, 0, 0] };
    }
  } else if (handle.cls === 'MeshPart') {
    const meshId = contentId(handle.props.meshid);
    if (meshId) {
      const textureId = contentId(handle.props.textureid);
      mesh = { meshId, ...(textureId ? { textureId } : {}), scale: [1, 1, 1], offset: [0, 0, 0] };
    }
  }
  if (!mesh) return null;
  return { name: text(tool.props.name), grip, handleSize: size, mesh };
}

export async function fetchGear(gearId: string, fetch: FetchLike): Promise<GearInfo | null> {
  const r = await fetch(`https://assetdelivery.roblox.com/v1/asset/?id=${gearId}`, { headers: { 'User-Agent': 'blox-scout (+https://github.com/orangutanger1/blox)' } });
  if (!r.ok || !r.text) return null;
  return parseGearXml(await r.text());
}

// The Luau a game uses to rebuild the gear's Handle, scripts left behind.
export function gearSnippet(g: GearInfo): string {
  const v = (a: number[]) => a.map((n) => +n.toFixed(3)).join(', ');
  return [
    `local handle = Instance.new("Part") handle.Name = "Handle" handle.Size = Vector3.new(${v(g.handleSize)})`,
    `local mesh = Instance.new("SpecialMesh") mesh.MeshType = Enum.MeshType.FileMesh`,
    `mesh.MeshId = "rbxassetid://${g.mesh.meshId}"${g.mesh.textureId ? ` mesh.TextureId = "rbxassetid://${g.mesh.textureId}"` : ''}`,
    `mesh.Scale = Vector3.new(${v(g.mesh.scale)}) mesh.Offset = Vector3.new(${v(g.mesh.offset)}) mesh.Parent = handle`,
    `tool.Grip = CFrame.new(${v(g.grip)})  -- a gear's grip rotation often served its own aim animation: check it in hand`,
  ].join('\n');
}
