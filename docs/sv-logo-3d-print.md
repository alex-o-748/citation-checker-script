# Source Verifier — 3D-printable "SV" logo

A print-ready logo with the letters **S** and **V** interleaved as a raised
relief on a solid base plate.

![top view](../sv_logo_top.png)
![iso view](../sv_logo_iso.png)

## Files

| File | Purpose |
|------|---------|
| `sv_logo.stl` | The mesh to slice/print (millimetres). |
| `scripts/generate_sv_logo.py` | Regenerates the STL from parameters. |
| `scripts/preview_sv_logo.py` | Renders `sv_logo_top.png` / `sv_logo_iso.png`. |

## Print notes

- **Everything sits on the base**, so the whole model touches the bed — good
  adhesion, no floating parts.
- The letters lie **flat in the plane of the base** and are extruded upward as
  a relief, so it prints **lying down with no support material**.
- **S is raised higher than V** (S tops out at 11 mm, V at 8 mm, on a 4 mm
  base). Where the two glyphs interleave, the taller S reads as the top layer.

Default dimensions: 120 × 70 mm footprint, 11 mm tall.

## Regenerating / customizing

```bash
pip install numpy-stl pillow      # one-time
python3 scripts/generate_sv_logo.py   # -> sv_logo.stl
python3 scripts/preview_sv_logo.py    # -> preview PNGs
```

Tunable constants live at the top of `scripts/generate_sv_logo.py`
(`BASE_W/D/H`, `LETTER_H`, `STROKE`, `S_RAISE`, `V_RAISE`, and the letter
placement offsets). Increase `S_RAISE` / `V_RAISE` for a deeper relief, or
change `V_OFF_X` to tighten/loosen how much the letters overlap.
