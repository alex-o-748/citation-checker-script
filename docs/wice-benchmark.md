# Benchmarking against WiCE

[WiCE](https://github.com/ryokamoi/wice) (Kamoi, Goyal, Rodriguez & Durrett, *"WiCE: Real-World Entailment for Claims in Wikipedia"*, EMNLP 2023) is a human-annotated entailment dataset built from real Wikipedia sentences and the web pages they cite. Its three labels line up with three of our four verdicts, which makes it something our own dataset can't be: an **external** benchmark, labeled by people with no stake in this tool, over claims nobody here selected.

`benchmark/convert_wice.js` converts it into a `dataset.json`-shaped file that the existing runner and analyzer consume unchanged.

## Quick start

From inside `benchmark/`:

```sh
npm run wice:convert      # fetch + convert dev+test -> dataset_wice.json (707 rows)
npm run wice:benchmark    # run providers against it -> results_wice.json
npm run wice:analyze      # metrics -> analysis_wice.json
```

Each is a thin alias; the underlying commands take the usual flags:

```sh
node convert_wice.js --splits dev,test,train      # add the 1,260-row train split
node convert_wice.js --wice-dir ../wice           # convert from a local clone, no network
node run_benchmark.js --dataset dataset_wice.json --results results_wice.json \
    --providers=claude,gemini --concurrency 8
```

The converter caches its downloads in `benchmark/.wice-cache/` (gitignored — ~25 MB for dev+test, ~38 MB if you add train), so re-running costs nothing.

### `dataset_wice.json` is generated, not committed

It is 7 MB — larger than this repo's entire git history — and unlike `dataset.json` it is **deterministically** reproducible: `npm run wice:convert` rebuilds it byte-identically from a pinned upstream repo. So it is gitignored, and you run the converter once before benchmarking.

`dataset.json` is committed precisely because it *isn't* reproducible (it depends on live Wikipedia revisions and live source fetches, which is also why the frozen `dataset_v1/v3.json` snapshots exist). Different property, different call.

To make a rebuild verifiable, the converter records a SHA-256 of the row payload in the file's metadata and prints it on completion. For dev+test at the time of writing:

```
956b87a90a9177916225a2e2e59490cfc8462b434cf5ee7dcaf6641e6cad2fa8
```

If your rebuild prints something else, upstream WiCE changed — and any existing `results_wice.json` is no longer attributable to a known corpus. Benchmark *outputs* (`results_wice.json`, `analysis_wice*.json`) are not gitignored; those are findings worth keeping.

**Why dev+test by default:** those splits were annotated by five workers each and manually error-corrected by the authors; train got three workers and no correction pass. 707 rows is also a reasonable default benchmark spend.

## Why this is kept separate from `dataset.json`

`dataset_wice.json` is a **separate file**, not rows merged into the main dataset. Three reasons:

1. Merging would disturb the frozen v1/v3 snapshots and the analyses derived from them.
2. WiCE row ids come from upstream (`wice_dev01234`), so they sidestep the CSV-line-number id fragility described in `CLAUDE.md` entirely — but only as long as they live in their own file.
3. WiCE's label distribution is deliberately unrepresentative (see below), so pooling it with our curated rows would silently change what headline accuracy means.

## Where WiCE's task differs from ours

This is the part that matters for interpreting a WiCE score. All four differences are handled in `benchmark/wice.js` and recorded on every converted row.

### 1. Claim level, never subclaim level

WiCE ships two parallel corpora: one row per Wikipedia **sentence** (`claim/`), and one row per GPT-3.5-decomposed **atomic fact** (`subclaim/`). Our verifier never decomposes a claim — it judges the span between adjacent citation markers as a unit — so scoring it on subclaims would measure a task the tool does not perform. **We convert the claim-level corpus only.**

### 2. Claim-level labels are *derived*, not annotated

The subtle one, and the reason to read this section before trusting a number.

WiCE's annotators only ever labeled subclaims. Claim-level labels are projected from them by a rule (paper §2.4):

| Subclaim labels | Projected claim label |
| --- | --- |
| all `supported` | `supported` |
| all `not_supported` | `not_supported` |
| anything mixed | `partially_supported` |

That rule is not our rubric. A claim whose every substantive part is unsupported, but which happens to carry one incidentally-true subclaim, lands in `partially_supported` under the projection — where our rubric, and a human editor, would likely say **Not supported**. It is also why `partially_supported` is ~57% of the converted rows, far above its share of our own dataset.

So the converter joins the subclaim corpus back in and records, per row:

| Field | Meaning |
| --- | --- |
| `wice_subclaim_labels` | The labels annotators actually assigned |
| `wice_subclaim_count` | How many subclaims the sentence decomposed into (2–6) |
| `wice_label_projection` | `unanimous` — subclaims agreed, so the claim label means what ours means<br>`mixed` — the label is an artifact of the projection rule |

**Use the split.** The `unanimous` subset (328 of 707 rows) is the apples-to-apples comparison. The `mixed` subset (379 rows) is a stress test where a disagreement may be rubric divergence rather than model error — a `Not supported` prediction against a `Partially supported` projected label is exactly the case to inspect by hand before calling it a miss.

`analyze_results.js --projection` scores either subset in place:

```sh
npm run wice:analyze:unanimous          # the 328 rows whose label isn't a projection artifact
npm run wice:analyze:mixed              # the 379 rows where our rubric may legitimately differ

# or directly, with the usual flags
node analyze_results.js --dataset dataset_wice.json --results results_wice.json \
    --projection unanimous --analysis analysis_wice_unanimous.json
```

Read the two together: a verifier that scores well on `unanimous` and poorly on `mixed` is probably applying our rubric correctly and being marked wrong by WiCE's projection rule. One that scores poorly on both has a real problem.

### 3. Claim granularity differs, and can't be fixed

A WiCE claim is a whole Wikipedia sentence. Ours is the span between adjacent citations, which equals a full sentence only when the citation is sentence-final and nothing cites mid-sentence. WiCE claims therefore skew longer and denser than our median row. No transform undoes this; `wice_subclaim_count` is recorded as a claim-complexity proxy to slice on instead.

### 4. Frozen evidence, not a live fetch

WiCE's `evidence` is the cited page as a sentence list, captured from Common Crawl in 2023. The converter joins it into one `source_text` rather than re-fetching the URL, because the annotators labeled against *that* text — re-fetching would silently invalidate the ground truth and collect years of link rot on the way.

Consequences:

- A WiCE run exercises the prompt, the model, and the quote verifier, but **not** the CORS-proxy fetch path.
- Results are fully reproducible and need no network at run time.
- WiCE ships **no source URL**, so `source_url` is `null`; the page's own title and publisher are recovered from its metadata lines into `source_title` / `source_publisher`.
- There are **no `Source unavailable` rows** — every WiCE row has evidence. That verdict class is untested here and still needs our own dataset.

Sentences are joined with single spaces, matching what the CORS proxy's `extractText()` emits, so the model's input stays distributionally close to production. WiCE's `(meta data) ` marker prefix is stripped (the content is kept), since no real page extraction contains that string.

## Truncation safety

Source text is capped at 50,000 chars, matching `extract_dataset.js`. Truncation is by whole sentence, and because WiCE gives supporting-sentence *indices*, the converter can check whether the cut dropped a sentence an annotator relied on. If it did, the row's label is no longer checkable against the text the model sees, so the row gets `needs_manual_review: true` and the runner's existing filter keeps it out of a default run.

On dev+test that is 8 truncated sources and exactly 1 excluded row (706 of 707 benchmarkable).

## Converted row schema

Standard fields (`id`, `claim_text`, `claim_container`, `source_text`, `ground_truth`, `dataset_version`, `extraction_status`, `needs_manual_review`) match `dataset.json`, so nothing downstream needs to know this file is different. `dataset_version` is `"wice"`.

`claim_container` is reconstructed: WiCE's `claim_context` is the text *preceding* the claim and never contains it (verified across all 349 dev rows), so the container is the context with the claim appended back on.

WiCE-specific provenance fields are all prefixed `wice_`, plus `source_title` / `source_publisher`.

## Licensing

Per WiCE's `LICENSE.md`:

- Wikipedia-derived text: **CC-BY-SA**
- Cited web-page text (from Common Crawl): governed by the **Common Crawl terms of use**
- WiCE's annotations: **ODC-BY 1.0**
- WiCE's code and model outputs: **MIT**

Benchmarking use in this repo is fine under all four; attribution belongs in any published result. Cite:

```bibtex
@inproceedings{kamoi-etal-2023-wice,
    title = "{W}i{CE}: Real-World Entailment for Claims in {W}ikipedia",
    author = "Kamoi, Ryo and Goyal, Tanya and Rodriguez, Juan Diego and Durrett, Greg",
    booktitle = "Proceedings of the 2023 Conference on Empirical Methods in Natural Language Processing",
    year = "2023",
    pages = "7561--7583",
}
```

## Reading a WiCE score

WiCE was built to exclude easy cases, and **retains only 16.3%** of its starting pool. Two filters do the work: claims that decompose to one or more than six subclaims are dropped (19.1% of dev), and then any claim whose subclaims a RoBERTa-Large DocNLI model *all* judged entailed is dropped as trivially supported.

Note what the second filter is and isn't. The authors deliberately used a comparatively weak model so as to "remove trivially entailed claims but avoid making a dataset that is adversarially difficult for larger models". So WiCE is filtered for non-triviality, **not** adversarially selected against modern LLMs. Still, the population is nothing like a random sample of Wikipedia citations — every plainly-fine citation, which is most of what an editor meets, has been removed by construction. A lower score here than on `dataset.json` is the expected result, not a regression.

### The comparability trap

The paper's headline numbers are a **binary** task: `SUPPORTED` vs not-supported, with `PARTIALLY-SUPPORTED` and `NOT-SUPPORTED` pooled together (paper §3.1 — the NLI models compared were trained on binary or neutral-collapsing corpora).

| Claim-level, binary | Accuracy |
| --- | --- |
| Majority-class baseline | 33.0 |
| Best off-the-shelf system (T5-3B / ANLI, chunk-level MAX) | 75.1 |
| Human | 92.0 |

One reason our numbers still aren't a clean drop-in next to that table, and one metric that closes most of the gap:

1. **Use `supportedVsRestAccuracy`, not `lenientAccuracy`.** `analyze_results.js` computes four accuracy fields:

    | Metric | Grouping |
    | --- | --- |
    | `exactAccuracy` | none — four-way exact match |
    | `lenientAccuracy` | `Supported` ↔ `Partially supported` forgiven (`exactMatches + partialMatches`) |
    | `binaryAccuracy` | {`Supported`, `Partially supported`} vs {`Not supported`, `Source unavailable`} |
    | `supportedVsRestAccuracy` | `Supported` must match exactly; `Partially supported` ↔ `Not supported` forgiven as mutual near-misses |

    `supportedVsRestAccuracy` (backed by `equalSupportedVsRest` in `core/verdicts.js`) *is* WiCE's split — `Supported` vs. everything else, since WiCE has no `Source unavailable` class for that field's exact-match requirement to bite on. `npm run wice:analyze` reports it automatically; look for the `Supported-vs-rest` column in the generated report or `supportedVsRestAccuracy` in `analysis_wice.json`, and put that number next to 75.1 / 92.0 — not `lenientAccuracy`, which forgives the opposite pair (`Supported ↔ Partially`) and answers a different question. (The two were confusable under the same "Lenient Accuracy" name in `docs/llm-benchmarking-overview.md` for months; see that doc's naming note.)
2. **Different inference setup and era still applies.** Those are 2023 NLI models using the "stretching" MAX strategy over document chunks; we pass the whole source in one LLM call. The paper's GPT-3.5/GPT-4 numbers (§3.4) are on the oracle-retrieval subset only, so there's no clean modern-LLM baseline in the table either — `supportedVsRestAccuracy` gets the *grouping* to match, not the setup.

Human accuracy of 92.0 is the more useful anchor: it tells you the task is genuinely ambiguous (Krippendorff's α = 0.62 on dev), so 100% is not the target and a residual error band is the task, not the tool.

So a WiCE number is not comparable to our own dataset's accuracy and should never be quoted as "the tool's accuracy". It answers a narrower question: *how does the verifier hold up on deliberately non-trivial cases that nobody here curated or labeled?* Track it as a trend across prompt changes; treat the paper's baselines as context, not as a scoreboard.
