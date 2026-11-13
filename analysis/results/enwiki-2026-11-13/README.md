# Full enwiki run, 13 Nov 2026

`summary.md` is the run's own summary, unedited: all three enwiki batches, `--source replicas` on Toolforge,
window 5 Nov 00:33 → 13 Nov 00:00 UTC. The per-claim and per-revision CSVs and the review sample were written
on Toolforge to `/data/project/source-verifier/edit-impact/enwiki/` and are not in the repository.

What it shows, without going beyond it:

- **Flagged claims changed about as often as supported ones**: 1.6% (220 of 13,630) against 1.4% (633 of
  44,847). Taking only edits *not* tagged `editsuggestion-seen`: 1.5% against 1.4%. Applying the supported
  rate to the flagged claims predicts about 192 changes; 220 were seen. Ordinary editing accounts for nearly
  all of it, and the gap is within what chance produces for groups this size.
- **Exposure was very small.** 19 of 6,359 revisions on these pages carried `editsuggestion-seen`, and the
  dashboard counts 22 times the card was shown on enwiki in the window. Most edits could not have been
  prompted by the card, so a large silent-fix effect was never possible; a small one can't be ruled out.
- **Where the tags are, the flagged claims are.** Of 12 claims first changed by a `seen`-tagged edit, 10 were
  flagged, though flagged claims are under a quarter of all claims. 7 of those 9 `used`-tagged flagged
  changes are the validation edits by one editor on 5 Nov (`analysis/validation/enwiki-2026-11-13/`).
- Four pages could not be measured (deleted or moved since the batch).

Whether the 220 flagged changes addressed the flag is what the review sample (`sample.md`) is for.
