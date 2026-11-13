# Edits after Source Verification suggestions

Since 5 November 2026, NOT SUPPORTED and PARTIALLY SUPPORTED findings from the
batch files (`analysis/batches.json`) are shown to editors as
`llmSourceVerification` in VisualEditor's Suggestion Mode. Wikimedia's
dashboard only counts clicks on the suggestion card. This analysis asks a
different question: **did the flagged sentence or its footnote change
afterwards, by any edit, and how does that compare with claims that weren't
flagged?** It answers from page histories, so it works on past edits.

It describes what happened. It does not say that a suggestion caused an edit.

## Running it

Both modes fetch revision text from the API (`api.php`), because the Wiki
Replicas hold no page text. They differ only in where revision metadata
(tags, editors, bot group) comes from.

**A handful of pages, from anywhere with API access** (the validation cases):

```bash
node analysis/run-edit-impact.js --wiki enwiki --batches ~/batch-export --source api \
  --titles "List of fictional ships|Beef clod|Dubin v. United States|OpenAI|Kumiharu Shigehara|National Military Cemetery, Abuja|Colette Kress" \
  --out ~/edit-impact-validation
```

**All of a wiki, on Toolforge** (metadata from the replicas, text from the API):

```bash
node analysis/run-edit-impact.js --wiki enwiki --batches ~/batch-export --source replicas --out ~/edit-impact
```

- `--batches` is the folder holding the batch files, as `.csv` or `.csv.gz`.
  They live on the `data/batches` branch; see `docs/batch-files.md`.
- `--until` fixes the end of the window. Without it, the first run fixes it at
  the time it starts, and records it in `run.json`.
- A killed run resumes from `pages.jsonl`. Pass `--fresh` to start again, for
  example to extend the window.
- Requests go one at a time, at least `--delay-ms` (default 1000) apart, with
  `maxlag=5`. The client backs off on 429, 503 and maxlag, honouring
  Retry-After. The User-Agent names this repository; `--contact` appends more,
  such as a wiki username.
- `node analysis/grafana-check.js --since 2026-11-05T00:33:00Z` prints the
  dashboard's own counts for the same window, for comparison.

## Outputs (`<out>/<wiki>/`)

| File | What |
|---|---|
| `suggestions.csv` | One row per flagged or supported claim: where it was found, the first revision that changed it and how, who made that edit, its tags, whether it was later reverted, before/after text |
| `revisions.csv` | Every revision after go-live on those pages: editor, editor type (registered/ip/temp), bot, `editsuggestion-seen`, `editsuggestion-used`, `mw-reverted`, VisualEditor, revert, diff link, and how many claims it changed first |
| `summary.md` / `summary.json` | The per-wiki summary |
| `sample.md` / `sample.csv` | About 30 changed flagged claims, drawn at random (seeded), with before/after and diff links, for a person to judge. Record the verdict in `sample.csv`'s `addressed_flag` column |

## Method

1. **Suggestions.** Every NOT SUPPORTED / PARTIALLY SUPPORTED row in the wiki's
   batch files is a *flagged* claim. Every SUPPORTED row on the same pages is a
   *supported* claim, the control group. SOURCE UNAVAILABLE, SKIPPED and ERROR
   rows are neither shown nor a clean control, so they are left out.
2. **Window.** It runs from the wiki's go-live, the config change that
   enabled the suggestion type, to `--until`:

   | Wiki | Go-live (UTC) |
   |---|---|
   | enwiki | 5 Nov 2026 00:33 |
   | ruwiki | 5 Nov 2026 10:58 |

   The **baseline** is the last revision before go-live, not the revision the
   batch checked. Edits between the check and go-live happened before anyone
   could see the suggestion.
3. **Locating each claim in the baseline.** Wikitext is reduced to plain
   text: refs, templates, markup and links are stripped, with link labels
   kept. Tokens are compared after case, quotes and dashes are folded. A claim
   is found in one of three ways, best first:
   - `footnote`: a footnote with the row's ref name, or containing its source
     URL (including the original behind a Wayback URL), whose preceding prose
     ends with the claim.
   - `claim`: no footnote matches by name or URL, but some footnote, such as an
     `{{sfn}}`, has the claim right before it. That footnote's wikitext then
     identifies it.
   - `page`: the claim is somewhere on the page, but the footnote is unknown.

   A claim that can't be located is reported and excluded from both groups
   alike.
