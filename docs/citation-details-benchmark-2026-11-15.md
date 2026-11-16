# Citation details in the prompt: benchmark (2026-11-15)

This run checks `PROMPT_VERSION` v3, which sends the citation as the article
shows it, the source URL and today's date with every check. That is cause 1 of
`docs/design-plans/2026-11-08-fixable-causes-of-disputed-verdicts.md`.

**Short answer: on the main metric (Supported vs everything else), no
collateral damage on Qwen3.8, and a small loss on GPT-OSS-20b that is about
the size of the noise. This benchmark barely tests what the change is for.**

- **Qwen3.8**, the default model, goes from 80.7% to 81.2%. Good citations
  wrongly flagged fall from 23 to 21.
- **GPT-OSS-20b** goes from 80.1% / 79.6% (two runs of the old prompt) to
  76.8% / 77.3% (two runs with the citation lines), about 4 rows of 181.
  - Two of those rows are calls that ran out of output budget (0–1 in the
    controls).
  - On rows that got an answer, the new runs flip 6–7 rows to wrong and 2–3 to
    right, while the two controls flip 3 each way between themselves. A sign
    test on 7 vs 3 gives p ≈ 0.34.
  - Only row_172 is worse in every comparison.
  - Exact-match accuracy, which also scores Partially vs Not supported, drops
    more, about 5 points (table below). The extra lines mostly change that
    shading, not whether a citation gets flagged.
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

### Main metric: Supported vs everything else

The ground truth and the verdict are each collapsed to Supported or not, and a
row scores when the two agree. Errors count as wrong.

| Model | Run | Correct | Good citations flagged | Failing citations missed | Errors |
|---|---|---|---|---|---|
| Qwen3.8 | control | 146/181 (80.7%) | 23 | 12 | 0 |
| Qwen3.8 | treatment | 147/181 (81.2%) | 21 | 13 | 0 |
| GPT-OSS-20b | control | 145/181 (80.1%) | 31 | 5 | 0 |
| GPT-OSS-20b | control2 | 144/181 (79.6%) | 30 | 6 | 1 |
| GPT-OSS-20b | treatment | 139/181 (76.8%) | 33 | 7 | 2 |
| GPT-OSS-20b | lines-only | 140/181 (77.3%) | 30 | 9 | 2 |

Flips on this metric, over rows answered in both runs:

| Model | Comparison | Became right | Became wrong | Rows that became wrong |
|---|---|---|---|---|
| Qwen3.8 | control → treatment | 7 | 6 | 16, 33, 132, 180 (good, now flagged); 137, 140 (failing, now missed) |
| GPT-OSS-20b | control → control2 (noise) | 3 | 3 | 132; 127, 162 |
| GPT-OSS-20b | control → treatment | 3 | 7 | 25, 66, 132, 149, 172; 127, 162 |
| GPT-OSS-20b | control2 → treatment | 2 | 6 | 9, 25, 66, 149, 172; 187 |
| GPT-OSS-20b | control → lines-only | 3 | 6 | 132, 172; 83, 162, 173, 183 |
| GPT-OSS-20b | control2 → lines-only | 3 | 6 | 46, 172; 83, 173, 183, 187 |

With the full change, GPT-OSS's new errors are mostly good citations flagged
as Partially supported (rows 25, 66, 149, 172). With the lines alone, they are
mostly failing citations it now misses. Neither pattern repeats across both
runs, apart from row_172.

### Exact match (four verdicts)

| Model | Run | Exact | Supported flagged (FPR) | Failing caught (TPR) | Errors |
|---|---|---|---|---|---|
| Qwen3.8 | control | 84/181 (46.4%) | 23/80 (28.8%) | 89/101 (88.1%) | 0 |
| Qwen3.8 | treatment | 85/181 (47.0%) | 21/80 (26.3%) | 88/101 (87.1%) | 0 |
| GPT-OSS-20b | control | 118/181 (65.2%) | 31/80 (38.8%) | 96/101 (95.0%) | 0 |
| GPT-OSS-20b | control2 | 118/181 (65.2%) | 31/80 (38.8%) | 95/101 (94.1%) | 1 |
| GPT-OSS-20b | treatment | 109/181 (60.2%) | 34/80 (42.5%) | 94/101 (93.1%) | 2 |
| GPT-OSS-20b | lines-only | 110/181 (60.8%) | 31/80 (38.8%) | 92/101 (91.1%) | 2 |

