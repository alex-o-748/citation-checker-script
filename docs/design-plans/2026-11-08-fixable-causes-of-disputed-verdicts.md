# Fixable causes of disputed verdicts

> **Status (2026-11-08):** Proposed. Nothing implemented. Written from the editor feedback in Neon; each cause below has its own fix and its own check, and they can land independently.

## Why this exists

Editors have rated 453 checks since 2026-08-05 (👍/👎 plus an optional corrected verdict, in the `feedback` table, joined to `verification_logs` on `check_id`). The ratings point overwhelmingly one way:

| Tool said | Rated | 👎 | Editors' correction |
|---|---|---|---|
| NOT SUPPORTED | 267 | 69% | 124 → SUPPORTED, 30 → PARTIALLY |
| PARTIALLY SUPPORTED | 78 | 45% | 29 → SUPPORTED |
| SOURCE UNAVAILABLE | 32 | 63% | 10 → SUPPORTED |
| SUPPORTED | 75 | 5% | — |

82% of the ratings are on `openai/gpt-oss-20b`, the default until Lift Wing Qwen3.8 replaced it around 2026-10-21. The benchmark had already shown the same tendency (it called 21 of 80 genuinely supported rows NOT SUPPORTED; `docs/hf-keyless-and-sonnet-5-benchmark.md`).

Reading the disputed rationales, most 👎 verdicts trace to five causes that a code change can address. Changing models alone would not fix them. This brief covers those five.

**Read the numbers with two caveats.** Ratings are self-selected: people rate what surprises them, so a 👎 share is not an error rate. And the "log" counts below were sized with regular expressions over `llm_comments` (appendix), whose precision has not been measured. That is why every fix has its own check before it ships.

"Log" means the ~68,000 checks carrying a `check_id` (2026-08-05 to 2026-11-08). "Flag" means a NOT SUPPORTED or PARTIALLY SUPPORTED verdict.

---

## 1. The model isn't told what the source is

**What happens.** Claims that depend on the source's identity or date fail, because the model can't see either:

- "In 2021 Protekta was named market leader *in the Handelszeitung*" was judged NOT SUPPORTED because the text "doesn't name the Handelszeitung". The URL is handelszeitung.ch (de.wikipedia, Protekta [4]).
- A Laudato si' quote failed on the Vatican's own PDF of the encyclical, because the text "does not attribute it to Pope Francis" (`9e33aa5b`).
- "3:22 p.m. on Thursday, not May 21, 2026" (`ca2084bb`), "only 'on Friday' rather than July 17" (`1bf1e70b`) and "does not provide a date of May 24" (`48040159`) all fail the same way: each date is the article's own dateline, and the model doesn't know it.
- "Does not state a 3-star rating" (`fe5b9a7a`): the Guardian shows its stars as a graphic, and text extraction drops it.

**Why.** `generateUserPrompt(claim, sourceInfo)` (`core/prompts.js:199`) sends the claim and the source body, nothing else, and `extractSourceText()` (`core/prompts.js:182`) strips the `Source URL:` line the fetcher adds. The footnote the editor sees (title, publication, author, date) never reaches the model, and neither does today's date. The group prompt labels each source with its URL but no metadata.

**Evidence.**
- Rated: flags whose rationale says the source doesn't specify a date, or mentions a weekday, got 👎 14 times out of 22 (11 corrected to SUPPORTED).
- Log: 1,588 flags (6% of all flags) object that the source doesn't specify a date, year or month.
- The attribution cases (publisher, affiliation by domain) aren't sized yet.

**Fix.**
1. `collectCitations()` (`core/citations.js:70`) gains a `referenceText` field: the footnote's text without backlinks or archive boilerplate. It already looks the footnote up by id for `url` and `pageNum`.
2. `generateUserPrompt()` takes an optional third argument, `{ citation, sourceUrl, today }`. It's optional so existing callers keep working, including the web tool's hand-written `.d.ts`. It prepends:
   ```
   Citation (as given in the article): "Brightwood review – …". The Guardian. 18 March 2024.
   Source URL: https://www.theguardian.com/film/2024/mar/18/…
   Today's date: 2026-11-08
   ```
