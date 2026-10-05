"""blox model helpers — build Roblox-ready, rig-ready models in Blender.

Available inside `blox model run` code (already imported: bpy, math, Vector).
Units: 1 Blender unit = 1 stud. Z is up in Blender; export maps it to Roblox Y.

  reset()                                  empty the scene
  material(color)                          "#rrggbb" or (r, g, b) 0-1 → material
  box(name, size, at, color, rot=(0,0,0))  one cube (size in studs, at = centre)
  shape(name, kind, size, at, color, rot=(0,0,0), segments=16, bevel=0, smooth=True)
      kind: sphere | cylinder | cone | torus | ico | cube. size = full extents
      in studs (x, y, z); cone tapers to size[0]*taper (taper=0 → point);
      torus: size x/y = outer diameter, size z = tube thickness. bevel rounds
      edges (studs). Low segment counts keep the low-poly look.
      torus sweep=<degrees> makes an arc (a C, a lock shackle, a rebirth arrow).
  prism(name, points, depth, at, color, rot=(0,0,0), bevel=0)
      2D outline [(x, z), …] (counter-clockwise, front view) extruded along Y
      by depth studs: stars, bolts, flames, arrows, flags.
  smooth(obj, angle=40)                    smooth shading up to a crease angle
  voxels(name, cells, unit=1.0, at=(0,0,0))
      cells: iterable of (x, y, z, color); faces between filled cells are
      culled, so a blocky model stays low-poly. Returns one mesh object.
  join(objs, name)                         merge mesh objects
  rig(name, bones)                         bones: [{name, head, tail, parent?}]
  bind_rigid(armature, parts, name)        parts: {bone: [mesh objects]} → one
      skinned mesh, every vertex 100% on its part's bone (blocky rigs)
  rig_rigid(armature, parts)               parts: {bone: [mesh objects]} → each
      piece stays its own object (no join, no skin); model export then writes a
      pieces-only model.glb + pivots.json for a Studio Motor6D rig
      (animate rig joints:"blender"). The biggest piece on a bone carries its
      joint; the rest ride it.
  animate(armature, action, keys, loop=True)
      keys: {frame: {bone: {"rot": (x, y, z) degrees, "loc": (x, y, z)}}}
      Each action is stored on its own NLA track so all of them export.

Export helpers (used by `model export` and `asset normalize`):
  bake_vertex_colors(objs)   flat material colours → one vertex-coloured material
  export_glb(path, objs)     Roblox upload format (1 unit = 1 stud, front = -Z;
                             set MeshPart.Color white after insert)
Colours are "#rrggbb" sRGB as you see them; materials store them linear.
"""
import json
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


def material(color, roughness=0.8):
    rgb = _rgb(color)
    key = "C_%02x%02x%02x" % tuple(int(round(c * 255)) for c in rgb)
    if roughness != 0.8:
        key += "_r%02d" % int(round(roughness * 100))
    m = _mats.get(key) or bpy.data.materials.get(key)
    if m is None:
        lin = tuple(to_linear(c) for c in rgb)
        m = bpy.data.materials.new(key)
        m.use_nodes = True
        bsdf = m.node_tree.nodes.get("Principled BSDF")
        bsdf.inputs["Base Color"].default_value = (*lin, 1.0)
        bsdf.inputs["Roughness"].default_value = roughness
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


