# Fact Hunt: an app for anyone to catch and fix places where Wikipedia disagrees with its own sources

> **Status (2026-11-23):** In progress on branch `ccr-9be554df-3rlar1`. The card builder (`service/run-build-cards.js`, `service/cards/`) and the app (`fact-hunt/`) are built and tested, and the app runs locally on a hand-made sample. Not deployed, and the builder hasn't yet run on real findings. Named Fact Hunt on 2026-11-24 (see *Open questions*, 1). Where the build differs from this design: see *As built*, at the end.

## Why

Three goals:

1. **More problems fixed.** The batch pipeline stores every finding in ToolsDB, but a finding is only seen by someone reading a batch CSV, or, later, by an editor in Edit Suggestions.
2. **Experience building for people who aren't editors.**
3. **A way into editing** for the kind of person who wants to fix things.

The userscript and Edit Suggestions reach people who already edit. This app is for people who don't: someone who opens a link on Bluesky or X, on a phone.

## What it is

Pick a topic. See a sentence from a Wikipedia article next to the passage from its cited source that contradicts it. Tap the words that are wrong. Fix it on Wikipedia, or ask the article's editors. Share the before and after.

Every card is a real finding from the batch pipeline. The app calls no model while anyone is using it.

## Decisions already made

These were settled while scoping this app, so they are recorded here rather than argued again:

- **Inaccuracies are the headline, not missing citations.** Finding sources is the ground of Citation Hunt and CNfirmed. It becomes a later path and a collaboration (see *Phases*).
- **No labeling phase before launch.** The check before a fix is part of the game (the tap, below), not a separate task.
- **Edits happen in Wikipedia's own editor, reached by a link.** There is no OAuth and no account in the app. One-click edits through OAuth are a later option, if the handoff to the editor turns out to be where people give up.
- **Only cheap guardrails** (listed under *Guardrails*), none that need anyone's permission first.
- **Sharing to Bluesky and X ships on day one.**

## The experience

### Principles

1. **One tap to the first card.** No sign-up and no tutorial screen: choosing a topic starts the first card.
2. **One decision per screen.**
3. **The core moment is a discovery**: you catch an article disagreeing with its own source. It should feel like one.
4. **Real stakes in real numbers**: how many people read the article each month (Pageviews API).
5. **Progress that is finite and visible**: each topic shows how many cards are left.
6. **No points, levels, streaks or leaderboards.** Rewarding volume rewards rushed edits, and rushed edits are what would get the app's edits mass-reverted. Each person gets a local tally of what they caught and fixed, and that's all.

### Screens

| Screen | Holds | Leads to |
|---|---|---|
| **Home** | Wordmark; one line ("Wikipedia articles sometimes say things their own sources don't"); topic chips with open counts; *Surprise me*; a total of fixes so far; the latest fix | A topic starts a card |
| **Card** | *Wikipedia says*: the sentence. *Its source says*: the verified quote, the publication and date, and *Read it in the source*. The instruction "Tap the words the source contradicts". *They say the same thing*. *Skip* | Tap → Caught |
| **Caught** | The tapped words get a red wavy underline and the quote's words a highlighter. "Wikipedia says 1999. Its source says 1998." The article's monthly readers. One line: sources can be wrong too | *Fix it on Wikipedia*, *Ask the article's editors*, *Next*, *Share this puzzle* |
| **Fix** | Three steps: *Find* (a snippet to search for), *Change* (old → new, which the person types), *Publish* (the summary is filled in, with a Copy button). A tip to log in or create an account | *Open Wikipedia's editor* (new tab) |
| **Fixed** | Detected when the person comes back. Before and after, the reader count, share buttons, the local tally | *Next* |

*Read it in the source* is a text-fragment link (`#:~:text=`), so the source page opens with the quote highlighted. Current Chrome, Safari and Firefox support it; where a browser doesn't, or the source is a PDF, it just opens the page.

### The tap, rather than a yes/no button

The card never marks the conflict before the person answers. They read both texts and tap the words in Wikipedia's sentence that the source contradicts. This works better than a yes/no button on two counts:

- **It's more fun.** It's spot-the-difference, and finding it yourself is the point of the moment.
- **It's a stronger check.** A yes/no button invites agreeing with whatever the app suggests. Finding the wrong words without being shown them is independent evidence that the finding is real. That matters, because this check is the only one before an edit.

Matching rule: a tap counts when it lands on the flagged words or one word either side. On a miss, the app shows what was flagged and asks "Is this wrong?": *yes* counts as caught, *no* as "they say the same thing". To keep the answer out of the page, the API sends the conflict spans only after an answer is recorded.

**Warm-up.** A new visitor's first card is one that has already been fixed, labelled as a warm-up. It teaches the tap with nothing at stake. At launch, these come from the 30 cards the owner plays first (*Phases*, step 0).

### Look

- **The spellchecker's red wavy underline is the signature.** It marks the error on a card, underlines the wordmark and appears on the share image. Fixed text gets a straight underline: the squiggle, straightened out.
- Ink on white, with one red for the error and one highlighter yellow for the source's evidence. Buttons are black. The two quoted texts are set in a serif, because they are documents. Everything else is sans.
- No Wikipedia logo, globe or typeface: that's for trademark reasons, and so the app doesn't look official.
- Dark mode is built from tokens, the way `main.js` does it. Motion respects reduced-motion settings. Tap targets are at least 44 px, and the sentence's words are real buttons, reachable by keyboard and screen reader.

### Copy

- Plain words only: never "citation", "claim", "verifiability" or "reference".
- The two labels are *Wikipedia says* and *Its source says*.
- The app says an article **"disagrees with its own source"**, never "Wikipedia is wrong". That's what the check shows, and it stays true when the source is the one that's wrong.
- Strings go through a `t()` table from day one, as in `main.js`. English ships first.

## Sharing (day one)

| Share | Offered | Post text (editable before posting) | Link preview | The link opens |
|---|---|---|---|---|
| **The fix** | Fixed screen | "Wikipedia said CZW was founded in 1999. Its own source said 1998. I fixed it. Find one yourself: ‹link›" | Before and after | The fix page: before and after, and *Find one yourself* |
| **A puzzle** | Caught screen, only for a card this person caught and nobody has fixed yet | "This Wikipedia sentence disagrees with its own source. Can you spot where? ‹link›" | The sentence only, with no answer | That card, as a puzzle |
| **A topic** | Topic header | "There are ‹n› places where Wikipedia's sports articles disagree with their own sources. Help fix them: ‹link›" | Topic and count | That topic's cards |

**The puzzle share is the one most likely to spread.** The person who opens it has something to do within ten seconds. And everyone who taps the same words adds another independent check of the finding. If the card was fixed before they arrive, they see the before and after instead.

How it works:

- **On phones**, the Web Share API, which reaches every app the person has.
- **On desktop**, plain links to Bluesky (`bsky.app/intent/compose?text=`: one text field, 300 graphemes including the link), X's [web intent](https://docs.x.com/x-for-websites/post-button/guides/web-intent), and Mastodon (the app asks for the person's server once and remembers it), plus *Copy link*.
- **No share widgets or third-party scripts.** Toolforge restricts making visitors' browsers load third-party resources without consent (the Cloud Services cross-site policy), and widgets track people. A plain link is something the person chooses to follow.
- **Link previews are what make a share work.** Each fix, puzzle and topic page carries Open Graph tags and a 1200×630 image rendered on the server.
- **Posts and fix pages link to the article, not the diff.** A diff names the account that made it. On wikis with temporary accounts that is no longer an IP address (enwiki's rollout was announced for November 2025), but it still ties a social media account to a Wikipedia edit history, and doing that should be the person's choice. They can add the diff themselves.
- A share link carries a random share id, used only to count visits per share.

## Where cards come from

### Selection: one filter on existing ToolsDB columns

```sql
SELECT ... FROM citation_findings
WHERE wiki = 'enwiki'
  AND check_kind = 'citation'
  AND verdict = 'NOT SUPPORTED' AND reason_type = 'contradiction'
  AND quote_status IN ('exact', 'normalized')
  AND source_truncated = 0
  AND is_collective = 0
  AND lead_demoted = 0
```

**Only contradictions with a verified quote**, because that's the only kind of finding someone who isn't an editor can check in a minute: two sentences and one difference. An omission means reading the whole source, and omissions are where truncated fetches produce false flags. A verified quote means every word on the card is in the source (`core/quote.js`).

Then each article is fetched once at its current revision, plus one API call for its protection, and that settles five things:

- **Is the sentence still there?** If not, the card is never made.
- **Can a new editor publish there?** Any edit protection (semi, extended-confirmed or full) or pending changes leaves the article out. Someone logged out, or with a new account, either can't publish there, or their edit waits for review where the app can't see it. Protection comes from `prop=info&inprop=protection`, and pending changes from `prop=flagged`. Talk pages are rarely protected, so these articles could come back later as cards with only *Ask the article's editors*.
- **Is it a biography of a living person** (`Category:Living people`)? Those are left out at launch, as is the Medicine & Health topic.
- **Which section is it in?** The edit link needs the section number.
- **Is the quote in the wiki's language?** At launch, enwiki cards need English sources.

A second supply, for later: PARTIALLY SUPPORTED findings where the severity pass found a `contradicted` subclaim. Today those exist only in the CSV.

### Enrichment: new, and small

| Field | How it is made | Cost |
|---|---|---|
| **Conflict spans**: the words in the sentence and in the quote that disagree | One model call per candidate, through the LLM Router. Both spans must be found verbatim (with `core/quote.js` normalization), or the card is dropped. The same call answers whether both statements could be true at once (see *A difference is not always an error*). Its own prompt with a hash-pinned version, like the repo's other prompts | One call per card, once |
| **Find text** | The shortest snippet around the flagged words that occurs exactly once in both the section's wikitext and its rendered text. That way, searching the editor for it always works, links and templates included | One wikitext fetch per article |
| **Topics** | Lift Wing's `outlink-topic-model` (64 WikiProject topics). It is language-agnostic, so ruwiki works too. Called one request at a time, because its model card warns against parallel requests | One call per article, cached |
| **Monthly readers** | Pageviews API | One call per article |
| **Source label** | The publication and date, from the stored citation text | Free |

**The model points at words and never writes the fix.** The rule from the source-quote design, that every character shown came from the source, extends to the highlights. And no text written by a model is ever offered as an edit. The uncited-text check has the same rule for a different reason. Here it is so that the edit is the person's own, which is also what makes it defensible to editors wary of LLM-written content.

### A difference is not always an error

The tap checks *where* the two texts differ. It can't check whether the difference means the article is wrong. On 15 real contradiction rows from the benchmark (people had labeled the claim unsupported, and the model's comment described a contradiction), people would have known what to tap on 12. But "make it match the source" was the right fix on only 4:

| Kind | Rows | Why the fix would fail |
|---|---|---|
| **The right fix** | 186 Combat Zone Wrestling (1999 / 1998), 112 Aida Turturro (2013 / 2011), 11 Immigration to the US (6% / 5%), 71 Tamil Tigers (April 1984 / March 1985) | It wouldn't |
| **A number that changes over time** | 104 Rax Roast Beef, 162 OneNote, 168 California's 55th district, 102 Ohio University, 185 Graham Craig | The source is older than the article, a different year, or (row 168) about a different area. "More than 500M downloads" is still true at 1B+ |
| **Not a contradiction** | 177 Final Fantasy, 75 First Chechen War, 109 Wes Olson, 99 Latin music | One year's award winners can't refute a career total. 50,000–100,000 sits inside 40,000–120,000. A 2016 book says nothing about a first book. "Hit the mainstream" is a different claim |
| **Thin source** | 10, 188 | The source is a headline, or the passage isn't there |

So the card builder keeps a card only when **both statements can't be true at once**. The conflict-span call asks: "Could both be true at a different time, place, scope or edition?" Only a *no* makes a card. On these 15 rows, that keeps exactly the four right fixes. Claims with "as of" or "currently" are left out at launch, whatever the answer. With both rules, "where do they differ?" and "what's wrong?" become the same question, and the tap stays honest.

The judgments above were made from the stored text, on benchmark rows rather than the batch's card filter. The owner's 30-card play-through (*Phases*, step 0) is the real test of how many cards survive.

An *Update it* card could come later: for a number that changes over time, where the source is newer than the article's "as of" date.

