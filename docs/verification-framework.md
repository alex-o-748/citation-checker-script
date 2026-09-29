# Citation verification framework

This page sets out the definitions the Citation Verifier works to: what counts
as a **claim**, what counts as a **source**, and what each **verdict** means.
The same definitions apply to the Wikipedia user script, the command-line tool,
the batch pipeline and the benchmark. The human-labeled benchmark data is judged
against them too.

The tool answers one question per citation: **does the cited source, as
retrieved, support the text the citation is attached to?** It does not ask
whether the claim is true, whether the source is reliable, or whether a better
source exists. Those are editorial judgements and are left to editors.

---

## 1. Claims

### Definition

A **claim** is the article text that a citation is attached to. It is the text
immediately *before* the citation marker, going back to the previous citation
in the same paragraph, list item or table cell. If there is no earlier citation
there, the claim goes back to the start of the paragraph, list item or cell.

> Sentence one.[1] Sentence two. Sentence three.[2]
>
> The claim for [2] is "Sentence two. Sentence three." The claim for [1] is
> "Sentence one."

This "between citations" rule follows how editors actually cite. A citation
covers the text since the last citation, so a claim can be longer than one
sentence.

### Rules

- **A claim is only ever text before its citation.** Text after the marker is
  never included, even when the text before it is very short.
