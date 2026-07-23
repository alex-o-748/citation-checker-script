#!/usr/bin/env python3
"""Render preview images of sv_logo.stl: a top-down map (to read the glyphs)
and an isometric view (to show the relief). Colours faces by height so the
raised S, the lower V, and the base are easy to tell apart."""
import numpy as np
from stl import mesh
from PIL import Image, ImageDraw

m = mesh.Mesh.from_file("sv_logo.stl")
tris = m.vectors.astype(float)                      # (N,3,3)
zmin, zmax = tris[:, :, 2].min(), tris[:, :, 2].max()

# Colour by each face's top height so the thicker S and thinner V are distinct.
def face_colour(ztop, shade):
    if ztop <= 0.5:
        rgb = np.array([40, 48, 66])                # a bottom face
    elif ztop <= 5.5:
        rgb = np.array([64, 128, 226])              # V (thinner letter)
    else:
        rgb = np.array([38, 200, 170])              # S (thicker letter)
    return tuple(np.clip(rgb * shade, 0, 255).astype(int))


def render(R, view_dir, fname, size=560):
    light = np.array([0.35, 0.45, 0.82]); light /= np.linalg.norm(light)
    rows = []
    for t in tris:
        p = (R @ t.T).T
        n = np.cross(p[1] - p[0], p[2] - p[0]); ln = np.linalg.norm(n)
        if ln == 0:
            continue
        n /= ln
        if n @ view_dir <= 0:                       # back-face cull, keep true normal
            continue
        shade = 0.4 + 0.6 * max(0.0, float(n @ light))
        ztop = t[:, 2].max()                         # solid's top height for this face
        rows.append((p[:, 2].mean(), p[:, :2], shade, ztop))
    rows.sort(key=lambda r: r[0])                   # painter's: far first

    pts = np.vstack([r[1] for r in rows])
    mn, mx = pts.min(0), pts.max(0)
    scale = size / (mx - mn).max(); pad = 36
    W = int((mx[0] - mn[0]) * scale + 2 * pad)
    H = int((mx[1] - mn[1]) * scale + 2 * pad)
    img = Image.new("RGB", (W, H), (18, 22, 34)); dr = ImageDraw.Draw(img)
    def px(xy):
        return ((xy[0]-mn[0])*scale+pad, H-((xy[1]-mn[1])*scale+pad))
    for _, poly, shade, zc in rows:
        dr.polygon([px(v) for v in poly], fill=face_colour(zc, shade))
    img.save(fname)
    return W, H


# Top-down (look straight down -Z): identity rotation, view dir +Z.
render(np.eye(3), np.array([0, 0, 1.0]), "sv_logo_top.png")

# Isometric: rotate about Z then tilt.
az, el = np.radians(-32), np.radians(38)            # el from horizontal-ish
Rz = np.array([[np.cos(az), -np.sin(az), 0],
               [np.sin(az),  np.cos(az), 0], [0, 0, 1]])
Rx = np.array([[1, 0, 0],
               [0, np.cos(el), -np.sin(el)],
               [0, np.sin(el),  np.cos(el)]])
R = Rx @ Rz
view = R @ np.array([0, 0, 1.0])                    # camera axis in world space
render(R, view, "sv_logo_iso.png")
print("wrote sv_logo_top.png and sv_logo_iso.png")
