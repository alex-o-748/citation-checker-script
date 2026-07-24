#!/usr/bin/env python3
"""
Generate a true vector SVG of the Source Verifier "SV2" logo lockup.

The shapes are emitted analytically (real arcs, not tessellated triangles) so
the file stays tiny and scales cleanly for screen printing / vinyl / DTG. The
"Source Verifier" wordmark is converted to outline paths (via fonttools) so the
SVG is self-contained and needs no fonts installed on the target machine.

Geometry mirrors scripts/generate_sv_logo.py (same constants) but drawn in 2D.

Usage:
    python3 scripts/generate_svg.py [--label TEXT] [--no-label] [-o FILE]
Output: sv_logo.svg
"""
import math
import sys

# ---- palette (matches the PNG renders) -----------------------------------
COL_S = "#1abea0"     # teal  -- the S (drawn above the V)
COL_V = "#3878dc"     # blue  -- the V
COL_2 = "#e6a23c"     # amber -- the superscript 2
COL_TXT = "#22303f"   # dark slate -- the wordmark

# ---- args ----------------------------------------------------------------
argv = sys.argv[1:]
label = "Source Verifier"
if "--no-label" in argv:
    label = ""
if "--label" in argv:
    label = argv[argv.index("--label") + 1]
out = "sv_logo.svg"
if "-o" in argv:
    out = argv[argv.index("-o") + 1]

# ---- geometry constants (from generate_sv_logo.py) -----------------------
H = 44.0
# S: two C-curves
S_CX, R_OUT, R_IN = 18.0, 13.0, 6.5
CY_TOP, CY_BOT, S_BOT_DX = 30.0, 14.0, 7.0
s_top_C = dict(cx=S_CX,             cy=CY_TOP, ro=R_OUT, ri=R_IN, a0=55,  a1=305)
s_bot_C = dict(cx=S_CX + S_BOT_DX,  cy=CY_BOT, ro=R_OUT, ri=R_IN, a0=235, a1=485)
# V: two legs (with the horizontal interleave offset)
V_W, wt, notch, V_OFF_X = 50.0, 11.0, 15.0, 13.0
v_left = [(25, 0), (25, notch), (wt, H), (0, H)]
v_right = [(V_W, H), (V_W - wt, H), (25, notch), (25, 0)]
v_left = [(x + V_OFF_X, y) for (x, y) in v_left]
v_right = [(x + V_OFF_X, y) for (x, y) in v_right]
# "2": arc + diagonal + base bar
TWO_X, TWO_Y, W2, H2, s2 = 52.0, 27.0, 13.0, 20.0, 4.5
def tf(x, y):
    return (x + TWO_X, y + TWO_Y)
two_arc = dict(cx=W2 / 2 + TWO_X, cy=H2 - W2 / 2 + TWO_Y, ro=W2 / 2,
               ri=W2 / 2 - s2, a0=-40, a1=215)
two_diag = [tf(1.5, 3.0), tf(6.0, 3.0), tf(11.5, 10.5), tf(7.0, 10.5)]
two_bar = [tf(0.0, 0.0), tf(W2, 0.0), tf(W2, s2), tf(0.0, s2)]

# ---- coordinate frame: flip Y (SVG is y-down) with a margin --------------
MARGIN = 4.0
# bounds of the mark
MINX, MAXX = 5.0, 65.0
MINY, MAXY = 0.0, 47.0

def fy(y):
    return MAXY - y                     # flip so the mark sits upright

def poly_path(pts):
    d = "M " + " L ".join(f"{x:.3f},{fy(y):.3f}" for (x, y) in pts) + " Z"
    return d

