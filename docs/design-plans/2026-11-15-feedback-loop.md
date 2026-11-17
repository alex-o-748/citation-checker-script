# A feedback loop with the owner auditing labels and approving fixes

> **Status (2026-11-17):** In progress on branch `claude/nifty-rubin-3iq0l1`, not yet merged. Stages 1–3 and the monitor are built; stages 4–5 are not. On 2026-11-17 label confirmation changed from merging a PR per batch to auditing a random sample (see *Decisions*). Operating notes: [`feedback-loop/README.md`](../../feedback-loop/README.md).

## Why

Editors had rated 510 checks by 2026-11-15, and the ratings say clearly what is wrong (see [`2026-11-08-fixable-causes-of-disputed-verdicts.md`](2026-11-08-fixable-causes-of-disputed-verdicts.md)). But a rating is not a test case:
- It carries no source text.
- It has no confirmed label.
- Its rater may have clicked through a Verify All report in seconds.

And a prompt change judged on the next week's ratings is judged by whoever happened to rate, on whatever they happened to check.

The loop turns ratings into confirmed regression rows, and the log into a daily trend. Changes can then be tested before they ship and measured after.

## The loop

| Stage | Who | Built |
|---|---|---|
| 1. Export rated checks; re-fetch; tag patterns | machine, nightly | yes (`sql/cases.sql`, `cases.js`, `causes.js`) |
| 2. Blind reading, then attribution; label by rule | machine, nightly | yes (`adjudicate.js`, `run-triage.js`) |
| 3. **Audit labels**: spot-check a weekly random sample, decide the exceptions, by one-line reply | **owner** | yes (`digest.js`, `feedback-digest.yml`, `feedback-commands.yml`) |
| 4. Propose a fix per cause cluster, gated on the benchmark | machine | no |
| 5. **Merge the fix**, then canary it | **owner**, then machine | no |
| Daily, beside all of it: label-free monitor | machine | yes (`monitor.js`, `feedback-monitor.yml`) |

## Decisions

**Neon is read through `psql` in the workflow, not a Node driver.** The root `package.json` is also a dependency of the standalone web tool, which installs this repo from GitHub, so a Postgres driver there would ship to every web-tool build. With `psql`, the Node code reads and writes plain files. That keeps it testable offline, and the same `.sql` runs unchanged in `psql`, in the Neon console and through the Neon connector, which is how it was checked.

**The first checkpoint is a pull request, not a review UI.**
- Labels end up versioned in the repo, with a diff showing exactly what changed and no new infrastructure to run.
- The cost is reviewing JSON. The per-case report beside it is the readable view, and accepting a suggestion is a one-field edit.

