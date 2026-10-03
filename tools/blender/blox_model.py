"""blox model helpers — build Roblox-ready, rig-ready models in Blender.

Available inside `blox model run` code (already imported: bpy, math, Vector).
Units: 1 Blender unit = 1 stud. Z is up in Blender; export maps it to Roblox Y.

  reset()                                  empty the scene
  material(color)                          "#rrggbb" or (r, g, b) 0-1 → material
  box(name, size, at, color, rot=(0,0,0))  one cube (size in studs, at = centre)
  voxels(name, cells, unit=1.0, at=(0,0,0))
      cells: iterable of (x, y, z, color); faces between filled cells are
      culled, so a blocky model stays low-poly. Returns one mesh object.
  join(objs, name)                         merge mesh objects
  rig(name, bones)                         bones: [{name, head, tail, parent?}]
  bind_rigid(armature, parts, name)        parts: {bone: [mesh objects]} → one
      skinned mesh, every vertex 100% on its part's bone (blocky rigs)
  animate(armature, action, keys, loop=True)
      keys: {frame: {bone: {"rot": (x, y, z) degrees, "loc": (x, y, z)}}}
      Each action is stored on its own NLA track so all of them export.

Export helpers (used by `model export` and `asset normalize`):
  bake_vertex_colors(objs)   flat material colours → one vertex-coloured material
  export_glb(path, objs)     Roblox upload format (1 unit = 1 stud, front = -Z;
                             set MeshPart.Color white after insert)
Colours are "#rrggbb" sRGB as you see them; materials store them linear.
"""
import math

import bmesh
import bpy
from mathutils import Euler, Vector

_mats = {}


def reset():
    for coll in (bpy.data.objects, bpy.data.meshes, bpy.data.materials, bpy.data.armatures, bpy.data.actions):
        for item in list(coll):
            coll.remove(item)
    _mats.clear()


def _rgb(color):
    if isinstance(color, str):
        h = color.lstrip("#")
        return tuple(int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4))
    return tuple(color[:3])


def to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def to_srgb(c):
    c = max(0.0, min(1.0, c))
    return c * 12.92 if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055


def material(color):
    rgb = _rgb(color)
    key = "C_%02x%02x%02x" % tuple(int(round(c * 255)) for c in rgb)
    m = _mats.get(key) or bpy.data.materials.get(key)
    if m is None:
        lin = tuple(to_linear(c) for c in rgb)
        m = bpy.data.materials.new(key)
        m.use_nodes = True
        bsdf = m.node_tree.nodes.get("Principled BSDF")
        bsdf.inputs["Base Color"].default_value = (*lin, 1.0)
        bsdf.inputs["Roughness"].default_value = 0.8
        m.diffuse_color = (*lin, 1.0)
    _mats[key] = m
    return m


def _link(obj):
    bpy.context.scene.collection.objects.link(obj)
    return obj


def box(name, size=(1, 1, 1), at=(0, 0, 0), color="#cccccc", rot=(0, 0, 0)):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=Vector(size), verts=bm.verts)
    bm.to_mesh(me)
    bm.free()
    obj = _link(bpy.data.objects.new(name, me))
    obj.location = Vector(at)
    obj.rotation_euler = Euler([math.radians(a) for a in rot])
    me.materials.append(material(color))
    return obj


_FACES = [
    ((1, 0, 0), [(1, 0, 0), (1, 1, 0), (1, 1, 1), (1, 0, 1)]),
    ((-1, 0, 0), [(0, 0, 0), (0, 0, 1), (0, 1, 1), (0, 1, 0)]),
    ((0, 1, 0), [(0, 1, 0), (0, 1, 1), (1, 1, 1), (1, 1, 0)]),
    ((0, -1, 0), [(0, 0, 0), (1, 0, 0), (1, 0, 1), (0, 0, 1)]),
    ((0, 0, 1), [(0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1)]),
    ((0, 0, -1), [(0, 0, 0), (0, 1, 0), (1, 1, 0), (1, 0, 0)]),
]


def voxels(name, cells, unit=1.0, at=(0, 0, 0)):
    filled = {}
    for c in cells:
        filled[(int(c[0]), int(c[1]), int(c[2]))] = c[3] if len(c) > 3 else "#cccccc"
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    slots = {}
    for (x, y, z), color in filled.items():
        for (dx, dy, dz), quad in _FACES:
            if (x + dx, y + dy, z + dz) in filled:
                continue
            vs = [bm.verts.new(((x + qx) * unit, (y + qy) * unit, (z + qz) * unit)) for qx, qy, qz in quad]
            f = bm.faces.new(vs)
            m = material(color)
            if m.name not in slots:
                slots[m.name] = len(slots)
                me.materials.append(m)
            f.material_index = slots[m.name]
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bm.to_mesh(me)
    bm.free()
    obj = _link(bpy.data.objects.new(name, me))
    obj.location = Vector(at)
    return obj


