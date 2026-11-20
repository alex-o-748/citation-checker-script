# Book citations, checked against the Internet Archive

> **Status (2026-11-20):** Proposed. Widens `2026-11-04-borrowable-book-leads.md` (books that already carry an archive.org link, as leads) to every book citation, linked or not, and to every kind of copy the Archive holds. That doc's two lead rules are kept as phase 4.

## In short

On enwiki, **18.5% of claims cite a book that the checker never reads**, and 2.9% of claims are judged against a catalogue page instead of the book. About half of those books have a copy on the Internet Archive. But only 7% of book claims have a copy whose text is public. For the rest, all the Archive offers is a search inside the book that returns ~100-character passages. Measured on 70 such claims, those passages confirm about one claim in ten, and they can never show that a claim fails.

So the impact comes in this order:

1. Stop judging claims against catalogue pages.
2. Give every book citation the link to its page on the Archive.
3. Read the cited page of public-domain books.
4. Confirm what the passages can confirm.
5. Ask the Archive for page text of lending-library books. That one grant would take full verdicts from 7% of book claims to 48%.

## The problem

A book citation gets no check today, whatever it looks like:

| The citation | What happens |
| --- | --- |
| No link (`{{cite book}}` with an ISBN, an sfn short cite) | Verify All: SOURCE UNAVAILABLE, "No URL found in reference". Single check: the paste box. Batch: `reason_type = no_url`. |
| A Google Books link | Skipped (`isGoogleBooksUrl()`), the paste box. |
| An archive.org book link (InternetArchiveBot adds these, with `/page/N`) | **Fetched as a web page.** For `archive.org/details/{id}/page/214` the fetcher returns ~6,900 characters of site chrome and catalogue record (measured), enough to pass as content, so the model judges the claim against a catalogue page. |
| Only a WorldCat / Open Library / LCCN link (`|oclc=`, `|ol=`, `|lccn=` with no `|url=`) | `extractHttpUrl()` returns the identifier link, so the same: a verdict on a catalogue record. |

CNfirmed (`alex-o-748/source-finder`) already reads Internet Archive books, to *find* a source for an uncited claim. The checker's problem is easier: the citation names the book, and nine times in ten the page.

## How many (measured 2026-11-20)

The sample is 200 random enwiki articles and 150 random ruwiki articles, each with at least five citations. Each article's rendered HTML (`action=parse`) went through `collectCitations()` as the userscript runs it. Book metadata came from the CS1 COinS span (`span.Z3988`) behind each footnote, following sfn short cites to their full citation.

**enwiki, 5,658 claims:**

| What the checker does with the claim's citation | Claims | Share |
| --- | ---: | ---: |
| Fetches a link | 3,662 | 64.7% |
| Skips it (claim too short) | 510 | 9.0% |
| **Book, no link** | 627 | 11.1% |
| **Book, Google Books link** (skipped) | 255 | 4.5% |
| **Book, archive.org link** (catalogue page read) | 117 | 2.1% |
| **Book, WorldCat/OL/LCCN link only** (catalogue page read) | 48 | 0.8% |
| No link, not a book (plain-text references 4.3%, news and journals 1.1%) | 327 | 5.8% |
| Identifier link only, not a book (DOI etc.) | 112 | 2.0% |

**Book citations are 18.5% of all claims, and they cluster.** 33 of the 200 articles have five or more book citations, and in those articles books are 48% of all claims (median 43%). Those are the articles, mostly history and biography, where Verify All's report is half "No URL found". 90% of the link-less book claims carry a page number, and 73% are sfn short cites.

**ruwiki, 3,947 claims.** Link-less books with an ISBN are 13.6% of claims, archive.org book links 7.7% (258 of the 304 come from one article), and Google Books 1.3%. ruwiki references are GOST-style plain text, so the ISBN is the only machine-readable field.

## What the Archive holds for them

Each enwiki book (434 distinct books, 1,054 claims, counting 7 too short to check) was looked up the way the design below does it:

1. the archive.org link, if there is one;
2. then the ISBN (`advancedsearch.php`, `isbn:(<13> OR <10>)`);
3. then the title's words with the first author's surname.

