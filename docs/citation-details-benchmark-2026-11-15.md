# Citation details in the prompt: benchmark (2026-11-15)

This run checks `PROMPT_VERSION` v3, which sends the citation as the article
shows it, the source URL and today's date with every check. That is cause 1 of
`docs/design-plans/2026-11-08-fixable-causes-of-disputed-verdicts.md`.

> **Update (2026-11-17), read this first.** A re-run on the 263-row dataset
> (v4 added) changes the reading below. Two more runs of v3 on GPT-OSS-20b
> score the same as the old prompt, so the 2026-11-15 loss was most likely a
> low run. The rule without "for nothing else in the claim" is the variant that
> loses, in all four of its GPT-OSS runs. See the last section.

**Short answer (2026-11-15, superseded above): on the main metric (Supported vs everything else), no
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

## Re-run on 263 rows (2026-11-17)

v4 brought the dataset to 263 rows. It adds 74 rows from the Source
Verification QA sheet, every one of them a batch-pipeline flag that a volunteer
reviewed (`docs/benchmark-v4-source-verification-qa-2026-11-17.md`). 249 rows
are scored. `citation_text` was backfilled for v4 by the `cite_ref` id in each
row's provenance, because their citation numbers are approximate. 72 of the 73
v4 rows that cite a source have one.

- **Old prompt:** a fresh run of `main` at `604f373`. The second control is
  `main`'s own same-day run, `benchmark/results_three_way_2026-11-17.json`.
- **v3:** this branch as committed. Two runs on GPT-OSS, one on Qwen3.8.
- **Edited rule:** v3 without "and for nothing else in the claim". Two runs on
  GPT-OSS, one on Qwen3.8.
- `BENCHMARK_TODAY=2026-11-17`. Raw rows are in
  `benchmark/results_citation_details_2026-11-17.json`.

Supported vs everything else, all 249 scored rows:

| Model | Old prompt | v3 as committed | Edited rule |
|---|---|---|---|
| GPT-OSS-20b | 82.7%, 82.7% | 82.3%, 82.7% | 81.1%, 80.7% |
| Qwen3.8 | 83.5%, 83.1% | 82.3% | 83.1% |

Good citations wrongly flagged (of 91 Supported rows):

| Model | Old prompt | v3 as committed | Edited rule |
|---|---|---|---|
| GPT-OSS-20b | 37, 36 | 39, 36 | 40, 40 |
| Qwen3.8 | 25, 27 | 26 | 25 |

The same split by subset. v1–v3 (181 rows) is the set the 2026-11-15 runs
used; v4 (68 rows) is new.

| Model | Run | v1–v3 correct | v1–v3 good flagged | v4 correct | v4 good flagged |
|---|---|---|---|---|---|
| GPT-OSS-20b | old ×2 | 80.1%, 79.6% | 31, 30 | 89.7%, 91.2% | 6, 6 |
| GPT-OSS-20b | v3 ×2 | 80.7%, 80.1% | 31, 30 | 86.8%, 89.7% | 8, 6 |
| GPT-OSS-20b | edited ×2 | 77.9%, 77.3% | 33, 34 | 89.7%, 89.7% | 7, 6 |
| Qwen3.8 | old ×2 | 82.3%, 81.2% | 20, 22 | 86.8%, 88.2% | 5, 5 |
| Qwen3.8 | v3 | 81.2% | 21 | 85.3% | 5 |
| Qwen3.8 | edited | 82.9% | 20 | 83.8% | 5 |

**All GPT-OSS runs on v1–v3 so far** (Supported vs everything else):

| Prompt | Runs | Mean |
|---|---|---|
| Old | 80.1, 79.6, 80.1, 79.6 | 79.9% |
| v3 as committed | 76.8, 80.7, 80.1 | 79.2% |
| Lines, no rule | 77.3 | 77.3% |
| Edited rule | 77.9, 76.8, 77.9, 77.3 | 77.5% |

### Reading it

- **v3 as committed shows no clear damage on either model.** On all 249
  rows it is within a point of the old prompt on both. On GPT-OSS, two of its
  three v1–v3 runs match the old prompt, and the third, from 2026-11-15, is
  the outlier. The 2026-11-15 conclusion that "the lines cause the loss" rested
  on that one run and on the one lines-only run. It does not hold up.
- **Dropping "for nothing else in the claim" does hurt GPT-OSS.** All four
  edited-rule runs land at 76.8–77.9% on v1–v3, against an old prompt that
  never left 79.6–80.1%. With the lines-only run at 77.3%, the likely reading is
  that the lines alone cost GPT-OSS about 2 points, and the clause wins them
  back. On Qwen3.8 the edited rule is neutral.
- **The old prompt is very stable run to run on GPT-OSS** (four runs within
  half a point on v1–v3). The prompts with the citation lines vary more. That
  is part of why a single run misled.
- **v4 is too small to separate the prompts.** 68 rows and 11 Supported, so a
  flagged good citation or a missed failing one moves it 1.5 points. Every run
  scores 84–91% there, in no consistent order.

**Keep the rule as committed.** v3 with the clause is the best-supported
choice: neutral on both models over 249 rows, and the clause is both a
safeguard and, on GPT-OSS, worth about 2 points. The field replay of the rated
date rows is still the test of whether the change does what it is for.
