# Validation run, enwiki, 13 Nov 2026

The seven pages named in the task, run with `--source api --until 2026-11-13T00:00:00Z`.

- The four pages with an `editsuggestion-used` edit (List of fictional ships, Beef clod, Dubin v. United States,
  OpenAI) all carry flagged claims. Each of Dreamyshade's four edits was diffed by hand; every flagged claim
  they touched is detected with the right kind — 7 claims: a source added (OpenAI [12]; Dubin [1], which also
  removed a {{failed verification}} from May 2024), a source URL replaced inside the named ref `:8` (two List of
  fictional ships rows), and three rewordings. Nothing they changed was missed.
- Two supported claims changed, both correctly: "(AWS)" added by another editor, and a moved VentureBeat URL
  replaced by GreenC bot (marked as a bot edit).
- Kumiharu Shigehara, Colette Kress and National Military Cemetery, Abuja are in no batch file (checked by
  title and page id), so they carry no Source Verification suggestion; their `editsuggestion-seen` tags come
  from other suggestion types.

Two detector gaps were found and fixed by this run: a source added beside the footnote, or a flag removed, were
not counted; and a URL changed inside a kept named ref was missed.