Every copy found was checked against the full-text index with a control query.

| Best copy found | Claims | Share |
| --- | ---: | ---: |
| None | 510 | 48.4% |
| Lending library: borrowable, text not public | 183 | 17.4% |
| For print-disabled readers only: text not public | 206 | 19.5% |
| An upload of an in-copyright book (never used, below) with a lending or print-disabled copy behind it | 48 | 4.6% |
| Only an upload of an in-copyright book | 29 | 2.8% |
| **Readable**: a public-domain library scan, or open access | 75 | 7.1% |
| Found, not in the full-text index | 3 | 0.3% |

About half of book claims (48.4% once uploads are set aside; 9.0% of all claims) have a copy the checker can search. A quarter (25.6%) have one an editor can open or borrow with a free account, and **7% have one whose text is public**.

By how the citation points at the book:

| Citation | Usable copy | Readable copy |
| --- | ---: | ---: |
| No link | 40% | 1.3% |
| WorldCat/OL link only | 71% | |
| Google Books link | 47% | |
| archive.org link | 91% | |

66% of usable copies are the cited edition (the link, the ISBN, or a title match with the cited year). That is what makes the cited page number usable.

ruwiki is different: **3 of 537 link-less book claims had a copy** (found by ISBN). Russian-language books are not on the Archive in numbers. The usable ruwiki copies are books that already carry an archive.org link, mostly in English.

### "Open" is not one thing

Half of what the Archive marks open was not usable. 150 claims had a best copy in no lending collection. Of these, **73 were user uploads of in-copyright books**: collections `opensource`, `community`, `folkscanomy…`, `fringe`, `deemphasize`, patron libraries. One upload of a 1995 history alone backed 25 claims in one article. The checker must never read or link these. Linking them is what WP:COPYLINK forbids, and the Archive itself flags many (`fringe`, `deemphasize`). The rest were public-domain scans from libraries (`americana`, `europeanlibraries`, `toronto`, Library of Congress, `biodiversity`, Gutenberg), usually carrying `possible-copyright-status: NOT_IN_COPYRIGHT`.

## What text each kind of copy gives

**A readable copy** has its whole OCR text. archive.org serves it itself, at `archive.org/stream/{id}/{id}_djvu.txt`, but with no page breaks. Cutting it into pages takes three derived files:

- `{id}_page_numbers.json`: printed page → scan leaf;
- `{id}_hocr_pageindex.json.gz` and `{id}_hocr_searchtext.txt.gz`: leaf → text.

They live on numbered datanodes outside Wikipedia's CSP. tf-source-fetcher reaches them (the page map came back), but its document path decodes a `.gz` as text. So they need a small new route (below).

**A lending or print-disabled copy** has no public text. The one thing open is archive.org's full-text search with `identifier:`, the endpoint CNfirmed uses. For a quoted term it returns **up to five passages of ~100 characters, and no page numbers**. Measured on 170 claims, searching each claim's numbers, surnames and rare words (up to five terms, one per query):

- 95% of claims get at least one passage. 55% get a passage holding two or more of the claim's anchors, but by reading, most of those are tables of contents, index lines or other events of the same year. The pilot below is the real measure.
- **75% of searches come back saturated**: five passages, because the term is more common in the book, and the rest are never seen. 54% of claims have every term saturated.
- **Two terms in one query are highlighted separately, never where they co-occur** (checked). So the passage that states a claim is reached only through a term or phrase that is rare in that book.
- 10% of terms (22% of claims) are absent from the book: zero hits on an indexed copy. On readable copies, mostly old scans, the figure was 29% of terms. Old type, old spelling and OCR errors make an absent word weak evidence there.
- The median claim got ~1,050 characters of passages. Search answered in about a second during these tests. CNfirmed has seen ~25 seconds under load, and bursts of HTTP 400 that archive.org then caches for ~20 minutes.

**Google Books is no substitute.** Its API returns `NO_PAGES` for in-copyright books, and a term query restricted to one ISBN matches only the book's description (checked on two books).

## What the verifier makes of it (pilot)