4. **First change.** Revisions after go-live are taken in order. The first one
   where any of the following holds is the claim's first change:

   | Change | Means |
   |---|---|
   | `sentence_edited` | The last *N* tokens before the footnote differ from the baseline, where *N* is the claim's length. Edits elsewhere in the paragraph don't count; a changed word inside the claim does |
   | `sentence_removed` | The footnote remains, but the claim is no longer in front of it |
   | `footnote_removed` | The footnote is gone and the sentence is still on the page |
   | `sentence_and_footnote_removed` | Both are gone |
   | `source_replaced` | The footnotes after the claim cite a different source in place of one they cited: the row's own URL is gone from a kept named ref, or a URL in the run was swapped. A bot fixing a moved link shows up here, marked as a bot edit |
   | `source_removed` | A source cited alongside the claim's footnote was removed, the footnote itself kept |
   | `flag_added` | `{{failed verification}}` or a relative (`{{better source needed}}`, `{{dubious}}`, `{{citation needed}}`, …) is newly attached to the footnote |
   | `flag_removed` | Such a template that was attached in the baseline is gone. `flags_at_baseline` lists them: some flagged claims were already tagged by editors before the batch ran |
   | `footnote_added` | The run of footnotes right after the claim now cites more sources than before. Editors often fix a citation this way rather than by touching it |

   A citation bot adding `access-date` or `archive-url` is *not* a change: the
   comparison looks at prose, source URLs, which footnotes sit together and the
   attached flag templates, never at the formatting of a citation.

   A reverted change still counts as the first change. `first_change_reverted`
   records that it was reverted, and `changed_at_end` records whether the claim
   still differs from the baseline at the end of the window.
5. **Summary.** For each group: the share of located claims that changed, with
   95% Wilson intervals, split by the edit that changed them:
   - tagged `editsuggestion-seen`,
   - any other edit,
   - tagged `editsuggestion-used`,
   - not by a bot and not later reverted.

## Limits — read before quoting a number

- **The tags don't identify this suggestion.** `editsuggestion-seen` and
  `editsuggestion-used` cover every suggestion type. A seen-tagged edit that
  changed a flagged claim might have been prompted by a different suggestion.
  The tags narrow the question; they don't settle it.
- **Most edits had no chance to see the card.** It appears only in
  VisualEditor's Suggestion Mode, for editors who open it. Edits in the source
  editor, by bots or via the app could not have been prompted by it.
- **Nothing records which flagged rows were actually displayed.** Every flagged
  row is treated as shown. If VisualEditor drops some, for example a claim it
  can't match to the page, those rows dilute the flagged group's rate.
- **The control isn't a randomised one.** Supported and flagged claims sit on
  the same pages and receive the same edits, which is why the comparison is
  useful. But flagged claims differ in other ways: they are more often list
  items, more recently written, or more contested. A gap between the groups is
  something to look into, not an effect size.
- **enwiki showed the suggestion before go-live.** The dashboard counts
  `llmSourceVerification` shown on enwiki on 15 Oct, 27 Oct, 30–31 Oct and 3–4
  Nov: 278 of 300 shows in the 30 days to 13 Nov. They come in tight hourly
  bursts, so they look like testing. Edits made then fall before the window
  and aren't counted.
- **Wikitext is approximated, not rendered.** Templates are dropped except a
  few text-producing ones (`nowrap`, `lang`, `convert`, …). A claim generated by
  a template, such as a table row built by a template, may not be located.
  Change detection is unaffected, because every revision is reduced the same
  way.
- **Only the first change.** If a bot edit changes a claim first, a later human
  fix of the same claim isn't the "first change". `end_kinds` shows the state
  at the end of the window.
- **Bot means the editor's current `bot` group**, not their group at the time
  of the edit. Neither the replicas nor the API keep that history.
- **Whether a change addressed the flag is a human judgement.** That is what
  the sample is for. The summary never claims it.