Errors count as wrong. They are the model spending its whole 16,384-token
output budget on reasoning. Exact-match flips against the control (better /
worse / lateral):

| Model | Comparison | Better | Worse | Lateral |
|---|---|---|---|---|
| Qwen3.8 | control → treatment | 10 | 9 | 5 |
| GPT-OSS-20b | control → control2 (noise) | 9 | 9 | 7 |
| GPT-OSS-20b | control → treatment | 9 | 18 | 4 |
| GPT-OSS-20b | control2 → treatment | 8 | 17 | 7 |
| GPT-OSS-20b | control → lines-only | 5 | 13 | 10 |
| GPT-OSS-20b | control2 → lines-only | 8 | 16 | 8 |

## Reading it

- **Exact-match noise is about 25 flips per run on GPT-OSS, and balanced.** Two controls
  flipped 25 rows between them, 9 better and 9 worse, with identical totals.
  Both runs with the lines lean the same way against both controls, so the loss
  is probably real. But it is about 9 rows out of 181 and spread out: only 3
  rows were right in both controls and wrong in both runs with the lines
  (row_164, row_167, row_172).
- **The rule is not the cause.** lines-only scores the same as the treatment.
  It is the extra lines in the user message.
- **The loss is mostly in shading, not in flagging.** The exact-match losses
  are mostly Partially → Not supported (6) and Supported → Partially (4). On
  Supported vs everything else, GPT-OSS loses about 4 rows, 2 of them
  errors.
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

## Follow-up (2026-11-16): a looser rule, and GLM-5.2

The first question was whether "and for nothing else in the claim" made the
models stricter. The test removes that clause from the rule and changes nothing
else (`BENCHMARK_PROMPT_OVERRIDE_FILE`; the committed prompt is unchanged).
The rule then reads:

> - The message may also give the citation as it appears in the Wikipedia article, the source's URL, and today's date. The citation and URL say what the source is: treat them as evidence for who published the source, who wrote it, and when it was published. Use the publication date to resolve relative dates in the source text ("on Thursday", "last year"). If the source text itself gives a different author or date, trust the source text. Dates up to today's date are in the past, even if they are later than you expect.

The second was a third model: GLM-5.2 (`hf-glm-5.2`, `zai-org/GLM-5.2`). It
goes through the Cloudflare Worker's keyless `/hf` route, because the
Toolforge router does not allow it. Its three runs went one at a time to stay
under the Worker's 20-requests-a-minute limit. Raw rows were added to
`benchmark/results_citation_details_2026-11-15.json` (runs `edited-rule*` and
`glm-*`).

Supported vs everything else (181 scored rows; errors count as wrong):

| Model | Old prompt | v3 as committed | Edited rule |
|---|---|---|---|
| GPT-OSS-20b | 80.1%, 79.6% | 76.8% | 77.9%, 76.8% |
| Qwen3.8 | 80.7% | 81.2% | 82.9% |
| GLM-5.2 | 79.6% | 78.5% | 80.7% |

Good citations wrongly flagged:

| Model | Old prompt | v3 as committed | Edited rule |
|---|---|---|---|
| GPT-OSS-20b | 31, 30 | 33 | 32, 34 |
| Qwen3.8 | 23 | 21 | 20 |
| GLM-5.2 | 31 | 31 | 28 |

- **GPT-OSS's loss is not the clause.** Every run with the three new lines
  is 2–3 points below the old prompt, whatever the rule says. row_172 is
  flagged in every one of them, and rows 25 and 149 in most.
- **On Qwen3.8 and GLM-5.2 the edited rule is the best of the three.** It is
  +2.2 and +1.1 points over the old prompt, against +0.5 and −1.1 for v3. Each
  is one run, inside the 2–3 point noise, so the honest reading is "no damage,
  possibly a little better".
- **The trade-off of dropping the clause.** It was the explicit guard against
  reading a footnote's own text (a `|quote=`, a descriptive title) as support
  for the claim's substance. Without it, the rule still lists what the
  citation is evidence for, but no longer says it is evidence for nothing else.