3. Add one rule to the system prompt. The citation details say what the source is: they count as evidence for who published it, who wrote it and when, and nothing else in the claim. Use the publication date to resolve relative dates in the source text ("on Thursday", "last year").
4. In the fetcher repos (`tf-source-fetcher`, `public-ai-proxy`), keep `alt`/`aria-label` text on rating graphics ("3 out of 5 stars").

**Risks.**
- The `|date=` in a citation is editor-written and can be wrong. Prefer the page's own `article:published_time` when the fetcher can supply it.
- This is a prompt change, so bump `PROMPT_VERSION` and re-run the benchmark: the few-shot examples are tuned against it.

**Check.**
- `dataset.json` has no reference text, so add a `citation_text` field. A one-off script can read each row's pinned revision (the `oldid` in `article_url`); `source_text` stays untouched.
- Run the benchmark before and after and compare with `ccs compare`. The target is fewer flags on Supported rows with no loss on Not supported rows.
- Replay the 22 rated date rows.

---

## 2. Unusable pages are judged as if they were the source (and the reverse)

**What happens.** The fetch succeeds but returns something other than the source:
- a login wall, captcha, JS error or cookie notice;
- a catalogue or metadata record (Internet Archive `/details/`, JSTOR `/stable/`, a BHL bibliography page, WorldCat);
- a DOI landing page with only an abstract;
- a database page rendered client-side (GBIF, WoRMS, IUCN, NBN Atlas);
- a page that only links to the document.

`gpt-oss-20b` then says NOT SUPPORTED, sometimes while its own rationale says the page is unusable:
- "The source is only a login page" (`0f6e963a`, IUCN).
- "Only links to a PDF that is not included in the provided text" (`a8add7f5`).
- "Contains only bibliographic information" (`41bc80ba`, BHL).

One DOI got SOURCE UNAVAILABLE on one check and NOT SUPPORTED on three others (de.wikipedia, Arcitalitrus dorrieni [2]).

**The reverse happens too, mostly with Qwen3.8.** A readable article that doesn't support the claim gets called SOURCE UNAVAILABLE: "an article about Mumford & Sons' *Babel* … contains no information regarding an album titled *Believe*". That is a failing citation shown to the editor as "couldn't read the source".

**Why.** The system prompt already lists these page types as unusable (`It is NOT usable if it's:` in `generateSystemPrompt()`), and both models apply the rule inconsistently. Whether a page is the source at all is decided by the model, implicitly, on each check.

**Evidence.**
- Rated: flags whose rationale describes an unusable page got 👎 17 times out of 19 (7 corrected to SUPPORTED, 7 to SOURCE UNAVAILABLE).
- Log: 841 flags carry a rationale saying the page is unusable (781 `gpt-oss-20b`, 39 Qwen3.8, 21 other).
- Reverse: 559 SOURCE UNAVAILABLE verdicts made by a model describe readable text. 422 of them are Qwen3.8's, 24% of all its model-made SOURCE UNAVAILABLE verdicts.
- In a hand-read random sample of 30 of those Qwen3.8 verdicts:
  - about 16 were right;
  - about 9 were readable but didn't support the claim;
  - 5 were claim fragments (cause 5).

**Fix**, in three layers, cheapest first:
1. **A guard after parsing.** A new `core/verdict-guards.js`, applied after `parseVerificationResult()` in every front end.
   - A flag whose rationale says the page is unusable becomes SOURCE UNAVAILABLE. Record `guard: 'unusable-page'` and the original verdict, so the log keeps both.
   - The reverse rule (SOURCE UNAVAILABLE whose rationale describes a readable article becomes NOT SUPPORTED / omission) is riskier. Ship it log-only, and flip verdicts only after a hand-check shows it is precise.
