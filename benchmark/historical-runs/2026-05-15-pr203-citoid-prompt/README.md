# PR 203 — citoid + two-step prompt, isolated effect (2026-05-15)

Empirical evidence committed alongside [PR #203](https://github.com/alex-o-748/citation-checker-script/pull/203). Generated 2026-05-15.

## What this measures

Isolates the **Citoid header + two-step prompt** contribution from PR 203, holding extraction constant at production PAP (strip-based). Defuddle extraction (PAP #14) is **not** exercised here — that's a separate experiment.

| Run | Code | PAP extraction | Citoid header | Prompt |
|---|---|---|---|---|
| `results-baseline.json` | `origin/main` (027fc5b) | strip (production PAP) | off | old single-step (with `confidence` field) |
| `results-pr203.json` | `origin/main` + PR #203 head (c3dd3c4) | strip (production PAP) | **on** | **two-step, no `confidence`** |

Both runs:
- v1+v2+v3 dataset, 189 rows, 181 valid after extraction-status filter
- 9 providers (10 requested; `openrouter-olmo-3.1-32b` no longer defined on `origin/main` and was auto-skipped)
- Concurrency 5; `--version all`
- `claude-sonnet-4-5` provider's `model:` field patched locally `claude-sonnet-4-5-20250929` → `claude-sonnet-4-6` to match `main.js` BYOK and `cli/verify.js` defaults. The provider key was kept (`claude-sonnet-4-5`) so the result records collate; only the model string differs. Filing a one-line upstream bump is a clean follow-up.

## Headline accuracy

| Provider | n | Control exact | Treatment exact | Δ exact | Δ lenient | Δ binary |
|---|---:|---:|---:|---:|---:|---:|
| `hf-deepseek-v3` | 181 | 44.2% | **65.7%** | **+21.5** | +14.4 | +1.7 |
| `claude-sonnet-4-6` | 181 | 42.5% | **58.6%** | **+16.0** | **+19.9** | +9.9 |
| `openrouter-granite-4.1-8b` | 181 | 55.8% | **65.7%** | +9.9 | +11.0 | +8.8 |
| `openrouter-gemma-4-26b-a4b` | 181 | 53.6% | **61.9%** | +8.3 | +12.7 | +0.6 |
| `hf-gpt-oss-20b` | 157 | 59.2% | **65.6%** | +6.4 | +10.2 | +10.2 |
| `openrouter-mistral-small-3.2` | 181 | 42.5% | 47.0% | +4.4 | +3.3 | −4.4 |
| `hf-qwen3-32b` | 181 | 59.7% | 63.0% | +3.3 | +3.9 | +3.3 |
| `gemini-2.5-flash` | 177 | 65.5% | 67.2% | +1.7 | +2.3 | +3.4 |
| `openrouter-qwen-3-32b` | 180 | 60.6% | 60.6% | +0.0 | +2.2 | −3.9 |

All deltas are pp. `hf-gpt-oss-20b`'s n=157 reflects parse errors (14 in control, 15 in treatment) excluded from the intersection. `gemini-2.5-flash` n=177 reflects 3 + 1 control/treatment errors. Noise floor for single-provider comparisons is ±5pp (95% CI heuristic).

**Aggregate flip direction (per `ccs compare`):**

| Direction | Count |
|---|---:|
| improvement | 225 |
| lateral | 113 |
| regression | 97 |

Improvement-to-regression ratio: 2.32×.

## Reproduce

```sh
# From repo root, after npm install in root + benchmark/
npx ccs compare \
  benchmark/historical-runs/2026-05-15-pr203-citoid-prompt/results-baseline.json \
  benchmark/historical-runs/2026-05-15-pr203-citoid-prompt/results-pr203.json \
  --dataset benchmark/dataset.json \
  --change-axis prompt --change-axis source_text \
  --report out.html
```

The full per-row flip listing is in [`compare.md`](./compare.md).

## What this does *not* show

- **Defuddle's contribution.** PAP #14 introduces Defuddle-based extraction. To measure citoid+prompt+Defuddle vs strip baselines, rerun with the PAP #14 worker pointed at as the `PAP_URL` (or wait for #14 to deploy and rerun against production).
- **Body-classifier compatibility.** PR 203's three commits don't include a pipeline-side body-classifier; if a body-classifier stack lands and the verdict set is collapsed to 3, these numbers may shift.
- **Ensemble (vote-3) panels.** Not computed here; raw results files support post-hoc ensembling via `compute_ensemble.js` if needed.
