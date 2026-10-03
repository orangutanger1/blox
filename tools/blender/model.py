"""blox model — headless Blender steps for AI-built models.

blender -b --factory-startup --python model.py -- <cmd> <args.json>

  run     open (or create) <blend>, exec the user's code with the blox_model
          helpers in scope, save. Prints stats.
  check   stats vs Roblox limits + turnaround renders (front/right/back/3-4) of
          the model into <views>/ for visual review against the references.
  export  <out>/model.glb (the upload: one vertex-coloured material, 1 unit =
          1 stud, front = Roblox -Z), <out>/model.fbx (mesh + rig, no
          animation, for Studio's 3D importer), one <out>/anim_<action>.fbx
          per action (for Studio's Animation Editor import), one
          <out>/anim_<action>.json per action (bone matrices per frame, for
          `model animate`, which builds a Roblox KeyframeSequence) and
          <out>/preview.json (coloured triangles in Roblox axes, for an
          EditableMesh preview in Studio without uploading).

Every command prints one line: BLOX_MODEL <json>. Errors: BLOX_ERROR <msg>.
Units: 1 Blender unit = 1 stud; Blender (x, y, z) → Roblox (x, z, -y).
"""
import json
import math
import os
import sys
import traceback

import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import blox_model  # noqa: E402

MESH_TRI_LIMIT = 20000  # Roblox MeshPart triangle cap
TEXTURE_LIMIT = 1024


def out(obj):
    print("BLOX_MODEL " + json.dumps(obj))


def fail(msg):
    print("BLOX_ERROR " + msg.replace("\n", " | "))
    sys.exit(1)


def open_blend(path, create=False):
    if os.path.exists(path):
        bpy.ops.wm.open_mainfile(filepath=path)
    elif create:
        bpy.ops.wm.read_factory_settings(use_empty=True)
    else:
        fail("no model yet at %s — run `model run` first" % path)


def meshes():
    return [o for o in bpy.context.scene.objects if o.type == "MESH"]


def tri_count(o):
    dg = bpy.context.evaluated_depsgraph_get()
    m = o.evaluated_get(dg).to_mesh()
    m.calc_loop_triangles()
    n = len(m.loop_triangles)
    o.evaluated_get(dg).to_mesh_clear()
    return n


def bounds():
    pts = []
    for o in meshes():
        pts += [o.matrix_world @ Vector(c) for c in o.bound_box]
    if not pts:
        return Vector((0, 0, 0)), Vector((0, 0, 0))
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return lo, hi


def rest_all():
    for o in bpy.context.scene.objects:
        if o.type == "ARMATURE":
            if o.animation_data:
                o.animation_data.action = None
                o.animation_data.use_nla = False  # NLA strips would keep posing it
            blox_model.rest(o)
    bpy.context.view_layer.update()


def stats(budget):
    rest_all()
    ms = meshes()
    tris = {o.name: tri_count(o) for o in ms}
    arms = [o for o in bpy.context.scene.objects if o.type == "ARMATURE"]
    bones = sum(len(a.data.bones) for a in arms)
    max_inf = 0
    for o in ms:
        for v in o.data.vertices:
            max_inf = max(max_inf, sum(1 for g in v.groups if g.weight > 0))
    actions = [{"name": a.name, "frames": [int(a.frame_range[0]), int(a.frame_range[1])]} for a in bpy.data.actions]
    textures = []
    for img in bpy.data.images:
        if img.size[0] or img.size[1]:
            textures.append({"name": img.name, "size": list(img.size)})
    lo, hi = bounds()
    size = hi - lo
    issues = []
    total = sum(tris.values())
    if budget and total > budget:
        issues.append("triangles %d > budget %d" % (total, budget))
    for n, t in tris.items():
        if t > MESH_TRI_LIMIT:
            issues.append("mesh %s has %d triangles (Roblox limit %d per MeshPart)" % (n, t, MESH_TRI_LIMIT))
    if max_inf > 4:
        issues.append("a vertex has %d bone influences (Roblox uses at most 4)" % max_inf)
    for t in textures:
        if max(t["size"]) > TEXTURE_LIMIT:
            issues.append("texture %s is %dx%d (Roblox downsizes above %d)" % (t["name"], t["size"][0], t["size"][1], TEXTURE_LIMIT))
    # rig_rigid pieces stay unskinned on purpose: Studio joins them with Motor6Ds.
    if arms and not any(o.find_armature() for o in ms) and not any("blox_rigid" in arm.keys() for arm in arms):
        issues.append("there is an armature but no mesh is skinned to it (use bind_rigid)")
    if not ms:
        issues.append("no meshes")
    colours = {}
    for o in ms:
        for slot in o.material_slots:
            if slot.material is not None:
                colours[slot.material.name] = blox_model.colour_class(slot.material)
    for name, cls in sorted(colours.items()):
        if cls == "procedural":
            issues.append("material %s: base colour comes from a node, lost on upload (arrives white) — use flat colours, a Color Attribute, or bake it to an image" % name)
        elif cls == "missing-image":
            issues.append("material %s: its image has no pixels (not packed, file missing), lost on upload — pack it or fix the path" % name)
    return {
        "triangles": total,
        "meshes": tris,
        "materials": len([m for m in bpy.data.materials if m.users]),
        "bones": bones,
        "maxInfluences": max_inf,
        "actions": actions,
        "textures": textures,
        "size": [round(size.x, 2), round(size.z, 2), round(size.y, 2)],  # Roblox x, y(up), z
        "issues": issues,
        "colours": colours,
        "uploadParts": blox_model.upload_parts(ms),
    }