2. **A page classifier in `fetchViaProxy()`**, modelled on `encodingDamage()` (`core/worker.js:114`).
   - It detects:
     - bot checks ("Just a moment", "Please wait while we check your connection", "Sicherheitsüberprüfung", "Verify you are human");
     - "enable JavaScript" pages with no content;
     - Internet Archive `/details/` item pages and JSTOR `/stable/` pages;
     - DOI landing pages with little body text.
   - It returns `{ content: null, error: UNUSABLE_PAGE_ERROR }`, so the existing archive/Wayback fallbacks run and, if nothing readable turns up, the check ends SOURCE UNAVAILABLE without a model call.
   - `classifyFetchError()` gets a bucket for it.
3. **Follow through to the real document** (fetcher repos). Candidates:
   - the `citation_pdf_url` meta tag;
   - a page whose main content is a single PDF link;
   - Internet Archive full text for `/details/` items (see `2026-11-04-borrowable-book-leads.md`);
   - an open-access copy for DOIs (Unpaywall, OpenAlex).

   doi.org alone accounts for 938 failed fetches in the log.

**Check.**
- `dataset.json`'s 11 rows with `excluded_reason` are bot walls, dead fetches and archive banners. The classifier should catch them and fire on none of the other 178.
- For the guard, replay it over the logged rows (no model calls), hand-check 50 random hits, and enable it at ≥90% precision.
- Replay the 19 rated rows.

---

## 3. The rationale contradicts the verdict

**What happens.** The explanation describes partial support, but the verdict is NOT SUPPORTED:
- "mentions their appointment as deputy ministers but does not state that they spent several months serving in that role" (`41dfb96e`);
- "lists Katuta Mwelwa as MP for Chienge in 2016 and 2021 but does not state she had served for 10 years" (`b6917781`).

Or it rejects a paraphrase: "does not contain the exact phrase 'As the temperature inside the tank continued to rise'" (`33c63735`; also `107d5360`, `ddbbfe28`).

**Why.** The prompt already says "Accept paraphrasing and straightforward implications". Its own few-shot example, "confirms growth but doesn't specify 12%", is PARTIALLY SUPPORTED. But the verdict is a single label emitted first in the JSON, and nothing ties it to the reasoning that follows.

**Evidence.**
- Rated:
  - NOT SUPPORTED with a "confirms X but not Y" rationale got 👎 35 times out of 49 (24 corrected to SUPPORTED, 9 to PARTIALLY).
  - Rationales demanding exact wording got 👎 13 times out of 17.
- Log:
  - 3,730 NOT SUPPORTED verdicts (23%) have a rationale admitting partial support: 22% of `gpt-oss-20b`'s and 30% of Qwen3.8's.
  - 478 flags demand the source's wording.

**Fix.** Make the verdict follow from the reasoning instead of preceding it.
- Change the response schema so the model first lists the claim's parts, each `supported`, `absent` or `contradicted`. That is the vocabulary `core/severity.js` already uses.
- Derive the verdict in code:

  | Parts | Verdict |
  |---|---|
  | all supported | SUPPORTED |
  | any contradicted | NOT SUPPORTED / contradiction |
  | some supported, some absent | PARTIALLY SUPPORTED |
  | all absent | NOT SUPPORTED / omission |

  `reason_type` falls out of the same rule. `support_score` and `source_quote` stay as they are.
- Add one rule: "Never require the source to use the claim's wording."

**Not proposed: a regex that rewrites NOT SUPPORTED to PARTIALLY when the rationale says "but".** On the 49 rated rows it would make 9 verdicts exactly right and turn 14 correct ones (rated 👍) wrong. Deriving the verdict from parts is the principled version of the same idea.

**Check.**
- This is the largest prompt change in the brief, so run the full benchmark plus WiCE `unanimous`, compared with `ccs compare`.
- Watch the parse-failure rate per provider (nested JSON is harder for small models) and output tokens and latency.
- Bump `PROMPT_VERSION`.

---

## 4. Omissions the editor can't check

**What happens.** NOT SUPPORTED / omission carries no quote by design, so the editor has to take an absence on trust. It is also where other failures end up: a missed passage, a page that isn't the source, a claim with extra sentences all come out as "the source doesn't mention it". Examples:
- "does not identify the subject or state that he placed 62nd", on a results table where he is 62nd (`bbf0ccd8`);
- "does not mention a second video" (`3e287137`);
- "does not mention any videos or social media circulation" (`826a725f`).