- **Citations with no text between them share a claim.** In `…in 1998.[3][4]`,
  both [3] and [4] cite the same claim. See [Multiple sources](#multiple-sources-for-one-claim).
- **Clean-up.** Footnote numbers such as `[5]` and inline maintenance tags such
  as `[citation needed]`, `[failed verification]` and `[dubious]` are removed.
  Whitespace is normalized.
- **Too short to check.** A claim under 10 characters, such as a bare name at
  the start of a list item, is not a checkable statement. The citation gets
  **Skipped** and no verdict. It is not widened to take in surrounding text.

### Claim scope

There are two scopes:

| Scope | Claim is | Used by |
|---|---|---|
| **Paragraph** (default) | The whole between-citations span, which can be several sentences | Interactive user script, CLI, benchmark |
| **Sentence** | Only the last sentence of that span | Batch pipeline; optional in the user script's settings |

Sentence scope exists because of how a multi-sentence claim can mislead. The
first sentence may be uncited (a "citation needed" problem), while the cited
sentence is fine. Judging the whole span would report the citation as
**Not supported** when the source is actually doing its job. An editor reading
the claim notices this, but an unattended batch run does not.

### Example

> R. Sankar[9] – former Chief Minister of Kerala.

The text before [9] is "R. Sankar", which is 9 characters. The citation is
**Skipped** (claim too short). The rest of the line comes after the marker, so
it is not used.

---

## 2. Sources

### Definition

A **source** is the document a citation points to, as the tool retrieves it.
The tool reads the citation's reference entry and picks a link:

1. If the entry has an Internet Archive (Wayback Machine) link, that copy is
   used. It is the version the citation was archived at, and it is fetched
   without the archive's toolbar.
2. Otherwise the live URL is used. If the live page can't be retrieved, the tool
   looks for a Wayback Machine snapshot of the same URL and uses that instead.

Links to Wikipedia's own pages, such as ISBN lookups and `Special:BookSources`,
are never treated as the source. If the citation gives a page number and the
source is a PDF, that page is extracted.

Citations with no link, such as offline books, can still be checked. The editor
pastes the relevant source text or uploads a PDF.

### Usable and unusable sources

The retrieved text is **usable** if it contains actual content from the cited
work:

- article text from any website, including Internet Archive snapshots
- news articles, blog posts and press releases
- real content surrounded by navigation, headers, footers or archive framing

It is **unusable** if it contains no content from the work itself:

- library catalogues, database records or book metadata (WorldCat, Google Books
  and JSTOR preview pages), including archived copies of them
- paywalls, login pages and "access denied" messages
- cookie notices, bot checks and JavaScript errors
- 404 pages and redirect notices
- bibliographic details with none of the cited content

Page clutter does not make a source unusable. If real paragraphs are present
along with menus and ads, the source is usable. An unusable source produces
**Source unavailable**, not a judgement about the claim.

### Truncated sources

Very long sources are cut off at a length limit (about 12,000 characters from
the fetching proxy). The verdict is based only on the part retrieved. If the
supporting passage comes after the cut-off, the tool can report a claim as
unsupported when the full source does support it. Truncated sources are flagged
so that this can be taken into account.

### Multiple sources for one claim

When several citations sit side by side on one claim (`…in 1998.[3][4][5]`),
each source is first checked on its own. The sources are then judged together
in a **collective** check:

- The claim is **Supported** if the sources *together* support it. No single
  source has to cover everything, and one may support one part while another
  supports a different part.
- Unusable sources in the group are ignored. The collective verdict is
  **Source unavailable** only if *none* of the sources is usable.
- If at most one source in the group is usable, the collective check is skipped
  because it would only repeat that source's own verdict.

---

## 3. Verdicts

Each check returns one of four verdicts, a **support score** from 0 to 100, a
short explanation, and where possible a quotation from the source.

| Verdict | Score | Meaning |
|---|---|---|
| **Supported** | 80–100 | The source states the claim, directly or through plain paraphrase or straightforward implication. |
| **Partially supported** | 50–79 | The source backs some of the claim but not all of it, or hedges something the claim states as fact. |
| **Not supported** | 1–49 | The source contradicts the claim, or does not address it. |
| **Source unavailable** | 0 | The retrieved text is not usable (see [above](#usable-and-unusable-sources)). No judgement is made about the claim. |

### Judging rules

1. **Only the source counts.** Outside knowledge is never used. A true claim
   cited to a source that doesn't say it is **Not supported**.
2. **Paraphrase and plain implication are accepted.** Speculative inference and
   logical leaps are not.
3. **Certainty must match.** A claim stated as fact needs a source that states
   it as fact. If the source says "it is believed" or "some historians
   dispute", that is at most **Partially supported**.
4. **Transliteration is not an error.** Different romanizations of the same name
   ("Chekhov" and "Tchekhov") are treated as the same name.
5. **Contradiction outranks partial support.** If the source says something
   incompatible with the claim, such as a different date, number or place, the
   verdict is **Not supported**. This applies even if the rest of the claim
   checks out. (But see [Open question](#5-open-question).)

### Reason type for Not supported

A **Not supported** verdict gives one of two reasons:

| Reason | Meaning |
|---|---|
| **Contradiction** | The source says something incompatible with the claim. |
| **Omission** | The source does not mention or address the claim. |

If both apply (one part is contradicted and another is missing), the reason is
**contradiction**.

### Examples

These are the worked examples the model is given, followed by real cases from
the benchmark.

**Supported**

> **Claim:** The company was founded in 1985 by John Smith.
> **Source:** "Acme Corp was established in 1985. Its founder, John Smith,
> served as CEO until 2001."
> **Verdict:** Supported (95). It's a definitive match, with paraphrase.

**Partially supported: hedged source**

> **Claim:** The treaty was signed in Paris.
> **Source:** "It is believed the treaty was signed in Paris, though some
> historians dispute this."
> **Verdict:** Partially supported (60). The source presents this as uncertain,
> but Wikipedia states it as fact.

**Partially supported: part of the claim is missing**

> **Claim:** The population increased by 12% between 2010 and 2020.
> **Source:** "Census data shows significant population growth in the region
> during the 2010s."
> **Verdict:** Partially supported (55). The source confirms growth but doesn't
> give the 12% figure.

**Not supported: contradiction**

> **Claim:** The treaty was signed by 45 countries.
> **Source:** "The treaty, finalized in March, was signed by over 30 nations,
> though the exact number remains disputed."
> **Verdict:** Not supported, contradiction (20). The source says "over 30",
> not 45.

> **Claim:** The bridge was completed in 1998.
> **Source (Internet Archive capture):** "…The bridge was finally opened to
> traffic in August 2002, four years behind schedule…"
> **Verdict:** Not supported, contradiction (15). The archive framing doesn't
> make the source unusable, and the article inside it gives a different year.

**Not supported: omission**

> **Claim:** She received the Nobel Prize in Chemistry in 2015.
> **Source:** A faculty profile covering her PhD, appointments, research and
> teaching awards.
> **Verdict:** Not supported, omission (10). The source covers her career but
> never mentions a Nobel Prize.

**Source unavailable**

> **Claim:** The committee published its findings in 1932.
> **Source:** "History of Modern Economics – Google Books  Sign in … My library
> Help Advanced Book Search … Get this book in print …"
> **Verdict:** Source unavailable (0). The page is the Google Books interface
> with no book content.

**Collective: sources together support the claim**

> **Claim:** The company was founded in 1985 by John Smith, who led it until 2001.
> **Source A:** "Acme Corp was established in 1985 in Ohio."
> **Source B:** "John Smith founded Acme Corp and served as its chief executive
> until 2001."
> **Verdict:** Supported (92). A gives the year, and B gives the founder and his
> tenure.

#### Real benchmark cases

| Article | Claim (abridged) | Source says | Verdict |
|---|---|---|---|
| Immigration to the United States | Fewer than one million immigrants moved to the United States from Europe between 1600 and 1799 | *"Historians estimate that well under a million immigrants—perhaps as few as 400,000—crossed the Atlantic during those two centuries."* | Supported |
| Gary Graffman | In 1985 he gave the UK premiere of Korngold's Left Hand concerto; Wittgenstein had commissioned it in the 1920s and played it many times, but it later slipped from the repertoire | *"Wittgenstein commissioned the concerto in 1923 … at its UK premiere in 1985 was called a keyboard Salome by the soloist Gary Graffman."* The core is there, but "played it many times" and "slipped from the repertoire" are absent | Partially supported |
| Fall of Aden (2026) | Government forces captured Aden, "resulting in the STC's reported dissolution and the collapse of the group's forces" | Same-day report: *"Some officials from the STC, however, said the group is still in control of Aden."* Dissolution and collapse are not mentioned | Partially supported |
| Ohio University | Classified "R1: Doctoral Universities – Very high research activity" | *"Doctoral Universities: High Research Activity"*, which is one tier lower | Not supported (contradiction) |
| Liberation Tigers of Tamil Eelam | The ENLF formed in April 1984, a union of five groups including PLOTE | *"In March 1985, the LTTE, EPRLF, TELO, and EROS formed … the ENLF. PLOTE … remained outside the coalition."* | Not supported (contradiction) |
| UC Colorado Springs | Recognized as a "Military Friendly® School" for its support of veterans | Neither "Military Friendly" nor "veteran" appears in the source | Not supported (omission) |
| Immigration to the United States | The Emergency Quota Act of 1921 limited immigration by national quotas of 3 percent… (cited to a Seattle Times archive) | About 3,000 characters of Wayback Machine navigation and a redirect notice, with no article | Source unavailable |

---

## 4. Evidence quotes

Along with a verdict, the tool asks for a **source quote**: the passage that
decides the verdict, copied word for word. For Supported and Partially
supported, it is the passage that supports the claim. For a contradiction, it is
the passage that conflicts with it. Omission and Source unavailable have nothing
to quote.

**The quote is checked against the source before it is shown.** Differences in
case, quote marks, dashes, hyphenation and whitespace are ignored, but the
matching is not fuzzy. A quote that can't be found in the source is not
displayed, so every character shown in the evidence box comes from the source.
A missing quote does not make the verdict weaker. It only means there is
nothing to show.

---

## 5. Open question

**When a source contradicts one detail but supports the rest of the claim, is
the verdict Partially supported or Not supported?**

The tool currently says **Not supported** (rule 5 above). A wrong date or number
is the kind of error an editor needs to fix, whatever else the source confirms.
Part of the human-labeled data follows the other convention and calls the same
case **Partially supported**. The benchmark has cases of this kind labeled both
ways. Until this is decided, disagreements between these two verdicts on
contradiction cases should be read as a difference in rubric, not as a model
error.

---

## 6. How verdicts are scored

This section is for readers of the benchmark reports.

- **The positive class is a failing citation.** That means any ground truth
  other than Supported: Partially supported, Not supported or Source
  unavailable. A "positive" is a citation an editor needs to act on.
  - **True positive rate:** of the citations that really fail, the share the
    tool flags.
  - **False positive rate:** of the citations that are really fine, the share
    the tool flags anyway.
- **Exact accuracy:** the verdict matches the label across all four classes.
- **Supported-vs-rest accuracy:** Supported must match exactly, but the three
  failing verdicts count as the same. This measures whether the tool gets the
  editor's question right: *does this citation need attention?*
- **Skipped** citations (claim too short) and pipeline errors are outcomes, not
  verdicts, and they are never scored.