def _select_only(objs, active):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = active


def join(objs, name):
    objs = [o for o in objs if o.type == "MESH"]
    if len(objs) == 1:
        objs[0].name = name
        return objs[0]
    _select_only(objs, objs[0])
    bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    obj.name = name
    return obj


def rig(name, bones):
    arm = bpy.data.armatures.new(name)
    obj = _link(bpy.data.objects.new(name, arm))
    _select_only([obj], obj)
    bpy.ops.object.mode_set(mode="EDIT")
    made = {}
    for b in bones:
        eb = arm.edit_bones.new(b["name"])
        eb.head = Vector(b["head"])
        eb.tail = Vector(b["tail"])
        made[b["name"]] = eb
    for b in bones:
        if b.get("parent"):
            made[b["name"]].parent = made[b["parent"]]
    bpy.ops.object.mode_set(mode="OBJECT")
    return obj


def bind_rigid(armature, parts, name):
    pieces = []
    for bone, objs in parts.items():
        for o in objs:
            _select_only([o], o)
            bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
            vg = o.vertex_groups.new(name=bone)
            vg.add([v.index for v in o.data.vertices], 1.0, "REPLACE")
            pieces.append(o)
    mesh = join(pieces, name)
    mod = mesh.modifiers.new("Armature", "ARMATURE")
    mod.object = armature
    mesh.parent = armature
    return mesh


def animate(armature, action, keys, loop=True):
    keys = {int(f): pose for f, pose in keys.items()}
    frames = sorted(keys)
    if loop and len(frames) > 1:
        # Close the loop: repeat the first pose one step after the last key.
        end = frames[-1] + (frames[1] - frames[0])
        keys[end] = keys[frames[0]]
        frames.append(end)
    armature.animation_data_create()
    act = bpy.data.actions.new(action)
    armature.animation_data.action = act
    for f in frames:
        for bone, t in keys[f].items():
            pb = armature.pose.bones[bone]
            pb.rotation_mode = "XYZ"
            if "rot" in t:
                pb.rotation_euler = Euler([math.radians(a) for a in t["rot"]])
                pb.keyframe_insert("rotation_euler", frame=f)
            if "loc" in t:
                pb.location = Vector(t["loc"])
                pb.keyframe_insert("location", frame=f)
    act.frame_range = (frames[0], frames[-1])
    act["blox_loop"] = bool(loop)
    track = armature.animation_data.nla_tracks.new()
    track.name = action
    track.strips.new(action, frames[0], act)
    armature.animation_data.action = None
    rest(armature)
    return act


def rest(armature):
    """Clear the pose back to the rest pose (keyframing leaves the last key applied)."""
    for pb in armature.pose.bones:
        pb.location = (0, 0, 0)
        pb.rotation_euler = (0, 0, 0)
        pb.rotation_quaternion = (1, 0, 0, 0)
        pb.scale = (1, 1, 1)


# --- Roblox export --------------------------------------------------------------
# Roblox makes one MeshPart per material slot and drops flat material colours
# (they arrive white/grey); vertex colours and packed image textures survive.
# Studio reads glTF vertex colours as sRGB, so they are written as sRGB numbers,
# and multiplies them by MeshPart.Color (set it to white after inserting).

VERTEX_MATERIAL = "BloxVertexColor"


def _has_texture(mat):
    return bool(mat and mat.use_nodes and any(n.type == "TEX_IMAGE" and n.image for n in mat.node_tree.nodes))


def _base_link(mat):
    """The node feeding the Principled BSDF's Base Color, or None."""
    if not (mat and mat.use_nodes):
        return None
    bsdf = next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if bsdf is None or not bsdf.inputs["Base Color"].is_linked:
        return None
    return bsdf.inputs["Base Color"].links[0].from_node


def _image_ok(img):
    if img is None:
        return False
    if img.packed_file or img.source == "GENERATED":
        return True
    import os
    return bool(img.filepath) and os.path.exists(bpy.path.abspath(img.filepath))


def colour_class(mat):
    """How a material's colour fares on a Roblox upload:
    flat (baked into vertex colours on export), vertex (Color Attribute, kept),
    texture (image, embedded), procedural / missing-image (arrive white)."""
    if mat is None or mat.name == VERTEX_MATERIAL:
        return "vertex" if mat is not None else "flat"
    if _has_texture(mat):
        imgs = [n.image for n in mat.node_tree.nodes if n.type == "TEX_IMAGE" and n.image]
        return "texture" if all(_image_ok(i) for i in imgs) else "missing-image"
    src = _base_link(mat)
    if src is None:
        return "flat"
    if src.type in ("VERTEX_COLOR", "ATTRIBUTE"):
        return "vertex"
    return "procedural"


def _vertex_source(mat, me):
    """The colour attribute a vertex-colour material reads (None → active)."""
    src = _base_link(mat)
    name = getattr(src, "layer_name", "") or getattr(src, "attribute_name", "")
    return me.color_attributes.get(name) if name else me.color_attributes.active_color


