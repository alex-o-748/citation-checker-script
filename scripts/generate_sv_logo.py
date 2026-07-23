#!/usr/bin/env python3
"""
Generate a 3D-printable "SV" (Source Verifier) logo as an STL.

Design (from the request):
  * Interleaved letters S and V (they overlap horizontally).
  * NO rectangular base plate. The letters lie flat and ARE the object, so the
    whole thing prints "lying down" with every part touching the bed and no
    support material.
  * The S is built from TWO C-shaped curves that overlap a bit in the middle.
  * One letter is a bit higher (thicker in Z) than the other: the S is thicker
    than the V, so at the interleave the S reads as the top layer.

Because the letters overlap each other (the two C's overlap, and the S overlaps
the V) the model fuses into a single connected piece.

Output: sv_logo.stl  (millimetre units, ready to slice)
"""

import math
import numpy as np
from stl import mesh

# ---------------------------------------------------------------------------
# Tunable parameters (millimetres)
# ---------------------------------------------------------------------------
S_THICK = 8.0         # S thickness (its "height" lying flat) -- the taller one
V_THICK = 5.0         # V thickness -- a bit lower than the S

LETTER_H = 44.0       # glyph height in the plane (Y span)
ARC_STEPS = 64        # smoothness of the C curves

# ---------------------------------------------------------------------------
# Geometry -- everything ends up as a list of triangles.
# ---------------------------------------------------------------------------
triangles = []


def add_prism(poly_xy, z0, z1):
    """Extrude a CONVEX XY polygon (e.g. a quad) between z0 and z1."""
    n = len(poly_xy)
    bottom = [(x, y, z0) for (x, y) in poly_xy]
    top = [(x, y, z1) for (x, y) in poly_xy]
    for i in range(1, n - 1):                       # bottom face (normal down)
        triangles.append((bottom[0], bottom[i + 1], bottom[i]))
    for i in range(1, n - 1):                       # top face (normal up)
        triangles.append((top[0], top[i], top[i + 1]))
    for i in range(n):                              # side walls
        j = (i + 1) % n
        triangles.append((bottom[i], bottom[j], top[j]))
        triangles.append((bottom[i], top[j], top[i]))


def add_ring(cx, cy, r_out, r_in, a0_deg, a1_deg, z0, z1, steps=ARC_STEPS):
    """Extrude an annular sector (a 'C') between z0 and z1. Angles CCW, deg."""
    a0, a1 = math.radians(a0_deg), math.radians(a1_deg)
    angs = [a0 + (a1 - a0) * k / steps for k in range(steps + 1)]
    O = [(cx + r_out * math.cos(a), cy + r_out * math.sin(a)) for a in angs]
    I = [(cx + r_in * math.cos(a), cy + r_in * math.sin(a)) for a in angs]

    def P(pt, z):
        return (pt[0], pt[1], z)

    for k in range(steps):
        Ok, Ok1, Ik, Ik1 = O[k], O[k + 1], I[k], I[k + 1]
        # top face (z1, normal up)
        triangles.append((P(Ok, z1), P(Ok1, z1), P(Ik1, z1)))
        triangles.append((P(Ok, z1), P(Ik1, z1), P(Ik, z1)))
        # bottom face (z0, normal down)
        triangles.append((P(Ok, z0), P(Ik1, z0), P(Ok1, z0)))
        triangles.append((P(Ok, z0), P(Ik, z0), P(Ik1, z0)))
        # outer wall
        triangles.append((P(Ok, z0), P(Ok1, z0), P(Ok1, z1)))
        triangles.append((P(Ok, z0), P(Ok1, z1), P(Ok, z1)))
        # inner wall
        triangles.append((P(Ik, z0), P(Ik1, z1), P(Ik1, z0)))
        triangles.append((P(Ik, z0), P(Ik, z1), P(Ik1, z1)))
    # end caps
    triangles.append((P(O[0], z0), P(I[0], z0), P(I[0], z1)))
    triangles.append((P(O[0], z0), P(I[0], z1), P(O[0], z1)))
    triangles.append((P(O[steps], z0), P(O[steps], z1), P(I[steps], z1)))
    triangles.append((P(O[steps], z0), P(I[steps], z1), P(I[steps], z0)))


def rect(x0, y0, x1, y1):
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]


# ---------------------------------------------------------------------------
# Letter S -- two overlapping C curves.
#   top C  = "("  (bulges left, opening on the right)
#   bottom C = ")" (bulges right, opening on the left)
# Stacked and overlapped in the middle they read as an S.
# ---------------------------------------------------------------------------
S_CX = 18.0
R_OUT = 13.0
R_IN = 6.5                      # stroke width = R_OUT - R_IN = 6.5 mm
CY_TOP = 30.0                   # centre of the upper C
CY_BOT = 14.0                   # centre of the lower C  (16 mm apart -> small overlap)

# top C = "(" : bulges left (gap on the right)
# bottom C = ")" : bulges right (gap on the left)
# top-left bulge over bottom-right bulge = an S; they cross in the middle.
s_top_C = dict(cx=S_CX, cy=CY_TOP, r_out=R_OUT, r_in=R_IN, a0=55,  a1=305)
s_bot_C = dict(cx=S_CX, cy=CY_BOT, r_out=R_OUT, r_in=R_IN, a0=235, a1=485)

# ---------------------------------------------------------------------------
# Letter V -- two straight legs meeting at the bottom (two convex quads).
# ---------------------------------------------------------------------------
V_W = 50.0
wt = 11.0
notch = 15.0
H = LETTER_H

v_left = [(V_W / 2, 0.0), (V_W / 2, notch), (wt, H), (0.0, H)]
v_right = [(V_W, H), (V_W - wt, H), (V_W / 2, notch), (V_W / 2, 0.0)]

# ---------------------------------------------------------------------------
# Placement -- overlap S and V so they interleave.
# ---------------------------------------------------------------------------
V_OFF_X = 20.0        # V shifted right so its left leg crosses the S

# V first (lower/thinner), then S on top -> S proud of V at the interleave.
add_prism([(x + V_OFF_X, y) for (x, y) in v_left], 0.0, V_THICK)
add_prism([(x + V_OFF_X, y) for (x, y) in v_right], 0.0, V_THICK)

for c in (s_top_C, s_bot_C):
    add_ring(c["cx"], c["cy"], c["r_out"], c["r_in"], c["a0"], c["a1"],
             0.0, S_THICK)

# ---------------------------------------------------------------------------
# Emit STL
# ---------------------------------------------------------------------------
data = np.zeros(len(triangles), dtype=mesh.Mesh.dtype)
for i, tri in enumerate(triangles):
    for j in range(3):
        data["vectors"][i][j] = tri[j]

m = mesh.Mesh(data)
m.update_normals()
m.save("sv_logo.stl")

allv = m.vectors.reshape(-1, 3)
mn, mx = allv.min(axis=0), allv.max(axis=0)
print(f"Wrote sv_logo.stl: {len(triangles)} triangles")
print(f"Bounding box (mm): X {mx[0]-mn[0]:.1f}  Y {mx[1]-mn[1]:.1f}  Z {mx[2]-mn[2]:.1f}")
print(f"S thickness: {S_THICK:.1f} mm   V thickness: {V_THICK:.1f} mm   (no base)")