def shape(name, kind, size=(1, 1, 1), at=(0, 0, 0), color="#cccccc", rot=(0, 0, 0), segments=16, bevel=0.0, smooth=True, taper=0.0, roughness=0.8, sweep=360.0):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    seg = max(3, int(segments))
    if kind == "sphere":
        bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=max(3, seg // 2), radius=0.5)
    elif kind == "ico":
        bmesh.ops.create_icosphere(bm, subdivisions=max(1, min(4, seg // 8)), radius=0.5)
    elif kind in ("cylinder", "cone"):
        r2 = 0.5 if kind == "cylinder" else 0.5 * taper
        bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=seg, radius1=0.5, radius2=r2, depth=1.0)
    elif kind == "cube":
        bmesh.ops.create_cube(bm, size=1.0)
    elif kind == "torus":
        sx, sy, sz = size
        tube = sz / 2.0
        major = max(sx, sy) / 2.0 - tube
        ring = max(3, seg // 2)
        rows = []
        closed = sweep >= 360
        steps = seg if closed else seg + 1
        for i in range(steps):
            a = math.radians(sweep) * i / seg
            row = []
            for j in range(ring):
                b = 2 * math.pi * j / ring
                r = major + tube * math.cos(b)
                row.append(bm.verts.new((r * math.cos(a), r * math.sin(a), tube * math.sin(b))))
            rows.append(row)
        for i in range(seg):
            for j in range(ring):
                a, b = rows[i], rows[(i + 1) % steps]
                bm.faces.new((a[j], b[j], b[(j + 1) % ring], a[(j + 1) % ring]))
        if not closed:
            bm.faces.new(list(reversed(rows[0])))
            bm.faces.new(rows[-1])
        size = (1, 1, 1)
    else:
        bm.free()
        raise ValueError("shape kind must be sphere, ico, cylinder, cone, torus or cube, not %r" % kind)
    bmesh.ops.scale(bm, vec=Vector(size), verts=bm.verts)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    if bevel > 0 and kind in ("cube", "cylinder", "cone"):
        edges = [e for e in bm.edges if not e.is_manifold or e.calc_face_angle(0) > math.radians(30)]
        bmesh.ops.bevel(bm, geom=edges, offset=bevel, segments=2, profile=0.5, affect="EDGES")
    bm.to_mesh(me)
    bm.free()
    obj = _link(bpy.data.objects.new(name, me))
    obj.location = Vector(at)
    obj.rotation_euler = Euler([math.radians(a) for a in rot])
    me.materials.append(material(color, roughness))
    if smooth:
        smooth_shade(obj)
    return obj


def prism(name, points, depth=0.5, at=(0, 0, 0), color="#cccccc", rot=(0, 0, 0), bevel=0.0, roughness=0.8):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    front = [bm.verts.new((x, -depth / 2, z)) for x, z in points]
    back = [bm.verts.new((x, depth / 2, z)) for x, z in points]
    n = len(points)
    bm.faces.new(front)
    bm.faces.new(list(reversed(back)))
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((front[j], front[i], back[i], back[j]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    # concave outlines (stars, bolts) need real triangles, not one n-gon
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 4])
    if bevel > 0:
        edges = [e for e in bm.edges if e.calc_face_angle(0) > math.radians(30)]
        bmesh.ops.bevel(bm, geom=edges, offset=bevel, segments=2, profile=0.5, affect="EDGES", clamp_overlap=True)
    bm.to_mesh(me)
    bm.free()
    obj = _link(bpy.data.objects.new(name, me))
    obj.location = Vector(at)
    obj.rotation_euler = Euler([math.radians(a) for a in rot])
    me.materials.append(material(color, roughness))
    smooth_shade(obj, 30)
    return obj


def smooth_shade(obj, angle=40):
    for p in obj.data.polygons:
        p.use_smooth = True
    if hasattr(obj.data, "set_sharp_from_angle"):
        obj.data.set_sharp_from_angle(angle=math.radians(angle))
    return obj


smooth = smooth_shade


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


def rig_rigid(armature, parts):
    names = {b.name for b in armature.data.bones}
    m = {}
    for bone, objs in parts.items():
        if bone not in names:
            raise ValueError("rig_rigid: no bone named %s" % bone)
        for o in objs:
            _select_only([o], o)
            bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
            m[o.name] = bone
    armature["blox_rigid"] = json.dumps(m)
    return armature


def rigid_pivots(armature):
    """pivots.json for `animate rig joints:"blender"`: each piece's world
    bounds, and for each bone carrying pieces a joint at the bone's head from
    the nearest ancestor bone's main piece (its biggest). A bone's other pieces
    ride its main piece. On a root bone the extra pieces get their own joint
    to the main piece, at the point of it nearest their centre (the trunk has no
    joint for them to ride)."""
    m = json.loads(armature["blox_rigid"])
    pieces, by_bone, lo_hi = {}, {}, {}
    for name, bone in m.items():
        o = bpy.data.objects[name]
        pts = [o.matrix_world @ v.co for v in o.data.vertices]
        lo = [min(p[i] for p in pts) for i in range(3)]
        hi = [max(p[i] for p in pts) for i in range(3)]
        lo_hi[name] = (lo, hi)
        pieces[name] = {
            "name": name,
            "bone": bone,
            "center": [round((lo[i] + hi[i]) / 2, 6) for i in range(3)],
            "size": [round(hi[i] - lo[i], 6) for i in range(3)],
        }
        by_bone.setdefault(bone, []).append(name)

    def vol(n):
        s = pieces[n]["size"]
        return s[0] * s[1] * s[2]

    for names in by_bone.values():
        names.sort(key=lambda n: (-vol(n), n))
    main = {bone: names[0] for bone, names in by_bone.items()}
    joints, riders = [], {}
    mw = armature.matrix_world
    for b in armature.data.bones:
        if b.name not in main:
            continue
        names = by_bone[b.name]
        anc = b.parent
        while anc is not None and anc.name not in main:
            anc = anc.parent
        if anc is None:
            lo, hi = lo_hi[names[0]]
            for n in names[1:]:
                c = pieces[n]["center"]
                joints.append({"name": n, "part": n, "parent": names[0], "pivot": [round(min(max(c[i], lo[i]), hi[i]), 6) for i in range(3)]})
            continue
        head = mw @ b.head_local
        joints.append({"name": b.name, "part": names[0], "parent": main[anc.name], "pivot": [round(x, 6) for x in head]})
        if len(names) > 1:
            riders[names[0]] = names[1:]
    return {"pieces": list(pieces.values()), "joints": joints, "riders": riders}


def piece_materials(objs):
    """Give each piece its own copy of its first material, named after it: an
    upload makes one MeshPart per material, so this keeps one MeshPart per
    piece (and its name)."""
    for o in objs:
        if o.type != "MESH" or not o.data.materials:
            continue
        mat = o.data.materials[0].copy()
        mat.name = o.name
        o.data.materials[0] = mat


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


def _colour_images(mat):
    """Image textures that reach the Principled BSDF's Base Color (through any
    nodes). An unconnected image, or one feeding only a normal/roughness map,
    is not the colour and does not make a textured MeshPart."""
    if not (mat and mat.use_nodes):
        return []
    bsdf = next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if bsdf is None or not bsdf.inputs["Base Color"].is_linked:
        return []
    seen, out, todo = set(), [], [bsdf.inputs["Base Color"].links[0].from_node]
    while todo:
        node = todo.pop()
        if node.name in seen:
            continue
        seen.add(node.name)
        if node.type == "TEX_IMAGE" and node.image:
            out.append(node.image)
        for inp in node.inputs:
            todo.extend(link.from_node for link in inp.links)
    return out


def _has_texture(mat):
    return bool(_colour_images(mat))


def _base_link(mat):
    """The node feeding the Principled BSDF's Base Color, or None."""
    if not (mat and mat.use_nodes):
        return None
    bsdf = next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if bsdf is None or not bsdf.inputs["Base Color"].is_linked:
        return None
    node = bsdf.inputs["Base Color"].links[0].from_node
    # Pass-through nodes keep the colour's source (blox's own vertex material
    # has a Gamma node; glTF imports and tidy node trees add Reroutes).
    for _ in range(16):
        if node.type not in ("REROUTE", "GAMMA"):
            break
        inp = node.inputs[0]
        if not inp.is_linked:
            break
        node = inp.links[0].from_node
    return node


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
    if mat is None:
        return "flat"
    if mat.name.startswith(VERTEX_MATERIAL):
        return "vertex"
    if _has_texture(mat):
        imgs = _colour_images(mat)
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
    if name:
        return me.color_attributes.get(name)
    # An empty name renders the mesh's default (render) colour attribute.
    ca = me.color_attributes
    default = ca.get(getattr(ca, "default_color_name", "") or "")
    return default or ca.active_color


def upload_parts(objs):
    """MeshParts an upload makes after the bake: per mesh, one for all its
    flat/vertex-coloured faces plus one per textured material it uses.
    Verified live: GLB uploads make one MeshPart per material (PR #67) and a
    rig_rigid dog of 7 single-material pieces made 7 (spec C smoke B)."""
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
    """Bake every untextured material's colour into a "Col" corner attribute
    and replace those materials with one shared vertex-colour material: flat
    colours as they are, painted Color Attribute materials copied per corner.
    Textured materials stay (their packed image survives upload).
    Returns {"materials": n_after, "baked": n_faces, "textured": n_textured}."""
    vmat = _vertex_material()
    baked = textured = 0
    for o in objs:
        if o.type != "MESH":
            continue
        me = o.data
        mats = [s.material for s in o.material_slots]
        keep = {}  # old slot index -> new slot index (textured materials)
        new_mats = [vmat]
        for i, m in enumerate(mats):
            if _has_texture(m):
                keep[i] = len(new_mats)
                new_mats.append(m)
        # Read every colour first: the source may itself be "Col", which is
        # replaced below by a fresh FLOAT/CORNER attribute.
        sources = {}
        for i, m in enumerate(mats):
            if i not in keep and m is not None and colour_class(m) == "vertex":
                attr = _vertex_source(m, me)
                if attr is not None:
                    # blox's own vertex material stores sRGB numbers; painted
                    # attributes store linear colours (Blender's convention).
                    raw = m.name.startswith(VERTEX_MATERIAL)
                    sources[i] = (attr.domain, [tuple(d.color[:3]) if raw else tuple(d.color_srgb[:3]) for d in attr.data])
        values = [None] * len(me.loops)
        for poly in me.polygons:
            m = mats[poly.material_index] if poly.material_index < len(mats) else None
            if poly.material_index in keep:
                textured += 1
                for li in poly.loop_indices:
                    values[li] = (1.0, 1.0, 1.0)
                continue
            baked += 1
            if poly.material_index in sources:
                domain, data = sources[poly.material_index]
                for li, vi in zip(poly.loop_indices, poly.vertices):
                    values[li] = data[li if domain == "CORNER" else vi]
            else:
                rgb = tuple(to_srgb(c) for c in _flat_color(m))
                for li in poly.loop_indices:
                    values[li] = rgb
        old = me.color_attributes.get("Col")
        if old is not None:
            me.color_attributes.remove(old)
        col = me.color_attributes.new("Col", "FLOAT_COLOR", "CORNER")
        for li, rgb in enumerate(values):
            col.data[li].color = (*(rgb or (1.0, 1.0, 1.0)), 1.0)
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
