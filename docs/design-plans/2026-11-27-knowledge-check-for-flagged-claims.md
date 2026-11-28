# A knowledge check for flagged claims: the uncited-text check, applied to cited statements

> **Status (2026-11-27):** Built behind opt-in switches; **gates 1 and 2 did not pass** (§ What the gates found). Built: the `u2` prompt, `core/knowledge-check.js`, the batch stage (`run-sweep.js --knowledge-check`, CSV columns, migration 007), the card builder's `--knowledge-check`, and the userscript setting (off by default). Not done: gate 2 on Fact Hunt's first build (its data is on Toolforge), gate 3 (the owner's 30-card play), step 6 (the finding-strength module does not exist yet). Nothing here is on by default anywhere; the one change that reaches users on merge is `u2` replacing `u1` in the uncited-text check, which gate 1 does not clear.

## Why

Every check in the pipeline asks one question: **does the source support the claim?** The first verdict, the severity pass, `run-recheck.js`'s second reading and Fact Hunt's "could both be true?" check all ask it in different ways. None of them asks a second question: **is the claim true?**

The two come apart more often than expected. Two cards on Fact Hunt's first live deck (2026-11-27) show it:

- **Wildwood (film).** The article says Carey Mulligan plays "a dowager governess who once ruled The South Wood". The source (a Spanish site) says she was "simply a mother". She can be both. The article is very likely right; this source just doesn't say so. A stronger model rechecking the source would still say NOT SUPPORTED, and it would be correct.
- **Republic of Ireland national football team.** "Five games against Spain, Northern Ireland," (a winning streak) set against "faced each other on nine occasions" (every meeting). Two different counts, both true.

For an editor, "the article is wrong" and "the article is right but needs a better source" call for different actions: fix the text, or find a source. On Fact Hunt, where a newcomer is asked to change the article, the second kind must not become a card at all.

## The check already exists

The userscript's and the batch's **uncited-text check** (`core/uncited-check.js`, `docs/design-plans/2026-10-23-uncited-text-check.md`) asks exactly the second question, of sentences with no citation: does the model, from its own knowledge, have a specific reason to believe the statement is wrong? It comes with a tested prompt, a model choice made on measurements (Lift Wing Qwen3.8 caught 8 of 9 injected errors with no false flag on the 2026-11-20 re-run), a parser, excerpt location and chunking.

**This design applies the same check to flagged cited claims.** No second check, no second prompt.

## Decisions

### One prompt, reworded

The prompt says twice that its statements have no citation: "None of them has a citation, so nothing in the article backs them up" and "Never report a statement because it has no citation. None of them has one." Neither line is load-bearing for the judgement. The rule that matters is "never report a statement *because* of its citation status". Both lines are reworded to say that, so the one prompt is true of cited and uncited statements alike:

- "Judge each statement using your own knowledge, whether or not the article cites a source for it."
- "Never report a statement because of whether it has a citation."

That is a prompt change, so `UNCITED_PROMPT_VERSION` goes from `u1` to `u2`, and the uncited smoke test is rerun before `u2` is used (see *Measuring it*).

### It reports doubts, not truths, and the routing follows from that

The check is built to report statements the model has a specific reason to believe are wrong, and the prompt says plainly that not knowing something is not a reason to doubt it. So its answer is **doubted** or **not doubted**, and "not doubted" covers "probably true" and "no idea" together. That is deliberate (it is why the check raises so few false flags), and it decides how the result is used. A finding the model doubts is **promoted**. A finding it doesn't doubt is **left as it is**, never labelled "probably true":

| Knowledge check | Fact Hunt | Userscript | Edit Suggestions |
|---|---|---|---|
| **Doubted** | Dealt. Two independent signals agree: the source contradicts the claim, and the model doubts it | Promoted: "Likely wrong", first in the "most serious first" order | "Check this fact" |
| **Not doubted** | Not dealt. Wildwood and the Ireland card land here | Unchanged | Unchanged, or "add a better source" (open question) |
| **Not checked** (call failed, setting off) | Not dealt | Unchanged | Unchanged |

The alternative, asking the model whether a claim is *likely true* and hiding the ones it vouches for, was rejected. Asking a model to vouch for a statement is where it is most willing to agree, and a wrong "likely true" hides a real error: the failure the pipeline exists to prevent.

### The model's knowledge only routes a finding; it is never the fix

The same rule as the uncited check: the model's idea of the right value stays in its comment. It is never offered as an edit, and Fact Hunt's fix still comes only from the cited source. The comment may be shown to an editor in the userscript's details, as the uncited check's is.

### Independence

The check sees the claim, the article's title and opening, and the paragraph text before the claim (the context the uncited check already gives). It never sees the source, the first verdict or the rationale. Its value is that it is a second, independent reading. That is the same rule as the feedback loop's blind call, and the same reason.

It is a separate call from the severity pass, which keeps its written rule that the model "is never asked whether a claim is 'probably true'".

### Batched per article

The check already sends about 12 statements per call (`UNCITED_CHUNK_SIZES`), so an article's flagged claims go in one call or a few. Over the 610 articles of the first Fact Hunt build, that is a few hundred calls, not thousands. The prompt's limit of 3 reported statements per call stays: it is part of what keeps the check precise. A flagged claim it misses is simply not promoted, which costs a Fact Hunt card, not a wrong edit.

## What changes, by surface

1. **`core/uncited-check.js`.** The reworded prompt (`u2`). `runUncitedCheck()` already takes any list of statements with their paragraph context, so the code change is small: callers pass flagged cited claims as well as uncited sentences, and a flag on each statement says which, so results route to the right place.
2. **Batch (`run-sweep.js`).** An opt-in `--knowledge-check` stage after the verdicts, like `--severity`. Columns on each flagged finding: `knowledge_check` (`doubted` / `not_doubted` / `error`, empty when not run), `knowledge_confidence`, `knowledge_comment`, `knowledge_prompt_version`. ToolsDB gets the first two and the version in a migration (007), so the card builder and Edit Suggestions can read them without the CSV.
3. **Card builder (`service/run-build-cards.js`).** Deals only `doubted` cards. When the stored finding has no result, it runs the check itself for that article. That needs paragraph context, which ToolsDB doesn't store, so it reads it from the article it already fetches. Results are cached per prompt version, as the conflict check's are.
4. **Userscript.** A setting, off by default at first (it costs about one call per article with flagged citations). A phase of Verify All after the verdicts, like severity. A doubted citation gets a "Likely wrong" label and sorts first under "most serious first". Nothing else changes, so a not-doubted citation looks exactly as it does today.
5. **The shared "finding strength" module** (the queued task "Unify the 'strongest finding' rule into one module"). This result becomes one of its inputs, so Fact Hunt, the userscript and Edit Suggestions read one rule.

## Measuring it

Each step has a gate, set before the step is tried:

1. **The reworded prompt.** Rerun the uncited check's smoke test (7 enwiki articles, 9 injected errors) with `u2` on Qwen3.8. Keep `u2` only if it catches at least 8 of 9 with at most 1 false flag, which is no worse than `u1`. Otherwise the rewording is wrong; fix it and rerun.
2. **On flagged claims.** Run the check on the 50 hand-labelled ruwiki contradictions (`benchmark/contradiction-spotcheck-2026-11.csv`: 25 genuine, 4 borderline, 21 wrong) and report what `run-recheck.js` reports: how many wrong flags are left unpromoted, and how many genuine ones are promoted. Also run it on Fact Hunt's first build, to see how many of the 1,052 cards would survive.
3. **On Fact Hunt.** The owner plays 30 doubted cards. The deck goes live with this rule only if most are real errors. "Most" is to be fixed before the play, not after.

Expect the Fact Hunt deck to shrink a lot. The prompt tells the model to leave obscure details alone, so an error in an obscure article is not doubted and does not become a card.

## What was built

- **`core/knowledge-check.js`**: `runKnowledgeCheck({ claims, articleTitle, opening })` turns flagged claims into the uncited check's input (`knowledgeStatements()`: the paragraph text before each claim as context, claims sharing a text sent once) and runs `runUncitedCheck()` with every finding kept. It returns, per claim key, `doubted` (with confidence, comment, excerpt), `not_doubted`, or `error`; a claim a stopped run never reached has no result. One deviation from § What changes, item 1: flagged claims go in **calls of their own**, not mixed with an article's uncited sentences, because the prompt's 3-reports-per-call limit would otherwise be shared, and an uncited sentence could crowd out a flagged claim. Same prompt, same parser, same model rule (`uncitedModelFor()`).
- **Batch**: `run-sweep.js --knowledge-check`. An article's flagged findings (not `lead_demoted`) are held until its citation and group tasks have all settled, checked in one call or a few, then written with `knowledge_check`, `knowledge_confidence`, `knowledge_comment`, `knowledge_prompt_version`. A halted run, or a check that failed as a whole, still writes every held finding, with the columns empty. Migration 007 adds three of the columns to ToolsDB (the comment is CSV-only); `buildUpsertQuery()` names them only on a row the check ran on, so a sweep without the flag works on an unmigrated table.
- **Card builder**: `run-build-cards.js --knowledge-check` deals only doubted cards (`not_doubted` and `knowledge_unchecked` in the dropped tally). It uses a finding's stored result when its prompt version is current, else its own cached one, else runs the check for that article, with the paragraph and opening read from the wikitext it already fetches (`service/cards/knowledge.js`). The comment is never on a card.
- **Userscript**: "Check flagged citations against general knowledge" (`verifier_knowledge_check`, off). A phase of Verify All after the uncited check and before severity, on `uncitedModel()`. A doubted row gets "Likely wrong" in its head line and the model's comment in its details ("Without reading the source, the model believes: …"), and sorts first under "Most serious first", which is offered whenever the check ran. Not logged, not exported.

## What the gates found

Both runs on Lift Wing Qwen3.8 (`llm-qwen38-27b`), 2026-11-27. The harnesses were throwaway, like the uncited check's.

### Gate 1: the reworded prompt

The 2026-10-23 harness was not kept, so it was rebuilt from § What the smoke test found of the uncited-check design: the same 7 articles at their current revisions, and the same injections where they can still be placed. 8 of the 9 could; the Podgórze/Vistula sentence is no longer in Kraków Ghetto's uncited text, so that article stays in as a clean one. 106 uncited sentences, 8 injected errors. `u1` and `u2` were run side by side, four times each, every finding kept (no top-3 cut):

| | u1 | u2 |
|---|---|---|
| Injected errors caught, per run | 7, 6, 7, 7 (**27 of 32**) | 6, 6, 7, 5 (**24 of 32**) |
| Untouched sentences flagged, per run | 2, 3, 3, 3 (**11**) | 3, 2, 2, 2 (**9**) |
| Always missed | Graz → Vienna | Graz → Vienna; Wheatstone → Faraday 3 times of 4 |

**The gate as written (at least 8 of 9 caught, at most 1 false flag) fails for both prompts on today's set**: no run of either had fewer than 2 false flags, so this set no longer reproduces the 2026-11-20 result (8 of 9, none) for `u1` either. The recurring false flags are on sentences the model is itself wrong about: that Mordechai Gebirtig was shot in the Kraków ghetto (he was), Burkhut's "pink coat" (his account does say pink), and the Einstein–de Haas sentence. Between the prompts, `u2` caught 3 fewer of 32 and flagged 2 fewer of 392. Both differences are within the run-to-run spread (u2 ranged from 5 to 7 caught), so the rewording has no effect this test can measure, and a small loss of recall can't be ruled out. Whether to keep `u2` is the owner's call; the gate as set does not license it.

### Gate 2: the 50 labelled ruwiki contradictions

Each claim checked with its title, the article's opening, and the paragraph before it, read from the article at the labelled revision (48 of 50 placed in their paragraph; 2 sent with no context). Two runs, identical:

| Label | Doubted | Not doubted |
|---|---|---|
| genuine (25) | **1** | 24 |
| wrong (21) | 1 | **20** |
| borderline (4) | 0 | 4 |

So the check leaves 20 of the 21 wrong flags unpromoted, as intended, and **promotes 1 of the 25 genuine errors**. For comparison, `run-recheck.js`'s two-model agreement keeps far more of the genuine ones at 83% precision. The two doubted rows: Kazakhstan's refineries (genuine; the model is right that they are not all in Atyrau) and Orlovsky v Struve at UFC 222 (labelled wrong; the model says the fight was on 17 March, but it was on 3 March, so the model is itself wrong).

This is the shrinkage § Measuring it expected, at its extreme. The prompt tells the model to leave obscure details alone, and the genuine contradictions are almost all details of that kind: release dates, review scores, match results, road lengths, train counts. As a filter on its own, "deal only doubted" would leave about 2% of a ruwiki deck. Open question 1's fallback (doubted first, then the rest) would be a ranking that changes almost nothing. Open question 4 (ruwiki) looks like the deciding one.

Gate 2's second half, Fact Hunt's first build, was not run: its findings and cards are on Toolforge.

## Open questions

1. **How small the Fact Hunt deck gets.** If too few cards survive, the fallback is to deal doubted cards first and the rest after, rather than only doubted ones.
2. **Agreement as extra evidence.** When the model's comment gives the same value as the source ("completed in 1889"), the two signals agree on the value as well as the doubt. That could rank a card higher. It would compare the model's comment against the source's span, never put the comment's value in an edit.
3. **Edit Suggestions for "not doubted".** "Add a better source" instead of "check this fact". Whether that is a useful suggestion type is a question for the Suggestions team.
4. **ruwiki.** The prompt and smoke test are English. The uncited check already runs on ruwiki articles, with a comment-language directive, but its measurements are enwiki.

## Phases

| Step | What | Done when |
|---|---|---|
| 1 | Reword the prompt (`u2`); rerun the smoke test | Gate 1 passes |
| 2 | Run it on the 50 labelled contradictions and on the first Fact Hunt build | Numbers reported here |
| 3 | Card builder deals doubted cards; owner plays 30 | Gate 3 passes |
| 4 | Batch stage, CSV columns, migration 007 | A sweep writes the columns |
| 5 | Userscript setting and label | Behind a setting, off by default |
| 6 | The finding-strength module reads it | One rule across the three surfaces |
