reset()
body = voxels("body", [(x, y, z, "#5a3a22") for x in range(-1, 2) for y in range(-3, 3) for z in range(2, 4)])
head = voxels("head", [(x, y, z, "#6b4429") for x in range(-1, 2) for y in range(-5, -2) for z in range(3, 6)] + [(-1, -6, 4, "#111111"), (1, -6, 4, "#111111")])
legs = {}
for name, (x, y) in {"leg_fl": (-1, -3), "leg_fr": (1, -3), "leg_bl": (-1, 2), "leg_br": (1, 2)}.items():
    legs[name] = voxels(name, [(x, y, z, "#4a2f1b") for z in range(0, 2)])
arm = rig("DogRig", [
    {"name": "root", "head": (0, 0, 2), "tail": (0, 0, 3)},
    {"name": "head", "head": (0, -3, 3.5), "tail": (0, -4, 4.5), "parent": "root"},
    *[{"name": n, "head": (x + 0.5, y + 0.5, 2), "tail": (x + 0.5, y + 0.5, 0), "parent": "root"} for n, (x, y) in {"leg_fl": (-1, -3), "leg_fr": (1, -3), "leg_bl": (-1, 2), "leg_br": (1, 2)}.items()],
])
bind_rigid(arm, {"root": [body], "head": [head], **{n: [o] for n, o in legs.items()}}, "Dog")
animate(arm, "Walk", {
    0: {"leg_fl": {"rot": (30, 0, 0)}, "leg_br": {"rot": (30, 0, 0)}, "leg_fr": {"rot": (-30, 0, 0)}, "leg_bl": {"rot": (-30, 0, 0)}},
    10: {"leg_fl": {"rot": (-30, 0, 0)}, "leg_br": {"rot": (-30, 0, 0)}, "leg_fr": {"rot": (30, 0, 0)}, "leg_bl": {"rot": (30, 0, 0)}},
})
animate(arm, "Sleep", {0: {"head": {"rot": (-20, 0, 0)}}, 30: {"head": {"rot": (-25, 0, 0)}}})
