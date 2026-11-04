# Leads from borrowable books: names the book never mentions, and contradictions in its snippets

> **Status (2026-11-04):** Proposed. Step 0 (measuring the Open Library endpoint) has to happen before any code.

## The problem

A `{{cite book}}` citation gets no check today. When it links a book on the Internet Archive
(InternetArchiveBot adds these links at scale, through GreenC's LAMP matcher), `extractHttpUrl()`
returns the `archive.org/details/{id}` link and `fetchSourceContent()` fetches it like any web page.
**For a lending-library book that page is a catalogue record**, so the model judges the claim
against a blurb. What verdict comes back has not been measured. It can't be a real check.

The model can't read the book itself. IA's open endpoints were tested as follows:

| Endpoint | Open (public-domain) book | Lending-library (`inlibrary`, `access-restricted-item`) book |
| --- | --- | --- |
| `{datanode}/fulltext/inside.php` | paragraph-length passages, page numbers, bounding boxes | refused, "Item not available" (tested 2026-08-04) |
| `openlibrary.org/search/inside.json?item_id={id}&q={term}` | not tested | **works, with "a limited amount of surrounding text"** (GreenC, IA Slack, 2026-11-04; not yet run by us) |
| `{datanode}/{dir}/{id}_djvu.txt` | whole OCR text | not available |

Whole-page text of a restricted book is a policy grant, not an API. GreenC says only a few IA staff
have it, and that only the head librarian can grant it. That request is being made separately. **If it
is granted, these restricted books go through the normal pipeline instead, and this design is
superseded.**

So for a restricted book all we have is short snippets around a search term, plus whatever page
information the endpoint returns. That's too little for a verdict:

- **Not supported can't be shown.** A missed search can be bad OCR, paraphrase or a different
  edition: the August `inside.php` captures showed heavily degraded OCR on old scans.
- **Partially supported needs context** a snippet doesn't carry.
- **Supported would be reliable but isn't actionable**: it gives the editor nothing to do.

Two things snippets *can* show, and both are worth an editor's minute:

1. **A name the book never mentions.** When the claim's distinctive surname or place name doesn't
   appear anywhere in a book that's in the full-text index, the book probably doesn't say what the
   claim says.
2. **A contradiction you can see in a snippet.** A snippet puts the claim's name next to a
   different value: "died in 1815" for a claim of 1814.

This design adds both as **leads**: flags to look at, shown beside the result. They are **never
verdicts**. Neither changes the verdict vocabulary, the benchmark, or the verdict prompt.

## Step 0 — measure the endpoint (Alaexis's machine; before any code)

`openlibrary.org` and the IA datanodes are denied from the Claude environment, so this runs locally.
Record every response under `tests/fixtures/ia-inside/` (one JSON file per call, with the URL in a
sidecar `.url` file), the way `source-finder` keeps `test/fixtures/archive/`. The tests below are
built on these files, so the parser is written against real responses, not a guessed schema.

1. GreenC's example: `item_id=visualeffectsind0000goul&q=television`.
2. The same item with a term that is certainly absent (a nonsense word) and one that is certainly
   present (a word from its title).
3. Three or four more `inlibrary` items, including one `printdisabled`-only item and one with
   `source: removed`, plus one open item (`adventuresofoli00dick`) for comparison with `inside.php`.
4. A multi-word query (`q="died in 1814"`) and a quoted phrase, to see what the endpoint accepts.

From these, write down in this doc:

- **Per hit:** characters of text, whether a page number comes back (and as the printed page or
  the scan's leaf index), and how the match is marked.
- **Per response:** total hit count, an `indexed`-style flag or an equivalent, and what zero hits
  looks like (empty list, error, or "not indexed"). **Rule 1 depends entirely on telling "not in the
  book" from "book not indexed"**, so this is the most important result.
- Latency, and whether rapid calls get throttled.
- Whether `openlibrary.org` is reachable from a Wikipedia page's script (CSP). `source-finder` found
  only `archive.org` on the allowlist, so assume it isn't, and plan the call through the Worker
  (`alex-o-748/public-ai-proxy`) or tf-source-fetcher. Check whether either already passes JSON
  through unchanged; if not, that's a small new route and a two-repo change.

**Stop and rewrite this design if** hits carry under ~60 characters, or zero hits can't be told
apart from "not indexed". Rule 2 needs a clause of context and rule 1 needs a reliable zero.

## Where it goes in the code

| Piece | File | Notes |
| --- | --- | --- |
| Recognize an IA book link | `core/urls.js` | `parseIaBookUrl(url)` → `{ identifier, page }` for `archive.org/details/{id}[/page/{n}][/mode/…]`. Distinct from `parseArchiveOrgUrl()`, which is Wayback. |
| Pure logic: terms, queries, response parsing, rules | **new `core/books.js`** | No I/O. Add to `scripts/sync-main.js`'s `CORE_ORDER` after `urls.js`, then `npm run build`. |
| Network calls | `core/worker.js` | `fetchIaMetadata(id)` (`archive.org/metadata/{id}`, on the CSP allowlist) and `searchInsideBook(id, term)` (through the Worker). Both injectable, like `fetchSource` in `core/pipeline.js`. |
| The contradiction prompt | `core/books.js` | Its own prompt and its own hash-pinned `BOOK_LEAD_PROMPT_VERSION`, as `core/severity.js` does. **The verdict prompt is not touched.** |
| Userscript wiring | `main.js`, the branch in `verifyClaim()` that already special-cases Google Books | See "The flow". |
| Tests | **new `tests/books.test.js`** | Built on the step 0 fixtures. |

### The flow, for a citation whose URL is an IA book link

1. `parseIaBookUrl()` recognizes it. **Stop treating the details page as the source** in
   `fetchSourceContent()` (the same place Google Books is caught).
2. `fetchIaMetadata()`. If the item is not access-restricted, it's an open book: out of scope here
   (it can get real text via `_djvu.txt` or `inside.php` later). Show the existing "paste the source"
   prompt, as for Google Books, rather than a verdict on a blurb.
3. If it's restricted, run the two rules below and show the result. Show the paste prompt as well,
   since an editor who has borrowed the book can still paste the page and get a real verdict.

The page comes from the link (`/page/214`) first, then from `extractPageNumber()`. Neither rule
needs it, but both show it when the snippet's page matches.

## Rule 1 — a name the book never mentions

**Choosing terms** (`bookAnchorTerms(claim, { articleTitle, bookTitle, bookCreator })`):

- Proper names from the claim: capitalized words not at a sentence start, keeping multi-word names
  together, then **searched by their last word** (surname, or the head of a place name). Books name
  people in more ways than Wikipedia does ("Emich Carl", "Emich Charles", "Prince Charles"), so the
  surname is the form most likely to survive. That lesson comes from CNfirmed's evaluation.
- Leave out any term in the book's own title or creator, and the article's title: those prove
  nothing by being present.
- **No numbers, no common nouns.** A book can say "the following year" for 1815, so a missing number
  is weak evidence. A missing surname is strong evidence.
- Up to three terms. Fold diacritics for comparison, but search the original form first.

**The control.** Search one term that must be in an indexed copy of the book: the most distinctive
word of its title. **If the control gets zero hits, the book isn't usable for this rule: report
nothing.** Without the control, every unindexed book would generate leads.

**The rule.** Raise the lead when the control hits and at least one anchor term gets zero hits.
Report which terms were missing and which were found.

**Don't raise it when:**

- the item's language (metadata `language`) isn't the claim's language, since names get
  transliterated (a Russian book cited on enwiki);
- the claim is about the book itself (a sentence citing the book for its own existence or
  publication);
- the citation names a translator or the metadata says the item is an abridgement;
- the term is a single letter, or under four characters.

**What the editor sees:** *"Worth a look: 'Leiningen' doesn't appear anywhere in this book (searched
the Internet Archive copy)."* Followed by a link to the book. No verdict word, no colour of a failed
verdict.

## Rule 2 — a contradiction visible in a snippet

1. Search inside for each anchor term from rule 1, plus each number in the claim. Collect the
   snippets, each with its page if the endpoint gives one.
2. One model call: the claim, its paragraph (`core/article-context.js`) and the snippets, each
   numbered. The question is narrow: *does any snippet state something about the same person, event
   or thing that is incompatible with the claim (a different date, number, place or person)? If so,
   quote the snippet's words exactly, and say whether it is clearly about the same thing.* Answer in
   JSON: `{ contradiction: true|false, snippet: n, quote, same_subject: "yes"|"unsure", reason }`.
3. **Run the quote through `verifyQuote()`** (`core/quote.js`) against that snippet. Raise the lead
   only when the quote verifies **and** `same_subject` is `"yes"`. A quote that doesn't verify, or an
   unsure subject, gives nothing, silently, as the quote panel does.
4. The model never sees the first-pass verdict, and it isn't asked whether the claim is true,
   only whether a snippet conflicts with it. Same rule as `core/severity.js`.

The main risk is a snippet about a different thing with the same name: "died in 1815" may be the
father. `same_subject` and the editor's own reading are the guard. That's why this is a lead and
not a NOT SUPPORTED.

**What the editor sees:** *"The book may say otherwise (p. 214): '…died at Amorbach in 1815…'"*, the
verified text only, and a link to the page (`archive.org/details/{id}/page/{n}`), which the editor
can open by borrowing the book.

**Provider:** the user's selected provider, through `callProviderAPI()`. One extra call per checked
book citation, and only when there are snippets to judge.

## Result shape

```js
bookLeads: [
  { kind: 'name_absent', terms: ['Leiningen'], found: ['Feodora'], control: 'Victoria', identifier },
  { kind: 'contradiction', page: 214, quote, verifiedText, reason, identifier },
]
```

Leads hang off the result, beside `verdict`; they are not a verdict. Like `SKIPPED`, they stay
outside `VERDICTS` / `VERDICT_LIST`, so the benchmark never sees them.

**Not logged to the Worker yet.** `logVerification()`'s fields are validated in
`alex-o-748/public-ai-proxy`, so a new field is a two-repo change. Add it once the leads have
earned a place.

## UI

- A "From the book" block under the result card, one line per lead. Strings go through `this.t()`
  and every message table (`tests/i18n.test.js` will fail otherwise). Colours are new `--sv-*`
  tokens in both blocks of `styleTokens()` (`tests/styles.test.js`).
- **Single check first.** Verify All later, behind the same block, once precision is known. A lead
  doesn't count toward the summary chips.
- No "found" message. A name the book does contain is not shown either (not actionable).

## Tests (`tests/books.test.js`)

- `parseIaBookUrl()` on `details/{id}`, `details/{id}/page/214`, `details/{id}/page/n214/mode/2up`,
  a Wayback URL (null) and an `archive.org/stream/` URL.
- `bookAnchorTerms()`: surnames from multi-word names, the title/creator/article exclusions, no
  numbers, the four-character floor.
- Rule 1 against the fixtures: lead on zero anchor hits plus a control hit; **nothing** when the
  control misses; nothing on a language mismatch.
- Rule 2 with a stubbed provider: a verified quote with `same_subject: "yes"` → lead; unverified
  quote → nothing; `"unsure"` → nothing.
- `fetchSourceContent()` no longer returns a details page as source text for an IA book URL.

## Before turning it on for everyone

Hand-check precision on about 30 book citations that carry an IA link, from articles with
`{{failed verification}}` and from random articles. For each lead, read the book (borrow it) and
record whether it was worth the editor's minute. **Ship rule 1 if most of its leads are**; ship
rule 2 if almost all are, since a false contradiction costs more than a false absence. Record the
numbers here.

## Not in this design

- Open books (`_djvu.txt`, `inside.php`): they get a real verdict, a separate piece of work.
- Suggesting a missing or wrong `|page=`: considered on 2026-11-04, not chosen for now.
- Books cited by ISBN with no IA link: needs a matcher. LAMP already does this; ask GreenC before
  building one.
- The batch pipeline: needs the Worker/Toolforge route from step 0 and a CSV column.
