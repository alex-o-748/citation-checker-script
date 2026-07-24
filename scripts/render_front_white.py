#!/usr/bin/env python3
"""Render a straight-on FRONT view of sv_logo.stl (readable letter faces).

Usage:
    python3 scripts/render_front_white.py [--size N] [--transparent] [-o FILE]

  --size N        target width of the artwork in px (default 900)
  --transparent   transparent background (best for t-shirts) instead of white
  -o FILE         output path (default sv_logo_front.png, or
                  sv_logo_front_transparent.png when --transparent)

The letters lie flat, so looking onto their faces gives the readable SV(2)
mark. Rendered at 2x and downscaled for anti-aliased edges.

For apparel at ~300 DPI: 900 px ~ 3 in, 3000 px ~ 10 in, 3600 px ~ 12 in.
"""
import sys
import numpy as np
from stl import mesh
from PIL import Image, ImageDraw

SS = 2                                   # supersample factor for smooth edges

# ---- args ----------------------------------------------------------------
argv = sys.argv[1:]
transparent = "--transparent" in argv
target = 900
if "--size" in argv:
    target = int(argv[argv.index("--size") + 1])
out = "sv_logo_front_transparent.png" if transparent else "sv_logo_front.png"
if "-o" in argv:
    out = argv[argv.index("-o") + 1]

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
scale = target / (mx - mn).max(); pad = int(0.07 * target)
W = int((mx[0]-mn[0])*scale + 2*pad); H = int((mx[1]-mn[1])*scale + 2*pad)

bg = (255, 255, 255, 0) if transparent else (255, 255, 255, 255)
img = Image.new("RGBA", (W*SS, H*SS), bg)
dr = ImageDraw.Draw(img)
def px(xy):
    return ((xy[0]-mn[0])*scale*SS + pad*SS, (H - ((xy[1]-mn[1])*scale + pad))*SS)
for _, poly, shade, ztop in rows:
    col = colour(ztop, shade) + (255,)
    dr.polygon([px(v) for v in poly], fill=col, outline=col)

img = img.resize((W, H), Image.LANCZOS)
if not transparent:
    img = img.convert("RGB")
img.save(out)
print(f"wrote {out} ({W}x{H})")
