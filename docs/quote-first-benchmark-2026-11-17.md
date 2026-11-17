# Quote first: `source_quote` before the verdict (2026-11-17)

`PROMPT_VERSION` v4 moves `source_quote` to the front of the JSON answer, ahead
of `support_score` and `verdict`, in the schema and in every few-shot example
of both system prompts. The single-source prompt's quote rule now reads "Quote
the passage that comes closest to supporting or contradicting the claim"
instead of "the passage that decides the verdict", since the verdict hasn't
been written yet when the quote is. Nothing else in the prompt changed.

The idea came from Femke on the Village pump (WMF), 2026-11-16: making the
model quote first might stop it reasoning correctly and still committing to
the wrong verdict, because it would have to find the passage before deciding.

- Results: `benchmark/results_quote_first_2026-11-17.json` (runs
  `quote-first-a`, `quote-first-b`; the `reason_type` check under
  `metadata.reason_type_check`)
- Controls (prompt v3, same day, same dataset): runs `v3-a` and `v3-b` in
  `benchmark/results_citation_details_2026-11-17.json`, and
  `benchmark/results_three_way_2026-11-17.json`
- `results.json` is unchanged

```bash
BENCHMARK_TODAY=2026-11-17 node run_benchmark.js \
  --providers=liftwing-qwen3.8-27b,hf-gpt-oss-20b --concurrency=3 \
  --results results_quote_first_a.json
```

The v4 runs were made before the change landed, with the v4 system prompt
passed as `BENCHMARK_PROMPT_OVERRIDE_FILE`. It is byte-identical to what
`generateSystemPrompt()` now returns.

## Headline

**The binary verdict doesn't move. Qwen3.8's exact accuracy rises about ten
points, because it stops calling sources unavailable. And both models start
quoting on omissions, which is why the display now hides those quotes.**

All figures are over the rows every run scored: 243 for gpt-oss-20b (5 runs),
249 for Qwen3.8 (4 runs). Strict means the source was stored whole (195 and
201 rows).

**Supported vs everything else**, each run:

| Provider | Scope | v3 (controls) | v4 (quote first) |
|---|---|---|---|
| `hf-gpt-oss-20b` | all | 82.7 · 82.7 · 83.1 | 82.3 · 81.5 |
| | strict | 83.1 · 83.6 · 84.6 | 82.6 · 82.6 |
| `liftwing-qwen3.8-27b` | all | 83.1 · 82.3 | 84.3 · 83.1 |
| | strict | 84.1 · 83.6 | 85.1 · 84.6 |

Every difference is about a point, which is what two runs of the same prompt
differ by. gpt-oss lands at the low end of its controls and Qwen at the high
end of its, and neither is a signal.

**Exact accuracy**, each run:

| Provider | Scope | v3 (controls) | v4 (quote first) |
|---|---|---|---|
| `hf-gpt-oss-20b` | all | 64.6 · 66.7 · 67.5 | 64.2 · 64.6 |
| `liftwing-qwen3.8-27b` | all | 49.4 · 50.2 | **61.4 · 59.0** |
| | strict | 51.2 · 52.2 | **61.7 · 59.7** |

Qwen's gain is far outside its run-to-run spread (under a point between its
controls, 2.4 between its v4 runs). Almost all of it is one change:

| Provider | `Source unavailable` calls, v3 | v4 |
|---|---|---|
| `liftwing-qwen3.8-27b` | 57 · 54 | **23 · 25** |
| `hf-gpt-oss-20b` | 4 · 4 · 3 | 4 · 4 |

Only one scored row in the dataset is labelled *Source unavailable*, so nearly
every one of those calls was wrong, and the three-way comparison
(`docs/three-way-benchmark-2026-11-17.md`) names them as Qwen's main weakness.
Supported-vs-rest can't see the change, because it scores *Source
unavailable* and *Not supported* as the same outcome.

Qwen's v4 verdicts differ from its v3 verdicts on 47–56 of 201 strict rows.
Two runs of the same prompt differ on 15–20, so the reorder changes how it
answers, not just which rows it gets right. gpt-oss is noisier run to run
(35–43 changed verdicts between same-prompt runs), and v4 doesn't stand out
against that.

## The side effect: quotes on omissions

The prompt says an omission (the source says nothing about the claim) gets an
empty quote. With the quote written first, the model hasn't decided it is an
omission yet:

| Provider | *Not supported* verdicts with a quote, v3 | v4 |
|---|---|---|
| `liftwing-qwen3.8-27b` | 57 / 99 · 56 / 97 | **100 / 111 · 104 / 112** |
| `hf-gpt-oss-20b` | 34 / 135 · 41 / 132 · 36 / 133 | **67 / 135 · 61 / 133** |

These quotes are usually real. They are found in the source and would pass
quote verification. But they are not evidence for anything, and in the panel
a quote under a *Not supported* verdict reads as the passage that refutes the
claim.

**Is the model relabelling the case to fit its quote?** If it called these
cases contradictions, no display rule keyed on `reason_type` could tell them
apart. The benchmark doesn't record `reason_type`, so rows that quoted under
v4 and not under v3 were re-run once under each prompt, keeping it:

| Provider | Rows | Quoted *Not supported* under v4 | Labelled `omission` |
|---|---|---|---|
| `liftwing-qwen3.8-27b` | 15 | 15 | 15 |
| `hf-gpt-oss-20b` | 15 | 8 | 7 |

The one exception (`row_114`, "The American Film Institute cites 6
contemporary reviews") is a judgement call rather than relabelling: v3 said
the source doesn't say six, and v4 quoted the citation list and counted seven.
`row_27` moved the other way, from a contradiction with a quote to an omission
without one. One row each way is ordinary label noise.

So the model keeps labelling these cases as omissions, and a display rule can
hide their quotes. That is `core/quote.js`'s `displayedQuote()`.

## What changed in the code

- `core/prompts.js`: the reorder in both system prompts, the reworded quote
  rule in the single-source prompt, `PROMPT_VERSION` v4. The group prompt keeps
  its own rule ("the single most decisive passage across all the sources"),
  which already reads naturally before a verdict.
- `core/quote.js`: `displayedQuote(check, verdict, reasonType)` returns the
  located quote only where `quoteExpectedFor()` says a passage decides the
  verdict: SUPPORTED, PARTIALLY SUPPORTED, NOT SUPPORTED with a contradiction.
- `main.js`: `buildQuoteView()` computes `display` through it. Every panel,
  report row and export reads `display` (or the stored `quoteDisplay`), so
  this one change covers them all.
- `core/pipeline.js`: `verifyCitation()` returns a new `quoteDisplay` field.
  The web tool should render it instead of `quote.verifiedText`, and its
  hand-written `.d.ts` needs the field.
- `cli/verify.js`: prints the quote line only for those verdicts.

The verification log still records `source_quote` and `quote_status` on every
row, and the batch CSV still writes them: that rule in CLAUDE.md ("Source
quotes") is unchanged. Only what is shown changed.

## Not measured

- **The group prompt.** Reordered the same way, but the benchmark only runs
  the single-source prompt.
- **The balance of omission and contradiction overall.** The `reason_type`
  check covered rows picked because their quoting changed. A full run that
  records `reason_type` would show whether v4 shifts that balance across all
  *Not supported* verdicts.
- **Paid models.** Only the two keyless ones were run.
