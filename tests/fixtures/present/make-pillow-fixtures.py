# Regenerates the Pillow JPEG fixtures: python3 tests/fixtures/present/make-pillow-fixtures.py
# (restart markers, 4:4:4, grayscale, odd sizes — cases Blender's encoder doesn't write).
import os
from PIL import Image
d = os.path.dirname(os.path.abspath(__file__))
def scene(w, h):
    im = Image.new("RGB", (w, h))
    im.putdata([(int(255 * x / (w - 1)), int(255 * y / (h - 1)), 128 if x < w // 2 else 30) for y in range(h) for x in range(w)])
    return im
scene(64, 48).save(f"{d}/rst.jpg", quality=95, subsampling=2, restart_marker_blocks=5)
scene(64, 48).save(f"{d}/norst.jpg", quality=95, subsampling=2)
scene(37, 29).save(f"{d}/odd444.jpg", quality=95, subsampling=0)
scene(37, 29).convert("L").save(f"{d}/gray.jpg", quality=95)
