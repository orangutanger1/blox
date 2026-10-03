# Regenerates the JPEG fixtures: blender -b --factory-startup --python tests/fixtures/present/make-fixtures.py -- tests/fixtures/present
import bpy, sys
out = sys.argv[sys.argv.index("--") + 1]
W, H = 64, 48
bpy.context.scene.view_settings.view_transform = "Standard"
bpy.context.scene.view_settings.look = "None"
def save(name, fn, sub="420"):
    img = bpy.data.images.new(name, W, H, alpha=False)
    px = []
    for y in range(H):
        for x in range(W):
            r, g, b = fn(x, y)
            px += [r, g, b, 1.0]
    img.pixels = px
    s = bpy.context.scene.render.image_settings
    s.file_format = "JPEG"
    s.quality = 95
    s.color_mode = "RGB"
    img.filepath_raw = out + "/" + name + ".jpg"
    img.file_format = "JPEG"
    img.save_render(img.filepath_raw, scene=bpy.context.scene)
# pixels are linear in Blender; pick values whose sRGB is simple
save("flat", lambda x, y: (0.5, 0.5, 0.5))  # byte image: stored as-is, ~128
save("gradient", lambda x, y: ((x / (W - 1)),) * 3)  # 0..255 left to right
save("split", lambda x, y: (1.0, 0.0, 0.0) if x < W // 2 else (0.0, 0.0, 1.0))
print("BLOX_OK")