> **Changed 2026-11-17: oversight is an audit of accepted labels, not an approval of each batch.** The owner asked for automation with oversight, and a nightly PR to merge is a chore, not oversight. An agreed label already needs two independent judgements (the editor's and a blind reading) plus evidence found in the source, so a merge click added little. Triage now commits straight to `main`, as the scraper and edit-log jobs do. What the owner checks instead is the rule itself: five accepted labels drawn at random each week. Two wrong in the last ten pause auto-accepting until recent spot-checks pass, so a misfiring rule stops itself rather than relying on the owner noticing. The field set stays versioned in the repo, so every accepted label can still be traced and reversed.

**The owner answers in one-line comments, not checkboxes or JSON edits.** `a1b2c3d4 not supported` can be written from a phone, says exactly what was decided, and leaves a public record in the issue. Checkboxes cannot carry "the right label is X" without five boxes per row. Only the repository owner's comments are applied, and the comment body reaches the script through an environment variable, never a shell string.

**Rows are never deleted; `drop` leaves a marker.** A check id missing from the field set looks untriaged, so a deleted row would be read, and paid for, again the next night.

**Two model calls, blind then attribution, not one.**
- A single call that sees the tool's verdict and the editor's correction is anchored by both, so its agreement with the editor proves little.
- The blind call sees the claim and the source only, so its agreement is independent evidence.
- The attribution call needs the disagreement, not the source. It is given the blind reading instead of a second copy of up to 100,000 characters.

**Labels are decided by rule, not by a model.**
- *Agreed* requires both the editor and the blind reading to reach the same verdict, and the quoted evidence, where the verdict calls for any, must be found in the source by `core/quote.js`.
- Everything else goes to the owner, with the reasons spelled out.
- A model can propose a label, but it cannot decide one.

**One definition for each pattern, compiled to JS and SQL.**
- Triage tags cases in JS; the monitor counts every logged check in Postgres.
- A pattern written twice drifts, so `causes.js` writes each once, in regex syntax both engines share, and `causeSql()` compiles it.
- The SQL was run against Neon and reproduced the brief's counts.

**The field set is separate from `dataset.json`**, for the reason WiCE is: its rows were chosen by disagreement, so pooling them would change what headline accuracy means.

**Alerts are fingerprinted, so a standing problem notifies once.**
- **When a comment is posted:** the monitor's issue body is replaced daily, but a comment (which notifies) is posted only when the set of alerts changes.
- **When a model's arrival or departure alerts:** only when it carries a real share of traffic, as a change of default does. One person's own API key starting or stopping is not an alert.

## Rejected

- **Publishing `client_id`** in the field set, even hashed: a stable token would let anyone link one person's ratings across articles. Only derived counts leave the query.
- **The adjudicator's verdict as the label.** That would replace the editor's judgement with a second model's, which is the thing being audited.
- **Triaging only thumbs-down.** Without confirmed correct verdicts, a fix for false alarms could pass by approving everything.
- **Exporting only rows since the last run.** Every run exports everything and skips by `check_id`. That is simpler, it is idempotent, and a run that died leaves nothing to reconcile.

## Next

1. **Bring the talk-page issues into the loop.** `.github/scripts/scrape_and_create.py` turns talk-page sections into GitHub issues (82 so far). The two streams have opposite blind spots:

   | | Ratings → field set | Talk page → issues |
   |---|---|---|
   | Volume | hundreds, structured | a few a week, written |
   | Tells you | how often, on which verdicts | why, and what to build |
   | Blind to | leniency (4 of 75 rated SUPPORTED verdicts got 👎); anything that isn't a verdict | frequency |

   [#143](https://github.com/alex-o-748/citation-checker-script/issues/143) shows why both are needed. It reports smaller models marking *unsupported* claims as Supported, the opposite of what the ratings say. A fix for false alarms (causes 3 and 4 of the brief) could make it worse, and nothing in the field set would notice.

   In order:
   1. **Editors' explanations into triage.** Sections opened from the Comment button carry `<!-- source-verifier check: <id> -->`. Triage can read the talk page itself (one request per run, archives included), match each check id to the editor's explanation, and give it to the attribution call and the digest. That needs no Worker or database change. Today the explanation only becomes an issue: [#396](https://github.com/alex-o-748/citation-checker-script/issues/396) came from check `a2d3f835`'s section, and the case itself never sees it. Every row's `wiki_section` is still empty.
   2. **Issues carry the cause vocabulary.**
      - The scraper's extraction prompt assigns a `cause:<id>` label from `causes.js` and `ATTRIBUTION_CAUSES`, plus `ui`, `install`, `localization` and `leniency` for what ratings can't see.
      - The digest then lists, per cause, field-set cases and open issues side by side.
      - The same prompt should be told the repo's convention that the positive class is the failing citation. #143's title uses "false positive" the other way round, which CLAUDE.md warns has happened twice already.
   3. **Check ids in issue bodies.** An issue from a check's section names the check id where a script can read it. The field-set row and the issue then point at each other, and when the row's label is decided the bot can say so on the issue.
   4. **Recurrence is a signal.** The scraper deduplicates against open issues only, so a complaint comes back as a new issue after its issue is closed (tool naming: #281, #341, #392). If it matched closed issues too, it could comment "reported again" on the original or reopen it, and a recurrence would read as a regression rather than a fresh ticket.
   5. **Leniency cases into the field set.** Issues like #143 name concrete examples (the Alien vs Predator cartridge claims). Those are exactly the should-be-NOT-SUPPORTED rows the ratings rarely produce. An issue label such as `field-case`, naming an article and citation, could feed triage the way a rating does.
   6. **Stage 4 reads both, and treats issues as data.** The fix proposer takes a cause cluster plus that cause's issues as its problem statement. Issue bodies are model summaries of a page anyone can edit: input to read, never instructions to follow.
   7. **Close the loop.** When a fix for a cause merges, close its issues with the PR link, and list it in the next digest so it can be mentioned on the talk page. Editors who see their reports acted on keep reporting.
2. **Capture what the log lacks.**
   - `buildLogPayload()` should send `PROMPT_VERSION` (it already exists in `core/prompts.js`), the claim scope, the source length and truncation. The Worker's INSERT needs the columns too (`docs/worker-logging-reference.md`).
   - The 👎 should send the source text the model saw, so triage stops depending on a re-fetch.
3. **Stage 4, the fix proposer.**
   - When a cause has at least 10 confirmed rows, an agent drafts the matching fix as a PR, one cause per PR.
   - The PR is gated on the field set, `dataset.json` and WiCE `unanimous`, with `ccs compare` output attached.
   - The pass bar is written down before the run, and the newest month of the field set is held out.
4. **Stage 5, the canary.**
   - Assign a candidate prompt by `client_id` hash and log `prompt_version`.
   - Raw 👎 rates are biased by who rates; the difference between randomly assigned groups isn't.
5. **Triage group checks**, and read each citation's reference text from the pinned revision, which cause 1's fix needs anyway.
6. **Patterns for non-English rationales**, or have the tool always explain itself in English in a field the log keeps.

## Open questions

- **The blind prompt counts a source's URL as evidence of its publisher.** That is the brief's cause 1, adopted for labelling. Keep it, or label strictly by the current framework and let those cases reach the owner?
- **Which model adjudicates, at what cost.** The default is the most capable Claude model, and `ADJUDICATOR_MODEL` overrides it. The README gives token estimates.
