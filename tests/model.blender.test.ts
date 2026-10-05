import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runModelPy, type ModelStats } from '../src/model/run.js';
import { blenderBin } from '../src/assets/blender.js';
import { decodePngRgba } from '../src/present/pixels.js';

// Real headless Blender; skipped where it is not installed.
function hasBlender(): boolean {
  try {
    execFileSync(blenderBin(), ['--version'], { stdio: 'ignore', timeout: 60_000 });
    return true;
  } catch {
    return false;
  }
}

async function build(code: string): Promise<ModelStats> {
  const dir = mkdtempSync(join(tmpdir(), 'blox-mblend-'));
  const file = join(dir, 'build.py');
  writeFileSync(file, code);
  return (await runModelPy('run', { blend: join(dir, 'model.blend'), code: file, budget: 1000, name: 'build.py' }, dir)) as unknown as ModelStats;
}

describe.skipIf(!hasBlender())('model stats in Blender', () => {
  it('shape/prism helpers build closed low-poly parts; icon renders a cropped, outlined transparent PNG', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-micon-'));
    const file = join(dir, 'build.py');
    writeFileSync(file, `reset()
shape("ball", "sphere", (2, 2, 2), (0, 0, 1), "#ff8800", segments=12)
shape("ring", "torus", (3, 3, 0.4), (0, 0, 2.2), "#ffcc00", sweep=180, segments=16)
shape("can", "cylinder", (1, 1, 1), (2, 0, 0.5), "#3388ff", bevel=0.1)
prism("star", [(0, 1), (-0.3, 0.3), (-1, 0.3), (-0.45, -0.15), (-0.6, -0.9), (0, -0.45), (0.6, -0.9), (0.45, -0.15), (1, 0.3), (0.3, 0.3)], depth=0.4, at=(-2, 0, 1), color="#ffffff", bevel=0.05)
`);
    const blend = join(dir, 'model.blend');
    const s = (await runModelPy('run', { blend, code: file, budget: 5000, name: 'build.py' }, dir)) as unknown as ModelStats;
    expect(s.issues).toEqual([]);
    expect(Object.keys(s.meshes).sort()).toEqual(['ball', 'can', 'ring', 'star']);
    expect(s.meshes.ball).toBe(12 * 6 * 2 - 24); // uv sphere: quads + pole fans
    const out = join(dir, 'icon.png');
    const r = (await runModelPy('icon', { blend, out, size: 128, samples: 4, outline: 3 }, dir)) as { size: number; outline: number };
    expect(r.outline).toBe(3);
    const img = decodePngRgba(readFileSync(out))!;
    expect(img.w).toBe(r.size);
    expect(img.h).toBe(r.size);
    const a = (x: number, y: number) => img.rgba[(y * img.w + x) * 4 + 3];
    expect(a(0, 0)).toBe(0); // transparent corner
    const mid = Math.floor(img.w / 2);
    let firstOpaque = -1;
    for (let x = 0; x < img.w && firstOpaque < 0; x++) if (a(x, mid) > 200) firstOpaque = x;
    expect(firstOpaque).toBeGreaterThan(0);
    const p = (firstOpaque + 1) * 4 + mid * img.w * 4;
    expect(Math.max(img.rgba[p], img.rgba[p + 1], img.rgba[p + 2])).toBeLessThan(80); // dark outline at the silhouette edge
  }, 180_000);

  it('flags a procedural base colour and counts upload MeshParts', async () => {
    const s = await build(`reset()
a = box("Body", (2, 2, 2), (0, 0, 1), "#ff0000")
b = box("Head", (1, 1, 1), (0, 0, 3), "#00ff00")
m = bpy.data.materials.new("Noisy")
m.use_nodes = True
nt = m.node_tree
noise = nt.nodes.new("ShaderNodeTexNoise")
nt.links.new(noise.outputs["Color"], nt.nodes["Principled BSDF"].inputs["Base Color"])
b.data.materials.clear()
b.data.materials.append(m)
`);
    expect(s.colours).toMatchObject({ Noisy: 'procedural' });
    expect(Object.values(s.colours!).filter((c) => c === 'flat').length).toBe(1);
    expect(s.issues.join('\n')).toMatch(/Noisy.*lost on upload/);
    expect(s.uploadParts).toBe(2);
  }, 180_000);

  it('flat and Color Attribute materials survive; a textured + flat mesh makes 2 MeshParts', async () => {
    const s = await build(`reset()
a = box("Body", (2, 2, 2), (0, 0, 1), "#ff0000")
v = bpy.data.materials.new("Painted")
v.use_nodes = True
ca = v.node_tree.nodes.new("ShaderNodeVertexColor")
v.node_tree.links.new(ca.outputs["Color"], v.node_tree.nodes["Principled BSDF"].inputs["Base Color"])
t = bpy.data.materials.new("Skin")
t.use_nodes = True
img = bpy.data.images.new("skin", 8, 8)
tex = t.node_tree.nodes.new("ShaderNodeTexImage")
tex.image = img
t.node_tree.links.new(tex.outputs["Color"], t.node_tree.nodes["Principled BSDF"].inputs["Base Color"])
a.data.materials.append(t)
a.data.polygons[0].material_index = 1
c = box("Tail", (1, 1, 1), (0, 0, 3), "#0000ff")
c.data.materials.clear()
c.data.materials.append(v)
`);
    expect(s.colours).toMatchObject({ Painted: 'vertex', Skin: 'texture' });
    expect(s.issues.filter((i) => /upload/.test(i))).toEqual([]);
    expect(s.uploadParts).toBe(3);
  }, 180_000);

  it('export bake keeps painted vertex colours instead of flattening them', async () => {
    // An assertion failure inside the build script fails the run (BLOX_ERROR).
    await build(`reset()
c = box("Tail", (1, 1, 1), (0, 0, 1), "#0000ff")
attr = c.data.color_attributes.new("Paint", "BYTE_COLOR", "CORNER")
for d in attr.data:
    d.color = (1.0, 0.5, 0.0, 1.0)
v = bpy.data.materials.new("Painted")
v.use_nodes = True
ca = v.node_tree.nodes.new("ShaderNodeVertexColor")
ca.layer_name = "Paint"
v.node_tree.links.new(ca.outputs["Color"], v.node_tree.nodes["Principled BSDF"].inputs["Base Color"])
c.data.materials.clear()
c.data.materials.append(v)
bake_vertex_colors([c])
col = c.data.color_attributes["Col"]
r, g, b, _ = col.data[0].color
# Paint set in linear 0.5 reads as sRGB ~0.735; "Col" stores sRGB.
assert abs(r - 1.0) < 0.02 and abs(g - 0.735) < 0.03 and b < 0.02, (r, g, b)
`);
  }, 180_000);

  it('paint already in "Col" (float corner or byte point) survives the bake', async () => {
    await build(`reset()
a = box("A", (1, 1, 1), (0, 0, 1), "#0000ff")
b = box("B", (1, 1, 1), (3, 0, 1), "#0000ff")
fa = a.data.color_attributes.new("Col", "FLOAT_COLOR", "CORNER")
for d in fa.data:
    d.color = (1.0, 0.0, 0.0, 1.0)
fb = b.data.color_attributes.new("Col", "BYTE_COLOR", "POINT")
for d in fb.data:
    d.color = (0.0, 1.0, 0.0, 1.0)
for o in (a, b):
    m = bpy.data.materials.new("P_" + o.name)
    m.use_nodes = True
    ca = m.node_tree.nodes.new("ShaderNodeVertexColor")
    ca.layer_name = "Col"
    m.node_tree.links.new(ca.outputs["Color"], m.node_tree.nodes["Principled BSDF"].inputs["Base Color"])
    o.data.materials.clear()
    o.data.materials.append(m)
bake_vertex_colors([a, b])
ra = a.data.color_attributes["Col"].data[0].color
rb = b.data.color_attributes["Col"].data[0].color
assert ra[0] > 0.98 and ra[1] < 0.02, tuple(ra)
assert rb[1] > 0.98 and rb[0] < 0.02, tuple(rb)
assert a.data.color_attributes["Col"].domain == "CORNER"
`);
  }, 180_000);

  it('a Reroute between the Color Attribute and Base Color is still vertex colour', async () => {
    const s = await build(`reset()
c = box("Tail", (1, 1, 1), (0, 0, 1), "#0000ff")
attr = c.data.color_attributes.new("Paint", "FLOAT_COLOR", "CORNER")
for d in attr.data:
    d.color = (1.0, 0.0, 0.0, 1.0)
v = bpy.data.materials.new("Rerouted")
v.use_nodes = True
nt = v.node_tree
ca = nt.nodes.new("ShaderNodeVertexColor")
ca.layer_name = "Paint"
rr = nt.nodes.new("NodeReroute")
nt.links.new(ca.outputs["Color"], rr.inputs[0])
nt.links.new(rr.outputs[0], nt.nodes["Principled BSDF"].inputs["Base Color"])
c.data.materials.clear()
c.data.materials.append(v)
assert colour_class(v) == "vertex", colour_class(v)
`);
    expect(s.colours).toMatchObject({ Rerouted: 'vertex' });
  }, 180_000);

  it('an image that is not the base colour (unconnected, or a normal map) is not a texture', async () => {
    const s = await build(`reset()
c = box("Rock", (1, 1, 1), (0, 0, 1), "#888888")
img = bpy.data.images.new("bump", 4, 4)
m = bpy.data.materials.new("Bumpy")
m.use_nodes = True
nt = m.node_tree
loose = nt.nodes.new("ShaderNodeTexImage")
loose.image = img
tex = nt.nodes.new("ShaderNodeTexImage")
tex.image = img
nm = nt.nodes.new("ShaderNodeNormalMap")
nt.links.new(tex.outputs["Color"], nm.inputs["Color"])
nt.links.new(nm.outputs["Normal"], nt.nodes["Principled BSDF"].inputs["Normal"])
c.data.materials.clear()
c.data.materials.append(m)
assert colour_class(m) == "flat", colour_class(m)
`);
    expect(s.colours).toMatchObject({ Bumpy: 'flat' });
    expect(s.uploadParts).toBe(1);
  }, 180_000);

  it('a Color Attribute node with no name bakes the default (render) attribute, not the active one', async () => {
    await build(`reset()
c = box("Tail", (1, 1, 1), (0, 0, 1), "#0000ff")
red = c.data.color_attributes.new("Red", "FLOAT_COLOR", "CORNER")
for d in red.data:
    d.color = (1.0, 0.0, 0.0, 1.0)
green = c.data.color_attributes.new("Green", "FLOAT_COLOR", "CORNER")
for d in green.data:
    d.color = (0.0, 1.0, 0.0, 1.0)
c.data.color_attributes.render_color_index = c.data.color_attributes.find("Red")
c.data.color_attributes.active_color = green
v = bpy.data.materials.new("Unnamed")
v.use_nodes = True
ca = v.node_tree.nodes.new("ShaderNodeVertexColor")
ca.layer_name = ""
v.node_tree.links.new(ca.outputs["Color"], v.node_tree.nodes["Principled BSDF"].inputs["Base Color"])
c.data.materials.clear()
c.data.materials.append(v)
bake_vertex_colors([c])
r, g, b, _ = c.data.color_attributes["Col"].data[0].color
assert r > 0.98 and g < 0.02, (r, g, b)
`);
  }, 180_000);
});