**Evidence.**
- Rated: omissions with no quote got 👎 125 times out of 179, the largest single group of complaints.
- Log: 12,153 of 16,400 NOT SUPPORTED verdicts (74%) are omissions with no quote. That's 77% for `gpt-oss-20b` and 52% for Qwen3.8.

**Fix.**
1. **A second look, on omissions only.**
   - A second call with the opposite task: "Quote the passage that best supports this claim, or answer NONE."
   - Run the quote through `core/quote.js`. If it verifies, re-judge with that passage in front of the model, or show the verdict as disputed alongside it.
   - The tool then has to fail to find support twice, once while actively looking for it.
   - Cost: one extra call on about 18% of checks.
2. **Help it look.** Before that call, use plain string search to pull the windows of source text containing the claim's numbers, dates and proper nouns, and put them first. This targets "it was in a table halfway down" without touching the main prompt.
3. **UI.**
   - Show an omission without a quote as "Not found in the source", not a red NOT SUPPORTED.
   - Add a find-in-source box over the fetched text, which the sidebar already holds, so the editor can check the absence in seconds.

**Check.**
- Replay the 179 rated rows. The second look should reverse most 👎 rows and few of the 53 👍 rows, where the omission was right.
- On the benchmark, flags on Supported rows should go down with no loss on Not supported rows.
- The severity pass's `disagreement` tier ("nothing wrong found") asks a similar question. Test it on the same rows before building a new call.

---

## 5. Claims that are the wrong size

**What happens.**
- **Too long.** In paragraph scope, the userscript's default, the claim is everything since the previous citation, which can be several sentences. The source supports the sentence the citation is attached to, and the whole span gets flagged, as in the multi-sentence NYT forestry claim (`fb97e5b4`).
- **Too short.** Table cells, list items and infobox values reach the model with no row or label, so it can't tell what is being claimed: "Airstrike.", "April 2026 – present", "Least Concern (IUCN 3.1)".

**Evidence.**
- Rated: NOT SUPPORTED on claims over 400 characters got 👎 15 times out of 16.
- Log: the verdict mix shifts with claim length. Longer claims have more parts, so some of this shift is real; the 👎 rate suggests much of it isn't.

  | Claim length | SUPPORTED | PARTIALLY |
  |---|---|---|
  | under 100 characters | 55–60% | 2–7% |
  | 400+ characters | 31% | 30% |

- 32% of judged claims are 200+ characters.
- Fragments: 148 rationales call the claim a fragment. 118 of them are Qwen3.8's, which labels them SOURCE UNAVAILABLE.

**Fix.**
1. **Long spans.** There are two options, and the choice is the owner's (open question 1):
   - **Per-sentence results.** When the span has several sentences, the parts from cause 3 are its sentences, reported individually: "The cited sentence is supported; the two before it aren't in this source." Nothing stops being checked.
   - **Last sentence plus context.** Verify the final sentence and pass the rest as context "for resolving names and pronouns only". This is the three-way input proposed in `docs/researcher-feedback-review.md` §2; `dataset.json` already stores `claim_container` for it. It's simpler, but it stops checking uncited earlier sentences, which a paragraph-end citation often is meant to cover.
2. **Fragments.** When the citation sits in a table cell, list item or infobox row and the claim is under ~40 characters, build the claim from its surroundings: row header + column header + cell ("<name> — cause of death: Airstrike"), or infobox label + value ("Conservation status: Least Concern (IUCN 3.1)"). This goes in `core/claim.js`, next to the existing short-claim handling.

**Check.**
- Benchmark rows whose `claim_container` holds several sentences.
- Replay the 16 rated long-claim rows.
- For fragments, take 30 table and infobox citations from the log and check the built claims read correctly.

---

## Shared groundwork

