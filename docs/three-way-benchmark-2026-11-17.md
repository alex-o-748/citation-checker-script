# GLM 5.2 vs gpt-oss-20b vs Qwen3.8: full dataset with v4 (2026-11-17)

This run compares three keyless providers on the full 263-row dataset, including the 74 new v4 rows (`docs/benchmark-v4-source-verification-qa-2026-11-17.md`):

- `hf-glm-5.2`: GLM 5.2 on Hugging Face, Novita backend
- `hf-gpt-oss-20b`: gpt-oss-20b on Hugging Face
- `liftwing-qwen3.8-27b`: Qwen3.8 on Lift Wing

All three used the current prompt (`core/prompts.js`, last changed 2026-09-28).

- Results: `benchmark/results_three_way_2026-11-17.json`
- Analysis: `benchmark/analysis_three_way_2026-11-17.json`
- `results.json` is unchanged

```bash
node run_benchmark.js --providers=hf-gpt-oss-20b,liftwing-qwen3.8-27b,hf-glm-5.2 \
  --results results_three_way_2026-11-17.json
node analyze_results.js --results results_three_way_2026-11-17.json \
  --analysis analysis_three_way_2026-11-17.json
```

## Headline

**GLM 5.2 and gpt-oss-20b are statistically tied, and both clearly beat Qwen3.8.**

- GLM is ahead on exact accuracy by 2.8 points, which is inside the noise.
- GLM is well ahead on lenient and binary accuracy, because it puts many more failing citations in *Partially supported* rather than *Not supported*.
- The two models raise false alarms on Supported citations at the same rate overall.

| Provider | Exact | Lenient | Binary | Supported-vs-rest | Errors | Avg latency |
|---|---|---|---|---|---|---|
| `hf-glm-5.2` | **68.0%** | **82.2%** | **83.8%** | 81.8% | 2 / 249 | 5.5 s |
| `hf-gpt-oss-20b` | 65.1% | 72.3% | 72.7% | 82.7% | 0 / 249 | 7.8 s |
| `liftwing-qwen3.8-27b` | 49.4% | 55.4% | 71.1% | **83.1%** | 0 / 249 | 8.7 s |

These are `analyze_results.js` figures over 249 scoreable rows per provider. That excludes 7 rows with an `excluded_reason` and 9 with no stored source. GLM's 2 errors are Novita returning `400 Provider returned error` on `row_83` and `row_251`, every time, across a retry.

## Detection: TPR and FPR

Positive means the citation genuinely fails, i.e. the ground truth is anything but Supported (see CLAUDE.md, "The positive class is the failing citation"). A flag is any verdict other than SUPPORTED.

These figures cover the 247 rows that all three providers answered.

| Subset | Rows (fail / ok) | GLM TPR / FPR | gpt-oss TPR / FPR | Qwen3.8 TPR / FPR |
|---|---|---|---|---|
| All | 247 (156 / 91) | 94.2 / 39.6 | 95.5 / 39.6 | 90.4 / **29.7** |
| v1–v3 | 180 (100 / 80) | 93.0 / 41.3 | 93.0 / 37.5 | 88.0 / **27.5** |
| v1–v3, whole sources only | 133 (76 / 57) | 92.1 / 40.4 | 90.8 / 36.8 | 88.2 / **26.3** |
| v4 | 67 (56 / 11) | 96.4 / **27.3** | 100.0 / 54.5 | 94.6 / 45.5 |

Exact accuracy on the same subsets:

| Subset | GLM | gpt-oss | Qwen3.8 |
|---|---|---|---|
| v1–v3 | 64.4% | 61.1% | 46.7% |
| v4 | 77.6% | 76.1% | 56.7% |

## How sure are the rankings

These are paired differences in exact accuracy on the same rows, with 95% bootstrap confidence intervals (4,000 resamples).

| Comparison | All rows (247) | v4 (67) |
|---|---|---|
| GLM − gpt-oss | +2.8 pp [−3.2, +8.9]; 32 rows only GLM got right, 25 only gpt-oss | +1.5 pp [−10.4, +13.4] |
| GLM − Qwen3.8 | **+18.6 pp [+10.9, +26.3]** | **+20.9 pp [+4.5, +37.3]** |
| gpt-oss − Qwen3.8 | **+15.8 pp [+8.5, +23.1]** | **+19.4 pp [+4.5, +34.3]** |

## Why Qwen3.8's exact accuracy is low

Qwen3.8 answered **SOURCE UNAVAILABLE on 57 rows**, and no scoreable row carries that label.

- Its rationales say the evidence "is not in the provided text" or that the page is "only navigation". It is using the verdict for absence, not for an unreadable source.
- 39 of the 57 rows are labelled *Not supported*.
- The SU rows are not longer than the rest (median 6.6k vs 6.9k chars), so this is not a context limit.
- Each SU answer still counts as a flag, so Qwen keeps its TPR, and SU on a Supported row is a false positive. Its exact accuracy collapses all the same.

This matches the October run, where Qwen3.8 scored 47.5% exact on v1–v3 (`docs/liftwing-qwen36-vs-qwen38-2026-10-21.md`).

A few of those rows (`row_17`, `row_22`) really are archive banners labelled *Not supported*. That is a ground-truth issue in the older rows worth an audit pass.

Qwen does have the lowest false-positive rate on v1–v3: it flags 27.5% of good citations, against 37.5% for gpt-oss and 41.3% for GLM. If the deciding metric is "how often does the tool cry wolf", Qwen is the most conservative of the three. It just labels its flags badly.

## Read the v4 numbers with care

- **Only 11 Supported rows are scoreable**, so each FPR there moves 9 points per row. GLM's 27.3% is 3 rows and gpt-oss's 54.5% is 6. That direction agrees with nothing in v1–v3, so do not quote it as a finding.
- **Every v4 row began as a batch-pipeline flag.** v4 measures agreement with human review of flags, not detection on a random sample of citations.
  - The batch model is not recorded in `verification_logs`; batch findings live in ToolsDB.
  - One reviewer note says "Qwen going in circles", which suggests the batch model was a Qwen. If so, the rows Qwen mis-flagged are over-represented among v4's Supported rows, which biases its v4 FPR upward.

## Verdict

- **Exact accuracy:** GLM 5.2 and gpt-oss-20b are statistically tied.
  - GLM is the better calibrated of the two on the Partially/Not split (lenient 82% vs 72%) and is faster on HF (5.5 s vs 7.8 s).
  - Its Novita backend refused 2 of 249 requests. gpt-oss refused none.
- **Qwen3.8** is about 16–19 points behind both on exact accuracy, mainly through its habit of answering SOURCE UNAVAILABLE.
- **False positives on v1–v3:** Qwen3.8 has the lowest rate, by about 10 points against gpt-oss. That gap is over 80 Supported rows and has not been tested for significance.