def ring_path(c):
    """Annular sector (a 'C') as an SVG path with real arc segments."""
    a0, a1 = math.radians(c["a0"]), math.radians(c["a1"])
    ro, ri, cx, cy = c["ro"], c["ri"], c["cx"], c["cy"]
    def pt(r, a):
        return (cx + r * math.cos(a), cy + r * math.sin(a))
    Oa0, Oa1 = pt(ro, a0), pt(ro, a1)
    Ia1, Ia0 = pt(ri, a1), pt(ri, a0)
    large = 1 if abs(c["a1"] - c["a0"]) > 180 else 0
    # with the Y-flip, the outer arc (a0->a1) is drawn sweep 0 and the inner
    # arc returns with sweep 1 (verified by rasterising each combination).
    d = (f"M {Oa0[0]:.3f},{fy(Oa0[1]):.3f} "
         f"A {ro:.3f},{ro:.3f} 0 {large} 0 {Oa1[0]:.3f},{fy(Oa1[1]):.3f} "
         f"L {Ia1[0]:.3f},{fy(Ia1[1]):.3f} "
         f"A {ri:.3f},{ri:.3f} 0 {large} 1 {Ia0[0]:.3f},{fy(Ia0[1]):.3f} Z")
    return d

# ---- wordmark: convert text to outline paths (fonttools) -----------------
def label_svg(text, cx, top_y, target_w):
    from fontTools.ttLib import TTFont
    from fontTools.pens.svgPathPen import SVGPathPen
    font_path = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
    font = TTFont(font_path)
    upm = font["head"].unitsPerEm
    cmap = font.getBestCmap()
    gs = font.getGlyphSet()
    # raw advance width in font units
    adv = sum(gs[cmap[ord(ch)]].width for ch in text if ord(ch) in cmap)
    s = target_w / adv                  # font-unit -> svg-unit scale (line = target_w)
    x0 = cx - target_w / 2.0
    cap = font["OS/2"].sCapHeight if hasattr(font["OS/2"], "sCapHeight") else 0.7 * upm
    baseline = top_y + s * cap
    parts = []
    cursor = 0.0
    for ch in text:
        gname = cmap.get(ord(ch))
        if gname is None:
            continue
        pen = SVGPathPen(gs)
        gs[gname].draw(pen)
        d = pen.getCommands()
        if d:
            tx = x0 + s * cursor
            # scale(s,-s) flips font y-up into SVG y-down, positioned on baseline
            parts.append(
                f'<g transform="translate({tx:.3f},{baseline:.3f}) '
                f'scale({s:.5f},{-s:.5f})"><path d="{d}" fill="{COL_TXT}"/></g>')
        cursor += gs[gname].width
    height = s * upm  # rough line box (ascent+descent)
    return "\n".join(parts), baseline + 0.30 * s * upm

# ---- assemble ------------------------------------------------------------
mark = []
# draw order (back -> front): V, then S over it, then the 2
mark.append(f'<path d="{poly_path(v_left)}" fill="{COL_V}"/>')
mark.append(f'<path d="{poly_path(v_right)}" fill="{COL_V}"/>')
mark.append(f'<path d="{ring_path(s_top_C)}" fill="{COL_S}"/>')
mark.append(f'<path d="{ring_path(s_bot_C)}" fill="{COL_S}"/>')
mark.append(f'<path d="{ring_path(two_arc)}" fill="{COL_2}"/>')
mark.append(f'<path d="{poly_path(two_diag)}" fill="{COL_2}"/>')
mark.append(f'<path d="{poly_path(two_bar)}" fill="{COL_2}"/>')

mark_bottom = fy(MINY)                   # y just below the mark
content_h = mark_bottom
label_block = ""
if label:
    gap = 6.0
    label_w = (MAXX - MINX) * 0.96
    label_block, content_h = label_svg(label, (MINX + MAXX) / 2.0,
                                       mark_bottom + gap, label_w)

vb_x = MINX - MARGIN
vb_y = fy(MAXY) - MARGIN
vb_w = (MAXX - MINX) + 2 * MARGIN
vb_h = (content_h - fy(MAXY)) + 2 * MARGIN

svg = [
    f'<svg xmlns="http://www.w3.org/2000/svg" '
    f'viewBox="{vb_x:.3f} {vb_y:.3f} {vb_w:.3f} {vb_h:.3f}">',
    '<title>Source Verifier</title>',
    "\n".join(mark),
    label_block,
    "</svg>",
]
with open(out, "w") as f:
    f.write("\n".join(p for p in svg if p))
print(f"wrote {out}  (viewBox {vb_w:.1f} x {vb_h:.1f})")