def upload_parts(objs):
    """MeshParts an upload makes after the bake: per mesh, one for all its
    flat/vertex-coloured faces plus one per textured material it uses."""
    n = 0
    for o in objs:
        if o.type != "MESH":
            continue
        mats = [s.material for s in o.material_slots]
        used = {p.material_index for p in o.data.polygons} or {0}
        textured = {i for i in used if i < len(mats) and _has_texture(mats[i])}
        n += len(textured) + (1 if used - textured else 0)
    return n


def _flat_color(mat):
    if mat is None:
        return (0.8, 0.8, 0.8)
    if mat.use_nodes:
        bsdf = next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
        if bsdf is not None and not bsdf.inputs["Base Color"].is_linked:
            return tuple(bsdf.inputs["Base Color"].default_value[:3])
    return tuple(mat.diffuse_color[:3])


def _vertex_material():
    m = bpy.data.materials.get(VERTEX_MATERIAL)
    if m is None:
        m = bpy.data.materials.new(VERTEX_MATERIAL)
        m.use_nodes = True
        nt = m.node_tree
        bsdf = nt.nodes.get("Principled BSDF")
        bsdf.inputs["Roughness"].default_value = 0.8
        attr = nt.nodes.new("ShaderNodeVertexColor")
        attr.layer_name = "Col"
        # The attribute holds sRGB numbers (what Studio expects); a gamma node
        # turns them back into linear so Blender renders still look right.
        gamma = nt.nodes.new("ShaderNodeGamma")
        gamma.inputs["Gamma"].default_value = 2.2
        nt.links.new(attr.outputs["Color"], gamma.inputs["Color"])
        nt.links.new(gamma.outputs["Color"], bsdf.inputs["Base Color"])
    return m


def bake_vertex_colors(objs):
    """Bake every untextured material's flat colour into a "Col" corner
    attribute and replace those materials with one shared vertex-colour
    material. Textured materials stay (their packed image survives upload).
    Returns {"materials": n_after, "baked": n_faces, "textured": n_textured}."""
    vmat = _vertex_material()
    baked = textured = 0
    for o in objs:
        if o.type != "MESH":
            continue
        me = o.data
        mats = [s.material for s in o.material_slots]
        col = me.color_attributes.get("Col") or me.color_attributes.new("Col", "FLOAT_COLOR", "CORNER")
        keep = {}  # old slot index -> new slot index (textured materials)
        new_mats = [vmat]
        for i, m in enumerate(mats):
            if _has_texture(m):
                keep[i] = len(new_mats)
                new_mats.append(m)
        # Painted materials keep their colours: read them before "Col" is overwritten.
        painted = {}
        for i, m in enumerate(mats):
            if i not in keep and m is not None and colour_class(m) == "vertex":
                attr = _vertex_source(m, me)
                if attr is not None and attr.name != col.name:
                    painted[i] = attr
        for poly in me.polygons:
            m = mats[poly.material_index] if poly.material_index < len(mats) else None
            if poly.material_index in keep:
                textured += 1
                rgb = (1.0, 1.0, 1.0)
            elif poly.material_index in painted:
                attr = painted[poly.material_index]
                for li, vi in zip(poly.loop_indices, poly.vertices):
                    # "Col" holds sRGB values (as the flat bake writes them).
                    c = attr.data[li if attr.domain == "CORNER" else vi].color_srgb
                    col.data[li].color = (c[0], c[1], c[2], 1.0)
                baked += 1
                continue
            else:
                rgb = tuple(to_srgb(c) for c in _flat_color(m))
                baked += 1
            for li in poly.loop_indices:
                col.data[li].color = (*rgb, 1.0)
        idx = [keep.get(p.material_index, 0) for p in me.polygons]
        me.materials.clear()
        for m in new_mats:
            me.materials.append(m)
        for p, i in zip(me.polygons, idx):
            p.material_index = i
        me.color_attributes.active_color = col
    used = {m.name for o in objs if o.type == "MESH" for m in o.data.materials if m}
    return {"materials": len(used), "baked": baked, "textured": textured}


def export_glb(path, objs, animations=False):
    """GLB for Open Cloud upload: 1 Blender unit = 1 stud. Blender's front
    (-Y) exports as glTF +Z, which Roblox's importer turns to its look
    direction (-Z); verified live. After inserting, set each MeshPart's Color to
    white: Studio multiplies vertex colours by it (default grey 163)."""
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    try:
        bpy.ops.export_scene.gltf(
            filepath=path,
            export_format="GLB",
            use_selection=True,
            export_apply=True,
            export_animations=animations,
            export_vertex_color="ACTIVE",
        )
    except TypeError:  # older/newer exporter without export_vertex_color
        bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True, export_apply=True, export_animations=animations)