Launch topics are friendly groups of the model's labels: Sports, Film & TV, Music, Books, Video games, Food & drink, History (with Military and warfare), Politics, Business, Science, Technology and Places. A topic goes live only once it has enough cards (see *Is there enough?*).

### Freshness

Findings are computed at a pinned revision, often weeks before anyone sees the card. A card showing an error someone already fixed wastes the visitor's time and makes the app look broken. So a daily job re-checks every open card against the current revision and the article's protection, which is often added in the middle of a dispute. The app checks once more, with one API call, when a card is opened.

### Is there enough?

Nobody knows yet, and one query will tell. A topic with three cards is a dead end, so a topic launches only if it has enough.

If enwiki is thin, run batches for the app itself, picking each topic's most-read articles. A fix there reaches more readers and makes a better share. That's a different selection from the Edit Suggestions batches, which pick articles for future editing activity (`2026-09-16-selecting-for-future-activity.md`). This app is a different consumer.

## The fix

### Handoff

- The link is `index.php?title=‹T›&action=edit&section=‹N›&summary=‹…›`, opened in a new tab.
- **`summary=` is documented for the wikitext editor only.** Whether VisualEditor and the mobile editor keep it is unverified. So the Fix screen also shows the summary with a Copy button, and tracking never depends on it.
- **The summary quotes the source:**
  `Corrected to match the cited source (DeRiemer 2022, Last Word on Pro Wrestling): "way back in 1998" #facthunt ([[User:Alaexis/Fact Hunt|what is this?]])`.
  An unexplained change to a number or date from a new or logged-out account looks exactly like sneaky vandalism, and patrollers revert it on sight. With the source's words in the summary, a patroller can check the change without clicking anything. The summary has a 500-character limit.
- **`#facthunt` makes every edit findable.** The Hashtags tool (`hashtags.wmcloud.org`) indexes hashtags in edit summaries, which is how #1Lib1Ref is tracked, so anyone can list every edit the app led to.
- **A tip to log in or create an account** (`Special:CreateAccount?returnto=‹article›`). The Growth team may be able to count account creations by a `campaign` value; that's an open question.
- **On a phone, editing is the hardest step.** The find text, and *Ask the article's editors* as an easier alternative, are the mitigation. Handoff completion is measured separately for phones and desktops (by viewport, with no user agent stored).

### Knowing it worked

When the person comes back to the tab, the server lists the page's revisions since the handoff. If the flagged words are gone from the sentence, the card counts as fixed. If nothing has changed yet, the app says "We don't see your edit yet" and offers two answers. *I published it* keeps checking for a minute, because of replication lag. *I didn't* goes back to the card. The daily job catches people who never come back.

A card counts as fixed when the sentence changed after the handoff, whoever changed it. The app never learns the person's username, and doesn't need to.

**Reverts.** MediaWiki tags a reverted edit `mw-reverted`. The daily job checks each fix's revision for that tag for 7 days. A reverted fix closes its card as *disputed*, and the card is never shown again.

### Ask the article's editors: the honest exit

An article disagreeing with its source doesn't say which of the two is wrong. Benchmark row_104 (Rax Roast Beef) shows it. The source lists five restaurants and the article says six, but the article's previous sentence reports a sixth that opened in 2022. "Make the article match its source" would have undone a correct update.

So the Caught screen always offers a second path. It opens a new section on the article's talk page (`action=edit&section=new&preloadtitle=…`, with the body preloaded from a template page through `preloadparams[]`). The note holds both quotes and the source, asks which is right, and is signed by the person. Check that `preloadparams[]` works with `section=new` before relying on it. The fallback is the same as for the summary: the text with a Copy button.

Once a note is posted, the card closes as *asked*. The freshness job retires it when the sentence changes.

**Holds.** Opening the editor or the talk page from a card holds that card for 20 minutes, so two people don't fix the same sentence.

## Guardrails

All of these are cheap:

1. **The selection filter**: contradictions only, where both statements can't be true at once. Verified quotes and whole sources only. No protected articles, no BLPs, no medicine, and no "as of" claims at launch.
2. **The tap**: *Fix it* appears only after the person has found the wrong words themselves.
3. **Freshness**: every card is re-checked against the current revision before it is shown.
4. **The summary** quotes the source and carries the hashtag.
5. **A project page** (`User:Alaexis/Fact Hunt`), linked from every summary. It says what the app is, that a person made each call, how to report a problem, and how to list every app edit (a Hashtags link).
6. **A heads-up at launch** on the village pump: "here's a thing, here's the page, tell me if it causes problems". It's an announcement, not a request for permission.
7. **A stop rule, fixed before launch** in the spirit of `GATE` in `feedback-loop/proposer.js`. If more than 1 in 5 of the first 50 fixes is reverted within 7 days, *Fix it* is switched off until the cause is understood, and *Ask the article's editors* stays on. After that it is measured again for every 50 fixes. Like `GATE`, it is never loosened to let a run through.
8. **Two "they say the same thing" answers retire a card.** The answers are kept, and can be exported to the benchmark or the feedback loop as labels, but nobody is ever asked to label.
9. **The owner plays the first 30 cards** before anyone else sees one.

## Architecture

- **A new Toolforge tool, `fact-hunt`** (`fact-hunt.toolforge.org`). It is a Node webservice serving one static page, a small JSON API, the share pages and their preview images.
- **The card builder** is a daily job in this repo (`service/run-build-cards.js`), next to the batch it reads. It uses `service/toolsdb.js`, the LLM Router and `core/quote.js`. It writes cards to a ToolsDB database whose name ends in `_p`, which every tool can read. Cards hold nothing private, only article text and a public source's words. The answers live in the app tool's own private database.
- **No model calls in the app**: no API keys, no cost per visitor, the same card for everyone.
- **The frontend is one page.** No third-party resources: fonts are self-hosted, and there are no analytics. `localStorage` keeps the chosen topic and the tally, and a random session id ties answers together. Every `localStorage` access is wrapped in a try/catch.
- **Code**: the app in a new repo, as with `citation-checker`; the card builder here, in `service/`.

### Data

**cards**:
- **Identity**: `id` (short and URL-safe), `wiki`, `page_id`, `page_title`, `revision_id`, `section_title`.
- **What the card shows**: `claim_text`, `claim_span`, `find_text`, `source_quote`, `quote_span`, `source_url`, `source_label`, `topics`, `monthly_views`.
- **State**: `status` (`open` | `held` | `fixed` | `asked` | `dismissed` | `disputed` | `gone`), the counts `caught`, `same` and `skipped`, `fix_rev_id`, and the two timestamps.
- **Link back to the finding**: `claim_hash`, `source_url_hash`, `provider`, `prompt_version`.

**answers**: `card_id`, `session` (random), `kind` (`caught` | `miss` | `same` | `skip` | `fix_opened` | `ask_opened` | `shared`), `at`. Nothing else: no IP address and no user agent.

### API

| Route | Does |
|---|---|
| `GET /api/next?topic=…` | The next open card for this session in a topic, without its spans |
| `POST /api/answer` | Records an answer and returns the spans |
| `POST /api/hold` | Holds a card for an editor or talk-page handoff |
| `GET /api/check/:id` | Has the sentence changed since the hold? |
| `GET /c/:id`, `/f/:id`, `/t/:topic` | Puzzle, fix and topic pages, with Open Graph tags |
| `GET /og/…png` | The preview images |
| `GET /api/stats` | The counters on the home screen |

## Measuring it

The funnel, per visitor: landed → first card → first tap → caught → editor opened → fix detected → kept for 7 days → shared → visits per share → visitors who then catch one.

What decides whether it's working:

| Measure | Why |
|---|---|
| **Kept fixes**: the share of fixes not reverted within 7 days | The stop rule. Whether the app's edits are good for Wikipedia |
| **Catch agreement**: the share of taps that land on the flagged words | A running estimate of how precise the filter is |
| **Shares per fix**, and **catches per shared link** | Whether sharing brings people in |
| **Second visits**; for detected fixes, whether the account goes on editing outside the app (aggregate only) | The "new editors" goal |

## Phases

