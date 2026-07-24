#!/usr/bin/env python3
"""Render a straight-on FRONT view of sv_logo.stl on a WHITE background.

The letters lie flat, so looking onto their faces gives the readable SV(2)
mark. Rendered at 2x and downscaled for anti-aliased edges -> sv_logo_front.png
"""
import numpy as np
from stl import mesh
from PIL import Image, ImageDraw

SS = 2                                   # supersample factor for smooth edges

m = mesh.Mesh.from_file("sv_logo.stl")
tris = m.vectors.astype(float)
c = tris.reshape(-1, 3).mean(axis=0)
c[2] = 0.0                               # keep true Z so height-based colours work
tris = tris - c


def colour(ztop, shade):
    if ztop <= 0.5:
        rgb = np.array([150, 160, 175])             # bottom faces (unseen)
    elif ztop <= 5.5:
        rgb = np.array([56, 120, 220])              # V
    elif ztop <= 7.0:
        rgb = np.array([230, 162, 60])              # superscript "2"
    else:
        rgb = np.array([26, 190, 160])              # S
    return tuple(np.clip(rgb * shade, 0, 255).astype(int))


# Face-on view: look straight down -Z onto the letter faces (identity rotation).
light = np.array([0.25, 0.4, 0.85]); light /= np.linalg.norm(light)
view = np.array([0, 0, 1.0])
rows = []
for t in tris:
    n = np.cross(t[1] - t[0], t[2] - t[0]); ln = np.linalg.norm(n)
    if ln == 0:
        continue
    n /= ln
    if n @ view <= 0:                    # keep only faces toward the camera
        continue
    shade = 0.72 + 0.28 * max(0.0, float(n @ light))
    rows.append((t[:, 2].mean(), t[:, :2], shade, t[:, 2].max()))
rows.sort(key=lambda r: r[0])

pts = np.vstack([r[1] for r in rows])
mn, mx = pts.min(0), pts.max(0)
target = 900
scale = target / (mx - mn).max(); pad = 60
W = int((mx[0]-mn[0])*scale + 2*pad); H = int((mx[1]-mn[1])*scale + 2*pad)

img = Image.new("RGB", (W*SS, H*SS), (255, 255, 255))
dr = ImageDraw.Draw(img)
def px(xy):
    return ((xy[0]-mn[0])*scale*SS + pad*SS, (H - ((xy[1]-mn[1])*scale + pad))*SS)
for _, poly, shade, ztop in rows:
    col = colour(ztop, shade)
    dr.polygon([px(v) for v in poly], fill=col, outline=col)

img = img.resize((W, H), Image.LANCZOS)
img.save("sv_logo_front.png")
print(f"wrote sv_logo_front.png ({W}x{H})")