def cmd_run(a):
    open_blend(a["blend"], create=True)
    ns = {"bpy": bpy, "math": math, "Vector": Vector}
    ns.update({k: getattr(blox_model, k) for k in dir(blox_model) if not k.startswith("_")})
    try:
        exec(compile(open(a["code"]).read(), a.get("name", "model code"), "exec"), ns)
    except Exception:
        fail("your code raised: " + traceback.format_exc(limit=4))
    os.makedirs(os.path.dirname(a["blend"]), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=a["blend"])
    out(stats(a.get("budget", 0)))


def render_views(view_dir):
    os.makedirs(view_dir, exist_ok=True)
    lo, hi = bounds()
    center = (lo + hi) / 2
    radius = max((hi - lo).length / 2, 0.5)
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "MATERIAL"
    scene.display.shading.show_cavity = True
    scene.render.resolution_x = scene.render.resolution_y = 512
    scene.render.film_transparent = False
    scene.world = scene.world or bpy.data.worlds.new("World")
    cam_data = bpy.data.cameras.new("bloxViewCam")
    cam_data.lens = 50
    cam = bpy.data.objects.new("bloxViewCam", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    dist = radius / math.tan(cam_data.angle / 2) * 1.15
    files = []
    # Blender -Y is the model's front (it exports to Roblox -Z, the look direction).
    for name, (az, el) in {"front": (-90, 10), "right": (0, 10), "back": (90, 10), "three_quarter": (-45, 25)}.items():
        azr, elr = math.radians(az), math.radians(el)
        offset = Vector((math.cos(azr) * math.cos(elr), math.sin(azr) * math.cos(elr), math.sin(elr))) * dist
        cam.location = center + offset
        cam.rotation_euler = (center - cam.location).to_track_quat("-Z", "Y").to_euler()
        path = os.path.join(view_dir, name + ".png")
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        files.append(path)
    bpy.data.objects.remove(cam)
    return files


def cmd_check(a):
    open_blend(a["blend"])
    s = stats(a.get("budget", 0))
    s["views"] = render_views(a["views"]) if meshes() else []
    out(s)


def export_fbx(path, objs, anim):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.ops.export_scene.fbx(
        filepath=path,
        use_selection=True,
        apply_unit_scale=True,
        apply_scale_options="FBX_SCALE_UNITS",
        axis_forward="-Z",
        axis_up="Y",
        add_leaf_bones=False,
        bake_anim=anim,
        bake_anim_use_all_actions=False,
        bake_anim_use_nla_strips=False,
        path_mode="COPY",
        embed_textures=True,
    )


def preview_tris():
    tris = []
    dg = bpy.context.evaluated_depsgraph_get()
    for o in meshes():
        ev = o.evaluated_get(dg)
        m = ev.to_mesh()
        m.calc_loop_triangles()
        mats = [s.material for s in o.material_slots]
        for lt in m.loop_triangles:
            mat = mats[lt.material_index] if lt.material_index < len(mats) else None
            c = [blox_model.to_srgb(x) for x in (mat.diffuse_color[:3] if mat else (0.6, 0.6, 0.6))]
            pts = []
            for vi in lt.vertices:
                p = o.matrix_world @ m.vertices[vi].co
                pts.append([round(p.x, 4), round(p.z, 4), round(-p.y, 4)])
            tris.append({"v": pts, "c": "%02x%02x%02x" % tuple(int(round(max(0, min(1, x)) * 255)) for x in c[:3])})
        ev.to_mesh_clear()
    return tris


def _m(mat):
    return [round(x, 6) for row in mat for x in row]


def anim_json(arm, act, mesh_objs):
    """Model-space (Blender world) rest and per-frame posed bone matrices."""
    scene = bpy.context.scene
    fps = scene.render.fps / scene.render.fps_base
    f0, f1 = int(act.frame_range[0]), int(act.frame_range[1])
    arm.animation_data.use_nla = False  # only this action poses the rig
    arm.animation_data.action = act
    bones = {}
    for b in arm.data.bones:
        bones[b.name] = {
            "parent": b.parent.name if b.parent else None,
            "rest": _m(arm.matrix_world @ b.matrix_local),
            "head": [round(x, 6) for x in (arm.matrix_world @ b.head_local)],
        }
    frames = []
    for f in range(f0, f1 + 1):
        scene.frame_set(f)
        frames.append({"t": round((f - f0) / fps, 4), "bones": {pb.name: _m(arm.matrix_world @ pb.matrix) for pb in arm.pose.bones}})
    arm.animation_data.action = None
    scene.frame_set(f0)
    rest_all()
    pts = []
    for o in mesh_objs:
        pts += [o.matrix_world @ v.co for v in o.data.vertices]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return {
        "name": act.name,
        "fps": fps,
        "loop": bool(act.get("blox_loop", True)),
        "meshes": [o.name for o in mesh_objs],
        "meshCenter": [round(x, 6) for x in (lo + hi) / 2],
        "bones": bones,
        "frames": frames,
    }


def cmd_export(a):
    open_blend(a["blend"])
    os.makedirs(a["out"], exist_ok=True)
    arms = [o for o in bpy.context.scene.objects if o.type == "ARMATURE"]
    objs = meshes() + arms
    files = {}
    # Rest pose, no actions, for the model itself.
    rest_all()
    model = os.path.join(a["out"], "model.fbx")
    export_fbx(model, objs, anim=False)
    files["model"] = model
    anims = {}
    for arm in arms:
        for act in bpy.data.actions:
            arm.animation_data.action = act
            bpy.context.scene.frame_start, bpy.context.scene.frame_end = int(act.frame_range[0]), int(act.frame_range[1])
            p = os.path.join(a["out"], "anim_%s.fbx" % act.name)
            export_fbx(p, objs, anim=True)
            anims[act.name] = p
        if arm.animation_data:  # a rig with no actions (e.g. rig_rigid pieces) has none
            arm.animation_data.action = None
    files["animations"] = anims
    anim_data = {}
    for arm in arms:
        skinned = [o for o in meshes() if o.find_armature() == arm]
        for act in bpy.data.actions:
            p = os.path.join(a["out"], "anim_%s.json" % act.name)
            with open(p, "w") as f:
                json.dump(anim_json(arm, act, skinned), f)
            anim_data[act.name] = p
    files["animationData"] = anim_data
    prev = os.path.join(a["out"], "preview.json")
    rest_all()  # the animation exports leave the last pose applied
    tris = preview_tris()
    with open(prev, "w") as f:
        json.dump({"triangles": tris}, f)
    files["preview"] = prev
    files["previewTriangles"] = len(tris)
    rigid = [arm for arm in arms if "blox_rigid" in arm.keys()]
    if rigid:
        piv = os.path.join(a["out"], "pivots.json")
        with open(piv, "w") as f:
            json.dump(blox_model.rigid_pivots(rigid[0]), f)
        files["pivots"] = piv
    # Last: baking replaces materials in this (unsaved) session only.
    glb = os.path.join(a["out"], "model.glb")
    files["bake"] = blox_model.bake_vertex_colors(meshes())
    if rigid:
        # Pieces only: Studio joins them with Motor6Ds (animate rig joints:"blender").
        blox_model.piece_materials(meshes())
        files["pieces"] = len(meshes())
        blox_model.export_glb(glb, meshes())
    else:
        blox_model.export_glb(glb, meshes() + arms)
    files["upload"] = glb
    out(files)


def main():
    argv = sys.argv[sys.argv.index("--") + 1:]
    cmd, args = argv[0], json.loads(open(argv[1]).read())
    {"run": cmd_run, "check": cmd_check, "export": cmd_export}.get(cmd, lambda _: fail("unknown command " + cmd))(args)


try:
    main()
except SystemExit:
    raise
except Exception:
    fail(traceback.format_exc(limit=4))
