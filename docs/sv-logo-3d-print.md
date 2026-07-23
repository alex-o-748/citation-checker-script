# Source Verifier — 3D-printable "SV" logo

A print-ready logo with the letters **S** and **V** interleaved. The letters
lie flat and are the object themselves — there is no separate base plate.

![top view](../sv_logo_top.png)
![iso view](../sv_logo_iso.png)

## Files

| File | Purpose |
|------|---------|
| `sv_logo.stl` | The mesh to slice/print (millimetres). |
| `scripts/generate_sv_logo.py` | Regenerates the STL from parameters. |
| `scripts/preview_sv_logo.py` | Renders `sv_logo_top.png` / `sv_logo_iso.png`. |

## Print notes

- **No base plate.** The letters lie flat and are the object; every part sits
  on the bed, so it prints **lying down with no support material**.
- The **S is built from two overlapping C-curves** (a top "(" bulging left and
  a bottom ")" bulging right) that cross in the middle.
- **S is thicker than V** (S = 8 mm, V = 5 mm). Where the two glyphs interleave,
  the thicker S reads as the top layer.
- The two C's overlap each other and the S overlaps the V, so the whole mark
  fuses into a single connected piece.

Default dimensions: ~65 × 44 mm footprint, 8 mm tall.

## Regenerating / customizing

```bash
pip install numpy-stl pillow      # one-time
python3 scripts/generate_sv_logo.py   # -> sv_logo.stl
python3 scripts/preview_sv_logo.py    # -> preview PNGs
```

Tunable constants live at the top of `scripts/generate_sv_logo.py`:

- `S_THICK` / `V_THICK` — letter thicknesses (keep S > V so it reads on top).
- `LETTER_H` — overall glyph height.
- The `s_top_C` / `s_bot_C` dicts — the two C-curves' centres, radii
  (`r_out`/`r_in` set the stroke width) and start/end angles. Move `CY_TOP` /
  `CY_BOT` closer together for more overlap between the two C's.
- `V_OFF_X` — how far the V sits over the S (how much they interleave).
