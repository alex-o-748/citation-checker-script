# Lift Wing: Qwen3.6-27B vs Qwen3.8-27B (2026-10-21)

Wikimedia ML asked us to move from `llm-qwen36-27b` to `llm-qwen38-27b` so the
older model can be retired. This run checks whether that costs anything.

**Short answer: 3.8 is not strictly better, but nothing measured is a reason to
stay on 3.6.** Verdict quality is a tie within noise; 3.8 is ~10% slower.
gpt-oss-safeguard-20b, measured the same day (last section), beats both on
exact accuracy and ties them on Supported-vs-rest.

## Setup

- Both models on the same 182 rows of `benchmark/dataset.json` (181 scored, 1
  excluded as unscoreable), interleaved in one run with the current
  `core/prompts.js`, temperature 0.1, concurrency 4.
- Called through the public API gateway
  (`LIFTWING_GATEWAY=1`, `api.wikimedia.org/service/lw/inference/v1/models/<model>/openai/...`),
  because `llm-router.toolforge.org` was unreachable from the machine running it.
  Both models took the same route, so latency is comparable between them, not
  with earlier tf-llm-router numbers.
- Raw rows: `benchmark/results_qwen36_vs_qwen38_2026-10-21.json`.
- One run per model. At temperature 0.1 a re-run moves a few verdicts, so read
  differences of 2-3 points as noise.

Positive class = ground truth is not `Supported` (see CLAUDE.md), so TPR is
failing citations caught and FPR is good citations flagged anyway.

## Quality

| | Qwen3.6 | Qwen3.8 | Δ (3.8 − 3.6) | 95% CI | McNemar p |
|---|---|---|---|---|---|
| Exact accuracy | 49.7% | 47.5% | −2.2pp | [−8.3, +3.9] | 0.61 |
| Supported-vs-rest | 79.0% | 81.8% | +2.8pp | [−2.2, +7.7] | 0.38 |
| TPR (failing citations caught) | 81.2% | 87.1% | +5.9pp | | |
| FPR (good citations flagged) | 23.8% | 25.0% | +1.2pp | | |
| Wrong "Source unavailable" | 36 (19.9%) | 44 (24.3%) | +8 | | |
| Errors | 0 | 0 | | | |
| Offered quotes found in source | 98.3% | 99.1% | | | |

Of 181 rows, 3.6 alone got 19 exactly right and 3.8 alone got 15; on
Supported-vs-rest it is 8 vs 13. Neither difference is significant.

3.8 leans further towards flagging: it catches more failing citations for about
the same false-alarm rate. It also says "Source unavailable" more often when the
source was there, mostly on rows whose ground truth is `Not supported` (28 vs
23). That habit already cost 3.6 the most exact accuracy in
`benchmark-ground-truth-audit-2026-09-06.md`, and 3.8 does it a little more.

By source completeness:

| Subset | n | Exact 3.6 / 3.8 | Supported-vs-rest 3.6 / 3.8 |
|---|---|---|---|
| Whole source | 133 | 52.6% / 48.9% | 79.7% / 82.0% |
| Truncated source | 48 | 41.7% / 43.8% | 77.1% / 81.3% |

## Speed

| | Qwen3.6 | Qwen3.8 |
|---|---|---|
| Median latency | 5.5 s | 6.0 s |
| p90 latency | 8.6 s | 9.6 s |
| Mean output tokens | 142 | 150 |

3.8 was faster on only 56 of 181 rows (sign test z ≈ −5), so the slowdown is
consistent, not a few outliers. It may reflect how each model is provisioned on
Lift Wing today rather than the model itself.

## Also measured: gpt-oss-safeguard-20b

The third Lift Wing model (`liftwing-safeguard`), run the same day on the same
181 rows (`benchmark/results_liftwing_safeguard_2026-10-21.json`). It ran on its
own rather than interleaved, and through the gateway's `:predict` endpoint, which
`LIFTWING_GATEWAY=1` now unwraps the way tf-llm-router does. The gateway returns
no token counts for it.

| | Qwen3.8 | safeguard-20b | hf-gpt-oss-20b ¹ |
|---|---|---|---|
| Exact accuracy | 47.5% | **66.9%** | 65.2% |
| Supported-vs-rest | 81.8% | 79.6% | 80.7% |
| TPR (failing citations caught) | 87.1% | 94.1% | 96.0% |
| FPR (good citations flagged) | 25.0% | 38.8% | 38.8% |
| Wrong "Source unavailable" | 44 | 5 | 3 |
| Offered quotes found in source | 99.1% | 80.8% | 92.7% |
| Median / p90 latency | 6.0 s / 9.6 s | 5.5 s / 12.8 s | 1.3 s / 8.6 s |

¹ The userscript's default provider, from `results.json` (2026-08-23 run, an
earlier prompt, a different route), so treat its column as indicative.

- **Exact accuracy: safeguard is clearly better than Qwen3.8**: +19.3pp, 95% CI
  [+11.0, +27.6], McNemar p < 0.001 (52 rows only safeguard got right, 17 only
  Qwen3.8). Almost all of it comes from two things: it nearly never says "Source
  unavailable" when the source is there (5 vs 44), and it uses
  `Partially supported` (30 of 54 right vs 7).
- **Supported-vs-rest is a tie** (−2.2pp, p = 0.54). Safeguard catches more
  failing citations but flags 39% of good ones against Qwen3.8's 25%. For a
  tool whose output an editor acts on, that false-alarm rate is the cost.
- **Against hf-gpt-oss-20b it is a tie on everything measured** (exact +1.7pp,
  p = 0.70; identical FPR). It is the same base model, so this is expected.
- **Quotes:** 23 of its offered quotes were not found in the source. Spot checks
  show real sentences from different places joined without an ellipsis, so the
  panel's quote check hides them (as designed) rather than showing them.
