# Citation details in the prompt: benchmark (2026-11-15)

This run checks `PROMPT_VERSION` v3, which sends the citation as the article
shows it, the source URL and today's date with every check. That is cause 1 of
`docs/design-plans/2026-11-08-fixable-causes-of-disputed-verdicts.md`.

**Short answer: neutral on Qwen3.8; GPT-OSS-20b loses about 5 points of exact
accuracy; and this benchmark barely tests what the change is for.**

- On Lift Wing Qwen3.8, the default model, nothing moved outside noise.
- On GPT-OSS-20b, exact accuracy fell about 5 points in two runs out of two.
  The cause is the lines in the user message, not the new system-prompt rule.
  The loss is mostly Partially ↔ Not supported, so whether a citation gets
  flagged at all barely changed.
- Few of the 182 rows hinge on who published a source or what its dateline
  says, which is the failure the change targets. The decisive check is the
  field replay of the 22 rated date rows, which has not been run.

## Setup

- 182 rows of `benchmark/dataset.json` with source text, 181 scored (1
  excluded). Temperature 0.1, concurrency 3, all runs on the same day.
- Lift Wing `llm-qwen38-27b` (benchmark provider `liftwing-qwen3.8-27b`) and
  `openai/gpt-oss-20b` on Hugging Face via the keyless route
  (`hf-gpt-oss-20b`, `HF_WORKER_BASE=https://llm-router.toolforge.org`).
- **control**: `main` at `0753ae5` (prompt v2: no citation lines, no new rule).
- **control2**: the same control again, GPT-OSS only, to measure run-to-run
  noise.
- **treatment**: this branch (prompt v3), `BENCHMARK_TODAY=2026-11-15`.
- **lines-only**: this branch with the v2 system prompt
  (`BENCHMARK_PROMPT_OVERRIDE_FILE`). It has the citation lines but not the
  new rule, so it separates the two parts of the change. GPT-OSS only.
- Every run read the same `dataset.json`, which now has `citation_text` on 187
  of 189 rows. The control code ignores that field.
- Raw rows for all four runs, without `raw_response`:
  `benchmark/results_citation_details_2026-11-15.json` (field `run`).

Positive class = ground truth is not `Supported` (see CLAUDE.md). "Supported
flagged" is the false-positive count the design doc wants to bring down.

## Results

| Model | Run | Exact | Supported flagged (FPR) | Failing caught (TPR) | Errors |
|---|---|---|---|---|---|
| Qwen3.8 | control | 84/181 (46.4%) | 23/80 (28.8%) | 89/101 (88.1%) | 0 |
| Qwen3.8 | treatment | 85/181 (47.0%) | 21/80 (26.3%) | 88/101 (87.1%) | 0 |
| GPT-OSS-20b | control | 118/181 (65.2%) | 31/80 (38.8%) | 96/101 (95.0%) | 0 |
| GPT-OSS-20b | control2 | 118/181 (65.2%) | 31/80 (38.8%) | 95/101 (94.1%) | 1 |
| GPT-OSS-20b | treatment | 109/181 (60.2%) | 34/80 (42.5%) | 94/101 (93.1%) | 2 |
| GPT-OSS-20b | lines-only | 110/181 (60.8%) | 31/80 (38.8%) | 92/101 (91.1%) | 2 |

Errors count as wrong. They are the model spending its whole 16,384-token
output budget on reasoning. Flips against the control (better / worse /
lateral):

| Model | Comparison | Better | Worse | Lateral |
|---|---|---|---|---|
| Qwen3.8 | control → treatment | 10 | 9 | 5 |
| GPT-OSS-20b | control → control2 (noise) | 9 | 9 | 7 |
| GPT-OSS-20b | control → treatment | 9 | 18 | 4 |
| GPT-OSS-20b | control2 → treatment | 8 | 17 | 7 |
| GPT-OSS-20b | control → lines-only | 5 | 13 | 10 |
| GPT-OSS-20b | control2 → lines-only | 8 | 16 | 8 |

## Reading it

- **Noise is about 25 flips per run on GPT-OSS, and balanced.** Two controls
  flipped 25 rows between them, 9 better and 9 worse, with identical totals.
  Both runs with the lines lean the same way against both controls, so the loss
  is probably real. But it is about 9 rows out of 181 and spread out: only 3
  rows were right in both controls and wrong in both runs with the lines
  (row_164, row_167, row_172).
- **The rule is not the cause.** lines-only scores the same as the treatment.
  It is the extra lines in the user message.
- **The loss is mostly in shading, not in flagging.** The worse flips are
  mostly Partially → Not supported (6) and Supported → Partially (4). The
  share of Supported rows flagged is unchanged in lines-only (31/80) and up 3
  in the treatment, which is within noise. TPR dips 1-4 points.
- **The model seldom uses the lines.** GPT-OSS's rationales mention a
  citation, publication date or URL on 8 rows (3 in the control), Qwen3.8's on
  23 (18), and almost none of those rows changed verdict. The rows the change
  is meant to fix, attribution to the publisher and datelines, are rare here.
  Nothing on this benchmark shows the target improvement, and nothing rules it
  out.

## What's next

1. Replay the 22 rated date rows and the attribution cases from the design
   doc (Handelszeitung, Laudato si') with and without the lines. That is the
   evidence this benchmark cannot give.
2. If the replay shows a gain, the open question is GPT-OSS. Either accept
   about 5 points of exact accuracy there, or try a shorter header (URL and
   date only, or the citation without the title) and re-run this comparison.