- **A field regression set**, `benchmark/dataset_field.json`, built from the rated checks.
  - Each row's label is the editor's correction (or the verdict, if 👍), confirmed by the owner and tagged with a cause from this brief.
  - Sources are re-fetched and stored now, because the log doesn't keep them; archive URLs keep most of them stable.
  - It stays separate from `dataset.json`, like WiCE, because every row was picked by someone who disagreed.
- **Log what changed.** Add `prompt_version`, `guard` (with the original verdict), `claim_scope`, source length and `truncated`, and the second-look outcome. They go into `buildLogPayload()` (`core/feedback.js`) and the Worker's INSERT column list (`docs/worker-logging-reference.md`), so each fix can be measured on real use and not only on the benchmark.
- **One cause per PR**, each with `ccs compare` output against the previous run, so a regression points at its cause.

## Suggested order

| # | Change | Cost | Prompt change |
|---|---|---|---|
| 1 | Cause 2: guard, then page classifier | Small; no model calls | None |
| 2 | Cause 1: citation details in the prompt | Small; one dataset field | One rule |
| 3 | Cause 4: second look, UI wording | One extra call on ~18% of checks | New, separate prompt |
| 4 | Cause 5: fragments | Medium | None |
| 5 | Cause 3: parts schema, then cause 5 long spans | Largest | Schema |

Cause 3 comes last because it is the biggest prompt change. The per-sentence option for long spans builds on it.

## Open questions

1. Long spans: per-sentence results, which keep checking uncited sentences, or last sentence plus context, which is simpler and stops checking them?
2. Should the reverse guard (SOURCE UNAVAILABLE → NOT SUPPORTED) ever flip a verdict automatically, or only flag it?
3. Should the second look in cause 4 be visible to the editor ("disputed") or silent (a re-judged verdict)?
4. Is storing re-fetched source text for a few hundred field-set rows acceptable, as `dataset.json` already does for 189?

## Appendix: how the counts were made

Queries were run against Neon on 2026-11-08. Ratings collapse to one row per check:

```sql
WITH f AS (
  SELECT check_id,
         max(rating) FILTER (WHERE rating IS NOT NULL) AS rating,
         max(corrected_verdict)                        AS corrected
  FROM feedback GROUP BY check_id
)
SELECT l.verdict, count(*) FILTER (WHERE f.rating = -1) AS down, count(*) AS rated
FROM f JOIN verification_logs l USING (check_id)
GROUP BY 1;
```

Rationale patterns (`llm_comments ~*`), unvalidated:

| Pattern | Regex |
|---|---|
| Unusable page (cause 2) | `(log ?in\|sign ?in\|paywall\|subscri\|captcha\|security check\|verify you are\|javascript\|cookie\|access denied\|bibliograph\|metadata\|catalog(ue)? (record\|page\|entry)\|landing page\|only (a \|the )?(abstract\|links?\|navigation\|menu\|table of contents\|title\|headline)\|not included in the provided\|no (article\|substantive\|actual\|readable) (content\|text))` |
| Readable but called unavailable (cause 2, reverse) | `(article\|report\|review\|interview\|story\|press release\|blog post\|obituary\|profile\|biography\|discusses\|is about)` together with `(does not\|doesn't\|no) (contain\|mention\|include\|provide\|state\|specify\|support\|information)`, excluding the unusable-page pattern, pre-model fetch errors and "fragment" |
| Admits partial support (cause 3) | `(confirms\|supports\|mentions\|states\|notes\|reports\|describes\|lists\|shows)[^.]{0,160}(but\|however\|although\|yet)` |
| Demands wording (cause 3) | `(exact (phrase\|wording)\|specific (phrase\|wording)\|the phrase\|verbatim\|that (specific )?wording)` |
| Missing date (cause 1) | `(does not\|doesn't\|no\|without\|not)[^.]{0,25}(specify\|mention\|provide\|give\|state\|include\|indicate)…[^.]{0,30}(date\|year\|month)`, plus weekday names |

Pre-model fetch failures are excluded from "model-made" SOURCE UNAVAILABLE by `^(HTTP \d|Source returned|Failed to fetch|fetch|timeout|timed out|Could not|Proxy|Network|Error|Google Books|No Wayback|Source text could not)`.
