"""blox asset normalize — headless Blender pass for external meshes.

blender -b --factory-startup --python normalize.py -- <in> <out.glb|out.fbx> <max_tris> <height_studs>

Imports GLB/GLTF/FBX/OBJ, applies transforms, joins meshes, decimates to the
triangle budget, scales to the target height (0 keeps size), moves the pivot to
the base centre and exports for Roblox: .glb (the upload format: flat material
colours baked into vertex colours, 1 unit = 1 stud) or .fbx (Studio's 3D
importer). Prints one BLOX_NORMALIZE line.
"""
import os
import sys

import bpy
import mathutils

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import blox_model  # noqa: E402


def main():
    argv = sys.argv[sys.argv.index("--") + 1:]
    src, out, max_tris, height = argv[0], argv[1], int(argv[2]), float(argv[3])
    bpy.ops.wm.read_factory_settings(use_empty=True)
    ext = os.path.splitext(src)[1].lower()
    if ext in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=src)
    elif ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=src)
    elif ext == ".obj":
        bpy.ops.wm.obj_import(filepath=src)
    else:
        raise SystemExit("BLOX_ERROR unsupported format " + ext)

    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    if not meshes:
        raise SystemExit("BLOX_ERROR no meshes in " + src)
    bpy.ops.object.select_all(action="DESELECT")
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    # Location too: the pivot step below works in mesh space, so mesh space must be world space.
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    if len(meshes) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active

    def tris(o):
        o.data.calc_loop_triangles()
        return len(o.data.loop_triangles)

    before = tris(obj)
    if before > max_tris > 0:
        mod = obj.modifiers.new("blox_decimate", "DECIMATE")
        mod.ratio = max_tris / before
        bpy.ops.object.modifier_apply(modifier=mod.name)
    after = tris(obj)

    if height > 0 and obj.dimensions.z > 0:
        s = height / obj.dimensions.z
        obj.scale = (s, s, s)
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

    corners = [obj.matrix_world @ mathutils.Vector(c) for c in obj.bound_box]
    min_z = min(v.z for v in corners)
    cx = sum(v.x for v in corners) / 8.0
    cy = sum(v.y for v in corners) / 8.0
    obj.data.transform(mathutils.Matrix.Translation((-cx, -cy, -min_z)))
    obj.location = (0.0, 0.0, 0.0)

    extra = ""
    if out.lower().endswith(".glb"):
        b = blox_model.bake_vertex_colors([obj])
        blox_model.export_glb(out, [obj])
        extra = " materials=%d textured=%d" % (b["materials"], b["textured"])
    else:
        bpy.ops.export_scene.fbx(filepath=out, use_selection=True, apply_unit_scale=True, axis_forward="-Z", axis_up="Y")
    d = obj.dimensions
    print("BLOX_NORMALIZE tris_before=%d tris_after=%d size=%.3f,%.3f,%.3f%s" % (before, after, d.x, d.y, d.z, extra))


main()