`verifyCitation()` ran with the production prompt and the default model (Lift Wing, Qwen3.8), unchanged. It was given the passages of 70 search-only claims, and for 35 readable claims the best ~1,500-character window of the whole text (the page route does not exist yet). I read every verdict below against what the model was shown.

| The model said | Search results (70) | Windows of a readable copy (35) |
| --- | --- | --- |
| SUPPORTED | 4, all correct | 6, all correct |
| PARTIALLY SUPPORTED | 8, **every one** a passage that begins the cited statement and is cut off by the ~100-character window | 4 |
| NOT SUPPORTED | 27, all omission | 15: 8 omission, 7 contradiction. **At least 4 of the 7 were the wrong passage**: another episode of the same narrative, another man's biography in a volume of biographies |
| SOURCE UNAVAILABLE | 31 | 10 |

I read 14 of the rejected search cases that had a passage with two or more of the claim's anchors. None of the passages states the claim: they share its names and dates but sit elsewhere in the book. Rejecting them is right; calling the citation NOT SUPPORTED would not be.

**Then phrase searches.** Each claim also got up to three searches for its own two- and three-word phrases. 83% of these found nothing, because a book words things its own way, but the hits landed on the statement. SUPPORTED went from 4 to 10, with none lost. But 2 of the 6 new ones were over-reaches: the model's own comment said the names, or the venue, were not in the passages. A guard that requires every number and name of the claim to appear in the passages rejects both. It also rejects one correct verdict, a claim carrying a parenthetical Portuguese name. Net result: **7 of 70 search-only claims (10%) confirmed, all 7 correct.**

Four conclusions:

1. On search results, PARTIALLY SUPPORTED and NOT SUPPORTED are never right as verdicts.
2. On a window of a readable book, a contradiction is not trustworthy either: only the cited page may refute.
3. Readable copies give real verdicts.
4. Search confirms about one claim in ten, and that is the ceiling of the search path. Seventy claims is a small sample: read it as "about one in ten", not as 10.0%.

## What it adds up to (enwiki, per 100 claims)

| | Claims |
| --- | ---: |
| Cite a book the checker never reads | 18.5 |
| …judged against a catalogue page today (phase 0 stops it) | 2.9 |
| …can get a link to a copy the editor can open or borrow (phase 1) | 4.8 |
| …can be searched by the checker, print-disabled copies included | 9.0 |
| …get a full verdict from the cited page of a readable copy (phase 2) | 1.3 |
| …get confirmed by search (phase 3) | ~0.8 |
| …would get a full verdict if the Archive serves lending pages (phase 5) | 9.0 |

In the articles that lean on books (33 of the 200), multiply by about two and a half.

## Design

### 1. Recognize a book citation (`core/books.js`, pure)

`bookReference(refElement, doc)` returns `{ isbns, title, surname, year, page, pages, via, iaIdentifier, iaPage }` or null. It reads the same elements `urlFromFootnote()` already walks: the footnote, the main reference of a sub-reference, and the full citation an sfn short cite points at.

- **Metadata from COinS**, the `span.Z3988` that CS1 puts after every `cite.citation`: `rft.btitle`, `rft.isbn`, `rft.aulast` / `rft.au`, `rft.date`, `rft.pages`. A book is a `cite.citation` of class `book`, `encyclopaedia`, `thesis` or `report`, or a CS2 citation with `rft.btitle`. `extractReferenceText()` deliberately strips `.Z3988` from what it gives the model; this function reads it instead.
- **Fallback: an ISBN in the footnote's text.** It is all ruwiki's GOST references offer.
- **The page** comes from `extractPageNumber()`, then `rft.pages`. On ruwiki, `extractPageNumber()` first needs to read `с.` / `С.` / `стр.`: in the sample it found the page in 2 of 452 footnotes that had one. That is a separate fix, and it matters for PDFs too.
- **Links that name a book.** `parseIaBookUrl()` handles `archive.org/details/{id}[/page/{N|nN}]` and `/stream/`; it is distinct from `parseArchiveOrgUrl()` (Wayback). A Google Books link counts as a book citation, with its ISBN taken from the same footnote's COinS.
- **`extractHttpUrl()` stops returning catalogue identifiers.** A CS1 identifier link to WorldCat, Open Library, LCCN or HathiTrust's catalogue is not the source; such a link is recognized by the `…_(identifier)` wikilink before it. DOI, JSTOR, PMID and the like stay as they are, since they lead to the work.