| Step | What | Done when |
|---|---|---|
| 0 | Count the cards per topic (one query). Build the card builder. The owner plays 30 cards | The subset's precision, and the topics with enough cards, are known |
| 1 | The app: home, card, caught, fix, fixed, ask the editors. The fix and topic shares, link previews, counters | It works end to end on one wiki |
| 2 | Soft launch: the project page, the hashtag, the heads-up post. Shared with the volunteers from the 2026-09-14 call and on the owner's own Bluesky | 50 fixes, measured against the stop rule |
| 3 | The puzzle share, if it didn't ship in step 1. A second wiki. A daily-catch account on Bluesky, posting cards that someone caught and nobody fixed. One-click fixes through OAuth, if the handoff is where people give up. *Find a better source*, with CNfirmed and Citation Hunt. PARTIALLY SUPPORTED contradictions from the severity pass | — |

## Left out of the first version, on purpose

- Accounts, points, leaderboards, streaks, notifications.
- Model calls while anyone is using the app.
- Omissions, truncated sources, group findings, BLPs, medicine, sources in another language.
- Protected articles, and articles under pending changes. They could come back as cards with only *Ask the article's editors*.
- Claims with "as of" or "currently", and other numbers that change over time.
- Edits through OAuth.

## Open questions

1. **The name: settled as Fact Hunt** (2026-11-24), in Citation Hunt's pattern, with "find and fix inaccuracies on Wikipedia" as the tagline. "Inaccuracies" was the working name. Fact Hunt was also a 2005 ITV comedy quiz (one series, Al Murray as the Pub Landlord), with no active brand; Error Hunt was the alternative if that mattered. The name can't contain "Wikipedia" (the Foundation's trademark policy). Citation Hunt's maintainers are to be told, on their talk page.
2. **The launch wiki.** enwiki, for reach on Bluesky and X, or ruwiki, where most findings and an engaged volunteer group already are.
3. **The puzzle share**: at launch, or a week after.
4. **Editors.** Which editor the link should open on phones, and which editors keep `summary=` and the talk-page preload.
5. **Growth team**: can they count account creations by a `campaign` value?
6. **Citation Hunt**: cross-links, a shared audience (#1Lib1Ref), or more.

## Alternatives considered

| Alternative | Why not, for now |
|---|---|
| Labeling first, fixing later | Safer, but slower, and few people want to label. The tap replaces it |
| OAuth edits from day one | One click and a free tag, but it needs Meta approval, a way to map the sentence to wikitext, and an account. Deferred to step 3 |
| Finding sources as the headline | Citation Hunt and CNfirmed already do this, and it's less of a hook. It's a later path |
| Live checks ("paste any article") | That's the `citation-checker` web tool. It would cost a model call per visitor and show findings nobody had filtered |
| A custom domain off Toolforge | A nicer link, but it loses direct ToolsDB access and the signal that it's hosted by Wikimedia |

## As built (2026-11-23)

Where the first build differs from the design above, and why:

- **Cards are handed over as a JSON file** (`CARDS_FILE`), not a `_p` ToolsDB table. A file is the simplest thing both sides can test. How the app tool gets the file on Toolforge is the open deployment question in `fact-hunt/README.md`.
- **Answers and fixes are an append-only event log** (`EVENTS_FILE`, JSON lines), not a ToolsDB table. The app is one process, so a log needs no database. And every count can be recomputed by replaying it, so a wrong rule is fixed without patching data.
- **The source label is the site's host name** (an archive snapshot is labelled by the site it archived), not the publication and date. Neither ToolsDB nor the batch CSV stores the citation text.
- **Talk-page notes aren't hashtag-tracked.** On `section=new`, MediaWiki makes the edit summary from the heading, so the hashtag can't ride along. The app records a note when the person says they posted it.
- **Readers, topics and model decisions are cached in the cards file.** Each rebuild re-reads every article: that is the freshness check. It calls the model only for a finding it hasn't seen under the current `CONFLICT_PROMPT_VERSION`.
- **The search text has at least three words**, preferring the words before the flagged ones ("founded in 1999" rather than "1999 by"), because it reads as a phrase.
- **A warm-up card comes from the chosen topic** when one has been fixed, and otherwise from any topic.
- **Two smaller departures:** fix detection is `POST /api/check`, and the home screen's counters come with `GET /api/topics` rather than a separate `/api/stats`.
