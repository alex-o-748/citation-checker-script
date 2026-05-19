# Historical-prompt replay runs

This directory contains worked examples of the historical-replay capability 
added in PR #165, allowing us to see more easily how the tool has improved 
(or regressed) over time. These files were generated on 2026-05-02 by 
running two "historical" (January and mid-April, 2026) prompts against 
the v1+v2+v3 dataset (187 entries) with a five-model panel:

- **Three open-weight models routed through OpenRouter** — small enough
  to be cheap to run, diverse enough that a 3-way majority vote across
  them is meaningful as an ensemble:
  - `openrouter-mistral-small-3.2`
  - `openrouter-olmo-3.1-32b`
  - `openrouter-deepseek-v3.2`
- **Two closed-weight models** for a baseline against widely-used
  general-purpose APIs:
  - `claude-sonnet-4-5`
  - `gemini-2.5-flash`

Each results file also contains synthetic ensemble rows
(`openrouter-vote-3` and `openrouter-vote-3-binary`, computed via
`compute_ensemble.js`) — a 3-model majority vote across the OpenRouter
panel members. The 4-class variant uses the modal class with a
tiebreaker rank when all three differ; the binary variant collapses each
verdict to support / no-support before the vote.

## What's here

| File | Contents |
|---|---|
| `2026-01-20-prompt.txt` | The system prompt as it lived in `main.js` at commit `16f365a` (the original `main.js`, day 1 of the project) — `generateSystemPrompt`'s template-literal body, verbatim. |
| `2026-01-20-results.json` | Result rows from running the 2026-01-20 prompt: 5 providers × 187 entries + 374 synthetic ensemble rows = 1309 rows total. Zero errors. |
| `2026-04-19-prompt.txt` | The system prompt at commit `00a87d4` — the last `main.js` commit before any external contributions to the repo. Three additions made between January and that date: transliteration handling, Internet Archive / Wayback snapshot recognition, and an explicit "if article content is present, the source IS usable" clause. This text is byte-equivalent to today's `core/prompts.js` (modulo whitespace). |
| `2026-04-19-results.json` | Result rows from running the 2026-04-19 prompt; same shape as above. Zero errors. |
| `comparison-2026-05-02.md` | Side-by-side delta report (Jan→Apr per provider, on Exact / Lenient / Binary). |

## How they were generated

Each results file's `metadata` header records the run-time attribution
(date, prompt source, dataset extraction date). For the January run the
end-to-end command was approximately:

```bash
# 1. Recover the prompt
git show 16f365a:main.js | <extraction script> > /tmp/january-prompt.txt

# 2. Run with override
. <(grep '^OPENROUTER_API_KEY=\|^ANTHROPIC_API_KEY=\|^GEMINI_API_KEY=' /path/to/.env)
export OPENROUTER_API_KEY ANTHROPIC_API_KEY GEMINI_API_KEY
BENCHMARK_PROMPT_OVERRIDE_FILE=/tmp/january-prompt.txt \
BENCHMARK_PROMPT_DATE=2026-01-20 \
  node run_benchmark.js \
  --providers=openrouter-mistral-small-3.2,openrouter-olmo-3.1-32b,openrouter-deepseek-v3.2,claude-sonnet-4-5,gemini-2.5-flash \
  --version all
mv results.json benchmark/historical-runs/2026-01-20-results.json

# 3. Compute ensembles
node compute_ensemble.js --results=benchmark/historical-runs/2026-01-20-results.json --write
```

`run_benchmark.js`'s `--resume` flag lets you build up a result file
across multiple invocations (skipping `entry_id|provider` pairs already
present), which is convenient when not all API keys are available at
once or when adding a new provider to an existing run.

## Caveats — what these data accurately reflect

- **The prompt at the historical date.** The text in each `*-prompt.txt`
  is verbatim from the cited git commit. Source of truth.
- **Today's models scoring against that prompt.** We use current model
  versions (`claude-sonnet-4-5-20250929`, `gemini-2.5-flash`,
  Mistral/OLMo/DeepSeek as deployed on OpenRouter at run time). This
  answers "what would today's models do with January's prompt," **not**
  "what did the userscript actually produce in January 2026 at the time."
  Older model snapshots are not always available.
- **Source text from a frozen extraction.** `dataset.json` rows reference
  `source_text` as fetched at extraction time through whichever proxy
  version was deployed then; we replay against that frozen text rather
  than re-fetching. For "what would a January user have seen" this is
  closer to right than re-fetching today; for "what would the *current*
  proxy give a January user" you'd need to re-extract.
- **Stochastic noise.** Temperature 0.1, not 0. Run-to-run variance is
  small but real.

## Headline finding

The three prompt additions between the January and April-19 versions were
net-positive at the ensemble level (`openrouter-vote-3-binary` +1.1 pp
Exact, +1.6 pp Binary), with substantial individual-model gains for
DeepSeek (+7.5 pp Exact, +9.1 pp Lenient) and Mistral (+5.3 pp Exact),
roughly flat for Claude (-0.5 pp Exact) and Gemini (-3.7 pp Exact, +2.1
pp Lenient), and a notable regression for OLMo (-4.3 pp Exact). See
`comparison-2026-05-02.md` for the full table. Numbers reflect the
ground-truth corrections in `docs/design-plans/2026-05-08-gt-audit-corrections.md`
(7 v1 rows corrected 2026-05-09, plus 5 more v1 rows corrected 2026-05-14)
applied in-place to the historical results files.

## How to add a new historical-replay run

1. Pick the SHA whose prompt you want to score.
2. Recover the prompt text into a file (`git show <sha>:core/prompts.js`
   for post-#118 dates, `git show <sha>:main.js` for pre-#118).
3. Run `BENCHMARK_PROMPT_OVERRIDE_FILE=<path> BENCHMARK_PROMPT_DATE=<YYYY-MM-DD>
   node run_benchmark.js ...`.
4. Drop the resulting `results.json` here as `<YYYY-MM-DD>-results.json`,
   and the prompt as `<YYYY-MM-DD>-prompt.txt`.
5. Update this README's table and (if useful) the comparison report.