### 2. Find the copy (`core/books.js` builds the queries, `core/worker.js` sends them)

In order, stopping at the first that gives a usable copy:

1. The archive.org link's own item.
2. The ISBN: `isbn:(<13> OR <10>)` on `advancedsearch.php`. Use both forms, unhyphenated: a hyphenated ISBN matches nothing (measured). An item also lists the ISBNs of its other bindings.
3. The title's words (main title, words of three letters or more, up to six, joined with `AND`) with the first author's surname. Keep a result only when the titles agree (≥0.6 token overlap here). These are CNfirmed's matcher rules (`eval/experiments/archive-ideas.ts`).

Which copy counts:

| Copy | Use |
| --- | --- |
| Public domain (the item's or the cited edition's year ≤ 1930, or `possible-copyright-status: NOT_IN_COPYRIGHT`), or open access | Read it (3a, 3b) |
| `inlibrary` (lending) | Search it (3c); the editor can borrow it |
| `printdisabled` without `inlibrary` | Search it (3c); search works the same, but an ordinary editor can't open it |
| Anything else that isn't access-restricted | **Never.** Not even as a fallback, not even its link: it is an upload of an in-copyright book |

A copy is the **cited edition** when it was found by link or ISBN, or by title with the cited year. Only then is the cited page number used to pick pages.

Results are cached per book: per page view in the userscript, per sweep in the batch. A book cited 25 times in an article is looked up once.

### 3. Read it

The result records which kind of text it was judged on: `evidence: 'pages' | 'windows' | 'search'`.

**a. Pages**: a readable copy, the cited edition, and a page number. The cited page and its neighbours (N−1 to N+1, or the cited range ±1) come from a new tf-source-fetcher route, `GET /ia/pages?identifier=…&pages=45-47`.

- It returns `{ pages: [{ page: '45', leaf: 52, text }] }`, built from the three files above.
- It refuses an access-restricted item, and caches forever (a scan does not change).
- The model gets `[p. 45] …` blocks and the standard prompt, the same way `&page=` works for a PDF.
- A page the map does not know (front matter, plates, a low-confidence map) falls through to b.

**b. Windows**: a readable copy with no page, or another edition. The model gets search results (as in c) plus the best ~1,500-character windows of the whole text by claim anchors, picked as CNfirmed's reader picks them.

**c. Search**: a lending or print-disabled copy. Search inside for the claim's telling terms, one term per query, as `"term" identifier:("id")`:

- **Terms, in order:**
  1. numbers, years first;
  2. surnames;
  3. names whose last word is generic ("Highland Chief", "Red River"), searched as a phrase;
  4. the claim's two- and three-word phrases, never across punctuation, longest word first (in the pilot these more than doubled the claims confirmed).
- **Limits:** never the book's own title words, which are on every page; up to eight searches.
- **CNfirmed's sanitizing applies:** no `/ ~ [ ]`, balanced quotes, and an identifier with a dot cannot be searched.
- A term with fewer than five passages has been seen everywhere it occurs. Zero passages on an indexed copy means the term is not in the book.
- **An error is never zero hits.** Retry the way CNfirmed does (ask for one more hit, after 5 and then 15 seconds). On a final error, report the book as not searched.
- **Never chain searches to see past a passage.** Searching a passage's last words to get the next 100 characters would rebuild text the Archive has chosen not to show. One search per term, no follow-ups. The way to see more is the request below.
- The model gets the passages numbered, each with the term searched, under a header that says what they are: search results inside the book, not its page, possibly from different pages.

### 4. What each kind of text may conclude

The verdict prompt is not changed. The kind of text goes in the source block's header, as `Truncated: true` does today, and these rules apply after parsing:

