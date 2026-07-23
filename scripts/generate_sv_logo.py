#!/usr/bin/env python3
"""
Generate a 3D-printable "SV" (Source Verifier) logo as an STL.

Design goals (from the request):
  * Interleaved letters S and V (they overlap horizontally).
  * A solid base so the print sticks to the bed and everything touches it.
  * Letters lie flat in the plane of the base and are extruded upward as a
    relief -> prints "lying down", no support material needed.
  * One letter is raised a bit higher than the other. Here S sits proud of V,
    so at the interleave the S reads as the top layer.

Output: sv_logo.stl  (millimetre units, ready to slice)

No external font is used: the glyphs are built from simple solid prisms so the
result is robust, watertight-per-solid, and has no fragile thin features.
"""

import math
import numpy as np
from stl import mesh

# ---------------------------------------------------------------------------
# Tunable parameters (millimetres)
# ---------------------------------------------------------------------------
BASE_W = 120.0        # base plate width  (X)
BASE_D = 70.0         # base plate depth  (Y)
BASE_H = 4.0          # base plate thickness (Z)

LETTER_H = 44.0       # glyph height in the plane (Y span)
STROKE = 9.0          # stroke thickness of the S
S_RAISE = 7.0         # how far S rises above the base top
V_RAISE = 4.0         # how far V rises above the base top  (lower than S)

EMBED = 0.6           # letters sink slightly into the base so they fuse to it

# ---------------------------------------------------------------------------
# Geometry helpers -- everything ends up as a list of triangles.
# ---------------------------------------------------------------------------
triangles = []  # each item: (v0, v1, v2) with v = (x, y, z)


def add_prism(poly_xy, z0, z1):
    """Extrude a simple (convex) XY polygon between z0 and z1 into a closed
    solid and append its triangles. `poly_xy` is a list of (x, y) given
    counter-clockwise."""
    n = len(poly_xy)
    bottom = [(x, y, z0) for (x, y) in poly_xy]
    top = [(x, y, z1) for (x, y) in poly_xy]

    # bottom face (normal down -> clockwise when viewed from below)
    for i in range(1, n - 1):
        triangles.append((bottom[0], bottom[i + 1], bottom[i]))
    # top face (normal up -> counter-clockwise)
    for i in range(1, n - 1):
        triangles.append((top[0], top[i], top[i + 1]))
    # side walls
    for i in range(n):
        j = (i + 1) % n
        triangles.append((bottom[i], bottom[j], top[j]))
        triangles.append((bottom[i], top[j], top[i]))


def rect(x0, y0, x1, y1):
    """Axis-aligned rectangle as a CCW polygon."""
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]


# ---------------------------------------------------------------------------
# Letter S -- blocky, five bars, in a local frame x:[0,S_W] y:[0,LETTER_H]
# ---------------------------------------------------------------------------
S_W = 34.0
w = STROKE
H = LETTER_H

s_parts = [
    rect(0,        H - w,   S_W,      H),          # top bar
    rect(0,        H / 2,   w,        H),          # upper-left vertical
    rect(0,        H / 2 - w / 2, S_W, H / 2 + w / 2),  # middle bar
    rect(S_W - w,  0,       S_W,      H / 2 + w / 2),   # lower-right vertical
    rect(0,        0,       S_W,      w),          # bottom bar
]

# ---------------------------------------------------------------------------
# Letter V -- two straight legs meeting at the bottom, built from two quads
# in a local frame x:[0,V_W] y:[0,LETTER_H]
# ---------------------------------------------------------------------------
V_W = 50.0
wt = 11.0            # leg thickness at the top
notch = 15.0         # height of the inner bottom vertex (the valley)

# left leg quad, wound CCW: outer-bottom, inner-bottom, inner-top, outer-top
v_left = [
    (V_W / 2,    0.0),
    (V_W / 2,    notch),
    (wt,         H),
    (0.0,        H),
]
# right leg quad, wound CCW: outer-top, inner-top, inner-bottom, outer-bottom
v_right = [
    (V_W,        H),
    (V_W - wt,   H),
    (V_W / 2,    notch),
    (V_W / 2,    0.0),
]

# ---------------------------------------------------------------------------
# Placement -- overlap S and V so they interleave.
# ---------------------------------------------------------------------------
S_OFF_X = 0.0
V_OFF_X = 18.0       # V shifted right; overlaps S by (S_W - V_OFF_X) mm

# Combined bounds -> centre the pair on the base.
comb_min_x = min(S_OFF_X, V_OFF_X)
comb_max_x = max(S_OFF_X + S_W, V_OFF_X + V_W)
comb_w = comb_max_x - comb_min_x
shift_x = (BASE_W - comb_w) / 2 - comb_min_x
shift_y = (BASE_D - LETTER_H) / 2

z_bottom = BASE_H - EMBED          # start a touch inside the base
s_top = BASE_H + S_RAISE
v_top = BASE_H + V_RAISE


def place(poly, off_x):
    return [(x + off_x + shift_x, y + shift_y) for (x, y) in poly]


# Base plate
add_prism(rect(0, 0, BASE_W, BASE_D), 0.0, BASE_H)

# V first (lower), then S on top so the interleave shows S proud of V.
for part in [v_left, v_right]:
    add_prism(place(part, V_OFF_X), z_bottom, v_top)
for part in s_parts:
    add_prism(place(part, S_OFF_X), z_bottom, s_top)

# ---------------------------------------------------------------------------
# Emit STL
# ---------------------------------------------------------------------------
data = np.zeros(len(triangles), dtype=mesh.Mesh.dtype)
for i, tri in enumerate(triangles):
    for j in range(3):
        data["vectors"][i][j] = tri[j]

m = mesh.Mesh(data)
m.update_normals()
out = "sv_logo.stl"
m.save(out)

# Report bounds
allv = m.vectors.reshape(-1, 3)
mn = allv.min(axis=0)
mx = allv.max(axis=0)
print(f"Wrote {out}: {len(triangles)} triangles")
print(f"Bounding box (mm): X {mx[0]-mn[0]:.1f}  Y {mx[1]-mn[1]:.1f}  Z {mx[2]-mn[2]:.1f}")
print(f"S top height: {s_top:.1f} mm   V top height: {v_top:.1f} mm   base: {BASE_H:.1f} mm")
