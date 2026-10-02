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


def material(color):
    rgb = _rgb(color)
    key = "C_%02x%02x%02x" % tuple(int(round(c * 255)) for c in rgb)
    m = _mats.get(key) or bpy.data.materials.get(key)
    if m is None:
        m = bpy.data.materials.new(key)
        m.use_nodes = True
        bsdf = m.node_tree.nodes.get("Principled BSDF")
        bsdf.inputs["Base Color"].default_value = (*rgb, 1.0)
        bsdf.inputs["Roughness"].default_value = 0.8
        m.diffuse_color = (*rgb, 1.0)
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