| The model says | Pages (the cited page) | Windows (elsewhere in a readable copy) | Search results |
| --- | --- | --- | --- |
| SUPPORTED | shown | shown with a verified quote | shown with a verified quote, **and only if every number and name of the claim is in the passages** |
| PARTIALLY SUPPORTED | shown | not a verdict | not a verdict: "the book has the start of this statement", with the passage |
| NOT SUPPORTED, omission | shown | not a verdict | not a verdict |
| NOT SUPPORTED, contradiction | shown | not a verdict (4 of 7 were the wrong passage) | a lead only (2026-11-04's rule 2: verified quote, same subject) |

"Not a verdict" means SOURCE UNAVAILABLE with a new reason, `book_not_readable`, plus the link to the page. Every NOT SUPPORTED and PARTIALLY SUPPORTED the checker shows on a book then comes from reading the cited page, the same promise it makes for web sources. The cost is genuine failures in lending books, which go unreported. Search can confirm a claim, but it cannot refute one.

### 5. What the editor sees

- **Every book citation with a copy the editor can open or borrow gets a link**: "Internet Archive: *Title* (year), p. 45", to `archive.org/details/{id}/page/45`, the link InternetArchiveBot writes. A lending book opens on that page once borrowed with a free account. This alone turns "No URL found" into one click to the page, whatever the verdict. A print-disabled-only copy is named but not linked as borrowable.
- **The edit InternetArchiveBot would make.** For a cited-edition copy that is lending or public domain, the link can come with "Add this link to the citation": `|url=…/page/45 |url-access=registration`, through the section editor, as CNfirmed inserts a `<ref>`. The editor reviews and saves, and the next reader and the next check get the link.
- **Pages and windows:** a result like a web source's, plus "Read pp. 44–46 of the Internet Archive copy".
- **Search:** a SUPPORTED with its quote, labelled "found by searching inside the book". Otherwise: "The book's text is not public. Searching it for '1814' and 'Leiningen' did not show the claim. Borrow it to check p. 45." Or, for a cut-off passage: "The book has the start of this statement; borrow it to read p. 45."
- **Verify All:** `book_not_readable` counts with Source unavailable, never as a failure. New fields go in a row's details (`findingHtml()`), strings through `this.t()` in every table, and colours as `--sv-*` tokens, per "The report view".

### 6. Where it goes in the code

| Piece | File |
| --- | --- |
| `bookReference()`, `parseIaBookUrl()`, ISBN forms, query builders, copy choice, search terms, the anchor guard, evidence assembly, the rules of section 4 | new `core/books.js`, in `scripts/sync-main.js`'s `CORE_ORDER` after `urls.js` |
| Catalogue identifiers are no longer sources | `core/urls.js`'s `extractHttpUrl()` |
| `findBookCopies()` (`advancedsearch.php`, `/metadata`), `searchInsideBook()` (the full-text search), `fetchBookPages()` | `core/worker.js`, injectable like `fetchSource`. The first two are on archive.org, inside Wikipedia's CSP |
| `GET /ia/pages`, `GET /ia/text` | `alex-o-748/tf-source-fetcher` |
| `citation.book` beside `citation.url` | `core/citations.js`'s `collectCitations()` |
| Userscript | `verifyClaim()` and `verifyAllCitations()`, where they branch on `!refUrl` / `isGoogleBooksUrl()` |
| Batch | `service/claim-extractor.js`'s `fetchSources()` (book jobs keyed to `archive.org` in the host pool) and `service/verifier.js` (the rules of section 4) |
| `evidence`, `ia_identifier` in the verification log | `core/worker.js`'s `logVerification()`, plus the Worker's field validation in `alex-o-748/public-ai-proxy`. A two-repo change, so that editor ratings can be split by kind of text |
| Tests | new `tests/books.test.js`, on recorded archive.org responses (`tests/fixtures/ia/`), as `source-finder` keeps `test/fixtures/archive/` |

`source-finder` has the same endpoints in TypeScript (`src/core/internetArchive.ts`), with every quirk written down. `core/` must stay dependency-free for `main.js`, so port the rules with their tests rather than importing them.

### 7. The batch pipeline

Book citations take the same path. **Findings come only from pages.** A search or window row is SUPPORTED or SOURCE UNAVAILABLE (`book_not_readable`), never a flagged finding, because the batch has no editor to borrow the book.

New CSV columns: `book_copy` (identifier), `book_evidence`, `book_edition` (`cited` / `other`). ToolsDB columns wait, as severity's did.

The present behaviour is also a source of false findings: every archive.org- or WorldCat-linked book in a sweep is judged on a catalogue page. Phase 0 removes those.

### 8. Load on the Archive

- **Per distinct book:** one or two catalogue queries, one metadata call and one control search.
- **Per claim:** one page fetch, or up to eight searches. An article with 60 book claims is a few hundred requests to archive.org.
- **Pacing:** the userscript runs book searches two at a time. The batch puts them through the host pool, so archive.org sees one request at a time.
- **Before turning it on for everyone,** tell the Archive's Wikipedia contacts (GreenC) the expected volume, as was done for tf-source-fetcher.

## The request worth making: page text for lending books

Copies that can only be searched cover 41% of book claims; readable ones cover 7%. **If the Archive serves this tool the text of a cited page of a restricted book (lending library or print-disabled), those claims move from 3c to 3a. Book claims with a full verdict would go from 7% to 48%, and search, which confirms one in ten, would stop mattering.** Nothing else in this design comes close.

2026-11-04 records that whole-page text of a restricted book is a policy grant: GreenC says few IA staff have it, and only the head librarian can grant it. The request is stronger when it is narrow and measured:

- For item X and page N, cited on a Wikipedia article, the text of pages N−1 to N+1, sent to a Toolforge tool.
- Shown to the editor: at most the verified quote, plus the link to borrow the book. Nothing stored beyond the verdict.
- Rate-limited, with the volume estimated from this doc: about one claim in eleven on enwiki.
- What it buys the Archive: every check sends the editor to the borrow page. Phase 1's links do that anyway.

Build `fetchBookPages()` so that a grant changes where the pages come from and nothing else.

## Validation

`benchmark/dataset_books.json` is a separate file, like `dataset_wice.json` and `dataset_lead.json`. It holds ~120 book claims from articles like the sample: 40 with readable copies, 40 search-only, 40 with no copy. Each is labelled by reading the cited page, either the open copy or the lending copy borrowed with a free account. Then measure:

- **Matching:** the share of copies that are the cited book, and the cited edition (spot-check 50). A wrong book is the worst error here.
- **Pages:** whether `/ia/pages` returned the cited page, and whether verdict accuracy matches that for web sources.
- **Search:** the precision of SUPPORTED-from-search (target ≥95%, since it clears a citation an editor would otherwise check), the share confirmed, and how many genuine failures "not a verdict" hides.
- **In use:** editor ratings split by `evidence`, once the log carries it.

## Phases

0. **Stop reading catalogue pages as sources.** Archive.org book links and WorldCat/OL-only links go to the book path, or, until it exists, to "no readable text" with the link. This affects 2.9% of enwiki claims.
1. **Find the copy and show the link** for every book citation, with the InternetArchiveBot edit offered. No model call. Expected: a link an editor can use for ~26% of book claims.
2. **Pages for readable copies**, with the tf-source-fetcher route.
3. **Search for lending and print-disabled copies**: SUPPORTED with a quote and the anchor guard, otherwise the link.
4. **Leads** from 2026-11-04 on search results: a name the book never mentions, a contradiction in a passage. Names are absent in 22% of claims here, so rule 1 will fire often; check its precision before it is shown.
5. **If the Archive agrees**, lending pages go through phase 2's path.

## Not in this design

- **Russian-language and other non-English books.** They are not on the Archive (3 of 537 ruwiki claims). Other libraries are a separate design.
- **Plain-text references without a template** (4.3% of enwiki claims). An ISBN in them is picked up; parsing the rest (Citoid, or a model) can come later.
- **Journals without links** (0.5% here). The Archive's scholarly index is a separate piece of work.
- **Google Books links without an ISBN in the footnote.** These need the Google Books API, server-side. Later.
- **Other editions' pages.** A copy matched by title with a different year is searched, never paged. Mapping pages across editions is not attempted.
