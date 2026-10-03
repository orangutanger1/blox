# A blocky dog of separate pieces on a rigid rig: blox model export writes
# pieces-only model.glb + pivots.json for animate rig joints:"blender".
reset()
body = box("Body", (2, 4, 1.2), (0, 0, 2.2), "#a0522d")
head = box("Head", (1.2, 1.4, 1.2), (0, -2.6, 3.0), "#a0522d")
nose = box("Nose", (0.4, 0.4, 0.4), (0, -3.4, 2.9), "#222222")
legs = {}
for name, x, y in (("FrontLeft", -0.7, -1.4), ("FrontRight", 0.7, -1.4), ("HindLeft", -0.7, 1.4), ("HindRight", 0.7, 1.4)):
    legs[name] = box(name, (0.5, 0.5, 1.6), (x, y, 0.8), "#8b4513")
bones = [
    {"name": "Root", "head": (0, 0, 2.2), "tail": (0, 0, 3.0)},
    {"name": "Neck", "head": (0, -2.0, 2.6), "tail": (0, -2.6, 3.4), "parent": "Root"},
]
for name, x, y in (("FrontLeft", -0.7, -1.4), ("FrontRight", 0.7, -1.4), ("HindLeft", -0.7, 1.4), ("HindRight", 0.7, 1.4)):
    bones.append({"name": name + "Hip", "head": (x, y, 1.6), "tail": (x, y, 0.0), "parent": "Root"})
arm = rig("DogRig", bones)
parts = {"Root": [body], "Neck": [head, nose]}
for name, o in legs.items():
    parts[name + "Hip"] = [o]
rig_rigid(arm, parts)
