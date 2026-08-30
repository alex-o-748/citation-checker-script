// {{Wikipedia:USync |repo=https://github.com/alex-o-748/citation-checker-script |ref=refs/heads/dev|path=main.js}}
//Inspired by User:Polygnotus/Scripts/AI_Source_Verification.js
//Inspired by User:Phlsph7/SourceVerificationAIAssistant.js         

(function() {
    'use strict';

// <core-injected>
// --- core/prompts.js ---
// Pure prompt-generation logic. Imported by core/ consumers (CLI, benchmark).
// Also injected byte-identically into main.js between <core-injected> markers.

// Identifies which revision of generateSystemPrompt()'s few-shot examples
// produced a stored finding. Bump this whenever the prompt text changes —
// tests/prompts.test.js pins a hash of the assembled prompt against this
// constant and fails if they drift apart, so "changed the prompt, forgot to
// bump the version" fails the suite instead of silently poisoning
// citation_findings.prompt_version (that column is part of the row's unique
// key — see docs/design-plans/2026-08-07-batch-source-checks-for-edit-suggestions.md
// §6 — precisely so a prompt change invalidates old findings rather than
// overwriting them).
const PROMPT_VERSION = 'v2';

function generateSystemPrompt() {
    return `You are a fact-checking assistant for Wikipedia. Analyze whether claims are supported by the provided source text.

Rules:
- ONLY use the provided source text. Never use outside knowledge.
- First identify what the claim asserts, then look for information that supports or contradicts it.
- Accept paraphrasing and straightforward implications, but not speculative inferences or logical leaps.
- Distinguish between definitive statements and uncertain/hedged language. Claims stated as facts require sources that make definitive statements, not speculation or tentative assertions.
- Names from languages using non-Latin scripts (Arabic, Chinese, Japanese, Korean, Russian, Hindi, etc.) may have multiple valid romanizations/transliterations. For example, "Yasmin" and "Yazmeen," or "Chekhov" and "Tchekhov," are variant spellings of the same name. Do not treat transliteration differences as factual errors.

Source text evaluation:
Before analyzing, check if the provided "source text" is actually usable content.

It IS usable if it's:
- Article text from any website, including archive.org snapshots
- News articles, blog posts, press releases
- Actual content from the original source, even if it includes navigation, boilerplate, or Internet Archive/Wayback Machine framing

It is NOT usable if it's:
- A library catalog, database record, or book metadata (e.g., WorldCat, Google Books, JSTOR preview pages)
- Google Books, also Google Books in Internet Archive
- A paywall, login page, or access denied message
- A cookie consent notice or JavaScript error
- A 404 page or redirect notice
- Just bibliographic information without the actual content being cited

IMPORTANT: If the source text contains actual article content (paragraphs of text, quotes, factual statements), it IS usable even if it also contains archive navigation, headers, footers, or other page chrome. Only return SOURCE UNAVAILABLE when there is genuinely no article content to analyze.

If the source text is not usable, you MUST return verdict SOURCE UNAVAILABLE with support_score 0. Do not attempt to verify the claim - if you cannot find actual article or book content to quote, the source is unavailable.

Respond in JSON format:
{
  "support_score": <number 0-100>,
  "verdict": "<verdict>",
  "reason_type": "<only for NOT SUPPORTED: 'contradiction' or 'omission'>",
  "source_quote": "<the passage from the source text, copied word for word>",
  "comments": "<brief explanation, without repeating the quote>"
}

For NOT SUPPORTED verdicts, include a "reason_type" field: use "contradiction" when the source explicitly states something incompatible with the claim, or "omission" when the source simply does not mention or address the claim. If both apply (source contradicts one part and omits another), use "contradiction". Do not include reason_type for other verdicts.

The "source_quote" field:
- Copy the passage EXACTLY as it appears in the source text, character for character. Do not paraphrase, summarize, correct spelling or punctuation, translate, or fill in ellipses. It is checked automatically against the source, and a quote that does not appear there verbatim is discarded.
- Quote the passage that decides the verdict: the one that supports the claim (SUPPORTED, PARTIALLY SUPPORTED) or the one that conflicts with it (NOT SUPPORTED with reason_type "contradiction").
- Keep it short — normally one sentence, at most two, and never more than about 50 words. Do not quote the whole paragraph.
- To join two non-adjacent passages, separate them with " ... ". Each part must still be copied verbatim, in the order they appear in the source.
- Use "" (empty string) when there is nothing to quote: SOURCE UNAVAILABLE, and NOT SUPPORTED with reason_type "omission" (the source says nothing about the claim, so no passage can be quoted).
- Never quote from the claim, and never write a passage the source does not contain. If you cannot find a passage worth quoting, use "".

Support score guide:
- 80-100: SUPPORTED
- 50-79: PARTIALLY SUPPORTED
- 1-49: NOT SUPPORTED
- 0: SOURCE UNAVAILABLE

<example>
Claim: "The committee published its findings in 1932."
Source text: "History of Modern Economics - Economic Research Council - Google Books Sign in Hidden fields Books Try the new Google Books Check out the new look and enjoy easier access to your favorite features Try it now No thanks My library Help Advanced Book Search Download EPUB Download PDF Plain text Read eBook Get this book in print AbeBooks On Demand Books Amazon Find in a library All sellers About this book Terms of Service Plain text PDF EPUB"

{"support_score": 0, "verdict": "SOURCE UNAVAILABLE", "source_quote": "", "comments": "Google Books interface with no actual book content, only navigation and metadata."}
</example>

<example>
Claim: "The bridge was completed in 1998."
Source text: "Skip to main content Web Archive toolbar... Capture date: 2015-03-12 ... City Tribune - Local News ... The Morrison Bridge project broke ground in 1994 after years of planning. Construction faced multiple delays due to funding shortages. The bridge was finally opened to traffic in August 2002, four years behind schedule. Mayor Davis called it 'a triumph of persistence.'"

{"support_score": 15, "verdict": "NOT SUPPORTED", "reason_type": "contradiction", "source_quote": "The bridge was finally opened to traffic in August 2002, four years behind schedule.", "comments": "Source says the bridge opened in 2002, not 1998. The article is accessible despite being an Internet Archive capture."}
</example>

<example>
Claim: "The company was founded in 1985 by John Smith."
Source text: "Acme Corp was established in 1985. Its founder, John Smith, served as CEO until 2001."

{"support_score": 95, "verdict": "SUPPORTED", "source_quote": "Acme Corp was established in 1985. Its founder, John Smith, served as CEO until 2001.", "comments": "Definitive match with paraphrasing."}
</example>

<example>
Claim: "The treaty was signed by 45 countries."
Source text: "The treaty, finalized in March, was signed by over 30 nations, though the exact number remains disputed."

{"support_score": 20, "verdict": "NOT SUPPORTED", "reason_type": "contradiction", "source_quote": "The treaty, finalized in March, was signed by over 30 nations, though the exact number remains disputed.", "comments": "Source says \\"over 30,\\" not 45."}
</example>

<example>
Claim: "The treaty was signed in Paris."
Source text: "It is believed the treaty was signed in Paris, though some historians dispute this."

{"support_score": 60, "verdict": "PARTIALLY SUPPORTED", "source_quote": "It is believed the treaty was signed in Paris, though some historians dispute this.", "comments": "Source hedges this as uncertain; Wikipedia states it as fact."}
</example>

<example>
Claim: "The population increased by 12% between 2010 and 2020."
Source text: "Census data shows significant population growth in the region during the 2010s."

{"support_score": 55, "verdict": "PARTIALLY SUPPORTED", "source_quote": "Census data shows significant population growth in the region during the 2010s.", "comments": "Source confirms growth but doesn't specify 12%."}
</example>

<example>
Claim: "The president resigned on March 3."
Source text: "The president remained in office throughout March."

{"support_score": 5, "verdict": "NOT SUPPORTED", "reason_type": "contradiction", "source_quote": "The president remained in office throughout March.", "comments": "Source directly contradicts the claim."}
</example>

<example>
Claim: "She received the Nobel Prize in Chemistry in 2015."
Source text: "Professor Martin completed her PhD at Oxford in 1998 and joined the faculty at Cambridge in 2003. Her research focuses on organic synthesis and catalysis. She has published over 200 papers and received several university teaching awards."

{"support_score": 10, "verdict": "NOT SUPPORTED", "reason_type": "omission", "source_quote": "", "comments": "The source discusses her academic career and publications but makes no mention of a Nobel Prize."}
</example>`;
}

// Strips the "Source URL: ... Source Content:\n" / "Manual source text:\n"
// framing that fetchSourceContent and the manual-paste path wrap around the
// actual source body, returning just the body. Shared by the single-source
// user prompt and the multi-source group assembler so both see identical text.
function extractSourceText(sourceInfo) {
    if (sourceInfo.startsWith('Manual source text:')) {
        return sourceInfo.replace(/^Manual source text:\s*\n\s*/, '');
    }
    if (sourceInfo.includes('Source Content:')) {
        const contentMatch = sourceInfo.match(/Source Content:\n([\s\S]*)/);
        return contentMatch ? contentMatch[1] : sourceInfo;
    }
    return sourceInfo;
}

/**
 * Parses source info and generates the user message
 * @param {string} claim - The claim to verify
 * @param {string} sourceInfo - The source information
 * @returns {string} The user message content
 */
function generateUserPrompt(claim, sourceInfo) {
    const sourceText = extractSourceText(sourceInfo);

    return `Claim: "${claim}"

Source text:
${sourceText}`;
}

// System prompt for the "adjacent citations" / collective-verification path:
// one claim is cited by several adjacent sources, and we judge whether the
// sources TOGETHER support it. Kept deliberately close to generateSystemPrompt
// (same JSON schema, verdict vocabulary, support score scale, reason_type rules)
// so verdicts stay comparable; the differences are the "collective" framing and
// the handling of partially-unavailable source sets. This is a NEW prompt — the
// single-source benchmark, which uses generateSystemPrompt, is unaffected.
function generateGroupSystemPrompt() {
    return `You are a fact-checking assistant for Wikipedia. A single claim is cited by MULTIPLE sources, provided below and each labeled with its citation number(s). Analyze whether the claim is supported by the sources taken TOGETHER.

Rules:
- ONLY use the provided source texts. Never use outside knowledge.
- First identify what the claim asserts, then look across ALL the sources for information that supports or contradicts each part.
- The claim is SUPPORTED if the sources COLLECTIVELY support it. No single source needs to support the whole claim on its own — one source may support one part and a different source another part.
- Return PARTIALLY SUPPORTED if the sources together back only some of the claim, and NOT SUPPORTED if the sources together contradict it or address none of it.
- Accept paraphrasing and straightforward implications, but not speculative inferences or logical leaps.
- Distinguish between definitive statements and uncertain/hedged language. Claims stated as facts require sources that make definitive statements, not speculation or tentative assertions.
- Names from languages using non-Latin scripts (Arabic, Chinese, Japanese, Korean, Russian, Hindi, etc.) may have multiple valid romanizations/transliterations. For example, "Yasmin" and "Yazmeen," or "Chekhov" and "Tchekhov," are variant spellings of the same name. Do not treat transliteration differences as factual errors.

Source text evaluation:
Some of the provided sources may be unusable — a paywall, login page, library catalog/metadata page (e.g. WorldCat, Google Books, JSTOR preview), cookie/JavaScript notice, 404/redirect, or an explicit "[This source could not be retrieved: ...]" note. Ignore unusable sources and judge the claim against the sources that DO contain usable article/book content.
Only return verdict SOURCE UNAVAILABLE with support_score 0 if NONE of the provided sources contain usable content.

Respond in JSON format:
{
  "support_score": <number 0-100>,
  "verdict": "<verdict>",
  "reason_type": "<only for NOT SUPPORTED: 'contradiction' or 'omission'>",
  "source_quote": "<the passage from one of the sources, copied word for word>",
  "comments": "<note which source(s) support or contradict which part of the claim>"
}

For NOT SUPPORTED verdicts, include a "reason_type" field: use "contradiction" when a source explicitly states something incompatible with the claim, or "omission" when the sources simply do not mention or address the claim. If both apply, use "contradiction". Do not include reason_type for other verdicts.

The "source_quote" field:
- Copy the passage EXACTLY as it appears in the source text, character for character. Do not paraphrase, summarize, correct spelling or punctuation, translate, or fill in ellipses. It is checked automatically against the sources, and a quote that does not appear in them verbatim is discarded.
- Quote the single most decisive passage across all the sources: the one that best supports the claim (SUPPORTED, PARTIALLY SUPPORTED) or the one that conflicts with it (NOT SUPPORTED with reason_type "contradiction"). Name the source it came from in "comments", not inside the quote itself — do not prefix the quote with "[2]" or a URL.
- Keep it short — normally one sentence, at most two, and never more than about 50 words.
- To join two non-adjacent passages, separate them with " ... ". Each part must still be copied verbatim.
- Use "" (empty string) when there is nothing to quote: SOURCE UNAVAILABLE, and NOT SUPPORTED with reason_type "omission".
- Never quote from the claim, and never write a passage the sources do not contain. If you cannot find a passage worth quoting, use "".

Support score guide:
- 80-100: SUPPORTED
- 50-79: PARTIALLY SUPPORTED
- 1-49: NOT SUPPORTED
- 0: SOURCE UNAVAILABLE

<example>
Claim: "The company was founded in 1985 by John Smith, who led it until 2001."
Source [1] (https://example.com/a): "Acme Corp was established in 1985 in Ohio."
Source [2] (https://example.com/b): "John Smith founded Acme Corp and served as its chief executive until 2001."

{"support_score": 92, "verdict": "SUPPORTED", "source_quote": "John Smith founded Acme Corp and served as its chief executive until 2001.", "comments": "Source [1] gives the 1985 founding year; source [2] confirms John Smith as founder and his tenure until 2001. Together they support the whole claim."}
</example>

<example>
Claim: "The treaty was signed in Paris in 1990."
Source [1] (https://example.com/a): [This source could not be retrieved: HTTP 403]
Source [2] (https://example.com/b): "The accord was signed in the French capital in the spring of 1990."

{"support_score": 88, "verdict": "SUPPORTED", "source_quote": "The accord was signed in the French capital in the spring of 1990.", "comments": "Source [1] was unavailable, but source [2] states the accord was signed in the French capital (Paris) in 1990, which supports the claim."}
</example>

<example>
Claim: "The bridge, built in 1998, cost $200 million."
Source [1] (https://example.com/a): "The bridge opened to traffic in 1998 after four years of construction."
Source [2] (https://example.com/b): "Funding for the project came from a mix of state and federal grants."

{"support_score": 55, "verdict": "PARTIALLY SUPPORTED", "source_quote": "The bridge opened to traffic in 1998 after four years of construction.", "comments": "Source [1] supports the 1998 date. Neither source states the $200 million cost, so that part is unverified."}
</example>`;
}

/**
 * Builds the user message for the collective (multi-source) verification path.
 * @param {string} claim - The claim cited by the group.
 * @param {string} assembledText - Labeled source blocks from assembleGroupSources().
 * @returns {string} The user message content.
 */
function generateGroupUserPrompt(claim, assembledText) {
    return `Claim: "${claim}"

The following sources are all cited for this claim. Evaluate whether they support it together.

${assembledText}`;
}

/**
 * Assembles the per-source fetch results of an adjacent-citation group into a
 * single labeled blob for the collective prompt. Unavailable sources are kept
 * (labeled) rather than dropped, so the model can reason about partial coverage.
 *
 * @param {Array<{citationNumbers: string[], url?: string, content?: string|null,
 *   error?: string|null, status?: number|null}>} entries - one per distinct
 *   source (callers should dedupe sources shared by named refs, merging their
 *   citation numbers into citationNumbers).
 * @returns {{text: string, anyAvailable: boolean}} Combined text and whether at
 *   least one source contributed usable content.
 */
function assembleGroupSources(entries) {
    const blocks = [];
    let anyAvailable = false;
    for (const e of entries) {
        const nums = (e.citationNumbers || []).map(n => `[${n}]`).join('');
        const label = `Source ${nums}${e.url ? ` (${e.url})` : ''}:`;
        const text = e.content ? extractSourceText(e.content).trim() : '';
        if (text) {
            anyAvailable = true;
            blocks.push(`${label}\n${text}`);
        } else {
            const reason = e.status != null ? `HTTP ${e.status}` : (e.error || 'could not be retrieved');
            blocks.push(`${label}\n[This source could not be retrieved: ${reason}]`);
        }
    }
    return { text: blocks.join('\n\n'), anyAvailable };
}

// --- core/verdicts.js ---
// Single source of truth for the four canonical verdict categories and
// the case/short-form conversions that the userscript, CLI, and benchmark
// pipeline each consume. Pre-consolidation, normalizeVerdict was
// reimplemented separately in run_benchmark.js, analyze_results.js,
// compare_results.js, and extract_dataset.js — each with a different
// return-value shape and a different fallback for unrecognized input.
// This module centralizes the recognition logic; callers compose it with
// the presenter that matches their downstream schema.

// Canonical UPPERCASE form. Matches the prompt's verdict spec and the
// userscript's existing inline comparisons.
const VERDICTS = Object.freeze({
    SUPPORTED:           'SUPPORTED',
    PARTIALLY_SUPPORTED: 'PARTIALLY SUPPORTED',
    NOT_SUPPORTED:       'NOT SUPPORTED',
    SOURCE_UNAVAILABLE:  'SOURCE UNAVAILABLE',
});

// Ordered by the support score guide in core/prompts.js. Confusion-matrix
// rows/columns in analyze_results.js iterate this list.
const VERDICT_LIST = Object.freeze([
    VERDICTS.SUPPORTED,
    VERDICTS.PARTIALLY_SUPPORTED,
    VERDICTS.NOT_SUPPORTED,
    VERDICTS.SOURCE_UNAVAILABLE,
]);

// Map any reasonable variant ('not_supported', 'Not Supported', 'PARTIALLY',
// 'unavailable', 'partial', ...) to one of the four canonical UPPERCASE
// values. Returns null for unrecognized input — callers decide whether to
// substitute a sentinel, pass through, or treat as 'Unknown'.
function canonicalizeVerdict(raw) {
    if (raw == null) return null;
    const v = String(raw).toUpperCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
    if (!v) return null;
    // NOT-prefix matches both 'NOT' (compare_results short code) and
    // 'NOT SUPPORTED'. Order doesn't matter for correctness here because
    // the canonical forms start with distinct letters; the ordering below
    // mirrors the historical order in run_benchmark.js for readability.
    if (v.startsWith('NOT'))     return VERDICTS.NOT_SUPPORTED;
    if (v.startsWith('PARTIAL')) return VERDICTS.PARTIALLY_SUPPORTED;
    if (v.startsWith('UNAVAIL')) return VERDICTS.SOURCE_UNAVAILABLE;
    if (v.startsWith('SOURCE'))  return VERDICTS.SOURCE_UNAVAILABLE;
    if (v.startsWith('SUPPORT')) return VERDICTS.SUPPORTED;
    return null;
}

// Presenter: canonical UPPERCASE -> title case ('Supported', 'Not supported', ...).
// Used by benchmark results.json schema and analyze_results.js's confusion matrix.
const TITLE_CASE = Object.freeze({
    [VERDICTS.SUPPORTED]:           'Supported',
    [VERDICTS.PARTIALLY_SUPPORTED]: 'Partially supported',
    [VERDICTS.NOT_SUPPORTED]:       'Not supported',
    [VERDICTS.SOURCE_UNAVAILABLE]:  'Source unavailable',
});
function toTitleCase(canonical) {
    return TITLE_CASE[canonical] ?? canonical;
}

// Presenter: canonical UPPERCASE -> short lowercase code ('support', 'not', ...).
// Used by compare_results.js for run-vs-run comparison.
const SHORT_CODE = Object.freeze({
    [VERDICTS.SUPPORTED]:           'support',
    [VERDICTS.PARTIALLY_SUPPORTED]: 'partial',
    [VERDICTS.NOT_SUPPORTED]:       'not',
    [VERDICTS.SOURCE_UNAVAILABLE]:  'unavailable',
});
function toShortCode(canonical) {
    return SHORT_CODE[canonical] ?? canonical;
}

// Supported-vs-rest equivalence: SUPPORTED and SOURCE_UNAVAILABLE must match
// exactly; PARTIALLY_SUPPORTED and NOT_SUPPORTED are forgiven as mutual
// near-misses, since both mean "an editor has to go look further." This is
// the grouping docs/llm-benchmarking-overview.md's "Lenient Accuracy" section
// describes, and the one WiCE's own claim-level binary task uses (see
// docs/wice-benchmark.md) — SUPPORTED vs. everything else.
//
// Defined here, exported, rather than inline in analyze_results.js (its only
// current caller): this exact grouping was hand-computed into that doc on
// 2026-01-23 and never implemented in the benchmark scripts, so for months
// the doc and the code disagreed under the same metric name ("Lenient
// Accuracy") without anyone noticing — see analyze_results.js's
// `lenientAccuracy` field, which forgives the *opposite* pair (SUPPORTED <->
// PARTIALLY). Keeping the definition here, rather than as a private helper in
// the script that happens to use it first, means a second caller (e.g.
// compare_results.js, if it ever wants this grouping) imports the same
// predicate instead of writing a fresh version that could quietly diverge
// from either the doc or this one.
function equalSupportedVsRest(a, b) {
    const ca = canonicalizeVerdict(a);
    const cb = canonicalizeVerdict(b);
    if (ca === null || cb === null) return false;
    if (ca === cb) return true;
    const isProblem = v => v === VERDICTS.PARTIALLY_SUPPORTED || v === VERDICTS.NOT_SUPPORTED;
    return isProblem(ca) && isProblem(cb);
}

// --- core/parsing.js ---
// Parses raw LLM response text into a structured verdict object.
//
// Happy path: JSON, optionally inside a ```json code fence or surrounded by
// prose. Falls back to a markdown-emphasis recovery regex for small
// open-weight models (e.g. Granite 4.1 8B) that occasionally emit
// "**Verdict:** SUPPORTED" prose instead of the requested JSON. On total
// failure, returns the 'PARSE_ERROR' sentinel — chosen to match what the
// benchmark already records for unrecoverable responses.


function parseVerificationResult(response) {
    const trimmed = response.trim();

    try {
        let jsonStr = trimmed;
        const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (codeBlockMatch) {
            jsonStr = codeBlockMatch[1].trim();
        } else {
            const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
            if (jsonMatch) jsonStr = jsonMatch[0];
        }
        const result = JSON.parse(jsonStr);
        return {
            verdict: result.verdict || 'UNKNOWN',
            support_score: result.support_score ?? null,
            comments: result.comments || '',
            reason_type: result.reason_type || null,
            // Field-name aliases: models occasionally camelCase the key or
            // shorten it to "quote". Always a string — an absent quote is ''
            // (expected for omission/unavailable), never null, so callers can
            // treat it uniformly. Whether the quote is real is decided by
            // core/quote.js, not here.
            source_quote: typeof (result.source_quote ?? result.sourceQuote ?? result.quote) === 'string'
                ? (result.source_quote ?? result.sourceQuote ?? result.quote).trim()
                : ''
        };
    } catch (e) {
        // fall through to the markdown-emphasis recovery
    }

    // Strip "**" and "__"-style emphasis so e.g. "**Verdict:** SUPPORTED"
    // becomes "Verdict: SUPPORTED", then capture the canonical word(s).
    const stripped = trimmed.replace(/\*+|__+/g, '');
    const match = stripped.match(/verdict[\s:"']+([A-Z][A-Z _]*)/i);
    if (match) {
        const verdict = canonicalizeVerdict(match[1]);
        if (verdict) {
            return { verdict, support_score: null, comments: '<extracted from non-JSON response>', source_quote: '' };
        }
    }

    return {
        verdict: 'PARSE_ERROR',
        support_score: null,
        comments: `Failed to parse AI response: ${response.substring(0, 200)}`,
        source_quote: ''
    };
}

// --- core/quote.js ---
// Verifies that a model-supplied `source_quote` actually occurs in the source
// text, so the UI can present it as evidence rather than as more model prose.
//
// The LLM is asked to copy a passage verbatim, but models paraphrase, "fix"
// punctuation, or occasionally invent a plausible-sounding sentence. Rather
// than trusting the field, we look it up. A quote we cannot locate is never
// shown as a confirmed quote — the design is deliberately conservative: it is
// better to fall back to the plain rationale than to display a passage the
// source may not contain.
//
// Matching is normalized (case, curly quotes, dashes, whitespace, ligature-ish
// unicode) because near-universal reformatting would otherwise sink almost
// every real quote. It is NOT fuzzy: no edit distance, no token overlap. A
// passage either occurs in the source under normalization or it doesn't.
//
// Non-contiguous quotes joined by an ellipsis ("A ... B") are supported: each
// segment must occur, in order.

// The complete set of values verifyQuote can put in `status`. Mirrors the
// VERDICTS / VERDICT_LIST pattern in core/verdicts.js.
//
// These strings leave the client: they are written to the `quote_status`
// column via POST /log, and the Cloudflare Worker
// (alex-o-748/public-ai-proxy, src/index.js) validates the incoming value
// against its own hardcoded copy of this list, storing NULL for anything it
// does not recognize. Cross-repo, that copy cannot be imported — so adding a
// status here is a two-repo change, and skipping the second half loses the new
// status silently. tests/quote.test.js pins the list to make that deliberate.
const QUOTE_STATUSES = Object.freeze({
    EXACT:      'exact',
    NORMALIZED: 'normalized',
    PARTIAL:    'partial',
    NOT_FOUND:  'not-found',
    TOO_SHORT:  'too-short',
    EMPTY:      'empty',
    NO_SOURCE:  'no-source',
});

const QUOTE_STATUS_LIST = Object.freeze(Object.values(QUOTE_STATUSES));

// The two statuses that mean "found in the source". `verified` is exactly
// membership of this set.
const VERIFIED_STATUSES = Object.freeze([
    QUOTE_STATUSES.EXACT,
    QUOTE_STATUSES.NORMALIZED,
]);

// A quote shorter than this (after normalization) is not evidence — "1985" or
// "the bridge" would match almost any source by accident.
const MIN_QUOTE_CHARS = 12;

// Ellipsis forms models use to join non-contiguous fragments.
const ELLIPSIS_SPLIT = /\s*(?:\[\s*(?:\.\.\.|…)\s*\]|\.\.\.\.?|…)\s*/g;

// Punctuation entities that survive upstream extraction. The Worker's
// extractText() decodes only &nbsp; &amp; &lt; &gt;, so a WordPress source
// reaches the model as "the mall&#8217;s amusement park" — and the model,
// reading that as an apostrophe, quotes it back decoded. Comparing the raw
// entity against the character it denotes is a false mismatch: they are the
// same character, differently encoded, exactly like the NFKC and curly-quote
// folds below. Numeric forms cover everything else a page is likely to emit.
const NAMED_ENTITIES = {
    quot: '"', apos: "'", amp: '&', lt: '<', gt: '>', nbsp: ' ',
    lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„',
    ndash: '–', mdash: '—', minus: '−', shy: '­', hellip: '…',
    prime: '′', Prime: '″', laquo: '«', raquo: '»',
    ensp: ' ', emsp: ' ', thinsp: ' ', middot: '·', bull: '•', deg: '°',
};

// The Latin-1 letter entities, which older CMSes emit for any accented name —
// &eacute; for José, &uuml; for Müller. U+00C0..U+00FF is exactly this
// sequence, so the table is generated from it rather than typed out, which is
// both shorter and impossible to get subtly wrong.
(
    'Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml '
    + 'Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times '
    + 'Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc '
    + 'atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute '
    + 'icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash '
    + 'ugrave uacute ucirc uuml yacute thorn yuml'
).split(' ').forEach((name, i) => {
    NAMED_ENTITIES[name] = String.fromCharCode(0xc0 + i);
});

function decodeEntities(text) {
    return text.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,10});/g, (whole, body) => {
        if (body[0] === '#') {
            const code = body[1] === 'x' || body[1] === 'X'
                ? parseInt(body.slice(2), 16)
                : parseInt(body.slice(1), 10);
            // Surrogates and out-of-range values would throw; leave them be.
            if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
            if (code >= 0xd800 && code <= 0xdfff) return whole;
            try {
                return String.fromCodePoint(code);
            } catch (e) {
                return whole;
            }
        }
        return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body)
            ? NAMED_ENTITIES[body]
            : whole;
    });
}

const CHAR_FOLD = [
    // All quotation marks fold to one character: models routinely swap ' for "
    // when copying, and the distinction carries no evidentiary weight here.
    [/[‘’‚‛′´`'ʻʼ“”„‟″«»"]/g, '"'],
    [/[‐-―−]/g, '-'],                      // hyphens, dashes, minus
    [/­/g, ''],                                      // soft hyphen
    [/[  -   　]/g, ' '],    // exotic spaces
    [/[​-‍﻿]/g, ''],                       // zero-width junk
];

/**
 * Canonical form used for substring comparison. Lossy by design — it throws
 * away exactly the differences (case, quote style, dash style, whitespace
 * runs, line breaks) that a model routinely introduces when copying.
 * @param {string} text
 * @returns {string}
 */
function normalizeForMatch(text) {
    if (text == null) return '';
    let out = String(text);
    try {
        out = out.normalize('NFKC');
    } catch (e) {
        // Environments without full Unicode data: normalization is an
        // optimization here, not a requirement.
    }
    // Before the character folds, so &#8217; becomes ’ and then folds with
    // every other apostrophe. Applied to both sides, so it can only make a
    // genuine quote match.
    out = decodeEntities(out);
    for (const [pattern, replacement] of CHAR_FOLD) {
        out = out.replace(pattern, replacement);
    }
    // Close up a hyphen followed by whitespace. PDF and OCR text layers break
    // words across lines and leave the hyphen behind ("school-\nlike"), and a
    // model copying that passage repairs some of them and not others — within
    // a single quote. Folding both sides to "school-like" makes the two agree
    // however the model chose to render it. Applied symmetrically, so the only
    // thing it can do is make a real quote match; a spaced dash used as
    // punctuation ("1994 - 1998") folds the same way on both sides.
    out = out.replace(/-\s+/g, '-');
    return out.replace(/\s+/g, ' ').trim().toLowerCase();
}

// Models often wrap the quote in quotation marks even when told not to, and
// sometimes trail a citation marker or a stray period. Strip the wrapper only
// when it is balanced, so a quote that legitimately opens with a quoted phrase
// survives intact.
function unwrap(quote) {
    let q = String(quote).trim();
    const pairs = [['"', '"'], ["'", "'"], ['“', '”'], ['‘', '’'], ['«', '»']];
    let changed = true;
    while (changed) {
        changed = false;
        for (const [open, close] of pairs) {
            if (q.length > 2 && q.startsWith(open) && q.endsWith(close)) {
                q = q.slice(open.length, q.length - close.length).trim();
                changed = true;
            }
        }
    }
    return q;
}

/**
 * Checks whether `quote` occurs in `sourceText`.
 *
 * @param {string} sourceText - The source body the model was shown (already
 *   unwrapped from its "Source Content:" framing by extractSourceText).
 * @param {string} quote - The model's `source_quote` field.
 * @returns {{verified: boolean, status: string, verifiedText: string,
 *   segments: Array<{text: string, found: boolean, located: boolean}>}}
 *   `verifiedText` is the part of the quote actually located in the source,
 *   ellipsis-joined — the whole quote when verified, the surviving fragments
 *   when partial, '' when nothing was found. Every character of it came from
 *   the source, so it is safe to display; `quote` as returned by the model is
 *   not. `found` counts toward the verdict, `located` records whether the
 *   fragment was really seen (they differ only for fragments too short to
 *   judge, which are forgiven but never shown).
 *   status is one of QUOTE_STATUS_LIST:
 *     'empty'      - no quote was offered (expected for omission / unavailable)
 *     'no-source'  - we have no source text to check against (e.g. cached
 *                    result restored without its source); quote is unproven
 *     'too-short'  - quote too short to be meaningful evidence
 *     'exact'      - occurs verbatim, byte for byte
 *     'normalized' - occurs after whitespace/punctuation/case normalization
 *     'partial'    - some ellipsis-joined segments found, others not
 *     'not-found'  - does not occur in the source
 *   `verified` is true exactly for the VERIFIED_STATUSES ('exact', 'normalized').
 */
function verifyQuote(sourceText, quote) {
    const raw = quote == null ? '' : String(quote).trim();
    if (!raw) return { verified: false, status: QUOTE_STATUSES.EMPTY, verifiedText: '', segments: [] };

    const cleaned = unwrap(raw);
    const source = sourceText == null ? '' : String(sourceText);
    if (!source.trim()) return { verified: false, status: QUOTE_STATUSES.NO_SOURCE, verifiedText: '', segments: [] };

    if (normalizeForMatch(cleaned).length < MIN_QUOTE_CHARS) {
        return { verified: false, status: QUOTE_STATUSES.TOO_SHORT, verifiedText: '', segments: [] };
    }

    if (source.includes(cleaned)) {
        return {
            verified: true,
            status: QUOTE_STATUSES.EXACT,
            verifiedText: cleaned,
            segments: [{ text: cleaned, found: true, located: true }],
        };
    }

    const haystack = normalizeForMatch(source);
    // String.split with a /g regex is safe (split resets lastIndex), but the
    // regex is recreated per call anyway to avoid any shared-state surprise.
    const rawSegments = cleaned.split(new RegExp(ELLIPSIS_SPLIT.source, 'g'))
        .map(s => s.trim())
        .filter(Boolean);

    let cursor = 0;
    const segments = [];
    for (const segment of rawSegments) {
        const needle = normalizeForMatch(segment);
        const at = needle ? haystack.indexOf(needle, cursor) : -1;
        // Fragments too short to carry meaning (a dangling "in 1985" after an
        // ellipsis) neither confirm nor refute the match, so they are forgiven
        // rather than failed — but they never advance the cursor, and they are
        // only shown if they really were located.
        if (needle.length < MIN_QUOTE_CHARS && rawSegments.length > 1) {
            segments.push({ text: segment, found: true, located: at !== -1 });
            continue;
        }
        if (at !== -1) {
            segments.push({ text: segment, found: true, located: true });
            cursor = at + needle.length;
            continue;
        }
        // Models routinely close a quotation with a full stop the source does
        // not have. Retry without it — and if that is what matched, display
        // the trimmed form, so every character shown is still one the source
        // contains.
        const trimmed = segment.replace(/[.,;:]+$/, '');
        const trimmedNeedle = normalizeForMatch(trimmed);
        const trimmedAt = trimmedNeedle && trimmedNeedle !== needle
            ? haystack.indexOf(trimmedNeedle, cursor)
            : -1;
        if (trimmedAt !== -1) {
            segments.push({ text: trimmed, found: true, located: true });
            cursor = trimmedAt + trimmedNeedle.length;
        } else {
            segments.push({ text: segment, found: false, located: false });
        }
    }

    const verifiedText = segments.filter(s => s.located).map(s => s.text).join(' … ');
    const foundCount = segments.filter(s => s.found).length;
    if (foundCount === segments.length && segments.length > 0) {
        return { verified: true, status: QUOTE_STATUSES.NORMALIZED, verifiedText, segments };
    }
    if (foundCount > 0) {
        return { verified: false, status: QUOTE_STATUSES.PARTIAL, verifiedText, segments };
    }
    return { verified: false, status: QUOTE_STATUSES.NOT_FOUND, verifiedText: '', segments };
}

// Verdicts for which a supporting/contradicting passage should exist in the
// source. Omission and unavailable verdicts have nothing to quote by
// definition, so a missing quote there is correct, not a failure.
const QUOTE_EXPECTED = new Set(['SUPPORTED', 'PARTIALLY SUPPORTED']);

/**
 * Whether a quote is expected for this verdict — used to decide if a missing
 * quote is worth surfacing to the user or is simply not applicable.
 * @param {string} verdict - Canonical UPPERCASE verdict.
 * @param {string|null} reasonType - 'contradiction' | 'omission' | null.
 * @returns {boolean}
 */
function quoteExpectedFor(verdict, reasonType) {
    if (QUOTE_EXPECTED.has(verdict)) return true;
    return verdict === 'NOT SUPPORTED' && reasonType === 'contradiction';
}

// --- core/retry.js ---
// Retry-with-backoff helper shared by the benchmark runner and the
// userscript's batch verify-all-citations path. Pre-consolidation, the
// benchmark used `withRetry` (5 attempts, exponential backoff, retries
// on 429 / 500 / 502 / 503 / 504 / network errors) while main.js's batch
// path had its own inline loop (3 attempts, fixed linear backoff,
// retries only on 429). The userscript's narrower trigger meant a single
// 503 during a batch run errored out the whole citation; the benchmark
// would have recovered. Sharing the impl widens the userscript to the
// benchmark's retry set.
//
// Defaults match the benchmark (1s base, exponential, ≤30s cap, 5
// attempts) — callers tune via options.

// Matches both the "HTTP <status>" shape (e.g. main.js's CORS-proxy fetch
// errors) and the "[<Label> ]API request failed (<status>): ..." shape thrown
// by every provider call in core/providers.js. The two families used to
// diverge silently: this regex only ever matched the former, so 429/5xx from
// a real LLM call (the actual withRetry-wrapped call path) never retried at
// all — see the 2026-08-16 keyless-HF-benchmark investigation.
//
// Both alternatives are anchored, and the optional label is `[^:()]*` rather
// than `.*` on purpose. The status must come from the message *we* format, not
// from the upstream response body interpolated after "): " — a permanent 400
// whose body happens to mention a 5xx ("...failed (400): upstream failed
// (503)") must stay non-retryable. `[^:()]*` cannot cross the first "(" or
// ":", so only the real status can satisfy the group. Labels are caller-side
// constants and may contain spaces ('Lift Wing'), hence not `\S+`.
const RETRYABLE_STATUS = /^(?:HTTP |[^:()]*API request failed \()(429|500|502|503|504)\b/;
const RETRYABLE_NETWORK = /timeout|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i;

// vLLM (Lift Wing's backend for open-weight models) reports a genuine
// input-validation failure — the prompt exceeds the model's context
// window — as an HTTP 500, which would otherwise match RETRYABLE_STATUS
// above. Retrying buys nothing: the same oversized prompt produces the
// identical error on every attempt, so retrying just burns up to ~30s of
// backoff before failing anyway, on a request that will never succeed no
// matter how many times it's sent. Real incident, 2026-08-24: exactly this
// on a live sweep against tf-llm-router. Exported (not just used inline
// below) so service/verifier.js can recognize this specific failure after
// withRetry gives up and record it as a per-citation result instead of
// treating it as a run-halting error the way an unrecognized failure is.
const CONTEXT_LENGTH_EXCEEDED = /maximum context length|VLLMValidationError/i;

function isContextLengthError(error) {
    return CONTEXT_LENGTH_EXCEEDED.test(error?.message ?? '');
}

function defaultSleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableError(error) {
    const msg = error?.message ?? '';

    if (isContextLengthError(error)) return false;

    // Node's fetch (undici) always throws this exact generic message for a
    // network/transport-layer failure — DNS, connection reset, refused, TLS
    // — never for an HTTP-level 4xx/5xx response (those resolve normally
    // and are turned into the "API request failed (<status>)" shape by our
    // own provider code, matched below). The actual reason lives one level
    // down in `error.cause` (e.g. `{ code: 'ENOTFOUND' }` or `ECONNRESET`),
    // which this function never inspected — so this entire category of
    // real transient failures skipped retry and went straight to a hard
    // failure. Real incident, 2026-08-24: a live sweep against
    // tf-llm-router halted immediately on "fetch failed" with zero retry
    // attempts. Matched by exact equality, not substring, so this can't
    // accidentally widen retry to some other error that merely mentions
    // "fetch failed" in a longer message.
    if (msg === 'fetch failed') return true;

    return RETRYABLE_STATUS.test(msg) || RETRYABLE_NETWORK.test(msg);
}

/**
 * Retry `fn` on transient failures (429, 5xx, network) with exponential
 * backoff + jitter.
 *
 * Options:
 *   maxRetries       Total attempt budget incl. the initial call (default 5).
 *   minBackoffMs     Base for the exponential curve (default 1000).
 *   maxBackoffMs     Cap on a single sleep (default 30000).
 *   jitterMs         Upper bound of additive random jitter (default 500).
 *   sleepFn          Injectable sleep — tests pass a no-op so they run instantly.
 *   shouldAbort      Optional callback; truthy return short-circuits the loop
 *                    (e.g. user cancellation in the userscript's batch path).
 *   onAttemptFailed  Optional callback invoked after each failed attempt with
 *                    { error, attempt, backoff, willRetry } — for progress UI.
 *                    `backoff` is the sleep duration about to elapse (0 if no retry).
 *
 * Throws the last error if every attempt fails or the failure isn't retryable.
 */
async function withRetry(fn, {
    maxRetries = 5,
    minBackoffMs = 1000,
    maxBackoffMs = 30000,
    jitterMs = 500,
    sleepFn = defaultSleep,
    shouldAbort,
    onAttemptFailed,
} = {}) {
    let lastError = null;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        if (shouldAbort && shouldAbort()) break;
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            const retryable = isRetryableError(error);
            const willRetry = retryable && attempt < maxRetries - 1
                && !(shouldAbort && shouldAbort());
            const backoff = willRetry
                ? Math.min(maxBackoffMs, minBackoffMs * Math.pow(2, attempt))
                  + Math.random() * jitterMs
                : 0;
            if (onAttemptFailed) onAttemptFailed({ error, attempt, backoff, willRetry });
            if (!willRetry) break;
            await sleepFn(backoff);
        }
    }
    throw lastError;
}

// --- core/urls.js ---
// URL extraction helpers for Wikipedia reference elements.
// extractReferenceUrl and extractPageNumber accept a `document` parameter
// for Node callers (CLI, tests). They fall back to `globalThis.document`
// when called without one — that's the userscript path, where the browser
// supplies the global.

const ARCHIVE_HOST_PATTERN = /web\.archive\.org|archive\.today|archive\.is|archive\.ph|webcitation\.org/i;

function isArchiveUrl(href) {
    return ARCHIVE_HOST_PATTERN.test(href);
}

// Wikimedia-family internal wikilinks (a[href^="http"] resolves to an absolute
// URL, so blue wikilinks like the "ISBN (identifier)" article, and the
// Special:BookSources bookseller-list page that ISBN magic links point to, can
// slip through the http filter). These are never genuine citation sources —
// verifying a claim against a wikilink is meaningless — so exclude them.
const WIKIMEDIA_INTERNAL_PATTERN = /^https?:\/\/[a-z0-9-]+\.(?:wikipedia|wikimedia|wiktionary|wikidata|wikisource|wikiquote|wikibooks|wikinews|wikiversity|wikivoyage)\.org\/wiki\//i;

function isInternalWikiLink(href) {
    if (!href) return false;
    // Special:BookSources is the page ISBN magic links target; match it
    // directly so localized/mirrored hosts are covered too.
    if (/Special:BookSources/i.test(href)) return true;
    return WIKIMEDIA_INTERNAL_PATTERN.test(href);
}

function parseArchiveOrgUrl(url) {
    const match = url.match(/^https?:\/\/web\.archive\.org\/web\/(\d+)(?:id_)?\/(https?:\/\/.+)$/);
    if (!match) return null;
    return { timestamp: match[1], originalUrl: match[2] };
}

function extractHttpUrl(element) {
    if (!element) return null;
    // Skip internal wikilinks (ISBN article, Special:BookSources, etc.) — a
    // book-only citation whose sole links are these would otherwise be
    // "verified" against a Wikipedia navigation page rather than a real source.
    const links = Array.from(element.querySelectorAll('a[href^="http"]'))
        .filter(link => !isInternalWikiLink(link.href));
    if (links.length === 0) return null;
    // Prefer Internet Archive URLs — we fetch via the Wayback raw endpoint
    // (id_) which returns clean original content without toolbar framing.
    for (const link of links) {
        if (/web\.archive\.org/.test(link.href)) return link.href;
    }
    // Then any live URL; other archive services (archive.today etc.) last.
    for (const link of links) {
        if (!isArchiveUrl(link.href)) return link.href;
    }
    return links[0].href;
}

function extractReferenceUrl(refElement, doc = globalThis.document) {
    let href = refElement.getAttribute('href');
    if (!href) {
        console.log('[CitationVerifier] No href on refElement');
        return null;
    }

    // Handle Wikipedia REST API HTML which uses relative URLs with fragments
    // like "./Page#cite_note-1". Extract just the fragment part.
    const fragmentIndex = href.indexOf('#');
    if (fragmentIndex === -1) {
        console.log('[CitationVerifier] No fragment in href:', href);
        return null;
    }
    const refId = href.substring(fragmentIndex + 1);
    const refTarget = doc.getElementById(refId);

    if (!refTarget) {
        console.log('[CitationVerifier] No element found for refId:', refId);
        return null;
    }

    // Try to extract a direct HTTP URL from the footnote
    const directUrl = extractHttpUrl(refTarget);
    if (directUrl) return directUrl;

    // Harvard/sfn citation support: the footnote may contain only a
    // short-cite linking to the full citation via a #CITEREF anchor.
    // Follow that link to resolve the actual source URL.
    const citerefLink = refTarget.querySelector('a[href^="#CITEREF"]');
    if (citerefLink) {
        const citerefId = citerefLink.getAttribute('href').substring(1);
        const fullCitation = doc.getElementById(citerefId);
        if (fullCitation) {
            const resolvedUrl = extractHttpUrl(fullCitation);
            if (resolvedUrl) {
                console.log('[CitationVerifier] Resolved Harvard/sfn citation via', citerefId);
                return resolvedUrl;
            }
        }
        // Also try the parent <li> or <cite> element in case the anchor
        // is on a child element within the full citation list item
        const fullCitationLi = fullCitation && fullCitation.closest('li');
        if (fullCitationLi && fullCitationLi !== fullCitation) {
            const resolvedUrl = extractHttpUrl(fullCitationLi);
            if (resolvedUrl) {
                console.log('[CitationVerifier] Resolved Harvard/sfn citation via parent li of', citerefId);
                return resolvedUrl;
            }
        }
        console.log('[CitationVerifier] Harvard/sfn citation found but no URL in full citation:', citerefId);
        return null;
    }

    console.log('[CitationVerifier] No http links in refTarget. innerHTML:', refTarget.innerHTML.substring(0, 500));
    return null;
}

function extractPageNumber(refElement, doc = globalThis.document) {
    const href = refElement.getAttribute('href');
    if (!href) return null;

    const fragmentIndex = href.indexOf('#');
    if (fragmentIndex === -1) return null;

    const refTarget = doc.getElementById(href.substring(fragmentIndex + 1));
    if (!refTarget) return null;

    const text = refTarget.textContent;
    // Match patterns like "p. 42", "pp. 42-43", "p.42", "page 42", "pages 42–43"
    const match = text.match(/\bp(?:p|ages?)?\.?\s*(\d+)/i);
    if (match) {
        console.log('[CitationVerifier] Extracted page number:', match[1]);
        return parseInt(match[1], 10);
    }
    return null;
}

function isGoogleBooksUrl(url) {
    return /books\.google\./.test(url);
}

// --- core/claim.js ---
// Extracts the prose claim text bearing a given citation from a parsed
// Wikipedia Document. Works with both browser DOM and JSDOM.

const MAINTENANCE_MARKER_RE = /\[(failed verification|verification needed|citation needed|better source[^\]]*|dubious[^\]]*|unreliable source[^\]]*|clarification needed|disputed[^\]]*|page needed|when\??|where\??|who\??|why\??|by whom\??|according to whom\??|original research[^\]]*|specify[^\]]*|vague|opinion|fact)\]/gi;

// True iff the DOM range strictly between two .reference wrapper elements (in
// document order: refA before refB) contains no non-whitespace text. This is
// the rule that defines whether two adjacent citations attach to the same
// claim — a comma or any other punctuation between them counts as text and
// breaks the group.
function hasTextBetween(refA, refB) {
    const document = refA.ownerDocument;
    const range = document.createRange();
    range.setStartAfter(refA);
    range.setEndBefore(refB);
    const between = range.toString().replace(/\s+/g, '').trim();
    return between.length > 0;
}

// Returns the contiguous run of .reference wrapper elements (in DOM order)
// that all attach to the same claim as refElement — i.e. consecutive siblings
// in the same container with no text between adjacent members. Always returns
// at least the wrapper of refElement; an isolated citation yields a single-
// element array.
function getCitationGroup(refElement) {
    const currentRef = refElement.closest('.reference');
    if (!currentRef) return [];

    const container = currentRef.closest('p, li, td, div, section');
    if (!container) return [currentRef];

    const refsInContainer = Array.from(container.querySelectorAll('.reference'));
    const idx = refsInContainer.indexOf(currentRef);
    if (idx === -1) return [currentRef];

    let start = idx;
    while (start > 0 && !hasTextBetween(refsInContainer[start - 1], refsInContainer[start])) {
        start--;
    }
    let end = idx;
    while (end < refsInContainer.length - 1 && !hasTextBetween(refsInContainer[end], refsInContainer[end + 1])) {
        end++;
    }
    return refsInContainer.slice(start, end + 1);
}

// Splits on a sentence-ending mark followed by whitespace and what looks like
// the start of a new sentence, then returns the last piece. Deliberately
// naive about abbreviations ("Dr. Smith", "U.S. policy") — for this use
// (finding where the final sentence of a claim begins), under-splitting an
// abbreviation into the same sentence is the safer failure than over-
// splitting mid-abbreviation and truncating the real claim.
const SENTENCE_SPLIT_RE = /(?<=[.!?])\s+(?=[A-Z0-9"'(À-Ü])/;

// Returns just the final sentence of `text` — the sentence immediately
// preceding wherever `text` ends. Used for the batch pipeline's stricter
// claim scope (see extractClaimText's `scope` option); returns the whole
// string unchanged if no sentence boundary is found.
function lastSentence(text) {
    if (!text) return text;
    const parts = text.split(SENTENCE_SPLIT_RE);
    return parts[parts.length - 1].trim();
}

function extractClaimText(refElement, { scope = 'paragraph' } = {}) {
    const document = refElement.ownerDocument;
    const container = refElement.closest('p, li, td, div, section');
    if (!container) {
        return '';
    }

    // Get the current reference wrapper element
    const currentRef = refElement.closest('.reference');
    if (!currentRef) {
        // Fallback: return container text
        return container.textContent
            .replace(/\[\d+\]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    // Find all references in the same container
    const refsInContainer = Array.from(container.querySelectorAll('.reference'));
    const currentIndexInContainer = refsInContainer.indexOf(currentRef);

    let claimStartNode = null;

    if (currentIndexInContainer > 0) {
        // Walk backwards through the consecutive same-claim run; the boundary
        // is the first previous ref that has actual text between it and its
        // successor (i.e. it cites a different claim).
        for (let i = currentIndexInContainer - 1; i >= 0; i--) {
            const prevRef = refsInContainer[i];
            const nextRef = refsInContainer[i + 1] || currentRef;
            if (hasTextBetween(prevRef, nextRef)) {
                claimStartNode = prevRef;
                break;
            }
        }
    }

    // Extract the text from the boundary to the current reference
    const extractionRange = document.createRange();

    if (claimStartNode) {
        extractionRange.setStartAfter(claimStartNode);
    } else {
        // No previous ref boundary - start from beginning of container
        extractionRange.setStart(container, 0);
    }
    extractionRange.setEndBefore(currentRef);

    // Get the text content
    let claimText = extractionRange.toString();

    // Clean up the text. Whitespace must be normalized BEFORE the marker
    // strip (Wikipedia's {{failed verification}} et al. use white-space:nowrap
    // and emit U+00A0 between the words, which the literal-space alternatives
    // in MAINTENANCE_MARKER_RE would otherwise fail to match) AND AFTER the
    // strip (removing a marker that had a leading/trailing space leaves a
    // double space behind).
    claimText = claimText
        .replace(/\[\d+\]/g, '')                 // Remove reference numbers like [1], [2]
        .replace(/\s+/g, ' ')                    // Normalize whitespace (incl. NBSP) so the marker regex matches
        .replace(MAINTENANCE_MARKER_RE, '')      // Remove maintenance markers like [failed verification]
        .replace(/\s+/g, ' ')                    // Collapse the gap left by the marker strip
        .trim();

    // If we got nothing meaningful, fall back to the container text
    if (!claimText || claimText.length < 10) {
        claimText = container.textContent
            .replace(/\[\d+\]/g, '')
            .replace(/\s+/g, ' ')
            .replace(MAINTENANCE_MARKER_RE, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    // Applied last, after the paragraph-scope text is settled (including its
    // own too-short fallback above) — narrowing to the final sentence is a
    // separate concern from finding the claim's boundary in the first place.
    if (scope === 'sentence') {
        claimText = lastSentence(claimText);
    }

    return claimText;
}

// --- core/citations.js ---
// Collects every citation in an article, with adjacent-group metadata attached.
//
// Extracted from main.js's collectAllCitations()/attachGroupMetadata() so the
// userscript, the CLI, and the Toolforge batch runner share one implementation
// rather than each re-deriving "what are the citations on this page".
//
// The caller supplies the root to search, because the two HTML sources differ:
// the userscript scopes to `#mw-content-text` (the MediaWiki skin's content
// container), while Parsoid REST HTML has no such wrapper and the document
// itself is the root.


// Claims shorter than this are extraction noise (a stray bullet, a lone date)
// rather than a verifiable statement. Matches main.js's original threshold.
const MIN_CLAIM_LENGTH = 10;

// Returns the fragment id a footnote anchor points at, or null if the href
// isn't a footnote link.
//
// The two HTML sources render the same anchor differently:
//   browser DOM   href="#cite_note-1"
//   Parsoid REST  href="./Article_title#cite_note-1"
// main.js's original guard was `href.startsWith('#')`, which is correct for the
// browser and rejects *every* citation in Parsoid output. Keying on the
// fragment covers both.
function refIdFromHref(href) {
    if (!href) return null;
    const hashIndex = href.indexOf('#');
    if (hashIndex === -1) return null;
    const refId = href.slice(hashIndex + 1);
    return refId || null;
}

// Recovers a named <ref name="..."> from its rendered footnote id, when the
// citation came from one. MediaWiki's Cite extension renders a *named* ref's
// footnote id as `cite_note-<name>-<n>` — <name> being the ref's `name`
// attribute, sanitized for HTML-id use (Sanitizer::escapeIdForAttribute:
// spaces become underscores, and so on), and <n> a global reference counter
// unrelated to the name, shared across every occurrence of that same named
// ref. An *unnamed* ref renders as plain `cite_note-<n>`, with no name
// segment to recover — refId already gives us that whole footnote id
// (refIdFromHref reads it off the same href this function's caller does), so
// no extra DOM access is needed to try to recover one.
//
// The recovered value is the *sanitized* id-safe form, not necessarily
// byte-identical to the wikitext attribute (an underscore may have been a
// space) — acceptable per CLAUDE.md: "ref_name... display only; NOT an
// identifier". Works identically on browser-skin and Parsoid REST HTML: Cite
// renders this id the same way on both, unlike the URL/page-number
// extraction in core/urls.js, which does differ between the two sources.
function refNameFromNoteId(refId) {
    const match = /^cite_note-(.+)-\d+$/.exec(refId || '');
    return match ? match[1] : null;
}

function collectCitations(root, { minClaimLength = MIN_CLAIM_LENGTH, claimScope = 'paragraph' } = {}) {
    if (!root) return [];
    // A Document has no ownerDocument; an Element does. Either can be the root.
    const doc = root.ownerDocument || root;

    const citations = [];
    for (const refElement of root.querySelectorAll('.reference a')) {
        const refId = refIdFromHref(refElement.getAttribute('href'));
        if (!refId) continue;

        const claimText = extractClaimText(refElement, { scope: claimScope });
        if (!claimText || claimText.length < minClaimLength) continue;

        citations.push({
            refElement,
            refId,
            refName: refNameFromNoteId(refId),
            citationNumber: refElement.textContent.replace(/[\[\]]/g, '').trim(),
            claimText,
            url: extractReferenceUrl(refElement, doc),
            pageNum: extractPageNumber(refElement, doc),
        });
    }

    attachGroupMetadata(citations);
    return citations;
}

// Every citation in a contiguous run of refs attached to the same claim shares
// a groupId, groupSize and groupCitationNumbers list; groupIndex is the
// citation's 0-based position within its group. Mutates the passed array's
// entries in place, matching main.js's original contract.
function attachGroupMetadata(citations) {
    // Key by the <sup class="reference"> wrapper element, not refId: named refs
    // (e.g. {{r|Foo}} cited twice) share the same cite_note href, so a
    // refId-keyed map collides and the second occurrence overwrites the first.
    // Wrapper elements are unique per occurrence.
    const byWrapper = new Map();
    for (const c of citations) {
        const wrapper = c.refElement.closest('.reference');
        if (wrapper) byWrapper.set(wrapper, c);
    }

    const visited = new Set();
    for (const citation of citations) {
        if (visited.has(citation)) continue;

        const groupCitations = [];
        for (const wrapper of getCitationGroup(citation.refElement)) {
            const c = byWrapper.get(wrapper);
            if (c) groupCitations.push(c);
        }
        if (groupCitations.length === 0) continue;

        // Use the first wrapper's id (cite_ref-X-Y, unique per occurrence) as
        // the group id so two groups whose first member is the same named
        // source — e.g. "[3][4]" and a separate "[3][5]" later in the article —
        // don't collide on the data-group-id used by the report renderer.
        const firstWrapper = groupCitations[0].refElement.closest('.reference');
        const groupId = (firstWrapper && firstWrapper.id) || groupCitations[0].refId;
        const groupCitationNumbers = groupCitations.map(c => c.citationNumber);

        groupCitations.forEach((c, idx) => {
            c.groupId = groupId;
            c.groupSize = groupCitations.length;
            c.groupIndex = idx;
            c.groupCitationNumbers = groupCitationNumbers;
            visited.add(c);
        });
    }
}

// --- core/groups.js ---
// Adjacent-citation group semantics: when the collective (multi-source)
// verification for a group should fire, how a group's members collapse to
// one entry per distinct source, whether the collective verdict is worth
// running at all, and how a collective verdict merges with per-source
// results into one unit per claim.
//
// Extracted verbatim from main.js's verifyGroupCollective() and
// getReportUnits() so the userscript and the Toolforge batch pipeline
// (service/verifier.js) compute identical group units instead of maintaining
// two implementations that can silently drift — see docs/design-plans/
// 2026-08-22-batch-verification-and-persistence.md §2 and docs/design-plans/
// 2026-08-24-csv-deliverable-and-component-names.md (G4). Pure logic only:
// no DOM, no fetch, no provider call — callers own all of that.


/**
 * True when `citation` is the last member of its adjacent-citation group —
 * the point at which the group's collective verification should fire, once
 * per group rather than once per member. A solo citation (no group, or a
 * group of one) is never "close".
 */
function isGroupClose(citation) {
    return Boolean(citation && citation.groupSize > 1 && citation.groupIndex === citation.groupSize - 1);
}

/**
 * Dedupes an adjacent-citation group's members down to one entry per
 * distinct source. Two citations backed by the same named `<ref>` (or the
 * same URL at the same page number) collapse into a single entry carrying
 * both citation numbers, so the group prompt (assembleGroupSources()) isn't
 * asked to show the model the same source text twice.
 *
 * `sourceFor(member)` resolves one member to its source; callers own *how*,
 * because that differs by caller: the userscript looks a member up in its
 * `url|page=N`-keyed sourceCache, while the batch pipeline already carries
 * each citation's resolved `source` object directly
 * (service/claim-extractor.js's processArticle output). It must return
 * `{ key, url, content, error, status }` — `key` is the dedup key; the rest
 * become the entry's fields the first time that key is seen.
 *
 * @param {Array<object>} members - Group members, sharing one groupId.
 * @param {(member: object) => {key: string, url?: string|null, content?: string|null, error?: string|null, status?: number|null}} sourceFor
 * @returns {Array<{citationNumbers: (string|number)[], url: string|null, content: string|null, error: string|null, status: number|null}>}
 */
function groupSourceEntries(members, sourceFor) {
    const byKey = new Map();
    for (const member of members) {
        const { key, url, content, error, status } = sourceFor(member);
        let entry = byKey.get(key);
        if (!entry) {
            entry = {
                citationNumbers: [],
                url: url || null,
                content: content ?? null,
                error: error ?? null,
                status: status ?? null,
            };
            byKey.set(key, entry);
        }
        entry.citationNumbers.push(member.citationNumber);
    }
    return Array.from(byKey.values());
}

/**
 * Whether the collective (multi-source) verdict should be skipped in favor
 * of the group's existing per-source results. True when at most one member
 * source has usable text — with ≤1 available source, a collective verdict
 * would just restate the solo one, so running it would burn a model call to
 * say nothing new.
 *
 * @param {ReturnType<typeof groupSourceEntries>} entries
 */
function shouldSkipCollective(entries) {
    const availableCount = entries.filter(e => e.content && extractSourceText(e.content).trim()).length;
    return availableCount <= 1;
}

/**
 * Merges per-source results and collective group verdicts into one entry per
 * claim, in the order `results` presents them: a solo citation passes
 * through unchanged; an adjacent group collapses to its collective verdict.
 * A group whose collective check was skipped (§ shouldSkipCollective) falls
 * back to its per-source member results instead. A group whose collective
 * check hasn't completed yet (`groupResults` has no entry for it) is omitted
 * entirely — a result page that hasn't finished a group shouldn't report a
 * partial or wrong verdict for it.
 *
 * Drives the summary counts and the wikitext/plaintext exporters — this is
 * the merge that decides which row means "for a group, the collective
 * verdict is the one to publish" (docs/design-plans/
 * 2026-08-07-batch-source-checks-for-edit-suggestions.md §6).
 *
 * @param {Array<object>} results - Per-source results, one per citation.
 * @param {Map<string, object>} groupResults - Collective verdicts (or
 *   `{ skipped: true, groupId }` placeholders), keyed by groupId.
 */
function mergeReportUnits(results, groupResults) {
    const units = [];
    const seenGroups = new Set();
    for (const r of results) {
        if (r.groupSize && r.groupSize > 1) {
            if (seenGroups.has(r.groupId)) continue;
            seenGroups.add(r.groupId);
            const collective = groupResults.get(r.groupId);
            if (collective && !collective.skipped) {
                units.push(collective);
            } else if (collective && collective.skipped) {
                for (const x of results) {
                    if (x.groupId === r.groupId) units.push(x);
                }
            }
        } else {
            units.push(r);
        }
    }
    return units;
}

// --- core/providers.js ---
// LLM provider dispatch. Pure HTTP routing — callers build the prompt.

// Shared call shape for OpenAI-compatible chat-completion upstreams.
// Used by PublicAI/HF (proxy-routed; key injected upstream), HF when the
// caller supplies their own bearer token (direct call to the HF router),
// OpenRouter (which adds attribution headers and surfaces per-call cost),
// and the benchmark runner (which calls direct PublicAI/OpenAI endpoints
// with bearer auth from environment variables).
// `responseFormat` is OpenAI-compatible structured-output: pass
// `{ type: 'json_object' }` to force JSON-only output, or a JSON-schema
// object on backends that support it. OpenRouter passes the param
// through to the underlying model; backends that don't recognise it
// generally ignore it rather than error. Small / weaker instruction-tuned
// models benefit most — Granite 4.1 8B in particular regressed from
// ~0.5% to 13% JSON-parse failures under terser prompts until this
// hint was supplied, after which parse failures returned to 0.
// maxTokens default is deliberately generous (16384): reasoning models such as
// gpt-oss spend output tokens on hidden reasoning *before* writing the answer,
// and a hard claim over a long source can burn several thousand tokens
// reasoning. At the old 2048 default the budget ran out mid-reasoning, so the
// model returned finish_reason "length" with empty content (surfacing as the
// opaque "Invalid API response format"). Reasoning length is also stochastic —
// the same request measured anywhere from ~1.5k to ~4k reasoning tokens — so
// the ceiling needs comfortable headroom, not just enough for the average case.
// 16384 is ~4x the observed worst case. Only tokens actually generated are
// billed, non-reasoning models stop well before the ceiling, and OpenAI-
// compatible endpoints clamp an over-large max_tokens to the model's own limit
// rather than erroring — so this larger default is safe for every shared caller.
async function callOpenAICompatibleChat({ url, apiKey, model, systemPrompt, userContent, label, extraHeaders, extraBody, maxTokens = 16384, temperature = 0.1, responseFormat }) {
    const requestBody = {
        model: model,
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userContent }
        ],
        max_tokens: maxTokens,
        temperature: temperature
    };
    if (extraBody) Object.assign(requestBody, extraBody);
    if (responseFormat) requestBody.response_format = responseFormat;

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    if (extraHeaders) Object.assign(headers, extraHeaders);

    const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        const errorText = await response.text();
        let errorMessage;
        try {
            const errorData = JSON.parse(errorText);
            errorMessage = errorData.error?.message || errorText;
        } catch {
            errorMessage = errorText;
        }
        // 413 is a byte cap on the request body (the CORS proxy rejects the
        // request before the model sees it), not a model context limit — so the
        // fix is a shorter source or a provider that calls its API directly
        // rather than through the size-limited proxy.
        if (response.status === 413) {
            throw new Error(`${label}: the source is too large to send. Trim the source text, or switch to a provider that calls its API directly (Claude, Gemini, or OpenAI).`);
        }
        throw new Error(`${label} API request failed (${response.status}): ${errorMessage}`);
    }

    const data = await response.json();

    const choice = data.choices?.[0];
    if (!choice?.message?.content) {
        // Reasoning models (e.g. gpt-oss) emit hidden reasoning before the
        // answer; if the output budget runs out mid-reasoning the response
        // comes back with finish_reason "length" and empty content. Name that
        // failure specifically so the user knows to raise the budget / simplify
        // the claim rather than assume the source or provider is broken.
        if (choice?.finish_reason === 'length') {
            throw new Error(`${label}: the model ran out of output budget (${maxTokens} tokens) before answering — it spent the whole budget reasoning. Try a shorter source, a simpler claim, or a non-reasoning provider.`);
        }
        throw new Error(`Invalid API response format (${label}: no content${choice?.finish_reason ? `, finish_reason "${choice.finish_reason}"` : ''})`);
    }

    return {
        text: data.choices[0].message.content,
        usage: {
            input: data.usage?.prompt_tokens || 0,
            output: data.usage?.completion_tokens || 0,
            cost_usd: data.usage?.cost ?? null
        }
    };
}

async function callPublicAIAPI({ apiKey, model, systemPrompt, userContent, workerBase = 'https://publicai-proxy.alaexis.workers.dev', maxTokens, temperature }) {
    return callOpenAICompatibleChat({
        url: workerBase,
        apiKey,
        model, systemPrompt, userContent, maxTokens, temperature,
        label: 'PublicAI',
    });
}

// HF direct router endpoint, used when the caller supplies an apiKey.
// Without one, the call falls back to the worker proxy's /hf path, which
// injects an upstream key on the user's behalf.
const HF_DIRECT_URL = 'https://router.huggingface.co/v1/chat/completions';

async function callHuggingFaceAPI({ apiKey, model, systemPrompt, userContent, workerBase = 'https://publicai-proxy.alaexis.workers.dev', maxTokens, temperature, extraHeaders }) {
    const direct = Boolean(apiKey);
    return callOpenAICompatibleChat({
        url: direct ? HF_DIRECT_URL : `${workerBase}/hf`,
        apiKey: direct ? apiKey : undefined,
        model, systemPrompt, userContent, maxTokens, temperature,
        label: 'HuggingFace',
        extraHeaders,
    });
}

// Wikimedia Lift Wing hosts open-weight models (Qwen3) on WMF infrastructure.
// Routed through the same CORS worker as PublicAI/HF, on the `/liftwing` path:
// the worker builds the upstream URL from the model id, works anonymously by
// default (an approved-bot JWT on the worker lifts the rate limit), and strips
// the reasoning models' <think>…</think> blocks from non-streaming responses so
// the verdict parser sees clean JSON. The worker clamps max_tokens to its own
// 4096 ceiling, so we pass that as the default rather than the shared 16384.
// No apiKey — the worker holds any credential.
async function callLiftwingAPI({ model, systemPrompt, userContent, workerBase = 'https://publicai-proxy.alaexis.workers.dev', maxTokens = 4096, temperature }) {
    return callOpenAICompatibleChat({
        url: `${workerBase}/liftwing`,
        model, systemPrompt, userContent, maxTokens, temperature,
        label: 'Lift Wing',
    });
}

// OpenRouter routes OpenAI-compatible requests across many open-weight backends.
// Per-call USD cost is surfaced on response.usage.cost (no opt-in flag required
// as of 2026; the older `usage: { include: true }` parameter is deprecated).
// Attribution headers (HTTP-Referer + X-Title) are recommended by OpenRouter
// for analytics; they don't affect routing.
async function callOpenRouterAPI({ apiKey, model, systemPrompt, userContent, maxTokens, temperature, extraBody, responseFormat }) {
    return callOpenAICompatibleChat({
        url: 'https://openrouter.ai/api/v1/chat/completions',
        apiKey,
        model, systemPrompt, userContent, maxTokens, temperature, extraBody, responseFormat,
        label: 'OpenRouter',
        extraHeaders: {
            'HTTP-Referer': 'https://github.com/alex-o-748/citation-checker-script',
            'X-Title': 'citation-checker-script',
        },
    });
}

// `effort` sets output_config.effort ("low"|"medium"|"high"|"xhigh"|"max") — GA,
// no beta header needed. Only pass it for models that support the effort ladder
// (Sonnet 5, Opus 5/4.8/4.7, Fable 5, Opus 4.6/Sonnet 4.6); Sonnet 4.5 and Haiku
// 4.5 don't recognize it and return 400, so it must stay opt-in per caller rather
// than a blanket default here.
async function callClaudeAPI({ apiKey, model, systemPrompt, userContent, maxTokens = 3000, effort }) {
    const requestBody = {
        model: model,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: "user", content: userContent }]
    };
    if (effort) requestBody.output_config = { effort };

    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API request failed (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    // content[0] is not necessarily the answer: a model with adaptive thinking
    // on (Sonnet 5, Opus 5/4.7/4.8, Fable 5 — enabled by default when `thinking`
    // is omitted, unlike Sonnet 4.6/Opus 4.6 which require it explicitly) returns
    // a `thinking` block first, which has no `.text`. Find the actual text block
    // instead of indexing blindly.
    const textBlock = data.content?.find(block => block.type === 'text');
    if (!textBlock) {
        throw new Error(`Invalid API response format (Claude: no text block${data.stop_reason ? `, stop_reason "${data.stop_reason}"` : ''})`);
    }
    return {
        text: textBlock.text,
        usage: {
            input: data.usage?.input_tokens || 0,
            output: data.usage?.output_tokens || 0,
            cost_usd: null
        }
    };
}

async function callGeminiAPI({ apiKey, model, systemPrompt, userContent, maxTokens = 2048, temperature = 0.1, useStructuredPrompt = true }) {
    const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    // useStructuredPrompt:true (default) uses Gemini's proper systemInstruction
    // + contents shape; the userscript and CLI have always used this.
    // useStructuredPrompt:false concatenates `${systemPrompt}\n\n${userContent}`
    // into a single user turn — the historical benchmark-runner shape, kept
    // available so past benchmark numbers stay reproducible until a deliberate
    // re-baselining run picks the canonical shape.
    const requestBody = useStructuredPrompt
        ? {
            contents: [{ parts: [{ text: userContent }] }],
            systemInstruction: { parts: [{ text: systemPrompt }] },
        }
        : {
            contents: [{ parts: [{ text: `${systemPrompt}\n\n${userContent}` }] }],
        };
    requestBody.generationConfig = {
        maxOutputTokens: maxTokens,
        temperature: temperature,
        // responseMimeType: 'application/json' constrains Gemini to emit
        // syntactically valid JSON only. Without it, Gemini occasionally
        // wraps output in markdown fences or emits prose, both of which
        // the verdict parser fails on. See issue #75.
        responseMimeType: 'application/json'
    };

    const response = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
    });

    const responseData = await response.json();

    if (!response.ok) {
        const errorDetail = responseData.error?.message || response.statusText;
        throw new Error(`API request failed (${response.status}): ${errorDetail}`);
    }

    if (!responseData.candidates?.[0]?.content?.parts?.[0]?.text) {
        throw new Error('Invalid API response format or no content generated.');
    }

    return {
        text: responseData.candidates[0].content.parts[0].text,
        usage: {
            input: responseData.usageMetadata?.promptTokenCount || 0,
            output: responseData.usageMetadata?.candidatesTokenCount || 0,
            cost_usd: null
        }
    };
}

async function callOpenAIAPI({ apiKey, model, systemPrompt, userContent, maxTokens = 2000, temperature = 0.1 }) {
    const requestBody = {
        model: model,
        max_tokens: maxTokens,
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userContent }
        ],
        temperature: temperature
    };

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        const errorText = await response.text();
        let errorMessage;
        try {
            const errorData = JSON.parse(errorText);
            errorMessage = errorData.error?.message || errorText;
        } catch {
            errorMessage = errorText;
        }
        throw new Error(`API request failed (${response.status}): ${errorMessage}`);
    }

    const data = await response.json();

    if (!data.choices?.[0]?.message?.content) {
        throw new Error('Invalid API response format');
    }

    return {
        text: data.choices[0].message.content,
        usage: {
            input: data.usage?.prompt_tokens || 0,
            output: data.usage?.completion_tokens || 0,
            cost_usd: null
        }
    };
}

async function callProviderAPI(name, config) {
    switch (name) {
        case 'publicai':    return await callPublicAIAPI(config);
        case 'huggingface': return await callHuggingFaceAPI(config);
        case 'liftwing':    return await callLiftwingAPI(config);
        case 'openrouter':  return await callOpenRouterAPI(config);
        case 'claude':      return await callClaudeAPI(config);
        case 'gemini':      return await callGeminiAPI(config);
        case 'openai':      return await callOpenAIAPI(config);
        default: throw new Error(`Unknown provider: ${name}`);
    }
}

// --- core/worker.js ---
// Calls to the Cloudflare Worker proxy: source fetching and verification logging.


// Identifies this codebase's direct calls to archive.org (the Wayback
// availability lookup below) — without it, that request carries no
// distinguishing UA at all. fetchViaProxy's calls go through workerBase (our
// own proxy/sidecar infra), which brands its own outbound requests
// separately (see tf-source-fetcher's src/config.js), so this only needs to
// cover the one call this module makes to a third party directly.
//
// Duplicated from core/wikipedia.js's DEFAULT_USER_AGENT rather than
// imported: this module is inlined into main.js by scripts/sync-main.js,
// which strips `import` lines outright rather than resolving them — an
// import here would silently vanish from the userscript build and throw a
// ReferenceError in the browser.
const DEFAULT_USER_AGENT =
    'citation-checker-script (https://github.com/alex-o-748/citation-checker-script)';

// `onRequest`, when supplied, is called once per outbound HTTP call this
// function makes — `{ kind: 'source-fetch', url, status, ok, error, latencyMs,
// bytes }` — regardless of success or failure. It exists for the Internet
// Archive load-test runner (service/ia-load-test.js), which needs per-request
// telemetry that the returned `{content, error, status}` summary can't carry;
// no caller in this repo passed it before that runner, so omitting it is a
// silent no-op and default behavior is unchanged.
async function fetchViaProxy(fetchUrl, pageNum, workerBase, sourceUrl, onRequest) {
    const startedAt = Date.now();
    const report = (status, ok, error, bytes = null) => {
        onRequest?.({ kind: 'source-fetch', url: fetchUrl, status, ok, error, latencyMs: Date.now() - startedAt, bytes });
    };
    try {
        let proxyUrl = `${workerBase}/?fetch=${encodeURIComponent(fetchUrl)}`;
        if (pageNum) {
            proxyUrl += `&page=${pageNum}`;
        }
        const response = await fetch(proxyUrl);
        const proxyStatus = response.status;
        let data = null;
        try {
            data = await response.json();
        } catch (_) {
            report(proxyStatus, false, `non-JSON response (HTTP ${proxyStatus})`);
            return { content: null, error: `Proxy returned non-JSON response (HTTP ${proxyStatus})`, status: proxyStatus };
        }

        const status = (data && typeof data.status === 'number') ? data.status : proxyStatus;

        if (data.error) {
            console.warn('[CitationVerifier] Proxy error:', data.error);
            report(status, false, data.error);
            return { content: null, error: data.error, status };
        }

        if (data.content && data.content.length > 100) {
            const isTruncated = data.truncated === true || data.content.length >= 12000;
            let meta = `Source URL: ${sourceUrl}`;
            if (data.pdf) {
                meta += `\nPDF: ${data.totalPages} pages`;
                if (data.page) {
                    meta += ` (extracted page ${data.page})`;
                }
            }
            if (isTruncated) {
                meta += `\nTruncated: true`;
            }
            report(status, true, null, data.content.length);
            return { content: `${meta}\n\nSource Content:\n${data.content}`, error: null, status };
        }

        if (data.pdf && !pageNum && data.totalPages > 15) {
            console.log('[CitationVerifier] Large PDF without page param, content may be truncated');
        }
        report(status, false, 'empty or too-short content');
        return { content: null, error: 'Source content was empty or too short to verify', status };
    } catch (error) {
        report(null, false, error?.message || String(error));
        console.error('Proxy fetch failed:', error);
        return { content: null, error: error?.message || String(error), status: null };
    }
}

async function findWaybackSnapshot(url, onRequest) {
    const startedAt = Date.now();
    try {
        const apiUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`;
        const response = await fetch(apiUrl, { headers: { 'User-Agent': DEFAULT_USER_AGENT } });
        const data = await response.json();
        onRequest?.({ kind: 'wayback-availability', url, status: response.status, ok: response.ok, error: null, latencyMs: Date.now() - startedAt, bytes: null });
        const snapshot = data?.archived_snapshots?.closest;
        if (snapshot?.available && snapshot.timestamp) {
            return `https://web.archive.org/web/${snapshot.timestamp}id_/${url}`;
        }
    } catch (e) {
        onRequest?.({ kind: 'wayback-availability', url, status: null, ok: false, error: e?.message || String(e), latencyMs: Date.now() - startedAt, bytes: null });
        console.warn('[CitationVerifier] Wayback availability check failed:', e?.message);
    }
    return null;
}

// Always returns { content, error, status }. `content` is the formatted source
// text on success and null on any failure; `error` is a short human-readable
// reason when content is null; `status` is the upstream HTTP status code if the
// proxy reports one (`data.status`), otherwise the proxy's own response status,
// or null if we never got a response at all.
//
// `archiveFirst` skips the live-publisher fetch entirely and goes straight to
// the Wayback snapshot lookup — for the Internet Archive load-test runner,
// which must never send traffic to a third-party publisher (see
// service/ia-load-test.js). Default behavior (live-first, Wayback as a
// fallback) is unchanged for the userscript, CLI, and batch pipeline.
async function fetchSourceContent(url, pageNum, { workerBase = 'https://publicai-proxy.alaexis.workers.dev', archiveFirst = false, onRequest } = {}) {
    if (isGoogleBooksUrl(url)) {
        console.log('[CitationVerifier] Skipping Google Books URL:', url);
        return { content: null, error: 'Google Books URL skipped (no fetchable content)', status: null };
    }

    const archiveInfo = parseArchiveOrgUrl(url);
    if (archiveInfo) {
        const rawUrl = `https://web.archive.org/web/${archiveInfo.timestamp}id_/${archiveInfo.originalUrl}`;
        console.log('[CitationVerifier] Fetching via Wayback raw endpoint');
        return fetchViaProxy(rawUrl, pageNum, workerBase, url, onRequest);
    }

    if (archiveFirst) {
        const waybackUrl = await findWaybackSnapshot(url, onRequest);
        if (!waybackUrl) {
            return { content: null, error: 'No Wayback snapshot available for this URL', status: null };
        }
        return fetchViaProxy(waybackUrl, pageNum, workerBase, url, onRequest);
    }

    const result = await fetchViaProxy(url, pageNum, workerBase, url, onRequest);

    if (!result.content) {
        const waybackUrl = await findWaybackSnapshot(url, onRequest);
        if (waybackUrl) {
            console.log('[CitationVerifier] Live fetch failed, trying Wayback snapshot');
            return fetchViaProxy(waybackUrl, pageNum, workerBase, url, onRequest);
        }
    }

    return result;
}

function logVerification(payload, { workerBase = 'https://publicai-proxy.alaexis.workers.dev' } = {}) {
    // Caller supplies the payload object; build it with buildLogPayload()
    // from core/feedback.js so the keys line up with the Neon columns.
    try {
        fetch(`${workerBase}/log`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        }).catch(() => {});
    } catch (e) {
        // logging should never break the main flow
    }
}

// Ratings and talk-page pointers. Unlike logVerification this resolves, so the
// UI can tell the user whether their rating actually landed — a silent no-op
// on a button the user deliberately pressed would be worse than an error.
function postFeedback(payload, { workerBase = 'https://publicai-proxy.alaexis.workers.dev' } = {}) {
    return fetch(`${workerBase}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    }).then(res => {
        if (!res.ok) throw new Error(`Feedback failed: HTTP ${res.status}`);
        return true;
    });
}

// --- core/feedback.js ---
// Feedback helpers: the check identifier and the verification-log payload.
//
// Every verification mints a short `check_id` client-side, at the moment the
// verdict is parsed. Client-side rather than server-assigned so that logging
// stays fire-and-forget — nothing has to await a round trip before the
// feedback controls attached to a result become usable, and the id still
// exists if the log write failed outright.
//
// The id is what lets a later rating or talk-page comment point back at the
// exact check it is about. Collision risk is 32 bits against a low-volume,
// human-paced event stream; a duplicate would mean one rating attaches to the
// wrong row, which is not worth a longer id in the UI or the section heading.
//
// Inlined into main.js between <core-injected> markers, and importable from
// tests.

// Where comments go. Deliberately the script's main talk page rather than a
// dedicated feedback subpage: volume is low, it is the address already
// advertised in the report footer, and concentrating discussion is worth more
// than tidiness. If it ever gets noisy, archiving is a bot config change
// rather than a redesign.
const FEEDBACK_TALK_PAGE = 'User talk:Alaexis/AI_Source_Verification';

// A one-line page whose entire content is `$1`. It exists only because
// MediaWiki will not accept body text directly in an edit URL; see
// buildCommentUrl(). Nothing about it needs to change when the section layout
// does.
const FEEDBACK_PRELOAD_PAGE = 'User:Alaexis/AI_Source_Verification/feedback-preload';

// Claim text and LLM rationale are unbounded in principle — a pathological
// source or a runaway model response shouldn't push a multi-megabyte row into
// the log table. Both are stored for interpretation, not verbatim archival.
const MAX_LOGGED_TEXT = 2000;

function truncateForLog(value, max = MAX_LOGGED_TEXT) {
    if (value == null) return null;
    const s = String(value).trim();
    if (!s) return null;
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// MediaWiki revision ids are positive integers. Normalising to a number (or
// null) rather than passing whatever the caller had keeps the log column
// numeric, and — because every consumer stringifies the result of this — makes
// the id inert wikitext by construction, with no separate escaping step to
// forget. `wgRevisionId` is 0 on a page that has no revision (a preview, a
// special page), which is not a revision and must not be recorded as one.
function normalizeRevisionId(value) {
    if (value == null) return null;
    const s = String(value).trim();
    if (!/^\d+$/.test(s)) return null;
    const n = Number(s);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// 8 hex characters. `source` is injectable so tests can pin the output;
// production passes nothing and picks up the ambient Web Crypto.
function newCheckId(source) {
    const c = source ?? (typeof crypto !== 'undefined' ? crypto : null);
    if (c && typeof c.randomUUID === 'function') {
        return c.randomUUID().replace(/-/g, '').slice(0, 8);
    }
    if (c && typeof c.getRandomValues === 'function') {
        const buf = c.getRandomValues(new Uint8Array(4));
        return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
    }
    // Neither API available (very old browser, exotic sandbox). Ratings and
    // comments still work; ids are merely less uniformly distributed.
    return Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0');
}

// Shapes the POST /log body. Field names are snake_case to match the Neon
// columns directly, so the worker can insert without a translation layer.
function buildLogPayload(fields = {}) {
    return {
        check_id:        fields.checkId ?? null,
        // 'source' for a single citation, 'group' for the collective verdict
        // over an adjacent-citation group. Without it a group row is
        // indistinguishable from a solo row whose source couldn't be fetched:
        // both carry a null source_url.
        kind:            fields.kind ?? 'source',
        article_url:     fields.articleUrl ?? null,
        article_title:   fields.articleTitle ?? null,
        // The article revision the check ran against. Without it a logged
        // verdict is not reproducible: the page it describes is a moving
        // target, so a disagreement about the verdict can't be separated from
        // an edit to the claim, and two model versions can't be compared
        // because they were never shown the same text.
        revision_id:     normalizeRevisionId(fields.revisionId),
        citation_number: fields.citationNumber ?? null,
        source_url:      fields.sourceUrl ?? null,
        provider:        fields.provider ?? null,
        model:           fields.model ?? null,
        verdict:         fields.verdict ?? null,
        // Sent as `confidence` — not renamed to match `supportScore` — because
        // it must line up with the Neon `verification_logs.confidence` column
        // (see docs/worker-logging-reference.md). Renaming the wire/column
        // name is a separate DB migration; this only renames the internal name.
        confidence:      fields.supportScore ?? null,
        reason_type:     fields.reasonType ?? null,
        // Without these two a thumbs-down is uninterpretable: you know the
        // check was wrong but not what it claimed or why it decided that.
        claim_text:      truncateForLog(fields.claimText),
        llm_comments:    truncateForLog(fields.comments),
        // The passage the model quoted from the source, and the result of
        // checking it against that source (see core/quote.js). Logged
        // together and unconditionally: an unverified quote is exactly the
        // row worth inspecting later, so unlike the UI — which hides it — the
        // log keeps it and lets quote_status say what it is. '' means no
        // quote was offered, which is the correct answer for an omission or
        // an unavailable source.
        source_quote:    truncateForLog(fields.sourceQuote),
        quote_status:    fields.quoteStatus ?? null,
    };
}

// Shapes the POST /feedback body. A row may carry a rating, a corrected
// verdict, a pointer to a talk-page section, or any combination — the comment
// flow sends a wiki_section with no rating, the thumbs send a rating with no
// section, and a thumbs-down that then gets commented on sends both.
//
// No username: the sidebar promises that results are logged without recording
// who ran them, and a rating is part of that promise. A talk-page comment is
// signed, but that signature lives on the wiki, not in this table.
function buildFeedbackPayload(fields = {}) {
    return {
        check_id:          fields.checkId ?? null,
        rating:            fields.rating ?? null,
        corrected_verdict: fields.correctedVerdict ?? null,
        wiki_section:      fields.wikiSection ?? null,
        // Random per-browser token from localStorage. Dedupes repeat clicks
        // and gives a rough distinct-user count; it is not derived from
        // anything about the user.
        client_id:         fields.clientId ?? null,
    };
}

// Wraps machine-inserted text so it can't be read as wikitext. Whitespace is
// collapsed because these land inline in a bullet list.
function nowikiWrap(text) {
    const s = String(text ?? '')
        .replace(/<\s*\/?\s*nowiki\s*\/?\s*>/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
    return s ? `<nowiki>${s}</nowiki>` : '';
}

// MediaWiki titles cannot contain = < > [ ] { } | # _, so an article title is
// already safe to drop into a heading; collapsing whitespace is enough. The
// citation number comes from DOM text, so it gets filtered.
function buildTalkSectionTitle({ articleTitle, citationNumber, checkId } = {}) {
    const title = String(articleTitle ?? '').replace(/\s+/g, ' ').trim() || 'Unknown article';
    const num = String(citationNumber ?? '').replace(/[^\w.,\s-]/g, '').replace(/\s+/g, ' ').trim();
    return `Feedback: ${title}${num ? ` [${num}]` : ''} (check ${checkId ?? 'unknown'})`;
}

// Title of the collapsed box holding the tool's own output, and the label
// introducing the editor's prose. Exported because they are the seam between
// this layout and anything reading it back — the talk-page scraper tells
// machine context from human text by these two strings.
const CHECK_DETAILS_TITLE = 'Check details';
const EDITOR_EXPLANATION_LABEL = "Editor's explanation";

// A talk-page section, split by who wrote what: everything the tool produced
// is collapsed behind {{hidden begin}}, and everything the editor supplies —
// the corrected verdict and their explanation — stays visible. A reader
// scanning the talk page sees the human argument; the machine context is one
// click away when they want to check it.
//
// The begin/end template pair is deliberate. {{collapse|...}} would make the
// bullets a template *parameter*, where a stray | or = in a source URL
// silently truncates the box; as body text between two templates they are
// inert. {{cot}}/{{cob}} is also wrong here — it renders "the following
// discussion is closed", and this was never a discussion.
//
// It is preloaded into Wikipedia's own new section form rather than posted by
// the script, so this text is a starting point the editor sees and can
// change, not a finished comment.
//
// The check id appears twice on purpose: in the heading, where a human reading
// the talk page can see which check is under discussion, and in a trailing
// HTML comment, which is what the talk-page scraper can match on without
// having to parse headings. HTML comments are also how the "write here"
// guidance is delivered — visible in the edit box, invisible once published.
//
// Nothing here emits a signature, and nothing here may. Four tildes are not
// text: they are an instruction to MediaWiki's pre-save transform, which runs
// over the *whole page* on every save, so a preloaded signature belongs to
// whoever saves next rather than to the editor who opened the form. If the
// tildes survive that first save unexpanded — the new topic tool handles
// signing itself — they sit in the page as a landmine until some unrelated
// account saves it and gets its own name and timestamp stamped in. That is
// exactly what happened to check 4d9d0118, which a passing bot signed.
// Signing is the editor's, and their editor's, business; we only ask for it.
//
// The same trap applies to the guidance below, which is why it spells out
// "sign" in words. Literal tildes inside an HTML comment are still expanded by
// the pre-save transform — invisible in the rendered page, and still a
// landmine in the wikitext.
function buildTalkSectionBody(fields = {}) {
    const {
        articleUrl, articleTitle, citationNumber, claimText, sourceUrl,
        verdict, comments, providerName, model, correctedVerdict, checkId,
        revisionId, revisionUrl,
    } = fields;

    const clean = v => String(v ?? '').replace(/\s+/g, ' ').trim();
    const label = clean(articleTitle) || clean(articleUrl);
    const toolLines = [];

    if (articleUrl && label) {
        const cite = clean(citationNumber);
        // The revision is what makes the report reproducible, and it belongs
        // on the Article line because it is a property of the article, not of
        // the check: the plain link goes to whatever the page says today, so
        // without the permalink a reader arriving at this section a month
        // later cannot tell whether they are looking at the text the tool
        // read. Linked when the caller supplied a permalink, bare otherwise —
        // the number alone still identifies the revision.
        const rev = normalizeRevisionId(revisionId);
        const revText = rev === null ? '' : (revisionUrl
            ? `[${encodeURI(String(revisionUrl))} ${rev}]`
            : String(rev));
        toolLines.push(`* '''Article:''' [${encodeURI(String(articleUrl))} ${label}]${cite ? `, citation [${cite}]` : ''}${revText ? `, revision ${revText}` : ''}`);
    }
    if (sourceUrl) {
        // encodeURI neutralises {{ }} (the one wikitext construct a citation
        // URL could plausibly smuggle in) while leaving the link clickable.
        toolLines.push(`* '''Source:''' ${encodeURI(String(sourceUrl))}`);
    }
    if (verdict) {
        const by = [clean(providerName), clean(model)].filter(Boolean).join(', ');
        toolLines.push(`* '''Tool's verdict:''' ${clean(verdict)}${by ? ` (${by})` : ''}`);
    }
    const claim = nowikiWrap(claimText);
    if (claim) toolLines.push(`* '''Claim checked:''' ${claim}`);
    const reasoning = nowikiWrap(comments);
    if (reasoning) toolLines.push(`* '''Tool's reasoning:''' ${reasoning}`);

    const blocks = [];

    if (toolLines.length) {
        blocks.push([
            `{{hidden begin|title=${CHECK_DETAILS_TITLE}}}`,
            ...toolLines,
            '{{hidden end}}',
        ].join('\n'));
    }
    // The editor's, not the tool's, so it stays outside the box — on a
    // thumbs-down this line is the disagreement itself, and burying it would
    // leave the visible section saying nothing.
    if (correctedVerdict) {
        blocks.push(`'''Editor says it should be:''' ${clean(correctedVerdict)}`);
    }
    // Label and guidance share a line so that writing at the obvious spot —
    // after the invisible comment — renders as "Editor's explanation: <prose>"
    // rather than leaving a bold heading dangling above the text.
    blocks.push(
        `'''${EDITOR_EXPLANATION_LABEL}:''' <!-- Write your explanation here, then sign and publish. -->`,
        `<!-- source-verifier check: ${checkId ?? 'unknown'} -->`,
    );

    return blocks.join('\n\n');
}

// The URL that opens Wikipedia's own "add new section" form with the context
// already in the edit box.
//
// A URL can name the page and set the heading, but there is no parameter for
// body text — hence preload, which starts the edit box off with the contents
// of another page, substituting $1, $2… from preloadparams. FEEDBACK_PRELOAD_PAGE
// contains nothing but `$1`, so the whole body travels as one parameter and
// buildTalkSectionBody stays the only place the layout is defined. That page
// never needs to change.
function buildCommentUrl(fields = {}, {
    wikiBase = 'https://en.wikipedia.org/w/index.php',
    talkPage = FEEDBACK_TALK_PAGE,
    preloadPage = FEEDBACK_PRELOAD_PAGE,
} = {}) {
    const params = new URLSearchParams();
    params.set('title', talkPage);
    params.set('action', 'edit');
    params.set('section', 'new');
    params.set('preloadtitle', buildTalkSectionTitle(fields));
    params.set('preload', preloadPage);
    params.set('preloadparams[]', buildTalkSectionBody(fields));
    return `${wikiBase}?${params.toString()}`;
}

// --- core/submission.js ---
// Dataset-submission helpers. Pure logic for building a prefilled Google Form
// URL so Wikipedia editors can contribute citation/ground-truth examples
// without an API or auth. Inlined into main.js between <core-injected>
// markers, and importable from tests.
//
// To activate the feature once a Form exists:
//   1. Create a Google Form whose questions correspond to the keys in
//      DATASET_SUBMISSION_ENTRY_IDS (articleUrl, citationNumber, claimText,
//      sourceUrl, llmVerdict, llmRationale, llmProvider, llmModel,
//      editorHandle, notes).
//   2. Use the Form's "Get pre-filled link" tool, fill every field with a
//      unique sentinel, and copy the resulting URL.
//   3. Replace DATASET_SUBMISSION_FORM_URL with the /viewform URL, and
//      replace each `entry.PLACEHOLDER_*` value with the matching
//      `entry.<numeric-id>` from the pre-filled link.
//   4. Run `npm run build` so the constants are re-inlined into main.js.

// Sentinel substring that marks scaffolded values as not-yet-configured.
// isDatasetSubmissionConfigured() looks for this exact token; don't reuse it
// anywhere else in this file.
const DATASET_SUBMISSION_PLACEHOLDER = 'PLACEHOLDER';

const DATASET_SUBMISSION_FORM_URL =
    'https://docs.google.com/forms/d/e/1FAIpQLSdn0mnTHLV7NQZSmEbQXgLRzkJEfd6tcvVffLdInGpVyySkBA/viewform';

const DATASET_SUBMISSION_ENTRY_IDS = {
    articleUrl:     'entry.1530874375',
    citationNumber: 'entry.1417860793',
    claimText:      'entry.1673425995',
    sourceUrl:      'entry.1675972910',
    llmVerdict:     'entry.270831712',
    llmRationale:   'entry.805615048',
    llmProvider:    'entry.230272168',
    llmModel:       'entry.166995',
    // Populated only for SOURCE UNAVAILABLE rows where the proxy reported an
    // HTTP status — lets the dataset distinguish "we never fetched" from
    // "we fetched and the source returned 4xx/5xx".
    fetchStatus:    'entry.375255643',
    editorHandle:   'entry.362287943',
    notes:          'entry.133790832',
    // The verbatim passage the model quoted from the source, and whether it
    // was found in that source (see core/quote.js). Optional — see
    // DATASET_SUBMISSION_OPTIONAL_KEYS: until a matching Form question exists
    // these stay on PLACEHOLDER and are simply left out of the prefilled URL,
    // rather than disabling the whole submission button.
    llmQuote:         'entry.PLACEHOLDER_QUOTE',
    llmQuoteVerified: 'entry.PLACEHOLDER_QUOTE_VERIFIED',
};

// Keys that isDatasetSubmissionConfigured() does not require. Add a Form
// question for these, paste in the real entry ids, and they start flowing;
// leave them and everything else keeps working.
const DATASET_SUBMISSION_OPTIONAL_KEYS = Object.freeze([
    'llmQuote',
    'llmQuoteVerified',
]);

function isDatasetSubmissionConfigured(
    formUrl = DATASET_SUBMISSION_FORM_URL,
    entryIds = DATASET_SUBMISSION_ENTRY_IDS,
) {
    if (!formUrl || formUrl.includes(DATASET_SUBMISSION_PLACEHOLDER)) return false;
    return Object.entries(entryIds).every(
        ([key, id]) => DATASET_SUBMISSION_OPTIONAL_KEYS.includes(key)
            || (typeof id === 'string' && id && !id.includes(DATASET_SUBMISSION_PLACEHOLDER))
    );
}

function buildDatasetSubmissionUrl(
    fields,
    formUrl = DATASET_SUBMISSION_FORM_URL,
    entryIds = DATASET_SUBMISSION_ENTRY_IDS,
) {
    const params = new URLSearchParams();
    params.set('usp', 'pp_url');
    for (const key of Object.keys(entryIds)) {
        const entryId = entryIds[key];
        // Skip fields whose Form question hasn't been created yet; sending
        // 'entry.PLACEHOLDER_*' would just add a junk query parameter.
        if (typeof entryId !== 'string' || !entryId || entryId.includes(DATASET_SUBMISSION_PLACEHOLDER)) continue;
        const value = fields == null ? undefined : fields[key];
        if (value === undefined || value === null || value === '') continue;
        params.set(entryId, String(value));
    }
    return `${formUrl}?${params.toString()}`;
}
// </core-injected>

// Cap for manually-pasted source text. Unlike fetched sources — which the
// Cloudflare Worker proxy truncates server-side before they reach us — a manual
// paste goes straight into the request body, so an oversized paste hits the
// proxy's request-body limit (HTTP 413 "Request body too large"). We trim here
// to stay comfortably under that limit (currently ~100 KB): budget = 100 KB
// minus the ~6.5 KB system prompt, the claim/user-prompt boilerplate, and
// JSON-escaping + UTF-8 overhead on the source itself. 80 000 chars leaves room.
//
// Deliberately *below* the </core-injected> marker: it has no counterpart in
// core/, so while it sat inside the injected region the next `npm run build`
// silently deleted it, taking loadManualSourceText() with it.
const MAX_MANUAL_SOURCE_CHARS = 80000;

// Experimental: opt-in override that routes Lift Wing / HuggingFace LLM calls
// through the tf-llm-router Toolforge tool
// (https://github.com/alex-o-748/tf-llm-router) instead of the Cloudflare
// Worker CORS proxy. Off by default for everyone; flip it on for yourself by
// running `localStorage.setItem('source_verifier_toolforge_llm_router', 'true')`
// in the browser console. Only overrides the `workerBase` passed to
// callLiftwingAPI/callHuggingFaceAPI (core/providers.js) — source fetching,
// /log, and /feedback keep using the Worker, since tf-llm-router doesn't
// implement those routes.
const TOOLFORGE_LLM_ROUTER_BASE = 'https://llm-router.toolforge.org';
function useToolforgeLlmRouter() {
    try {
        return localStorage.getItem('source_verifier_toolforge_llm_router') === 'true';
    } catch {
        return false;
    }
}

// Experimental: opt-in override that routes source fetching through the
// tf-source-fetcher Toolforge tool
// (https://github.com/alex-o-748/tf-source-fetcher) instead of the Cloudflare
// Worker CORS proxy. Off by default for everyone — per the tool's README it
// has not yet been cleared with WMCS for unattended fetching from Wikimedia
// infrastructure, so live traffic must not be switched over until that
// approval lands. Flip it on for yourself by running
// `localStorage.setItem('source_verifier_toolforge_source_fetcher', 'true')`
// in the browser console. Only overrides the `workerBase` passed to
// fetchSourceContent (core/worker.js) — /log and /feedback keep using the
// Worker, since tf-source-fetcher doesn't implement those routes.
const TOOLFORGE_SOURCE_FETCHER_BASE = 'https://source-fetcher.toolforge.org';
function useToolforgeSourceFetcher() {
    try {
        return localStorage.getItem('source_verifier_toolforge_source_fetcher') === 'true';
    } catch {
        return false;
    }
}

    // ========================================
    // UI LOCALIZATION (i18n)
    // ========================================
    // The interface is English by default. When the script runs on a wiki whose
    // language has a message table below (French, Spanish), user-facing strings
    // are shown in that language. Only the on-screen UI, notifications, dialogs
    // and report output are localized — the LLM prompts (in core/prompts.js)
    // stay in English by design, since the few-shot examples are tuned against
    // the benchmark.
    //
    // Strings are keyed by their English source text: `this.t('Verify Claim')`.
    // The per-language table supplies the override; a missing key falls back to
    // the English key itself, so untranslated strings degrade gracefully. Use
    // `{name}`-style placeholders for interpolation: t('Set {name} API Key', {name}).
    //
    // Adding a language: write its table, register it in MESSAGES, and add its
    // name to PROMPT_LANGUAGES so verdict comments come back in that language
    // too. detectUiLang() picks it up automatically — no other wiring.
    // `tests/i18n.test.js` fails if a table drifts out of parity with French.

    const FR_MESSAGES = {
        // Sidebar structure
        'Selected Claim': 'Affirmation sélectionnée',
        'Click on a reference number [1] next to a claim to verify it against its source.':
            'Cliquez sur un numéro de référence [1] à côté d’une affirmation pour la vérifier par rapport à sa source.',
        'Source Content': 'Contenu de la source',
        'No source loaded yet.': 'Aucune source chargée pour le moment.',
        'Verification Result': 'Résultat de la vérification',

        // Buttons and inputs
        'Close': 'Fermer',
        'Set API Key': 'Définir la clé API',
        'Verify Claim': 'Vérifier l’affirmation',
        'Verifying...': 'Vérification…',
        'Change Key': 'Modifier la clé',
        'Remove API Key': 'Supprimer la clé API',
        'Paste the source text here...': 'Collez le texte de la source ici…',
        'Load Text': 'Charger le texte',
        'Cancel': 'Annuler',
        'Paste source text manually': 'Coller le texte de la source manuellement',
        'Replace the fetched source content with text you paste in (e.g., the full article from The Wikipedia Library)':
            'Remplacer le contenu récupéré de la source par un texte que vous collez (par ex. l’article complet de la Bibliothèque Wikipédia)',
        'Verify All Citations': 'Vérifier toutes les citations',
        'Stop': 'Arrêter',
        'Back to Report': 'Retour au rapport',
        'Save': 'Enregistrer',
        'Give feedback': 'Signaler un problème',
      
        // Feedback controls
        'Was this right?': 'Est-ce correct ?',
        'Yes': 'Oui',
        'No': 'Non',
        'This verdict looks right': 'Ce verdict semble correct',
        'This verdict looks wrong': 'Ce verdict semble erroné',
        'What should it have been?': 'Quel aurait dû être le verdict ?',
        'Thanks — recorded.': 'Merci — c’est enregistré.',
        'Could not record that, sorry.': 'Impossible d’enregistrer, désolé.',
        'Comment': 'Commenter',
        'Edit Section': 'Modifier la section',
        'Copy Report (Wikitext)': 'Copier le rapport (wikicode)',
        'Copy Report (Plain Text)': 'Copier le rapport (texte brut)',

        // Provider info
        '✓ Using your {name} API key': '✓ Utilisation de votre clé API {name}',
        '✓ Free to use. Optional: ': '✓ Gratuit. Facultatif : ',
        'add your {name} API key': 'ajoutez votre clé API {name}',
        '✓ Free to use': '✓ Gratuit',
        'API key configured for {name}': 'Clé API configurée pour {name}',
        'API key required for {name}': 'Clé API requise pour {name}',
        'Results are logged for research. Your username is not recorded.':
            'Les résultats sont enregistrés à des fins de recherche. Votre nom d’utilisateur n’est pas enregistré.',
        'Claim scope': 'Portée de l’affirmation',
        'Full claim': 'Affirmation complète',
        'Last sentence only': 'Dernière phrase uniquement',
        '"Last sentence only" avoids flagging a multi-sentence claim as unsupported just because an earlier sentence lacks a citation.':
            '« Dernière phrase uniquement » évite de signaler une affirmation de plusieurs phrases comme non étayée simplement parce qu’une phrase précédente manque de source.',

        // Verifier tab + first-run notification
        'Verify': 'Vérifier',
        'Verify claims against sources': 'Vérifier les affirmations par rapport aux sources',
        'Citation Verifier': 'Vérificateur de citations',
        'Citation Verifier installed — click the ':
            'Vérificateur de citations installé — cliquez sur l’onglet ',
        ' tab to get started.': ' pour commencer.',

        // Source display
        '✓ PDF content extracted{pageInfo}': '✓ Contenu PDF extrait{pageInfo}',
        ' (page {page} of {total})': ' (page {page} sur {total})',
        ' ({pages} pages)': ' ({pages} pages)',
        '✓ Content fetched successfully': '✓ Contenu récupéré avec succès',
        'Content will be fetched by AI during verification.':
            'Le contenu sera récupéré par l’IA lors de la vérification.',
        '⚠ The source is long and can only be checked partially.':
            '⚠ La source est longue et ne peut être vérifiée que partiellement.',
        'Source URL:': 'URL de la source :',
        'No URL found. Please paste the source text below:':
            'Aucune URL trouvée. Veuillez coller le texte de la source ci-dessous :',
        'Manual Source Text:': 'Texte de source manuel :',
        'No source loaded.': 'Aucune source chargée.',
        'Click "Verify Claim" to verify the selected claim against the source.':
            'Cliquez sur « Vérifier l’affirmation » pour vérifier l’affirmation sélectionnée par rapport à la source.',
        'Part of a group of {count} citations: {numbers}':
            'Fait partie d’un groupe de {count} citations : {numbers}',

        // Verdicts (full, shown for a single verification)
        'SUPPORTED': 'CONFIRMÉE',
        'PARTIALLY SUPPORTED': 'PARTIELLEMENT CONFIRMÉE',
        'NOT SUPPORTED': 'NON CONFIRMÉE',
        'SOURCE UNAVAILABLE': 'SOURCE INDISPONIBLE',
        'ERROR': 'ERREUR',
        // Verdicts (short, shown on report cards/chips)
        'Supported': 'Confirmée',
        'Partial': 'Partielle',
        'Not Supported': 'Non confirmée',
        'Unavailable': 'Indisponible',
        // Reason tag on a 'not supported' verdict
        'Contradiction': 'Contradiction',
        'Omission': 'Omission',

        // Report progress
        'Checking citation [{num}]': 'Vérification de la citation [{num}]',
        'Fetching source for [{num}]': 'Récupération de la source pour [{num}]',
        'Verifying citation [{num}]': 'Analyse de la citation [{num}]',
        'Rate limited, retrying in {secs}s...':
            'Limite de débit atteinte, nouvelle tentative dans {secs} s…',
        'Checking combined sources {token}': 'Vérification des sources combinées {token}',
        'Completed: {count} citations checked': 'Terminé : {count} citations vérifiées',
        'Completed: {count} citation checked': 'Terminé : {count} citation vérifiée',
        'Cancelled after {done} of {total} citations': 'Annulé après {done} sur {total} citations',
        'Cancelled after {done} of {total} citation': 'Annulé après {done} sur {total} citation',
        ' · ~{duration} remaining': ' · ~{duration} restant(e)(s)',

        // Report summary
        'supported': 'confirmées',
        'partial': 'partielles',
        'not supported': 'non confirmées',
        'unavailable': 'indisponibles',
        'errors': 'erreurs',
        'Show {label} citations': 'Afficher les citations {label}',
        'Hide {label} citations': 'Masquer les citations {label}',
        '{count} citations checked': '{count} citations vérifiées',
        '{count} citation checked': '{count} citation vérifiée',
        '{citations} citations across {claims} claims':
            '{citations} citations réparties sur {claims} affirmations',
        '{citations} citations across {claims} claim':
            '{citations} citations réparties sur {claims} affirmation',
        ' · {count} hidden by filter': ' · {count} masquées par le filtre',
        ' · {input} input + {output} output tokens':
            ' · {input} jetons d’entrée + {output} jetons de sortie',
        'Revision: ': 'Révision : ',

        // Report cards / groups
        '⚠ Source is long, only partially checked.':
            '⚠ Source longue, vérifiée partiellement seulement.',
        '⚠ Combined sources are long, only partially checked.':
            '⚠ Sources combinées longues, vérifiées partiellement seulement.',
        'Group of {size} · {numbers}': 'Groupe de {size} · {numbers}',
        'Checking combined sources…': 'Vérification des sources combinées…',
        'Individual sources': 'Sources individuelles',
        'Combined verdict': 'Verdict combiné',
        'All citations are hidden by the current filters. Click a filter above to show them.':
            'Toutes les citations sont masquées par les filtres actuels. Cliquez sur un filtre ci-dessus pour les afficher.',

        // Notifications / dialogs
        'Report copied to clipboard!': 'Rapport copié dans le presse-papiers !',
        'No citations found on this page.': 'Aucune citation trouvée sur cette page.',
        'Are you sure you want to remove the stored API key?':
            'Voulez-vous vraiment supprimer la clé API enregistrée ?',
        'Enter your {name} API Key...': 'Saisissez votre clé API {name}…',
        'Set {name} API Key': 'Définir la clé API {name}',
        'Enter your {name} API Key to enable source verification:':
            'Saisissez votre clé API {name} pour activer la vérification des sources :',
        'This will verify {citations} citations from {sources} unique sources.{groupNote}\n\nEstimated time: ~{minutes} minutes.\n\nContinue?':
            'Cette action vérifiera {citations} citations provenant de {sources} sources uniques.{groupNote}\n\nDurée estimée : ~{minutes} minutes.\n\nContinuer ?',
        'This will verify {citations} citations from {sources} unique sources.{groupNote}\n\nEstimated time: ~{minutes} minute.\n\nContinue?':
            'Cette action vérifiera {citations} citations provenant de {sources} sources uniques.{groupNote}\n\nDurée estimée : ~{minutes} minute.\n\nContinuer ?',
        '\n\nThis includes {count} combined-source checks for adjacent citation groups.':
            '\n\nCela inclut {count} vérifications de sources combinées pour les groupes de citations adjacentes.',
        '\n\nThis includes {count} combined-source check for adjacent citation groups.':
            '\n\nCela inclut {count} vérification de sources combinées pour les groupes de citations adjacentes.',

        // Generated result comments
        'No URL found in reference': 'Aucune URL trouvée dans la référence',
        'None of the grouped sources could be retrieved.':
            'Aucune des sources groupées n’a pu être récupérée.',
        'Could not fetch source content': 'Impossible de récupérer le contenu de la source',

        // Exported reports (wikitext + plain text)
        'Submit': 'Signaler',
        'Citation verification report': 'Rapport de vérification des citations',
        'This is an experimental check of the article sources by [[User:Alaexis/AI_Source_Verification|Citation Verifier]]. Treat it with caution, be aware of its [[User:Alaexis/AI_Source_Verification#Limitations|limitations]] and feel free to leave feedback at [[User_talk:Alaexis/AI_Source_Verification|the talk page]].':
            'Ceci est une vérification expérimentale des sources de l’article par [[:en:User:Alaexis/AI_Source_Verification|Citation Verifier]]. Les résultats sont à prendre avec précaution : tenez compte de ses [[:en:User:Alaexis/AI_Source_Verification#Limitations|limites]] et n’hésitez pas à laisser un retour sur [[:en:User_talk:Alaexis/AI_Source_Verification|la page de discussion de l’outil]].',
        'Revision checked: ': 'Révision vérifiée : ',
        '! # !! Verdict !! Source !! Comments !! class="unsortable" | Submit':
            '! # !! Verdict !! Source !! Commentaires !! class="unsortable" | Signaler',
        '! # !! Verdict !! Source !! Comments':
            '! # !! Verdict !! Source !! Commentaires',
        '{{tick}} Supported': '{{Oui-}} Confirmée',
        '{{bang}} Partially supported': 'Partiellement confirmée',
        '{{cross}} Not supported': '{{Non-}} Non confirmée',
        '{{hmmm}} Source unavailable': 'Source indisponible',
        "''(Combined sources are long, only partially checked.)''":
            "''(Sources combinées longues, vérifiées partiellement seulement.)''",
        "''(Source is long, only partially checked.)''":
            "''(Source longue, vérifiée partiellement seulement.)''",
        '(combined)': '(combinées)',
        // Link text for the source column of the wikitext table: [url source]
        'source': 'source',
        "'''Summary:''' {supported} supported, {partial} partially supported, {notSupported} not supported, {unavailable} source unavailable out of {claims}.":
            "'''Résumé :''' {supported} confirmées, {partial} partiellement confirmées, {notSupported} non confirmées, {unavailable} sources indisponibles sur {claims}.",
        '{count} citations': '{count} citations',
        '{count} citation': '{count} citation',
        '{claims} claims ({citations} citations)': '{claims} affirmations ({citations} citations)',
        '{claims} claim ({citations} citations)': '{claims} affirmation ({citations} citations)',
        'a PublicAI-hosted open-source LLM': 'un LLM open source hébergé par PublicAI',
        'a HuggingFace-hosted open-source LLM ({model})':
            'un LLM open source hébergé par HuggingFace ({model})',
        'a Wikimedia Lift Wing-hosted open-source LLM ({model})':
            'un LLM open source hébergé par Wikimedia Lift Wing ({model})',
        'Generated by [[User:Alaexis/AI_Source_Verification|Citation Verifier]] using {model} on ~~~~~.':
            'Généré par [[:en:User:Alaexis/AI_Source_Verification|Citation Verifier]] avec {model} le ~~~~~.',
        ' Tokens used: {input} input, {output} output.':
            ' Jetons utilisés : {input} en entrée, {output} en sortie.',
        'Citation Verification Report: {title}': 'Rapport de vérification des citations : {title}',
        'Provider: {name}': 'Fournisseur : {name}',
        'Revision: {rev}': 'Révision : {rev}',
        'Claim: {text}': 'Affirmation : {text}',
        'Sources: {urls}': 'Sources : {urls}',
        'Source: {url}': 'Source : {url}',
        'Quote: "{text}"': 'Citation : « {text} »',
        'Comments: {text}': 'Commentaires : {text}',
        'From the source': 'Extrait de la source',
        'Note: Combined sources are long, only partially checked.':
            'Note : Sources combinées longues, vérifiées partiellement seulement.',
        'Note: Source is long, only partially checked.':
            'Note : Source longue, vérifiée partiellement seulement.',
        'Tokens used: {input} input, {output} output':
            'Jetons utilisés : {input} en entrée, {output} en sortie',
        // Sidebar chrome and the state-driven panel
        'Settings': 'Paramètres',
        'Done': 'Terminé',
        'Open settings': 'Ouvrir les paramètres',
        'Upload PDF': 'Téléverser un PDF',
        'or paste the text below': 'ou collez le texte ci-dessous',
        'Click any citation number in the article to check whether its source actually supports the claim.':
            'Cliquez sur un numéro de référence dans l’article pour vérifier si sa source appuie réellement l’affirmation.',
        'Ready · free, no setup needed': 'Prêt · gratuit, aucune configuration',
        'Ready · using your API key': 'Prêt · avec votre clé API',
        'Add an API key in settings to start':
            'Ajoutez une clé API dans les paramètres pour commencer',
        'Checking citations…': 'Vérification des citations…',
        'Model: {model}': 'Modèle : {model}',
        // Verdict framing: the assessment is attributed, and each verdict says
        // what the editor should do next.
        'AI assessment': 'Évaluation par IA',
        'Read the source before changing the article — this is a machine reading, not a fact.':
            'Lisez la source avant de modifier l’article — il s’agit d’une lecture automatique, pas d’un fait.',
        'Spot-check the source yourself — this is a machine reading, not a fact.':
            'Vérifiez la source par vous-même — il s’agit d’une lecture automatique, pas d’un fait.',
        'The tool could not read this source. Try pasting the text or uploading a PDF.':
            'L’outil n’a pas pu lire cette source. Essayez de coller le texte ou de téléverser un PDF.',
        'How accurate is this?': 'Quelle est la fiabilité de cet outil ?',
        'Measured against 186 human-labelled citations, a "not supported" flag was confirmed by a reviewer roughly two thirds of the time. Treat every verdict as a reason to read the source, not as a conclusion.':
            'Sur 186 citations annotées par des humains, un signalement « non confirmée » a été validé par un relecteur dans environ deux tiers des cas. Considérez chaque verdict comme une raison de lire la source, et non comme une conclusion.',

        // Status strip
        'Could not extract claim text': 'Impossible d’extraire le texte de l’affirmation',
        'No URL found in reference. Please paste the source text below.':
            'Aucune URL trouvée dans la référence. Veuillez coller le texte de la source ci-dessous.',
        'Google Books sources cannot be fetched. Please paste the source text below.':
            'Les sources Google Books ne peuvent pas être récupérées. Veuillez coller le texte de la source ci-dessous.',
        'Fetching source content...': 'Récupération du contenu de la source…',
        'Could not fetch source{status}{reason}. Please paste the source text below.':
            'Impossible de récupérer la source{status}{reason}. Veuillez coller le texte de la source ci-dessous.',
        'Source fetched. Ready to verify.': 'Source récupérée. Prêt à vérifier.',
        'Ready to verify claim against source': 'Prêt à vérifier l’affirmation par rapport à la source',
        'Error: {message}': 'Erreur : {message}',
        'Please enter some source text': 'Veuillez saisir un texte de source',
        'Source text loaded (trimmed to {count} characters). Ready to verify.':
            'Texte de la source chargé (tronqué à {count} caractères). Prêt à vérifier.',
        'Source text loaded. Ready to verify.': 'Texte de la source chargé. Prêt à vérifier.',
        'Cancelled': 'Annulé',
        'Please choose a PDF file.': 'Veuillez choisir un fichier PDF.',
        'Reading {name}…': 'Lecture de {name}…',
        'This PDF has no selectable text (it looks scanned). Please paste the relevant passage instead.':
            'Ce PDF ne contient pas de texte sélectionnable (il semble numérisé). Veuillez plutôt coller le passage concerné.',
        'Loaded text from {name}. Ready to verify.': 'Texte chargé depuis {name}. Prêt à vérifier.',
        'Could not read that PDF: {message}. Try pasting the text instead.':
            'Impossible de lire ce PDF : {message}. Essayez plutôt de coller le texte.',
        'Switched to {name}': 'Basculé vers {name}',
        'Paste replacement source text below, then click Load Text.':
            'Collez le texte de remplacement ci-dessous, puis cliquez sur « Charger le texte ».',
        'This provider does not require an API key.': 'Ce fournisseur ne nécessite pas de clé API.',
        'API key set successfully!': 'Clé API enregistrée !',
        'This provider does not use a stored API key.': 'Ce fournisseur n’utilise pas de clé API enregistrée.',
        'API key removed successfully!': 'Clé API supprimée !',
        'Missing API key (for this provider), claim, or source content':
            'Clé API (pour ce fournisseur), affirmation ou contenu de la source manquant',
        'Verifying claim against source...': 'Vérification de l’affirmation par rapport à la source…',
        'Verification complete!': 'Vérification terminée !',

        // Pre-filled wiki edit summary
        'source does not support claim (checked with [[User:Alaexis/AI_Source_Verification|Source Verifier]])':
            'la source n’appuie pas l’affirmation (vérifié avec [[:en:User:Alaexis/AI_Source_Verification|Source Verifier]])',
    };

    // Spanish. es.wikipedia's interface deliberately avoids addressing the
    // reader in any second person, because tú/vos/usted all carry regional
    // baggage. Two registers do the work, and the split matters: an *action
    // label* — button, link, menu item, input placeholder — takes a bare
    // infinitive ("Subir archivo", "Buscar en Wikipedia"), but a *sentence* of
    // running prose takes impersonal "se" ("Se puede hacer clic en…"), because
    // a bare infinitive reads as a clipped fragment there. No tuteo, no
    // possessive "tu", and «angle quotes» over "".
    const ES_MESSAGES = {
        // Sidebar structure
        'Selected Claim': 'Afirmación seleccionada',
        'Click on a reference number [1] next to a claim to verify it against its source.':
            'Se puede hacer clic en un número de referencia [1] junto a una afirmación para verificarla con su fuente.',
        'Source Content': 'Contenido de la fuente',
        'No source loaded yet.': 'Todavía no se ha cargado ninguna fuente.',
        'Verification Result': 'Resultado de la verificación',

        // Buttons and inputs
        'Close': 'Cerrar',
        'Set API Key': 'Configurar la clave API',
        'Verify Claim': 'Verificar la afirmación',
        'Verifying...': 'Verificando…',
        'Change Key': 'Cambiar la clave',
        'Remove API Key': 'Eliminar la clave API',
        'Paste the source text here...': 'Pegar aquí el texto de la fuente…',
        'Load Text': 'Cargar el texto',
        'Cancel': 'Cancelar',
        'Paste source text manually': 'Pegar el texto de la fuente manualmente',
        'Replace the fetched source content with text you paste in (e.g., the full article from The Wikipedia Library)':
            'Sustituir el contenido obtenido de la fuente por un texto pegado manualmente (por ejemplo, el artículo completo de la Biblioteca de Wikipedia)',
        'Verify All Citations': 'Verificar todas las citas',
        'Stop': 'Detener',
        'Back to Report': 'Volver al informe',
        'Save': 'Guardar',
        'Give feedback': 'Enviar comentarios',

        // Feedback controls
        'Was this right?': '¿Es correcto?',
        'Yes': 'Sí',
        'No': 'No',
        'This verdict looks right': 'El veredicto parece correcto',
        'This verdict looks wrong': 'El veredicto parece incorrecto',
        'What should it have been?': '¿Cuál habría sido el veredicto correcto?',
        'Thanks — recorded.': 'Gracias, registrado.',
        'Could not record that, sorry.': 'No se ha podido registrar. Disculpas.',
        'Comment': 'Comentario',
        'Edit Section': 'Editar la sección',
        'Copy Report (Wikitext)': 'Copiar el informe (wikitexto)',
        'Copy Report (Plain Text)': 'Copiar el informe (texto plano)',

        // Provider info
        '✓ Using your {name} API key': '✓ Usando la clave API de {name}',
        '✓ Free to use. Optional: ': '✓ Uso gratuito. Opcional: ',
        'add your {name} API key': 'añadir una clave API de {name}',
        '✓ Free to use': '✓ Uso gratuito',
        'API key configured for {name}': 'Clave API configurada para {name}',
        'API key required for {name}': 'Se necesita una clave API para {name}',
        'Results are logged for research. Your username is not recorded.':
            'Los resultados se registran con fines de investigación. El nombre de usuario no se registra.',
        'Claim scope': 'Alcance de la afirmación',
        'Full claim': 'Afirmación completa',
        'Last sentence only': 'Solo la última frase',
        '"Last sentence only" avoids flagging a multi-sentence claim as unsupported just because an earlier sentence lacks a citation.':
            'Con «Solo la última frase» se evita marcar como no respaldada una afirmación de varias frases solo porque a una frase anterior le falta una fuente.',

        // Verifier tab + first-run notification
        'Verify': 'Verificar',
        'Verify claims against sources': 'Verificar afirmaciones con sus fuentes',
        'Citation Verifier': 'Verificador de citas',
        'Citation Verifier installed — click the ':
            'Verificador de citas instalado: la pestaña ',
        ' tab to get started.': ' permite empezar.',

        // Source display
        '✓ PDF content extracted{pageInfo}': '✓ Contenido del PDF extraído{pageInfo}',
        ' (page {page} of {total})': ' (página {page} de {total})',
        ' ({pages} pages)': ' ({pages} páginas)',
        '✓ Content fetched successfully': '✓ Contenido obtenido correctamente',
        'Content will be fetched by AI during verification.':
            'La IA obtendrá el contenido durante la verificación.',
        '⚠ The source is long and can only be checked partially.':
            '⚠ La fuente es extensa y solo puede comprobarse parcialmente.',
        'Source URL:': 'URL de la fuente:',
        'No URL found. Please paste the source text below:':
            'No se ha encontrado ninguna URL; el texto de la fuente puede pegarse a continuación:',
        'Manual Source Text:': 'Texto de la fuente introducido manualmente:',
        'No source loaded.': 'No hay ninguna fuente cargada.',
        'Click "Verify Claim" to verify the selected claim against the source.':
            'Al hacer clic en «Verificar la afirmación» se comprueba la afirmación seleccionada con la fuente.',
        'Part of a group of {count} citations: {numbers}':
            'Forma parte de un grupo de {count} citas: {numbers}',

        // Verdicts (full, shown for a single verification)
        'SUPPORTED': 'RESPALDADA',
        'PARTIALLY SUPPORTED': 'PARCIALMENTE RESPALDADA',
        'NOT SUPPORTED': 'NO RESPALDADA',
        'SOURCE UNAVAILABLE': 'FUENTE NO DISPONIBLE',
        'ERROR': 'ERROR',
        // Verdicts (short, shown on report cards/chips)
        'Supported': 'Respaldada',
        'Partial': 'Parcial',
        'Not Supported': 'No respaldada',
        'Unavailable': 'No disponible',
        // Reason tag on a 'not supported' verdict
        'Contradiction': 'Contradicción',
        'Omission': 'Omisión',

        // Report progress
        'Checking citation [{num}]': 'Comprobando la cita [{num}]',
        'Fetching source for [{num}]': 'Obteniendo la fuente de [{num}]',
        'Verifying citation [{num}]': 'Verificando la cita [{num}]',
        'Rate limited, retrying in {secs}s...':
            'Límite de solicitudes alcanzado, reintentando en {secs} s…',
        'Checking combined sources {token}': 'Comprobando las fuentes combinadas {token}',
        'Completed: {count} citations checked': 'Completado: {count} citas comprobadas',
        'Completed: {count} citation checked': 'Completado: {count} cita comprobada',
        'Cancelled after {done} of {total} citations': 'Cancelado tras {done} de {total} citas',
        'Cancelled after {done} of {total} citation': 'Cancelado tras {done} de {total} cita',
        ' · ~{duration} remaining': ' · ~{duration} restante',

        // Report summary
        'supported': 'respaldadas',
        'partial': 'parciales',
        'not supported': 'no respaldadas',
        'unavailable': 'no disponibles',
        'errors': 'errores',
        'Show {label} citations': 'Mostrar las citas «{label}»',
        'Hide {label} citations': 'Ocultar las citas «{label}»',
        '{count} citations checked': '{count} citas comprobadas',
        '{count} citation checked': '{count} cita comprobada',
        '{citations} citations across {claims} claims':
            '{citations} citas repartidas en {claims} afirmaciones',
        '{citations} citations across {claims} claim':
            '{citations} citas repartidas en {claims} afirmación',
        ' · {count} hidden by filter': ' · {count} ocultas por el filtro',
        ' · {input} input + {output} output tokens':
            ' · {input} tokens de entrada + {output} de salida',
        'Revision: ': 'Revisión: ',

        // Report cards / groups
        '⚠ Source is long, only partially checked.':
            '⚠ La fuente es extensa; solo se ha comprobado parcialmente.',
        '⚠ Combined sources are long, only partially checked.':
            '⚠ Las fuentes combinadas son extensas; solo se han comprobado parcialmente.',
        'Group of {size} · {numbers}': 'Grupo de {size} · {numbers}',
        'Checking combined sources…': 'Comprobando las fuentes combinadas…',
        'Individual sources': 'Fuentes individuales',
        'Combined verdict': 'Veredicto combinado',
        'All citations are hidden by the current filters. Click a filter above to show them.':
            'Los filtros actuales ocultan todas las citas. Se puede hacer clic en uno de los filtros de arriba para mostrarlas.',

        // Notifications / dialogs
        'Report copied to clipboard!': '¡Informe copiado al portapapeles!',
        'No citations found on this page.': 'No se han encontrado citas en esta página.',
        'Are you sure you want to remove the stored API key?':
            '¿Eliminar la clave API guardada?',
        'Enter your {name} API Key...': 'Introducir la clave API de {name}…',
        'Set {name} API Key': 'Configurar la clave API de {name}',
        'Enter your {name} API Key to enable source verification:':
            'Se necesita la clave API de {name} para activar la verificación de fuentes:',
        'This will verify {citations} citations from {sources} unique sources.{groupNote}\n\nEstimated time: ~{minutes} minutes.\n\nContinue?':
            'Esto verificará {citations} citas procedentes de {sources} fuentes distintas.{groupNote}\n\nTiempo estimado: ~{minutes} minutos.\n\n¿Continuar?',
        'This will verify {citations} citations from {sources} unique sources.{groupNote}\n\nEstimated time: ~{minutes} minute.\n\nContinue?':
            'Esto verificará {citations} citas procedentes de {sources} fuentes distintas.{groupNote}\n\nTiempo estimado: ~{minutes} minuto.\n\n¿Continuar?',
        '\n\nThis includes {count} combined-source checks for adjacent citation groups.':
            '\n\nEsto incluye {count} comprobaciones de fuentes combinadas para grupos de citas adyacentes.',
        '\n\nThis includes {count} combined-source check for adjacent citation groups.':
            '\n\nEsto incluye {count} comprobación de fuentes combinadas para grupos de citas adyacentes.',

        // Generated result comments
        'No URL found in reference': 'No se ha encontrado ninguna URL en la referencia',
        'None of the grouped sources could be retrieved.':
            'No se ha podido obtener ninguna de las fuentes del grupo.',
        'Could not fetch source content': 'No se ha podido obtener el contenido de la fuente',

        // Exported reports (wikitext + plain text)
        'Submit': 'Enviar',
        'Citation verification report': 'Informe de verificación de citas',
        'This is an experimental check of the article sources by [[User:Alaexis/AI_Source_Verification|Citation Verifier]]. Treat it with caution, be aware of its [[User:Alaexis/AI_Source_Verification#Limitations|limitations]] and feel free to leave feedback at [[User_talk:Alaexis/AI_Source_Verification|the talk page]].':
            'Esta es una comprobación experimental de las fuentes del artículo hecha por [[:en:User:Alaexis/AI_Source_Verification|Citation Verifier]]. Conviene tomarla con cautela y tener en cuenta sus [[:en:User:Alaexis/AI_Source_Verification#Limitations|limitaciones]]; los comentarios son bienvenidos en [[:en:User_talk:Alaexis/AI_Source_Verification|la página de discusión]].',
        'Revision checked: ': 'Revisión comprobada: ',
        '! # !! Verdict !! Source !! Comments !! class="unsortable" | Submit':
            '! # !! Veredicto !! Fuente !! Comentarios !! class="unsortable" | Enviar',
        '! # !! Verdict !! Source !! Comments':
            '! # !! Veredicto !! Fuente !! Comentarios',
        '{{tick}} Supported': '{{tick}} Respaldada',
        '{{bang}} Partially supported': '{{bang}} Parcialmente respaldada',
        '{{cross}} Not supported': '{{cross}} No respaldada',
        '{{hmmm}} Source unavailable': '{{hmmm}} Fuente no disponible',
        "''(Combined sources are long, only partially checked.)''":
            "''(Las fuentes combinadas son extensas; solo se han comprobado parcialmente.)''",
        "''(Source is long, only partially checked.)''":
            "''(La fuente es extensa; solo se ha comprobado parcialmente.)''",
        '(combined)': '(combinada)',
        // Link text for the source column of the wikitext table: [url source]
        'source': 'fuente',
        "'''Summary:''' {supported} supported, {partial} partially supported, {notSupported} not supported, {unavailable} source unavailable out of {claims}.":
            "'''Resumen:''' {supported} respaldadas, {partial} parcialmente respaldadas, {notSupported} no respaldadas, {unavailable} con la fuente no disponible, de un total de {claims}.",
        '{count} citations': '{count} citas',
        '{count} citation': '{count} cita',
        '{claims} claims ({citations} citations)': '{claims} afirmaciones ({citations} citas)',
        '{claims} claim ({citations} citations)': '{claims} afirmación ({citations} citas)',
        'a PublicAI-hosted open-source LLM': 'un LLM de código abierto alojado por PublicAI',
        'a HuggingFace-hosted open-source LLM ({model})':
            'un LLM de código abierto alojado por HuggingFace ({model})',
        'a Wikimedia Lift Wing-hosted open-source LLM ({model})':
            'un LLM de código abierto alojado por Wikimedia Lift Wing ({model})',
        'Generated by [[User:Alaexis/AI_Source_Verification|Citation Verifier]] using {model} on ~~~~~.':
            'Generado por [[:en:User:Alaexis/AI_Source_Verification|Citation Verifier]] con {model} el ~~~~~.',
        ' Tokens used: {input} input, {output} output.':
            ' Tokens utilizados: {input} de entrada, {output} de salida.',
        'Citation Verification Report: {title}': 'Informe de verificación de citas: {title}',
        'Provider: {name}': 'Proveedor: {name}',
        'Revision: {rev}': 'Revisión: {rev}',
        'Claim: {text}': 'Afirmación: {text}',
        'Sources: {urls}': 'Fuentes: {urls}',
        'Source: {url}': 'Fuente: {url}',
        'Quote: "{text}"': 'Cita: «{text}»',
        'Comments: {text}': 'Comentarios: {text}',
        'From the source': 'Extracto de la fuente',
        'Note: Combined sources are long, only partially checked.':
            'Nota: Las fuentes combinadas son extensas; solo se han comprobado parcialmente.',
        'Note: Source is long, only partially checked.':
            'Nota: La fuente es extensa; solo se ha comprobado parcialmente.',
        'Tokens used: {input} input, {output} output':
            'Tokens utilizados: {input} de entrada, {output} de salida',
        // Sidebar chrome and the state-driven panel
        'Settings': 'Configuración',
        'Done': 'Hecho',
        'Open settings': 'Abrir la configuración',
        'Upload PDF': 'Subir un PDF',
        'or paste the text below': 'o pegar el texto a continuación',
        'Click any citation number in the article to check whether its source actually supports the claim.':
            'Se puede hacer clic en cualquier número de cita del artículo para comprobar si su fuente respalda realmente la afirmación.',
        'Ready · free, no setup needed': 'Listo · gratuito, sin configuración',
        'Ready · using your API key': 'Listo · con la clave API configurada',
        'Add an API key in settings to start':
            'Añadir una clave API en la configuración para empezar',
        'Checking citations…': 'Comprobando las citas…',
        'Model: {model}': 'Modelo: {model}',
        // Verdict framing: the assessment is attributed, and each verdict says
        // what the editor should do next.
        'AI assessment': 'Evaluación de la IA',
        'Read the source before changing the article — this is a machine reading, not a fact.':
            'Conviene leer la fuente antes de modificar el artículo: es una lectura automática, no un hecho.',
        'Spot-check the source yourself — this is a machine reading, not a fact.':
            'Conviene comprobar la fuente personalmente: es una lectura automática, no un hecho.',
        'The tool could not read this source. Try pasting the text or uploading a PDF.':
            'La herramienta no ha podido leer esta fuente. Se puede pegar el texto o subir un PDF.',
        'How accurate is this?': '¿Qué fiabilidad tiene?',
        'Measured against 186 human-labelled citations, a "not supported" flag was confirmed by a reviewer roughly two thirds of the time. Treat every verdict as a reason to read the source, not as a conclusion.':
            'Sobre 186 citas etiquetadas por personas, un aviso de «no respaldada» fue confirmado por un revisor en aproximadamente dos tercios de los casos. Conviene considerar cada veredicto como un motivo para leer la fuente, no como una conclusión.',

        // Status strip
        'Could not extract claim text': 'No se ha podido extraer el texto de la afirmación',
        'No URL found in reference. Please paste the source text below.':
            'No se ha encontrado ninguna URL en la referencia; el texto de la fuente puede pegarse a continuación.',
        'Google Books sources cannot be fetched. Please paste the source text below.':
            'Las fuentes de Google Books no se pueden obtener; el texto de la fuente puede pegarse a continuación.',
        'Fetching source content...': 'Obteniendo el contenido de la fuente…',
        'Could not fetch source{status}{reason}. Please paste the source text below.':
            'No se ha podido obtener la fuente{status}{reason}; el texto de la fuente puede pegarse a continuación.',
        'Source fetched. Ready to verify.': 'Fuente obtenida. Todo listo para verificar.',
        'Ready to verify claim against source': 'Todo listo para verificar la afirmación con la fuente',
        'Error: {message}': 'Error: {message}',
        'Please enter some source text': 'Hace falta introducir el texto de la fuente',
        'Source text loaded (trimmed to {count} characters). Ready to verify.':
            'Texto de la fuente cargado (recortado a {count} caracteres). Todo listo para verificar.',
        'Source text loaded. Ready to verify.': 'Texto de la fuente cargado. Todo listo para verificar.',
        'Cancelled': 'Cancelado',
        'Please choose a PDF file.': 'Hace falta elegir un archivo PDF.',
        'Reading {name}…': 'Leyendo {name}…',
        'This PDF has no selectable text (it looks scanned). Please paste the relevant passage instead.':
            'Este PDF no tiene texto seleccionable (parece escaneado); conviene pegar el fragmento correspondiente.',
        'Loaded text from {name}. Ready to verify.': 'Texto cargado desde {name}. Todo listo para verificar.',
        'Could not read that PDF: {message}. Try pasting the text instead.':
            'No se ha podido leer el PDF: {message}. Se puede pegar el texto en su lugar.',
        'Switched to {name}': 'Se ha cambiado a {name}',
        'Paste replacement source text below, then click Load Text.':
            'El texto de sustitución puede pegarse a continuación y cargarse con «Cargar el texto».',
        'This provider does not require an API key.': 'Este proveedor no necesita una clave API.',
        'API key set successfully!': '¡Clave API guardada!',
        'This provider does not use a stored API key.': 'Este proveedor no usa ninguna clave API guardada.',
        'API key removed successfully!': '¡Clave API eliminada!',
        'Missing API key (for this provider), claim, or source content':
            'Falta la clave API (para este proveedor), la afirmación o el contenido de la fuente',
        'Verifying claim against source...': 'Verificando la afirmación con la fuente…',
        'Verification complete!': '¡Verificación completada!',

        // Pre-filled wiki edit summary
        'source does not support claim (checked with [[User:Alaexis/AI_Source_Verification|Source Verifier]])':
            'la fuente no respalda la afirmación (comprobado con [[:en:User:Alaexis/AI_Source_Verification|Source Verifier]])',
    };

    // Registered UI languages, keyed by the MediaWiki language-code prefix that
    // selects them. English is the absence of a table, not an entry here.
    const MESSAGES = {
        fr: FR_MESSAGES,
        es: ES_MESSAGES
    };

    // How each localized language is named to the LLM when asking it to write
    // its free-text "comments" in that language. Keys must match MESSAGES.
    const PROMPT_LANGUAGES = {
        fr: 'French (français)',
        es: 'Spanish (español)'
    };

    // Pick the UI language from the wiki's content language, falling back to the
    // user's interface language. Matching is by prefix, so regional variants
    // (es-419, fr-ca) resolve to their base table.
    function detectUiLang() {
        try {
            if (typeof mw !== 'undefined') {
                const lang = String(mw.config.get('wgContentLanguage')
                    || mw.config.get('wgUserLanguage') || 'en').toLowerCase();
                for (const code of Object.keys(MESSAGES)) {
                    if (lang === code || lang.startsWith(code + '-')) return code;
                }
            }
        } catch (e) { /* non-MediaWiki context: keep English */ }
        return 'en';
    }

    class WikipediaSourceVerifier {
        constructor() {
            // UI language: a key of MESSAGES on wikis in that language,
            // 'en' everywhere else.
            this.lang = detectUiLang();

            this.providers = {
                publicai: {
                    name: 'PublicAI',
                    storageKey: null, // No key needed - uses built-in key
                    color: '#6B21A8',
                    model: 'aisingapore/Qwen-SEA-LION-v4-32B-IT',
                    requiresKey: false
                },
                huggingface: {
                    name: 'HuggingFace',
                    // Optional key: free via the proxy without one; direct call
                    // to HF (any model) when stored.
                    storageKey: 'hf_api_key',
                    color: '#6B21A8',
                    model: 'openai/gpt-oss-20b',
                    requiresKey: false,
                    optionalKey: true
                },
                liftwing: {
                    name: 'Lift Wing',
                    // No key needed - proxied through the CORS worker's /liftwing
                    // path, which talks to Wikimedia Lift Wing anonymously (an
                    // approved-bot JWT on the worker lifts the rate limit).
                    storageKey: null,
                    color: '#6B21A8',
                    model: 'llm-qwen36-27b',
                    requiresKey: false
                },
                claude: {
                    name: 'Claude',
                    storageKey: 'claude_api_key',
                    color: '#6B21A8',
                    model: 'claude-sonnet-4-6',
                    requiresKey: true
                },
                gemini: {
                    name: 'Gemini',
                    storageKey: 'gemini_api_key',
                    color: '#6B21A8',
                    model: 'gemini-flash-latest',
                    requiresKey: true
                },
                openai: {
                    name: 'ChatGPT',
                    storageKey: 'openai_api_key',
                    color: '#6B21A8',
                    model: 'gpt-4o',
                    requiresKey: true
                }
            };
            
            // Migrate legacy provider selections ('apertus', 'publicai') to
            // the current default ('huggingface').
            let storedProvider = localStorage.getItem('source_verifier_provider');
            if (storedProvider === 'apertus' || storedProvider === 'publicai') {
                storedProvider = 'huggingface';
                localStorage.setItem('source_verifier_provider', 'huggingface');
            }
            this.currentProvider = storedProvider || 'huggingface';
            // 'paragraph' (default) is the full "between citations" span, which
            // can include multiple sentences — same scope the batch pipeline
            // used before it moved to 'sentence' by default (see CLAUDE.md).
            // Exposed here for the same reason: a multi-sentence claim can flag
            // NOT SUPPORTED because only its first sentence lacks a citation,
            // and 'sentence' narrows to just the sentence next to the ref.
            const storedClaimScope = localStorage.getItem('verifier_claim_scope');
            this.claimScope = storedClaimScope === 'sentence' ? 'sentence' : 'paragraph';
            this.sidebarWidth = localStorage.getItem('verifier_sidebar_width') || '400px';
            this.isVisible = localStorage.getItem('verifier_sidebar_visible') === 'true';
            this.buttons = {};
            this.activeClaim = null;
            this.activeSource = null;
            this.activeSourceUrl = null;
            this.activeCitationNumber = null;
            this.activeRefElement = null;
            // Id of the check currently shown in the sidebar; feedback on that
            // result is keyed on it. Null until a verdict parses successfully.
            this.activeCheckId = null;
            this.currentFetchId = 0;
            this.currentVerifyId = 0;

            this.sourceTextInput = null;
            this.sourceInputForOverride = false;
            this._pdfJsLoading = null;

            // View state. settingsOpen and reportMode are mutually exclusive
            // views; hasResult tracks whether there is a verdict worth showing.
            this.settingsOpen = false;
            this.hasResult = false;

            // Article report state
            this.reportMode = false;
            this.reportCancelled = false;
            this.reportRunning = false;
            this.reportResults = [];
            this.reportGroupResults = new Map();
            this.sourceCache = new Map();
            this.reportTokenUsage = { input: 0, output: 0 };
            this.hasReport = false;
            this.reportRevisionId = null;
            this.reportFilters = this.loadReportFilters();

            this.init();
        }
        
        init() {
            if (mw.config.get('wgAction') !== 'view') return;

            this.loadOOUI().then(() => {
                this.createUI();
                this.attachEventListeners();
                this.attachReferenceClickHandlers();
                this.adjustMainContent();
            });
        }
        
        async loadOOUI() {
            await mw.loader.using(['oojs-ui-core', 'oojs-ui-widgets', 'oojs-ui-windows', 'oojs-ui.styles.icons-interactions']);
        }
        
        getCurrentApiKey() {
            const provider = this.providers[this.currentProvider];
            if (provider.builtInKey) {
                return provider.builtInKey;
            }
            return localStorage.getItem(provider.storageKey);
        }
        
        setCurrentApiKey(key) {
            const provider = this.providers[this.currentProvider];
            if (provider.storageKey) {
                localStorage.setItem(provider.storageKey, key);
            }
        }
        
        removeCurrentApiKey() {
            const provider = this.providers[this.currentProvider];
            if (provider.storageKey) {
                localStorage.removeItem(provider.storageKey);
            }
        }
        
        getCurrentColor() {
            return this.providers[this.currentProvider].color;
        }
        
        providerRequiresKey() {
            return this.providers[this.currentProvider].requiresKey;
        }
        
        // Translate an English source string to the active UI language.
        // Missing keys fall back to the English text. Supports
        // `{placeholder}` interpolation from an optional params object.
        t(en, params) {
            const table = MESSAGES[this.lang];
            let s = (table && table[en] != null) ? table[en] : en;
            if (params) {
                for (const key of Object.keys(params)) {
                    s = s.split('{' + key + '}').join(String(params[key]));
                }
            }
            return s;
        }

        createUI() {
            const sidebar = document.createElement('div');
            sidebar.id = 'source-verifier-sidebar';
            
            this.createOOUIButtons();
            
            // Section order is the reading order of a finished check: the verdict
            // and its explanation first, then the claim and source that produced
            // it, then the controls. renderUiState() decides which of these are
            // on screen; nothing here is unconditionally visible except the
            // header and status strip.
            sidebar.innerHTML = `
                <div id="verifier-sidebar-header">
                    ${this.logoMarkSvg()}
                    <h3><a href="https://en.wikipedia.org/wiki/User:Alaexis/AI_Source_Verification" target="_blank" id="verifier-title-link">${this.t('Citation Verifier')}</a></h3>
                    <div id="verifier-sidebar-controls">
                        <div id="verifier-settings-btn-container"></div>
                        <div id="verifier-close-btn-container"></div>
                    </div>
                </div>
                <div id="verifier-status-strip">
                    <span id="verifier-status-dot"></span>
                    <span id="verifier-status-text"></span>
                    <a href="#" id="verifier-status-settings">${this.t('Settings')}</a>
                </div>
                <div id="verifier-sidebar-content">
                    <div id="verifier-settings-view" style="display:none;">
                        <h4>${this.t('Settings')}</h4>
                        <div id="verifier-provider-container"></div>
                        <div id="verifier-provider-info"></div>
                        <div id="verifier-key-buttons"></div>
                        <div id="verifier-claim-scope-label">${this.t('Claim scope')}</div>
                        <div id="verifier-claim-scope-container"></div>
                        <div id="verifier-claim-scope-note">${this.t('"Last sentence only" avoids flagging a multi-sentence claim as unsupported just because an earlier sentence lacks a citation.')}</div>
                        <div id="verifier-accuracy-note"></div>
                        <div id="verifier-privacy-note">${this.t('Results are logged for research. Your username is not recorded.')}</div>
                        <div id="verifier-settings-done-container"></div>
                    </div>
                    <div id="verifier-main-view">
                        <div id="verifier-idle-view">
                            <div id="verifier-idle-glyph">[1]</div>
                            <p id="verifier-idle-text">${this.t('Click any citation number in the article to check whether its source actually supports the claim.')}</p>
                        </div>
                        <div id="verifier-results">
                            <div id="verifier-verdict-attrib">${this.t('AI assessment')}</div>
                            <div id="verifier-verdict"></div>
                            <div id="verifier-quote"></div>
                            <div id="verifier-comments"></div>
                            <div id="verifier-verdict-next"></div>
                            <div id="verifier-action-container"></div>
                        </div>
                        <div id="verifier-claim-section">
                            <h4>${this.t('Selected Claim')}</h4>
                            <div id="verifier-claim-text">${this.t('Click on a reference number [1] next to a claim to verify it against its source.')}</div>
                            <div id="verifier-claim-group-indicator" style="display: none;"></div>
                        </div>
                        <div id="verifier-source-section">
                            <h4>${this.t('Source Content')}</h4>
                            <div id="verifier-source-text">${this.t('No source loaded yet.')}</div>
                            <div id="verifier-source-override-container" style="display: none; margin-top: 8px;"></div>
                            <div id="verifier-source-input-container" style="display: none; margin-top: 10px;">
                                <div id="verifier-source-pdf-row">
                                    <label id="verifier-source-pdf-label" for="verifier-source-pdf-input" role="button" tabindex="0">📄 ${this.t('Upload PDF')}</label>
                                    <input type="file" id="verifier-source-pdf-input" accept=".pdf,application/pdf">
                                    <span id="verifier-source-pdf-hint">${this.t('or paste the text below')}</span>
                                </div>
                                <div id="verifier-source-textarea-container"></div>
                                <div id="verifier-source-buttons" style="margin-top: 8px; display: flex; gap: 8px;">
                                    <div id="verifier-load-text-btn-container" style="flex: 1;"></div>
                                    <div id="verifier-cancel-text-btn-container" style="flex: 1;"></div>
                                </div>
                            </div>
                        </div>
                        <div id="verifier-controls">
                            <div id="verifier-buttons-container"></div>
                        </div>
                        <div id="verifier-report-view" style="display:none;">
                            <div id="verifier-report-progress"></div>
                            <div id="verifier-report-summary"></div>
                            <div id="verifier-report-results"></div>
                            <div id="verifier-report-actions"></div>
                        </div>
                    </div>
                </div>
                <div id="verifier-resize-handle"></div>
            `;
            
            this.createVerifierTab();
            this.createStyles();
            document.body.append(sidebar);
            
            this.appendOOUIButtons();
            
            if (!this.isVisible) {
                this.hideSidebar();
            }
            
            this.makeResizable();
            this.renderUiState();
        }

        // The logo mark from assets/logo/sv_logo.svg, wordmark omitted (the
        // header already says "Source Verifier"). Inlined because a userscript
        // can't reference a repository file.
        //
        // This is the reversed variant: the header is always the accent purple,
        // and the V is that same purple, so it is knocked out to white and the
        // bar shows through it. The teal S and amber glass sit on the purple
        // unaided at 3.7:1 and 4.0:1, clear of the 3:1 floor for non-text marks.
        // Without the knockout the V is invisible, which is what the white
        // backing plate used to paper over.
        logoMarkSvg() {
            return `<svg id="verifier-logo" viewBox="2 0 65 50" aria-hidden="true" focusable="false">
                <path d="M 38,47 L 38,32 L 24,3 L 13,3 Z" fill="#ffffff"/>
                <path d="M 63,3 L 52,3 L 38,32 L 38,47 Z" fill="#ffffff"/>
                <path d="M 25.456,6.351 A 13,13 0 1 0 25.456,27.649 L 21.728,22.324 A 6.5,6.5 0 1 1 21.728,11.676 Z" fill="#1abea0"/>
                <path d="M 17.544,43.649 A 13,13 0 1 0 17.544,22.351 L 21.272,27.676 A 6.5,6.5 0 1 1 21.272,38.324 Z" fill="#1abea0"/>
                <path d="M 63.479,10.678 A 6.5,6.5 0 1 0 53.176,10.228 L 56.862,7.647 A 2,2 0 1 1 60.032,7.786 Z" fill="#e6a23c"/>
                <path d="M 53.5,17 L 58,17 L 63.5,9.5 L 59,9.5 Z" fill="#e6a23c"/>
                <path d="M 52,20 L 65,20 L 65,15.5 L 52,15.5 Z" fill="#e6a23c"/>
            </svg>`;
        }

        // Single source of truth for what is on screen. Four mutually exclusive
        // views — settings, report, a finished check, and everything else —
        // rather than the previous approach of every section being present at
        // all times with placeholder text standing in for absent content.
        renderUiState() {
            const show = (id, visible, display = '') => {
                const el = document.getElementById(id);
                if (el) el.style.display = visible ? display : 'none';
            };

            const settings = this.settingsOpen;
            const report = !settings && this.reportMode;
            const main = !settings && !report;
            const hasClaim = !!this.activeClaim;

            show('verifier-settings-view', settings);
            show('verifier-main-view', !settings);
            show('verifier-report-view', report, 'block');

            // Idle is the only state with no claim to talk about, so the claim
            // and source sections stay out of the way entirely.
            show('verifier-idle-view', main && !hasClaim);
            show('verifier-claim-section', main && hasClaim);
            show('verifier-source-section', main && hasClaim);
            show('verifier-results', main && this.hasResult);
            show('verifier-controls', main || report);

            this.updateStatusStrip();
        }

        openSettings() {
            this.settingsOpen = true;
            this.renderUiState();
        }

        closeSettings() {
            this.settingsOpen = false;
            this.renderUiState();
        }

        // The status strip answers "can I use this right now?" without naming a
        // model. The model identity lives in settings and in the generated
        // wikitext, where it is an attribution requirement.
        updateStatusStrip() {
            const dot = document.getElementById('verifier-status-dot');
            const text = document.getElementById('verifier-status-text');
            if (!dot || !text) return;

            const provider = this.providers[this.currentProvider];
            const hasKey = this.getCurrentApiKey();
            let ready = true;
            let message;

            if (provider.requiresKey && !hasKey) {
                ready = false;
                message = this.t('Add an API key in settings to start');
            } else if (this.reportRunning) {
                message = this.t('Checking citations…');
            } else if (hasKey && (provider.requiresKey || provider.optionalKey)) {
                message = this.t('Ready · using your API key');
            } else {
                message = this.t('Ready · free, no setup needed');
            }

            dot.className = ready ? 'ready' : 'blocked';
            text.textContent = message;
        }

        // One line telling the editor what to actually do about the verdict.
        // Deliberately phrased as a next step rather than a disclaimer, and
        // shown in place rather than buried in documentation nobody opens.
        nextStepFor(verdict) {
            switch (verdict) {
                case 'SUPPORTED':
                    return this.t('Spot-check the source yourself — this is a machine reading, not a fact.');
                case 'SOURCE UNAVAILABLE':
                    return this.t('The tool could not read this source. Try pasting the text or uploading a PDF.');
                case 'PARTIALLY SUPPORTED':
                case 'NOT SUPPORTED':
                    return this.t('Read the source before changing the article — this is a machine reading, not a fact.');
                default:
                    return '';
            }
        }

        // Design tokens.
        //
        // Every component rule in this file takes its colors from these custom
        // properties, so a theme is defined by remapping the token block rather
        // than by restating each rule under a theme selector. Wikipedia exposes
        // two independent dark-mode signals — an explicit night theme, and
        // "follow OS" plus a dark OS — and both simply redefine the same tokens.
        //
        // This replaces roughly 490 lines of hand-mirrored overrides. Adding a
        // component now means writing it once with var(--sv-*); dark mode
        // follows automatically, which is the bug class described in CLAUDE.md.
        //
        // Values here are deliberately identical to the pre-token stylesheet:
        // this is a refactor, and any palette change is a separate, reviewable
        // edit to one block.
        styleTokens(accent) {
            return {
                light: `
                    /* Solid brand purple. Always a background under white text,
                       so it must NOT lighten in dark mode. */
                    --sv-accent: ${accent};
                    /* The same purple used as a mark on the panel: headings,
                       stripes, progress fill. This one lightens in dark mode. */
                    --sv-accent-fg: ${accent};

                    /* Neutral ramp, darkest to faintest */
                    --sv-ink: #202122;
                    --sv-ink-2: #333;
                    --sv-ink-3: #555;
                    --sv-ink-4: #666;
                    --sv-ink-5: #888;
                    --sv-ink-hint: #888;
                    --sv-ink-chip: #333;
                    --sv-ink-chip-off: #333;
                    --sv-ink-comment: #666;
                    --sv-ink-subtle: #72777d;

                    /* Surfaces */
                    --sv-bg: #fff;
                    --sv-bg-card: #fff;
                    /* Hover wash for the header controls: a white veil over the
                       accent, so it is the same in both themes. */
                    --sv-header-hover: rgba(255,255,255,0.18);
                    --sv-bg-2: #f8f9fa;
                    --sv-bg-3: #fafafa;
                    --sv-bg-inset: #f6f8fb;
                    --sv-bg-hover: #f0f4ff;
                    --sv-bg-hover-inset: #f0f4ff;
                    --sv-bg-chip-hover: #eef2ff;
                    --sv-bg-chip-off: #f0f0f0;
                    --sv-track: #e0e0e0;

                    /* Borders */
                    --sv-border: #ddd;
                    --sv-border-2: #e0e4ea;
                    --sv-border-3: #cdd5e0;
                    --sv-border-chip: #ccc;
                    --sv-border-chip-hover: #99a;

                    /* Verdict semantics */
                    --sv-ok-bg: #d4edda;
                    --sv-ok-fg: #155724;
                    --sv-ok-bd: #c3e6cb;
                    --sv-warn-bg: #fff3cd;
                    --sv-warn-fg: #856404;
                    --sv-warn-bd: #ffeeba;
                    --sv-err-bg: #f8d7da;
                    --sv-err-fg: #721c24;
                    --sv-err-bd: #f5c6cb;
                    --sv-na-bg: #e2e3e5;
                    --sv-na-fg: #383d41;
                    --sv-na-bd: #d6d8db;

                    /* Verdict stripes and summary segments (theme-independent) */
                    --sv-seg-supported: #28a745;
                    --sv-seg-partial: #ffc107;
                    --sv-seg-not-supported: #dc3545;
                    --sv-seg-unavailable: #6c757d;
                    --sv-seg-error: #adb5bd;
                    --sv-stripe-neutral: #ccc;

                    /* Failure box (distinct from the "not supported" verdict) */
                    --sv-error-fg: #d33;
                    --sv-error-bg: #fef2f2;
                    --sv-error-bd: #fecaca;

                    /* Free-provider notice */
                    --sv-free-bg: #e8f5e9;
                    --sv-free-fg: #2e7d32;

                    /* Plain controls (PDF upload label, textarea) */
                    --sv-ctl-bg: #f8f9fa;
                    --sv-ctl-bd: #a2a9b1;
                    --sv-ctl-bg-hover: #ffffff;
                    --sv-ctl-bd-hover: #72777d;

                    /* Quiet underlined link (manual source override) */
                    --sv-quiet-fg: #54595d;
                    --sv-quiet-deco: #a2a9b1;
                    --sv-quiet-fg-hover: #202122;
                    --sv-quiet-deco-hover: #54595d;

                    /* Article-body affordances */
                    --sv-ref-hover: #e6f3ff;

                    --sv-shadow: rgba(0,0,0,0.1);
                `,
                dark: `
                    /* A lighter tint of the accent purple: the light-mode value is
                       too dark to read against the night background. Only the
                       foreground variant changes -- --sv-accent stays the solid
                       purple because white text sits on it. Every provider shares
                       one accent, so this can be a constant; give it a per-provider
                       value if they diverge. */
                    --sv-accent-fg: #B48EDE;
                    --sv-ink: #e0e0e0;
                    --sv-ink-2: #d0d0d8;
                    --sv-ink-3: #b0b0c0;
                    --sv-ink-4: #b0b0c0;
                    --sv-ink-5: #a0a0b0;
                    --sv-ink-hint: #888;
                    --sv-ink-chip: #e0e0e0;
                    --sv-ink-chip-off: #8a8a9e;
                    --sv-ink-comment: #a0a0b0;
                    --sv-ink-subtle: #a0a0a8;

                    --sv-bg: #1a1a2e;
                    --sv-bg-card: #2a2a3e;
                    --sv-header-hover: rgba(255,255,255,0.18);
                    --sv-bg-2: #2a2a3e;
                    --sv-bg-3: #2a2a3e;
                    --sv-bg-inset: #232336;
                    --sv-bg-hover: #3a3a5e;
                    --sv-bg-hover-inset: #232336;
                    --sv-bg-chip-hover: #3a3a5e;
                    --sv-bg-chip-off: #1f1f2e;
                    --sv-track: #3a3a4e;

                    --sv-border: #3a3a4e;
                    --sv-border-2: #3a3a4e;
                    --sv-border-3: #3a3a4e;
                    --sv-border-chip: #3a3a4e;
                    --sv-border-chip-hover: #5a5a7e;

                    --sv-ok-bg: #1a3a1a;
                    --sv-ok-fg: #6ecf6e;
                    --sv-ok-bd: #2a5a2a;
                    --sv-warn-bg: #3a3a1a;
                    --sv-warn-fg: #e0c060;
                    --sv-warn-bd: #5a5a2a;
                    --sv-err-bg: #3a1a1a;
                    --sv-err-fg: #e06060;
                    --sv-err-bd: #5a2a2a;
                    --sv-na-bg: #2a2a2e;
                    --sv-na-fg: #a0a0a8;
                    --sv-na-bd: #3a3a3e;

                    --sv-error-fg: #ff8080;
                    --sv-error-bg: #3a1a1a;
                    --sv-error-bd: #5a2a2a;

                    --sv-free-bg: #1a2e1a;
                    --sv-free-fg: #6ecf6e;

                    --sv-ctl-bg: #2a2a3e;
                    --sv-ctl-bd: #3a3a4e;
                    --sv-ctl-bg-hover: #3a3a4e;
                    --sv-ctl-bd-hover: #54595d;

                    --sv-quiet-fg: #a0a8b3;
                    --sv-quiet-deco: #6a7280;
                    --sv-quiet-fg-hover: #e0e0e0;
                    --sv-quiet-deco-hover: #a0a8b3;

                    --sv-ref-hover: rgba(100, 149, 237, 0.15);

                    --sv-shadow: rgba(0,0,0,0.4);
                `
            };
        }

        // Dark-mode rules that a token swap can't express, emitted once per dark
        // signal. OOUI ships its own light-mode CSS with higher specificity than
        // our component rules, so those widgets need explicit overrides rather
        // than inherited tokens; icons are bitmap-tinted via filter.
        //
        // Everything else belongs in the token block above — add here only when
        // the property genuinely isn't a color we control.
        darkOnlyStyles(root, accent) {
            return `
                /* The header keeps its accent background in dark mode, so its
                   contents must stay white rather than pick up the dark theme's
                   ink — including OOUI labels, which carry their own color. */
                ${root} #verifier-sidebar-header * {
                    color: white !important;
                }
                ${root} #source-verifier-sidebar .oo-ui-dropdownWidget {
                    background: var(--sv-bg-2) !important;
                    border-color: var(--sv-border) !important;
                }
                ${root} #source-verifier-sidebar .oo-ui-dropdownWidget .oo-ui-labelElement-label {
                    color: var(--sv-ink) !important;
                }
                /* Framed buttons only. A frameless button is deliberately
                   chrome-less — the header controls, the "paste source text"
                   link — so giving it a filled background turns it into a box
                   that wasn't asked for. */
                ${root} #source-verifier-sidebar .oo-ui-buttonElement-framed > .oo-ui-buttonElement-button {
                    background: var(--sv-bg-2) !important;
                    color: var(--sv-ink) !important;
                    border-color: var(--sv-border) !important;
                }
                ${root} #source-verifier-sidebar .oo-ui-buttonElement-button .oo-ui-labelElement-label {
                    color: var(--sv-ink) !important;
                }
                ${root} #source-verifier-sidebar .oo-ui-flaggedElement-primary.oo-ui-flaggedElement-progressive .oo-ui-buttonElement-button {
                    background: ${accent} !important;
                    color: white !important;
                    border-color: ${accent} !important;
                }
                /* Disabled-primary greys have no light-mode counterpart — light
                   mode keeps OOUI's own disabled styling — so they stay literal
                   rather than becoming tokens that only ever hold one value. */
                ${root} #source-verifier-sidebar .oo-ui-flaggedElement-primary.oo-ui-flaggedElement-progressive.oo-ui-widget-disabled .oo-ui-buttonElement-button {
                    background: #3a3a4e !important;
                    color: #888 !important;
                    border-color: #4a4a5e !important;
                    cursor: default !important;
                }
                ${root} #source-verifier-sidebar .oo-ui-flaggedElement-primary.oo-ui-flaggedElement-progressive .oo-ui-labelElement-label {
                    color: white !important;
                }
                ${root} #source-verifier-sidebar .oo-ui-flaggedElement-destructive .oo-ui-buttonElement-button {
                    color: var(--sv-err-fg) !important;
                }
                ${root} #source-verifier-sidebar .oo-ui-iconElement-icon,
                ${root} #source-verifier-sidebar .oo-ui-indicatorElement-indicator {
                    filter: invert(0.8);
                }
                ${root} #source-verifier-sidebar .oo-ui-menuSelectWidget {
                    background: var(--sv-bg-2) !important;
                    border-color: var(--sv-border) !important;
                }
                ${root} #source-verifier-sidebar .oo-ui-optionWidget {
                    color: var(--sv-ink) !important;
                }
                ${root} #source-verifier-sidebar .oo-ui-optionWidget-highlighted {
                    background: var(--sv-bg-hover) !important;
                }
                ${root} #source-verifier-sidebar .oo-ui-optionWidget-selected {
                    background: ${accent} !important;
                    color: white !important;
                }
                ${root} #source-verifier-sidebar textarea {
                    background: var(--sv-bg-2) !important;
                    color: var(--sv-ink) !important;
                    border-color: var(--sv-border) !important;
                }
            `;
        }

        createStyles() {
            const accent = this.getCurrentColor();
            const tokens = this.styleTokens(accent);

            const style = document.createElement('style');
            style.id = 'source-verifier-styles';
            style.textContent = `
                :root {${tokens.light}}
                html.skin-theme-clientpref-night {${tokens.dark}}
                @media (prefers-color-scheme: dark) {
                    html.skin-theme-clientpref-os {${tokens.dark}}
                }
                ${this.darkOnlyStyles('html.skin-theme-clientpref-night', accent)}
                @media (prefers-color-scheme: dark) {
                    ${this.darkOnlyStyles('html.skin-theme-clientpref-os', accent)}
                }

                #source-verifier-sidebar {
                    position: fixed;
                    top: 0;
                    right: 0;
                    width: ${this.sidebarWidth};
                    height: 100vh;
                    background: var(--sv-bg);
                    color: var(--sv-ink);
                    border-left: 2px solid var(--sv-accent-fg);
                    box-shadow: -2px 0 8px var(--sv-shadow);
                    z-index: 10000;
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                    font-size: 14px;
                    display: flex;
                    flex-direction: column;
                    transition: all 0.3s ease;
                }
                #verifier-sidebar-header {
                    background: var(--sv-accent);
                    color: white;
                    padding: 12px 15px;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    flex-shrink: 0;
                }
                #verifier-sidebar-header h3 {
                    margin: 0;
                    font-size: 16px;
                    flex: 1;
                }
                #verifier-logo {
                    width: 26px;
                    height: 20px;
                    flex-shrink: 0;
                    display: block;
                }
                #verifier-status-strip {
                    display: flex;
                    align-items: center;
                    gap: 7px;
                    padding: 6px 15px;
                    background: var(--sv-bg-2);
                    border-bottom: 1px solid var(--sv-border);
                    font-size: 12px;
                    color: var(--sv-ink-4);
                    flex-shrink: 0;
                }
                #verifier-status-dot {
                    width: 7px;
                    height: 7px;
                    border-radius: 50%;
                    flex-shrink: 0;
                    background: var(--sv-seg-supported);
                }
                #verifier-status-dot.blocked {
                    background: var(--sv-seg-partial);
                }
                #verifier-status-text {
                    flex: 1;
                    min-width: 0;
                }
                #verifier-status-settings {
                    flex-shrink: 0;
                    color: var(--sv-accent-fg);
                }
                #verifier-main-view, #verifier-settings-view {
                    display: flex;
                    flex-direction: column;
                    gap: 15px;
                }
                #verifier-settings-view h4 {
                    margin: 0;
                    color: var(--sv-accent-fg);
                    font-size: 14px;
                    font-weight: bold;
                }
                #verifier-key-buttons {
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                }
                #verifier-key-buttons .oo-ui-buttonElement,
                #verifier-key-buttons .oo-ui-buttonElement-button {
                    width: 100%;
                    justify-content: center;
                }
                #verifier-provider-model {
                    margin-top: 4px;
                    font-size: 11px;
                    color: var(--sv-ink-5);
                    word-break: break-all;
                }
                #verifier-accuracy-note {
                    padding: 10px;
                    background: var(--sv-bg-2);
                    border: 1px solid var(--sv-border);
                    border-radius: 4px;
                    font-size: 12px;
                    line-height: 1.5;
                    color: var(--sv-ink-4);
                }
                #verifier-accuracy-note strong {
                    display: block;
                    margin-bottom: 3px;
                    color: var(--sv-ink);
                }
                #verifier-privacy-note {
                    font-size: 11px;
                    color: var(--sv-ink-5);
                }
                #verifier-settings-done-container .oo-ui-buttonElement,
                #verifier-settings-done-container .oo-ui-buttonElement-button {
                    width: 100%;
                    justify-content: center;
                }
                #verifier-idle-view {
                    text-align: center;
                    padding: 22px 12px 8px;
                }
                #verifier-idle-glyph {
                    display: inline-block;
                    font-size: 15px;
                    font-weight: bold;
                    color: var(--sv-accent-fg);
                    background: var(--sv-bg-2);
                    border: 1px solid var(--sv-border);
                    border-radius: 6px;
                    padding: 5px 10px;
                    margin-bottom: 12px;
                }
                #verifier-idle-text {
                    margin: 0 auto;
                    max-width: 30em;
                    font-size: 13px;
                    line-height: 1.5;
                    color: var(--sv-ink-4);
                }
                #verifier-verdict-attrib {
                    font-size: 10px;
                    letter-spacing: 0.09em;
                    text-transform: uppercase;
                    color: var(--sv-ink-5);
                    margin-bottom: 4px;
                }
                #verifier-verdict-next {
                    margin-top: 8px;
                    font-size: 12px;
                    line-height: 1.45;
                    color: var(--sv-ink-4);
                }
                #verifier-sidebar-controls {
                    display: flex;
                    gap: 4px;
                }
                /* The header sits on the accent colour in both themes, so its
                   controls are always white-on-purple rather than following the
                   panel's ink. The double-id specificity is what lets these beat
                   the theme-wide OOUI overrides in darkOnlyStyles(). */
                #source-verifier-sidebar #verifier-sidebar-header .oo-ui-buttonElement-button {
                    background: transparent !important;
                    border-color: transparent !important;
                    box-shadow: none !important;
                }
                #source-verifier-sidebar #verifier-sidebar-header .oo-ui-buttonElement-button:hover {
                    background: var(--sv-header-hover) !important;
                }
                /* brightness(0) flattens the icon to black whatever it started
                   as, then invert(1) makes it white — reliable for OOUI's
                   bitmap-ish icons in either theme. */
                #source-verifier-sidebar #verifier-sidebar-header .oo-ui-iconElement-icon {
                    filter: brightness(0) invert(1) !important;
                    opacity: 0.9;
                }
                #source-verifier-sidebar #verifier-sidebar-header .oo-ui-buttonElement-button:hover .oo-ui-iconElement-icon {
                    opacity: 1;
                }
                #verifier-sidebar-content {
                    background: var(--sv-bg);
                    color: var(--sv-ink);
                    padding: 15px;
                    flex: 1;
                    overflow-y: auto;
                    display: flex;
                    flex-direction: column;
                    gap: 15px;
                }
                #verifier-controls {
                    flex-shrink: 0;
                }
                #verifier-provider-container {
                    margin-bottom: 10px;
                }
                #verifier-provider-info {
                    font-size: 12px;
                    color: var(--sv-ink-4);
                    margin-bottom: 10px;
                    padding: 8px;
                    background: var(--sv-bg-2);
                    border-radius: 4px;
                }
                #verifier-provider-info.free-provider {
                    background: var(--sv-free-bg);
                    color: var(--sv-free-fg);
                }
                #verifier-provider-info.free-provider a {
                    color: inherit;
                    text-decoration: underline;
                }
                #verifier-claim-scope-label {
                    font-size: 12px;
                    font-weight: bold;
                    color: var(--sv-ink-4);
                    margin-bottom: 4px;
                }
                #verifier-claim-scope-container {
                    margin-bottom: 6px;
                }
                #verifier-claim-scope-note {
                    font-size: 12px;
                    color: var(--sv-ink-4);
                    margin-bottom: 10px;
                }
                #verifier-buttons-container {
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                }
                #verifier-buttons-container .oo-ui-buttonElement {
                    width: 100%;
                }
                #verifier-buttons-container .oo-ui-buttonElement-button {
                    width: 100%;
                    justify-content: center;
                }
                #verifier-claim-section, #verifier-source-section, #verifier-results {
                    flex-shrink: 0;
                }
                #verifier-claim-section h4, #verifier-source-section h4, #verifier-results h4 {
                    margin: 0 0 8px 0;
                    color: var(--sv-accent-fg);
                    font-size: 14px;
                    font-weight: bold;
                }
                #verifier-claim-text, #verifier-source-text {
                    padding: 10px;
                    background: var(--sv-bg-2);
                    border: 1px solid var(--sv-border);
                    border-radius: 4px;
                    color: var(--sv-ink);
                    font-size: 13px;
                    line-height: 1.4;
                    max-height: 120px;
                    overflow-y: auto;
                }
                #verifier-source-input-container {
                    margin-top: 10px;
                }
                #verifier-source-override-container .verifier-override-link .oo-ui-buttonElement-button {
                    padding: 0;
                    min-height: 0;
                    font-weight: normal;
                }
                #verifier-source-override-container .verifier-override-link .oo-ui-labelElement-label {
                    font-size: 12px;
                    color: var(--sv-quiet-fg);
                    text-decoration: underline;
                    text-decoration-color: var(--sv-quiet-deco);
                    text-underline-offset: 2px;
                }
                #verifier-source-override-container .verifier-override-link:hover .oo-ui-labelElement-label {
                    color: var(--sv-quiet-fg-hover);
                    text-decoration-color: var(--sv-quiet-deco-hover);
                }
                #verifier-source-pdf-row {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    flex-wrap: wrap;
                    margin-bottom: 8px;
                }
                #verifier-source-pdf-input {
                    display: none;
                }
                #verifier-source-pdf-label {
                    display: inline-block;
                    padding: 4px 10px;
                    font-size: 13px;
                    color: var(--sv-ink);
                    background: var(--sv-ctl-bg);
                    border: 1px solid var(--sv-ctl-bd);
                    border-radius: 4px;
                    cursor: pointer;
                    user-select: none;
                }
                #verifier-source-pdf-label:hover {
                    background: var(--sv-ctl-bg-hover);
                    border-color: var(--sv-ctl-bd-hover);
                }
                #verifier-source-pdf-hint {
                    font-size: 12px;
                    color: var(--sv-ink-subtle);
                }
                #verifier-source-textarea-container .oo-ui-inputWidget {
                    width: 100%;
                }
                #verifier-source-textarea-container textarea {
                    min-height: 120px;
                    font-size: 13px;
                    font-family: monospace;
                }
                #verifier-verdict {
                    padding: 12px;
                    border-radius: 4px;
                    font-size: 14px;
                    font-weight: bold;
                    text-align: center;
                    margin-bottom: 10px;
                    color: var(--sv-ink);
                }
                #verifier-verdict.supported {
                    background: var(--sv-ok-bg);
                    color: var(--sv-ok-fg);
                    border: 1px solid var(--sv-ok-bd);
                }
                #verifier-verdict.partially-supported {
                    background: var(--sv-warn-bg);
                    color: var(--sv-warn-fg);
                    border: 1px solid var(--sv-warn-bd);
                }
                #verifier-verdict.not-supported {
                    background: var(--sv-err-bg);
                    color: var(--sv-err-fg);
                    border: 1px solid var(--sv-err-bd);
                }
                #verifier-verdict.source-unavailable {
                    background: var(--sv-na-bg);
                    color: var(--sv-na-fg);
                    border: 1px solid var(--sv-na-bd);
                }
                #verifier-comments {
                    padding: 10px;
                    background: var(--sv-bg-3);
                    border: 1px solid var(--sv-border);
                    border-radius: 4px;
                    color: var(--sv-ink);
                    font-size: 13px;
                    line-height: 1.5;
                    max-height: 300px;
                    overflow-y: auto;
                }

                /* Evidence block: the passage the model quoted from the source,
                   shown only once it has been located in that source (see
                   core/quote.js). Same markup in the sidebar and in report
                   cards, so one rule set covers both. */
                .sv-quote {
                    margin-bottom: 8px;
                    padding: 8px 10px;
                    background: var(--sv-bg-inset);
                    border-left: 3px solid var(--sv-accent);
                    border-radius: 0 3px 3px 0;
                }
                .sv-quote-label {
                    display: block;
                    margin-bottom: 3px;
                    font-size: 10px;
                    font-weight: 600;
                    letter-spacing: 0.04em;
                    text-transform: uppercase;
                    color: var(--sv-ink-subtle);
                }
                .sv-quote-text {
                    font-size: 13px;
                    line-height: 1.5;
                    font-style: italic;
                    color: var(--sv-ink-2);
                    max-height: 200px;
                    overflow-y: auto;
                }
                .verifier-report-card .sv-quote,
                .verifier-report-group-row .sv-quote,
                .verifier-report-group-collective .sv-quote {
                    margin-top: 6px;
                }
                #verifier-action-container {
                    margin-top: 10px;
                }
                /* Direct children only. "Edit Section" is the panel's primary
                   call to action and is appended straight to this container, so
                   it spans the full width. The feedback controls live in a
                   .verifier-feedback wrapper inside the same container, and an
                   unscoped rule stretched every one of their buttons too —
                   which is what made Yes/No/Comment and the correction chips
                   shrink to unrelated widths instead of sitting as a row. */
                #verifier-action-container > .oo-ui-buttonElement {
                    width: 100%;
                }
                #verifier-title-link {
                    color: white;
                    text-decoration: none;
                }
                #verifier-title-link:hover {
                    text-decoration: underline;
                }
                #verifier-action-container > .oo-ui-buttonElement > .oo-ui-buttonElement-button {
                    width: 100%;
                    justify-content: center;
                }
                .verifier-action-hint {
                    font-size: 11px;
                    color: var(--sv-ink-hint);
                    margin-top: 4px;
                    text-align: center;
                }
                #verifier-resize-handle {
                    position: absolute;
                    left: 0;
                    top: 0;
                    width: 4px;
                    height: 100%;
                    background: transparent;
                    cursor: ew-resize;
                    z-index: 10001;
                }
                #verifier-resize-handle:hover {
                    background: var(--sv-accent-fg);
                    opacity: 0.5;
                }
                #ca-verifier, #t-verifier {
                    display: none;
                }
                #ca-verifier a, #t-verifier a {
                    color: var(--sv-accent-fg) !important;
                    text-decoration: none !important;
                }
                #ca-verifier a:hover, #t-verifier a:hover {
                    text-decoration: underline !important;
                }
                body {
                    margin-right: ${this.isVisible ? this.sidebarWidth : '0'};
                    transition: margin-right 0.3s ease;
                }
                .verifier-error {
                    color: var(--sv-error-fg);
                    background: var(--sv-error-bg);
                    border: 1px solid var(--sv-error-bd);
                    padding: 8px;
                    border-radius: 4px;
                }
                .verifier-truncation-warning {
                    margin-top: 6px;
                    padding: 6px 8px;
                    font-size: 12px;
                    color: var(--sv-warn-fg);
                    background: var(--sv-warn-bg);
                    border: 1px solid var(--sv-warn-bd);
                    border-radius: 4px;
                }
                .report-card-truncated {
                    margin-top: 4px;
                    font-size: 11px;
                    color: var(--sv-warn-fg);
                    background: var(--sv-warn-bg);
                    border: 1px solid var(--sv-warn-bd);
                    border-radius: 3px;
                    padding: 2px 6px;
                }
                body.verifier-sidebar-hidden {
                    margin-right: 0 !important;
                }
                body.verifier-sidebar-hidden #source-verifier-sidebar {
                    display: none;
                }
                body.verifier-sidebar-hidden #ca-verifier,
                body.verifier-sidebar-hidden #t-verifier {
                    display: list-item !important;
                }
                /* Wikipedia's #mw-teleport-target wraps OOUI dialogs and has
                   z-index: 450, which creates a stacking context that caps
                   any z-index we set on the inner modal. Lift the wrapper
                   itself above the sidebar (z-index 10000) so confirmation
                   dialogs render on top instead of being hidden behind it. */
                #mw-teleport-target {
                    z-index: 10002 !important;
                }
                /* Report view styles */
                #verifier-report-view h4 {
                    margin: 0 0 8px 0;
                    color: var(--sv-accent-fg);
                    font-size: 14px;
                    font-weight: bold;
                }
                #verifier-report-progress {
                    margin-bottom: 12px;
                }
                .verifier-progress-bar {
                    width: 100%;
                    height: 8px;
                    background: var(--sv-track);
                    border-radius: 4px;
                    overflow: hidden;
                    margin-bottom: 6px;
                }
                .verifier-progress-fill {
                    height: 100%;
                    background: var(--sv-accent-fg);
                    transition: width 0.3s ease;
                    border-radius: 4px;
                }
                .verifier-progress-text {
                    font-size: 12px;
                    color: var(--sv-ink-4);
                }
                #verifier-report-summary {
                    padding: 10px;
                    background: var(--sv-bg-2);
                    border: 1px solid var(--sv-border);
                    border-radius: 4px;
                    color: var(--sv-ink);
                    font-size: 13px;
                    margin-bottom: 12px;
                }
                .verifier-summary-bar {
                    display: flex;
                    height: 6px;
                    border-radius: 3px;
                    overflow: hidden;
                    margin-bottom: 8px;
                }
                .verifier-summary-bar .seg-supported { background: var(--sv-seg-supported); }
                .verifier-summary-bar .seg-partial { background: var(--sv-seg-partial); }
                .verifier-summary-bar .seg-not-supported { background: var(--sv-seg-not-supported); }
                .verifier-summary-bar .seg-unavailable { background: var(--sv-seg-unavailable); }
                .verifier-summary-bar .seg-error { background: var(--sv-seg-error); }
                .verifier-summary-counts {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 6px;
                    font-size: 12px;
                }
                .verifier-summary-counts .dot {
                    width: 8px;
                    height: 8px;
                    border-radius: 50%;
                    display: inline-block;
                }
                .verifier-filter-chip {
                    display: inline-flex;
                    align-items: center;
                    gap: 4px;
                    padding: 2px 8px;
                    font: inherit;
                    font-size: 12px;
                    color: var(--sv-ink-chip);
                    background: var(--sv-bg-card);
                    border: 1px solid var(--sv-border-chip);
                    border-radius: 12px;
                    cursor: pointer;
                    user-select: none;
                    transition: opacity 0.15s, background 0.15s;
                }
                .verifier-filter-chip:hover {
                    background: var(--sv-bg-chip-hover);
                    border-color: var(--sv-border-chip-hover);
                }
                .verifier-filter-chip.verifier-chip-off {
                    opacity: 0.5;
                    text-decoration: line-through;
                    color: var(--sv-ink-chip-off);
                    background: var(--sv-bg-chip-off);
                }
                .verifier-summary-meta {
                    margin-top: 6px;
                    font-size: 11px;
                    color: var(--sv-ink-5);
                }
                #verifier-report-results {
                    display: flex;
                    flex-direction: column;
                    gap: 6px;
                    max-height: 50vh;
                    overflow-y: auto;
                    margin-bottom: 12px;
                }
                #verifier-report-results.filter-hide-supported .verifier-report-card.verdict-supported,
                #verifier-report-results.filter-hide-partial .verifier-report-card.verdict-partial,
                #verifier-report-results.filter-hide-not-supported .verifier-report-card.verdict-not-supported,
                #verifier-report-results.filter-hide-unavailable .verifier-report-card.verdict-unavailable,
                #verifier-report-results.filter-hide-error .verifier-report-card.verdict-error {
                    display: none;
                }
                .verifier-filter-empty {
                    padding: 12px;
                    background: var(--sv-bg-2);
                    border: 1px dashed var(--sv-border-chip);
                    border-radius: 4px;
                    color: var(--sv-ink-4);
                    font-size: 12px;
                    text-align: center;
                }
                .verifier-report-card {
                    padding: 8px 10px;
                    border: 1px solid var(--sv-border);
                    border-radius: 4px;
                    color: var(--sv-ink);
                    font-size: 12px;
                    cursor: pointer;
                    background: var(--sv-bg-card);
                    border-left: 3px solid var(--sv-stripe-neutral);
                }
                .verifier-report-card:hover {
                    background: var(--sv-bg-hover);
                }
                .verifier-report-card.verdict-supported { border-left-color: var(--sv-seg-supported); }
                .verifier-report-card.verdict-partial { border-left-color: var(--sv-seg-partial); }
                .verifier-report-card.verdict-not-supported { border-left-color: var(--sv-seg-not-supported); }
                .verifier-report-card.verdict-unavailable { border-left-color: var(--sv-seg-unavailable); }
                .verifier-report-card.verdict-error { border-left-color: var(--sv-seg-error); }
                .report-card-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 4px;
                }
                .report-card-citation {
                    font-weight: bold;
                }
                a.report-card-citation-link {
                    color: var(--sv-accent-fg);
                    text-decoration: none;
                }
                a.report-card-citation-link:hover {
                    text-decoration: underline;
                }
                .report-card-verdict {
                    font-weight: bold;
                    font-size: 11px;
                    padding: 1px 6px;
                    border-radius: 3px;
                }
                .report-card-verdict.supported { background: var(--sv-ok-bg); color: var(--sv-ok-fg); }
                .report-card-verdict.partial { background: var(--sv-warn-bg); color: var(--sv-warn-fg); }
                .report-card-verdict.not-supported { background: var(--sv-err-bg); color: var(--sv-err-fg); }
                .report-card-verdict.unavailable { background: var(--sv-na-bg); color: var(--sv-na-fg); }
                .report-card-verdict.error { background: var(--sv-na-bg); color: var(--sv-na-fg); }
                .reason-type-tag {
                    display: inline-block;
                    font-size: 11px;
                    padding: 1px 6px;
                    border-radius: 3px;
                    margin-left: 6px;
                    font-weight: normal;
                    vertical-align: middle;
                }
                .reason-type-contradiction { background: var(--sv-err-bg); color: var(--sv-err-fg); }
                .reason-type-omission { background: var(--sv-warn-bg); color: var(--sv-warn-fg); }
                .report-card-claim {
                    color: var(--sv-ink-3);
                    font-size: 11px;
                    margin-bottom: 2px;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                .report-card-comment {
                    color: var(--sv-ink-comment);
                    font-size: 11px;
                    font-style: italic;
                }
                .report-card-action {
                    margin-top: 4px;
                }
                .report-card-action .oo-ui-buttonElement-button {
                    font-size: 11px;
                    padding: 2px 4px;
                }
                .verifier-feedback {
                    margin-top: 6px;
                    padding-top: 6px;
                    border-top: 1px solid var(--sv-border-2);
                }
                .verifier-feedback-row,
                .verifier-feedback-correction {
                    display: flex;
                    align-items: center;
                    flex-wrap: wrap;
                    gap: 6px;
                }
                /* [hidden] has to be restated: the display:flex above outranks
                   the user-agent's [hidden] rule, so without this the
                   corrected-verdict chips show under every verdict — including
                   the thumbs-up they are meant to stay out of. */
                .verifier-feedback-correction[hidden] {
                    display: none;
                }
                .verifier-feedback-correction {
                    margin-top: 6px;
                }
                .verifier-feedback-prompt {
                    color: var(--sv-ink-subtle);
                    font-size: 11px;
                }
                /* The four verdicts are long enough to wrap in a 400px sidebar.
                   Giving the question its own line lets them wrap as one block
                   instead of one chip trailing the label and the rest below. */
                .verifier-feedback-correction .verifier-feedback-prompt {
                    flex-basis: 100%;
                }
                .verifier-feedback .oo-ui-buttonElement {
                    margin: 0;
                }
                /* OOUI gives a button min-height: 32px but leaves its line box
                   at the natural height of the text, and an inline-block puts
                   the leftover space entirely below — so the label sits high in
                   the box. Icons don't: they are absolutely positioned at
                   top: 50%, which is why this only reads as broken on the
                   correction chips, the one button here with no icon beside the
                   text. inline-flex centres the content vertically without
                   taking the button out of the inline flow; horizontal
                   placement is left alone, since the icon is out of flow and
                   centring the label would slide it under the icon. */
                .verifier-feedback .oo-ui-buttonElement-button {
                    display: inline-flex;
                    align-items: center;
                }
                /* Yes / No / Comment are the same widget — a frameless OOUI
                   button with an icon and a label — and deliberately carry no
                   styling of our own. Anything we add here is a way for the
                   three to stop matching, which is how the row ended up with
                   two emoji next to an icon-and-label button. */
                /* The ring marks the recorded answer. Both buttons are disabled
                   after the first click and OOUI dims them identically, so
                   without it the row forgets which way the editor voted. It is
                   an inset shadow rather than a border so nothing reflows. */
                .verifier-feedback .is-chosen .oo-ui-buttonElement-button {
                    box-shadow: inset 0 0 0 1px var(--sv-accent-fg);
                    border-radius: 2px;
                    background: var(--sv-bg-chip-hover);
                    color: var(--sv-ink-chip);
                    opacity: 1;
                }
                .verifier-feedback .is-chosen .oo-ui-labelElement-label {
                    color: var(--sv-ink-chip);
                    opacity: 1;
                }
                .verifier-feedback .is-dimmed {
                    opacity: 0.35;
                }
                .verifier-feedback-chip .oo-ui-buttonElement-button {
                    border: 1px solid var(--sv-border-chip);
                    border-radius: 10px;
                    background: var(--sv-bg-chip-off);
                    color: var(--sv-ink-chip-off);
                    font-size: 11px;
                    padding: 2px 8px;
                }
                .verifier-feedback-chip .oo-ui-buttonElement-button:hover {
                    border-color: var(--sv-border-chip-hover);
                    background: var(--sv-bg-chip-hover);
                }
                .verifier-feedback-status {
                    color: var(--sv-ink-subtle);
                    font-size: 11px;
                    margin-top: 4px;
                }
                .verifier-feedback-status:empty {
                    display: none;
                }
                /* The chips' own confirmation is a flex item, so it needs a full
                   row of its own to land under them rather than beside them. */
                .verifier-feedback-correction .verifier-feedback-status {
                    flex-basis: 100%;
                    margin-top: 2px;
                }
                /* The confirmation sits directly under whatever was clicked, so
                   it has to carry its own weight rather than blend into the
                   surrounding grey captions. */
                .verifier-feedback-status.is-done {
                    color: var(--sv-ok-fg);
                    font-weight: 600;
                }
                .verifier-feedback-status.is-done::before {
                    content: '✓ ';
                }
                .verifier-feedback-status.is-error {
                    color: var(--sv-error-fg);
                }
                .report-card-header-actions {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    min-width: 0;
                }
                .report-card-header-actions .oo-ui-buttonElement {
                    margin: 0;
                }
                .report-card-header-actions .oo-ui-buttonElement-button {
                    font-size: 11px;
                    padding: 1px 6px;
                    white-space: nowrap;
                }
                .verifier-report-group {
                    border: 1px solid var(--sv-border-3);
                    border-left: 3px solid var(--sv-accent-fg);
                    border-radius: 4px;
                    background: var(--sv-bg-inset);
                    padding: 6px 8px;
                    font-size: 12px;
                }
                .verifier-report-group-header {
                    margin-bottom: 6px;
                }
                .verifier-report-group-title {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    margin-bottom: 4px;
                }
                .verifier-report-group-badge {
                    font-weight: bold;
                    font-size: 11px;
                    color: var(--sv-accent-fg);
                }
                .verifier-report-group-claim {
                    color: var(--sv-ink-2);
                    font-size: 12px;
                    line-height: 1.4;
                    margin-bottom: 4px;
                }
                .verifier-report-group-collective {
                    background: var(--sv-bg);
                    border: 1px solid var(--sv-border-2);
                    border-radius: 3px;
                    color: var(--sv-ink);
                    padding: 5px 8px;
                    margin-bottom: 6px;
                }
                .verifier-report-group-collective-header {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    margin-bottom: 2px;
                }
                .verifier-report-group-collective-label {
                    font-weight: bold;
                    font-size: 11px;
                    color: var(--sv-ink-2);
                }
                .verifier-report-group-collective-pending {
                    font-size: 11px;
                    color: var(--sv-ink-5);
                    font-style: italic;
                }
                .verifier-report-group-rows-label {
                    font-size: 10px;
                    text-transform: uppercase;
                    letter-spacing: 0.04em;
                    color: var(--sv-ink-5);
                    margin-bottom: 3px;
                }
                .verifier-report-group-edit {
                    margin-top: 2px;
                }
                .verifier-report-group-edit .oo-ui-buttonElement-button {
                    font-size: 11px;
                    padding: 2px 4px;
                }
                .verifier-report-group-rows {
                    display: flex;
                    flex-direction: column;
                    gap: 4px;
                }
                .verifier-report-group-row {
                    background: var(--sv-bg);
                    border: 1px solid var(--sv-border-2);
                    border-left: 3px solid var(--sv-stripe-neutral);
                    border-radius: 3px;
                    color: var(--sv-ink);
                    padding: 5px 8px;
                    cursor: pointer;
                }
                .verifier-report-group-row:hover {
                    background: var(--sv-bg-hover-inset);
                }
                .verifier-report-group-row.verdict-supported { border-left-color: var(--sv-seg-supported); }
                .verifier-report-group-row.verdict-partial { border-left-color: var(--sv-seg-partial); }
                .verifier-report-group-row.verdict-not-supported { border-left-color: var(--sv-seg-not-supported); }
                .verifier-report-group-row.verdict-unavailable { border-left-color: var(--sv-seg-unavailable); }
                .verifier-report-group-row.verdict-error { border-left-color: var(--sv-seg-error); }
                .verifier-report-group-row .report-card-verdict {
                    background: transparent;
                    color: var(--sv-ink-4);
                    font-size: 10px;
                    font-weight: normal;
                    padding: 0;
                }
                .verifier-report-group-row .reason-type-tag {
                    background: transparent;
                    color: var(--sv-ink-4);
                    font-size: 10px;
                    padding: 0;
                    margin-left: 4px;
                }
                .verifier-report-group-row-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 2px;
                }
                #verifier-claim-group-indicator {
                    margin-top: 6px;
                    font-size: 11px;
                    color: var(--sv-ink-4);
                    line-height: 1.4;
                }
                #verifier-claim-group-indicator .group-active {
                    font-weight: bold;
                    color: var(--sv-accent-fg);
                }
                /* OOUI renders the icon span on every button, icon or not, so
                   the sibling selector alone puts this gap on labels with
                   nothing beside them — it was pushing the text in each
                   correction chip 4px right of centre. The widget root only
                   carries .oo-ui-iconElement when an icon was really set. */
                #source-verifier-sidebar .oo-ui-iconElement .oo-ui-iconElement-icon + .oo-ui-labelElement-label {
                    margin-left: 4px;
                }
                #verifier-report-actions {
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                }
                #verifier-report-actions .oo-ui-buttonElement {
                    width: 100%;
                }
                #verifier-report-actions .oo-ui-buttonElement-button {
                    width: 100%;
                    justify-content: center;
                }

                .reference:hover {
                    background-color: var(--sv-ref-hover);
                    cursor: pointer;
                }
                .reference.verifier-active {
                    background-color: var(--sv-accent);
                    color: white;
                }
                .claim-highlight {
                    background-color: var(--sv-warn-bg);
                    border-left: 3px solid var(--sv-accent-fg);
                    padding-left: 5px;
                    margin-left: -8px;
                }
            `;

            // createStyles() re-runs when the provider changes; replace the
            // previous sheet instead of stacking a new one on every switch.
            const previous = document.getElementById('source-verifier-styles');
            if (previous) previous.remove();
            document.head.appendChild(style);
        }
        
        createOOUIButtons() {
            this.buttons.close = new OO.ui.ButtonWidget({
                icon: 'close',
                title: this.t('Close'),
                framed: false,
                classes: ['verifier-close-button']
            });

            this.buttons.settings = new OO.ui.ButtonWidget({
                icon: 'settings',
                title: this.t('Settings'),
                framed: false,
                classes: ['verifier-settings-button']
            });

            this.buttons.settingsDone = new OO.ui.ButtonWidget({
                label: this.t('Done'),
                flags: ['primary', 'progressive']
            });

            // Shown in the main view when the chosen provider has no key, so the
            // blocked state offers the way out rather than just naming the problem.
            this.buttons.openSettings = new OO.ui.ButtonWidget({
                label: this.t('Open settings'),
                flags: ['primary', 'progressive'],
                icon: 'settings'
            });
            
            // Provider selector
            this.buttons.providerSelect = new OO.ui.DropdownWidget({
                menu: {
                    items: Object.keys(this.providers).map(key => 
                        new OO.ui.MenuOptionWidget({
                            data: key,
                            label: this.providers[key].name
                        })
                    )
                }
            });
            this.buttons.providerSelect.getMenu().selectItemByData(this.currentProvider);

            // Claim scope selector
            this.buttons.claimScopeSelect = new OO.ui.DropdownWidget({
                menu: {
                    items: [
                        new OO.ui.MenuOptionWidget({ data: 'paragraph', label: this.t('Full claim') }),
                        new OO.ui.MenuOptionWidget({ data: 'sentence', label: this.t('Last sentence only') })
                    ]
                }
            });
            this.buttons.claimScopeSelect.getMenu().selectItemByData(this.claimScope);

            this.buttons.setKey = new OO.ui.ButtonWidget({
                label: this.t('Set API Key'),
                flags: ['primary', 'progressive'],
                disabled: false
            });

            this.buttons.verify = new OO.ui.ButtonWidget({
                label: this.t('Verify Claim'),
                flags: ['primary', 'progressive'],
                icon: 'check',
                disabled: true
            });

            this.buttons.changeKey = new OO.ui.ButtonWidget({
                label: this.t('Change Key'),
                flags: ['safe'],
                icon: 'edit',
                disabled: false
            });

            this.buttons.removeKey = new OO.ui.ButtonWidget({
                label: this.t('Remove API Key'),
                flags: ['destructive'],
                icon: 'trash',
                disabled: false
            });

            // Source text input widgets
            this.sourceTextInput = new OO.ui.MultilineTextInputWidget({
                placeholder: this.t('Paste the source text here...'),
                rows: 6,
                autosize: true,
                maxRows: 15
            });

            this.buttons.loadText = new OO.ui.ButtonWidget({
                label: this.t('Load Text'),
                flags: ['primary', 'progressive']
            });

            this.buttons.cancelText = new OO.ui.ButtonWidget({
                label: this.t('Cancel'),
                flags: ['safe']
            });

            this.buttons.overrideText = new OO.ui.ButtonWidget({
                label: this.t('Paste source text manually'),
                framed: false,
                title: this.t('Replace the fetched source content with text you paste in (e.g., the full article from The Wikipedia Library)')
            });
            this.buttons.overrideText.$element.addClass('verifier-override-link');

            // Article report buttons
            this.buttons.verifyAll = new OO.ui.ButtonWidget({
                label: this.t('Verify All Citations'),
                flags: ['primary', 'progressive'],
                icon: 'articles'
            });

            this.buttons.stopAll = new OO.ui.ButtonWidget({
                label: this.t('Stop'),
                flags: ['destructive'],
                icon: 'cancel'
            });

            this.buttons.backToReport = new OO.ui.ButtonWidget({
                label: this.t('Back to Report'),
                flags: ['safe'],
                icon: 'arrowPrevious'
            });

            this.updateButtonVisibility();
        }
        
        appendOOUIButtons() {
            document.getElementById('verifier-close-btn-container').appendChild(this.buttons.close.$element[0]);
            document.getElementById('verifier-settings-btn-container').appendChild(this.buttons.settings.$element[0]);
            document.getElementById('verifier-provider-container').appendChild(this.buttons.providerSelect.$element[0]);
            document.getElementById('verifier-claim-scope-container').appendChild(this.buttons.claimScopeSelect.$element[0]);
            document.getElementById('verifier-settings-done-container').appendChild(this.buttons.settingsDone.$element[0]);

            this.updateProviderInfo();
            this.updateButtonVisibility();
            
            // Append source input widgets
            document.getElementById('verifier-source-textarea-container').appendChild(this.sourceTextInput.$element[0]);
            document.getElementById('verifier-load-text-btn-container').appendChild(this.buttons.loadText.$element[0]);
            document.getElementById('verifier-cancel-text-btn-container').appendChild(this.buttons.cancelText.$element[0]);
            document.getElementById('verifier-source-override-container').appendChild(this.buttons.overrideText.$element[0]);
        }
        
        updateProviderInfo() {
            const infoEl = document.getElementById('verifier-provider-info');
            if (!infoEl) return;
            
            const provider = this.providers[this.currentProvider];
            infoEl.textContent = '';
            if (!provider.requiresKey) {
                if (provider.optionalKey && this.getCurrentApiKey()) {
                    infoEl.textContent = this.t('✓ Using your {name} API key', { name: provider.name });
                } else if (provider.optionalKey) {
                    infoEl.appendChild(document.createTextNode(this.t('✓ Free to use. Optional: ')));
                    const link = document.createElement('a');
                    link.href = '#';
                    link.textContent = this.t('add your {name} API key', { name: provider.name });
                    link.addEventListener('click', (e) => {
                        e.preventDefault();
                        this.setApiKey();
                    });
                    infoEl.appendChild(link);
                } else {
                    infoEl.textContent = this.t('✓ Free to use');
                }
                infoEl.className = 'free-provider';
            } else if (this.getCurrentApiKey()) {
                infoEl.textContent = this.t('API key configured for {name}', { name: provider.name });
                infoEl.className = '';
            } else {
                infoEl.textContent = this.t('API key required for {name}', { name: provider.name });
                infoEl.className = '';
            }

            // The model identity lives here rather than in the sidebar chrome:
            // nobody picks between model names day to day, but it has to stay
            // discoverable because the generated wikitext cites it.
            const model = document.createElement('div');
            model.id = 'verifier-provider-model';
            model.textContent = this.t('Model: {model}', { model: provider.model });
            infoEl.appendChild(model);
        }

        // Published accuracy, in the panel rather than in documentation, so the
        // expectation is set before the first false positive instead of after.
        // Figures come from benchmark/analysis.json (186 human-labelled rows).
        updateAccuracyNote() {
            const el = document.getElementById('verifier-accuracy-note');
            if (!el) return;
            el.textContent = '';

            const heading = document.createElement('strong');
            heading.textContent = this.t('How accurate is this?');
            const body = document.createElement('div');
            body.textContent = this.t('Measured against 186 human-labelled citations, a "not supported" flag was confirmed by a reviewer roughly two thirds of the time. Treat every verdict as a reason to read the source, not as a conclusion.');
            el.appendChild(heading);
            el.appendChild(body);
        }
        
        updateButtonVisibility() {
            const container = document.getElementById('verifier-buttons-container');
            if (!container) return;
            
            container.innerHTML = '';
            
            const hasKey = this.getCurrentApiKey();
            const requiresKey = this.providerRequiresKey();
            const optionalKey = this.providers[this.currentProvider].optionalKey;

            // The main container holds only the actions a reader takes on the
            // article. Key management moved into the settings panel, where it is
            // needed once rather than on every check.
            const keyContainer = document.getElementById('verifier-key-buttons');
            if (keyContainer) keyContainer.innerHTML = '';

            if (!requiresKey || hasKey) {
                // Provider is ready to use
                if (this.reportRunning) {
                    container.appendChild(this.buttons.stopAll.$element[0]);
                } else {
                    const hasClaimAndSource = this.activeClaim && this.activeSource;
                    this.buttons.verify.setDisabled(!hasClaimAndSource);
                    // With no claim selected there is nothing to verify, so the
                    // whole-article action stands alone rather than sitting
                    // beneath a permanently disabled button.
                    if (this.activeClaim) {
                        container.appendChild(this.buttons.verify.$element[0]);
                    }
                    container.appendChild(this.buttons.verifyAll.$element[0]);

                    if (this.hasReport && !this.reportMode) {
                        container.appendChild(this.buttons.backToReport.$element[0]);
                    }
                }

                // Key-management buttons: required-key providers always show
                // change/remove; optional-key providers show change/remove
                // when a key is stored. The "set key" affordance for the
                // optional-no-key case lives as an inline link inside
                // updateProviderInfo() so it doesn't compete with Verify.
                if (keyContainer && (requiresKey || (optionalKey && hasKey))) {
                    keyContainer.appendChild(this.buttons.changeKey.$element[0]);
                    keyContainer.appendChild(this.buttons.removeKey.$element[0]);
                }
            } else {
                // Provider needs a key. Point at settings from the main view
                // instead of putting the key form in the reader's way.
                this.buttons.verify.setDisabled(true);
                if (keyContainer) keyContainer.appendChild(this.buttons.setKey.$element[0]);
                container.appendChild(this.buttons.openSettings.$element[0]);
            }

            this.updateProviderInfo();
            this.updateAccuracyNote();
            this.updateStatusStrip();
        }
        
        createVerifierTab() {
            if (typeof mw !== 'undefined' && [0, 2, 118].includes(mw.config.get('wgNamespaceNumber'))) {
                const skin = mw.config.get('skin');
                let portletId;
                
                switch(skin) {
                    case 'vector-2022':
                        portletId = 'p-associated-pages';
                        break;
                    case 'vector':
                        portletId = 'p-cactions';
                        break;
                    case 'monobook':
                        portletId = 'p-cactions';
                        break;
                    case 'minerva':
                        portletId = 'p-tb';
                        break;
                    case 'timeless':
                        portletId = 'p-associated-pages';
                        break;
                    default:
                        portletId = 'p-namespaces';
                }
                
                try {
                    const verifierLink = mw.util.addPortletLink(
                        portletId,
                        '#',
                        this.t('Verify'),
                        't-verifier',
                        this.t('Verify claims against sources'),
                        'v',
                    );
                    
                    if (verifierLink) {
                        verifierLink.addEventListener('click', (e) => {
                            e.preventDefault();
                            this.showSidebar();
                        });
                        this.showFirstRunNotification();
                    }
                } catch (error) {
                    console.warn('Could not create verifier tab:', error);
                }
            }
        }
        
        showFirstRunNotification() {
            if (localStorage.getItem('verifier_first_run_done')) return;
            localStorage.setItem('verifier_first_run_done', 'true');
            mw.notify(
                $('<span>').append(
                    this.t('Citation Verifier installed — click the '),
                    $('<strong>').text(this.t('Verify')),
                    this.t(' tab to get started.')
                ),
                { title: this.t('Citation Verifier'), type: 'info', autoHide: true, autoHideSeconds: 8 }
            );
        }

        attachReferenceClickHandlers() {
            const references = document.querySelectorAll('.reference a');
            references.forEach(ref => {
                ref.addEventListener('click', (e) => {
                    if (!this.isVisible) return;
                    e.preventDefault();
                    e.stopPropagation();
                    this.handleReferenceClick(ref);
                });
            });
        }
        
        async handleReferenceClick(refElement) {
            try {
                // When in report mode, don't switch to single-citation view.
                // Instead, scroll to the matching report card if one exists.
                if (this.reportMode) {
                    const matchIndex = this.reportResults.findIndex(r => r.refElement === refElement);
                    if (matchIndex !== -1) {
                        const cards = document.querySelectorAll('#verifier-report-results .report-card');
                        const card = cards[matchIndex];
                        if (card) {
                            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            card.style.transition = 'box-shadow 0.3s';
                            card.style.boxShadow = '0 0 0 3px #36c';
                            setTimeout(() => { card.style.boxShadow = ''; }, 1500);
                        }
                    }
                    return;
                }
                this.clearHighlights();
                this.showSidebar();

                // Clear previous verification result and invalidate any in-flight verification
                this.clearResult();
                this.currentVerifyId++;
                
                const claim = this.extractClaimText(refElement);
                if (!claim) {
                    this.updateStatus(this.t('Could not extract claim text'), true);
                    return;
                }
                
                this.highlightClaim(refElement, claim);
                refElement.parentElement.classList.add('verifier-active');
                
                this.activeClaim = claim;
                this.activeCitationNumber = refElement.textContent.replace(/[\[\]]/g, '').trim() || null;
                this.activeRefElement = refElement;

                document.getElementById('verifier-claim-text').textContent = claim;
                this.renderClaimGroupIndicator(refElement);
                // Selecting a claim leaves the idle state; the claim and source
                // sections only exist on screen from here on.
                this.renderUiState();

                const refUrl = this.extractReferenceUrl(refElement);
                this.activeSourceUrl = refUrl;
                
                if (!refUrl) {
                    this.showSourceTextInput();
                    this.updateStatus(this.t('No URL found in reference. Please paste the source text below.'));
                    return;
                }

                if (this.isGoogleBooksUrl(refUrl)) {
                    this.showSourceTextInput();
                    this.updateStatus(this.t('Google Books sources cannot be fetched. Please paste the source text below.'));
                    return;
                }

                this.hideSourceTextInput();
                this.activeSource = null;
                this.updateButtonVisibility();
                this.updateStatus(this.t('Fetching source content...'));
                const fetchId = ++this.currentFetchId;
                const pageNum = this.extractPageNumber(refElement);
                const fetchResult = await this.fetchSourceContent(refUrl, pageNum);

                if (fetchId !== this.currentFetchId) {
                    return;
                }

                if (!fetchResult.content) {
                    this.showSourceTextInput();
                    const status = fetchResult.status != null ? ` (HTTP ${fetchResult.status})` : '';
                    const reason = fetchResult.error ? `: ${fetchResult.error}` : '';
                    this.updateStatus(this.t('Could not fetch source{status}{reason}. Please paste the source text below.', { status, reason }), true);
                    return;
                }

                const sourceInfo = fetchResult.content;
                this.activeSource = sourceInfo;
                const sourceElement = document.getElementById('verifier-source-text');

                const urlMatch = sourceInfo.match(/Source URL: (https?:\/\/[^\s\n]+)/);
                const contentFetched = sourceInfo.includes('Source Content:');
                const pdfMatch = sourceInfo.match(/PDF: (\d+) pages/);
                const pageMatch = sourceInfo.match(/\(extracted page (\d+)\)/);
                const isTruncated = sourceInfo.includes('\nTruncated: true');

                if (urlMatch) {
                    let statusHtml;
                    if (contentFetched && pdfMatch) {
                        const pageInfo = pageMatch
                            ? this.t(' (page {page} of {total})', { page: pageMatch[1], total: pdfMatch[1] })
                            : this.t(' ({pages} pages)', { pages: pdfMatch[1] });
                        statusHtml = `<span style="color: #2e7d32;">${this.escapeHtml(this.t('✓ PDF content extracted{pageInfo}', { pageInfo }))}</span>`;
                    } else if (contentFetched) {
                        statusHtml = `<span style="color: #2e7d32;">${this.t('✓ Content fetched successfully')}</span>`;
                    } else {
                        statusHtml = `<em>${this.t('Content will be fetched by AI during verification.')}</em>`;
                    }
                    const truncationHtml = isTruncated
                        ? `<div class="verifier-truncation-warning">${this.t('⚠ The source is long and can only be checked partially.')}</div>`
                        : '';
                    sourceElement.innerHTML = `
                        <strong>${this.t('Source URL:')}</strong><br>
                        <a href="${urlMatch[1]}" target="_blank" style="word-break: break-all;">${urlMatch[1]}</a><br><br>
                        ${statusHtml}
                        ${truncationHtml}
                    `;
                } else {
                    sourceElement.textContent = sourceInfo;
                }

                this.updateButtonVisibility();
                this.refreshOverrideButton();
                this.updateStatus(this.t(contentFetched ? 'Source fetched. Ready to verify.' : 'Ready to verify claim against source'));
                
            } catch (error) {
                console.error('Error handling reference click:', error);
                this.updateStatus(this.t('Error: {message}', { message: error.message }), true);
            }
        }
        
        showSourceTextInput(forOverride = false) {
            this.sourceInputForOverride = forOverride;
            document.getElementById('verifier-source-input-container').style.display = 'block';
            if (!forOverride) {
                document.getElementById('verifier-source-text').textContent = this.t('No URL found. Please paste the source text below:');
            }
            this.sourceTextInput.setValue('');
            this.hideOverrideButton();
        }

        hideSourceTextInput() {
            document.getElementById('verifier-source-input-container').style.display = 'none';
            this.refreshOverrideButton();
        }

        showOverrideButton() {
            const el = document.getElementById('verifier-source-override-container');
            if (el) el.style.display = '';
        }

        hideOverrideButton() {
            const el = document.getElementById('verifier-source-override-container');
            if (el) el.style.display = 'none';
        }

        // Show the override button only when there is a loaded source to override
        // and the manual-input panel is not already open.
        refreshOverrideButton() {
            const inputOpen = document.getElementById('verifier-source-input-container').style.display === 'block';
            if (this.activeClaim && this.activeSource && !inputOpen && !this.reportMode) {
                this.showOverrideButton();
            } else {
                this.hideOverrideButton();
            }
        }

        loadManualSourceText() {
            let text = this.sourceTextInput.getValue().trim();
            if (!text) {
                this.updateStatus(this.t('Please enter some source text'), true);
                return;
            }

            // Trim overlong pastes so the request body stays under the proxy's
            // size limit; anything past the cap can only be checked partially.
            const wasTrimmed = text.length > MAX_MANUAL_SOURCE_CHARS;
            if (wasTrimmed) {
                text = text.slice(0, MAX_MANUAL_SOURCE_CHARS);
            }

            // The previous verdict was computed against whatever source content
            // is being replaced (a failed fetch, or nothing). Leaving it on
            // screen would show a stale assessment — e.g. still saying "SOURCE
            // UNAVAILABLE: only a JS-disabled notice" after a PDF upload — that
            // reads as though the override was ignored, even though activeSource
            // below is correctly updated. Clear it so the panel goes back to
            // "ready to verify" until the user re-runs it against the new text.
            this.clearResult();
            this.currentVerifyId++;
            // clearResult() also wipes the group-membership badge (it's meant
            // to be re-populated by a fresh citation selection); the claim and
            // its group haven't changed here, only the source, so restore it.
            if (this.activeRefElement) {
                this.renderClaimGroupIndicator(this.activeRefElement);
            }

            this.activeSource = `Manual source text:\n\n${text}`;
            const preview = `${text.substring(0, 200)}${text.length > 200 ? '...' : ''}`;
            const truncationHtml = wasTrimmed
                ? `<div class="verifier-truncation-warning">${this.t('⚠ The source is long and can only be checked partially.')}</div>`
                : '';
            document.getElementById('verifier-source-text').innerHTML = `<strong>${this.t('Manual Source Text:')}</strong><br><em>${preview}</em>${truncationHtml}`;
            this.sourceInputForOverride = false;
            this.hideSourceTextInput();
            this.updateButtonVisibility();
            this.updateStatus(wasTrimmed
                ? this.t('Source text loaded (trimmed to {count} characters). Ready to verify.', { count: MAX_MANUAL_SOURCE_CHARS.toLocaleString() })
                : this.t('Source text loaded. Ready to verify.'));
        }

        cancelManualSourceText() {
            const wasOverride = this.sourceInputForOverride;
            this.sourceTextInput.setValue('');
            this.sourceInputForOverride = false;
            this.hideSourceTextInput();
            if (!wasOverride) {
                this.activeSource = null;
                document.getElementById('verifier-source-text').textContent = this.t('No source loaded.');
            }
            this.updateButtonVisibility();
            this.updateStatus(this.t('Cancelled'));
        }

        // Lazily load PDF.js the first time a user picks a PDF, and cache the
        // in-flight promise so concurrent/repeat calls don't load it twice.
        // Pinned to a specific UMD build (exposes window.pdfjsLib) so a future
        // PDF.js release can't silently change extraction behavior. The CDN
        // load was verified to pass Wikipedia's CSP (script-src allows cdnjs).
        ensurePdfJs() {
            if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
            if (!this._pdfJsLoading) {
                const version = '3.11.174';
                const base = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${version}`;
                this._pdfJsLoading = mw.loader.getScript(`${base}/pdf.min.js`).then(() => {
                    // Parse in a Web Worker when the browser permits a
                    // cross-origin worker; if CSP blocks that, PDF.js falls back
                    // to main-thread parsing, loading this same script via
                    // script-src (the path we verified works). Either way,
                    // extraction succeeds — we just don't need to host a worker.
                    window.pdfjsLib.GlobalWorkerOptions.workerSrc = `${base}/pdf.worker.min.js`;
                    return window.pdfjsLib;
                }).catch((err) => {
                    // Allow a later retry rather than caching the failure.
                    this._pdfJsLoading = null;
                    throw err;
                });
            }
            return this._pdfJsLoading;
        }

        // Pull the text layer out of a PDF file. Returns '' for PDFs with no
        // selectable text (e.g. scanned/image-only), which the caller surfaces
        // as a "paste the passage instead" message rather than sending blanks.
        async extractPdfText(file) {
            const pdfjsLib = await this.ensurePdfJs();
            const data = new Uint8Array(await file.arrayBuffer());
            const pdf = await pdfjsLib.getDocument({ data }).promise;
            const pages = [];
            for (let i = 1; i <= pdf.numPages; i++) {
                const page = await pdf.getPage(i);
                const content = await page.getTextContent();
                pages.push(content.items.map(item => item.str).join(' '));
            }
            return pages.join('\n\n').trim();
        }

        // Wire an uploaded PDF into the existing manual-source-text pipeline:
        // extract → drop into the textarea → load it as the active source. From
        // there it's indistinguishable from pasted text for verification.
        async handlePdfFileSelected(file) {
            if (!file) return;
            const looksPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
            if (!looksPdf) {
                this.updateStatus(this.t('Please choose a PDF file.'), true);
                return;
            }
            this.updateStatus(this.t('Reading {name}…', { name: file.name }));
            try {
                const text = await this.extractPdfText(file);
                if (!text) {
                    this.updateStatus(this.t('This PDF has no selectable text (it looks scanned). Please paste the relevant passage instead.'), true);
                    return;
                }
                this.sourceTextInput.setValue(text);
                this.loadManualSourceText();
                this.updateStatus(this.t('Loaded text from {name}. Ready to verify.', { name: file.name }));
            } catch (error) {
                console.error('PDF extraction failed:', error);
                this.updateStatus(this.t('Could not read that PDF: {message}. Try pasting the text instead.', { message: error.message }), true);
            }
        }

        extractClaimText(refElement) {
            return extractClaimText(refElement, { scope: this.claimScope });
        }

        getCitationGroup(refElement) {
            return getCitationGroup(refElement);
        }

        extractHttpUrl(element) {
            return extractHttpUrl(element);
        }

        extractReferenceUrl(refElement) {
            return extractReferenceUrl(refElement);
        }

        extractPageNumber(refElement) {
            return extractPageNumber(refElement);
        }

        isGoogleBooksUrl(url) {
            return isGoogleBooksUrl(url);
        }

        async fetchSourceContent(url, pageNum) {
            const overrides = useToolforgeSourceFetcher() ? { workerBase: TOOLFORGE_SOURCE_FETCHER_BASE } : {};
            return fetchSourceContent(url, pageNum, overrides);
        }
        
        highlightClaim(refElement, claim) {
            const parentElement = refElement.closest('p, li, td, div');
            if (parentElement && !parentElement.classList.contains('claim-highlight')) {
                parentElement.classList.add('claim-highlight');
            }
        }
        
        clearHighlights() {
            document.querySelectorAll('.reference.verifier-active').forEach(el => {
                el.classList.remove('verifier-active');
            });
            
            document.querySelectorAll('.claim-highlight').forEach(el => {
                el.classList.remove('claim-highlight');
            });
        }
        
        makeResizable() {
            const handle = document.getElementById('verifier-resize-handle');
            const sidebar = document.getElementById('source-verifier-sidebar');
            
            if (!handle || !sidebar) return;
            
            let isResizing = false;
            handle.addEventListener('mousedown', (e) => {
                isResizing = true;
                document.addEventListener('mousemove', handleMouseMove);
                document.addEventListener('mouseup', handleMouseUp);
                e.preventDefault();
            });
            
            const handleMouseMove = (e) => {
                if (!isResizing) return;
                
                const newWidth = window.innerWidth - e.clientX;
                const minWidth = 300;
                const maxWidth = window.innerWidth * 0.8;
                
                if (newWidth >= minWidth && newWidth <= maxWidth) {
                    const widthPx = newWidth + 'px';
                    sidebar.style.width = widthPx;
                    document.body.style.marginRight = widthPx;
                    this.sidebarWidth = widthPx;
                    localStorage.setItem('verifier_sidebar_width', widthPx);
                }
            };
            
            const handleMouseUp = () => {
                isResizing = false;
                document.removeEventListener('mousemove', handleMouseMove);
                document.removeEventListener('mouseup', handleMouseUp);
            };
        }
        
        showSidebar() {
            const verifierTab = document.getElementById('ca-verifier') || document.getElementById('t-verifier');
            
            document.body.classList.remove('verifier-sidebar-hidden');
            if (verifierTab) verifierTab.style.display = 'none';
            document.body.style.marginRight = this.sidebarWidth;
            
            this.isVisible = true;
            localStorage.setItem('verifier_sidebar_visible', 'true');
        }
        
        hideSidebar() {
            const verifierTab = document.getElementById('ca-verifier') || document.getElementById('t-verifier');
            
            document.body.classList.add('verifier-sidebar-hidden');
            if (verifierTab) verifierTab.style.display = 'list-item';
            document.body.style.marginRight = '0';
            
            this.clearHighlights();
            
            this.isVisible = false;
            localStorage.setItem('verifier_sidebar_visible', 'false');
        }
        
        adjustMainContent() {
            if (this.isVisible) {
                document.body.style.marginRight = this.sidebarWidth;
            } else {
                document.body.style.marginRight = '0';
            }
        }
        
        attachEventListeners() {
            this.buttons.close.on('click', () => {
                this.hideSidebar();
            });

            // The gear toggles, so a second click backs out the way a user expects.
            this.buttons.settings.on('click', () => {
                if (this.settingsOpen) this.closeSettings();
                else this.openSettings();
            });

            this.buttons.settingsDone.on('click', () => {
                this.closeSettings();
            });

            this.buttons.openSettings.on('click', () => {
                this.openSettings();
            });

            const statusSettingsLink = document.getElementById('verifier-status-settings');
            if (statusSettingsLink) {
                statusSettingsLink.addEventListener('click', (e) => {
                    e.preventDefault();
                    this.openSettings();
                });
            }
            
            this.buttons.providerSelect.getMenu().on('select', (item) => {
                this.currentProvider = item.getData();
                localStorage.setItem('source_verifier_provider', this.currentProvider);
                this.updateButtonVisibility();
                this.updateTheme();
                this.updateStatus(this.t('Switched to {name}', { name: this.providers[this.currentProvider].name }));
            });

            this.buttons.claimScopeSelect.getMenu().on('select', (item) => {
                this.claimScope = item.getData();
                localStorage.setItem('verifier_claim_scope', this.claimScope);
            });

            this.buttons.setKey.on('click', () => {
                this.setApiKey();
            });
            
            this.buttons.changeKey.on('click', () => {
                this.setApiKey();
            });
            
            this.buttons.verify.on('click', () => {
                this.verifyClaim();
            });
            
            this.buttons.removeKey.on('click', () => {
                this.removeApiKey();
            });
            
            this.buttons.loadText.on('click', () => {
                this.loadManualSourceText();
            });
            
            this.buttons.cancelText.on('click', () => {
                this.cancelManualSourceText();
            });

            const pdfInput = document.getElementById('verifier-source-pdf-input');
            if (pdfInput) {
                pdfInput.addEventListener('change', (event) => {
                    const file = event.target.files && event.target.files[0];
                    // Reset so picking the same file again still fires 'change'.
                    event.target.value = '';
                    this.handlePdfFileSelected(file);
                });
            }
            const pdfLabel = document.getElementById('verifier-source-pdf-label');
            if (pdfLabel && pdfInput) {
                // Keyboard access: Enter/Space on the styled label opens the picker.
                pdfLabel.addEventListener('keydown', (event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        pdfInput.click();
                    }
                });
            }

            this.buttons.overrideText.on('click', () => {
                this.showSourceTextInput(true);
                this.updateStatus(this.t('Paste replacement source text below, then click Load Text.'));
            });

            this.buttons.verifyAll.on('click', () => {
                this.verifyAllCitations();
            });

            this.buttons.stopAll.on('click', () => {
                this.reportCancelled = true;
            });

            this.buttons.backToReport.on('click', () => {
                this.showReportView();
            });
        }
        
        updateTheme() {
            const color = this.getCurrentColor();
            // Remove old styles and re-create to pick up new provider color in dark theme
            const oldStyle = document.querySelector('style[data-verifier-theme]');
            if (oldStyle) oldStyle.remove();
            // Re-create styles with updated color references
            const existingStyles = document.head.querySelectorAll('style');
            existingStyles.forEach(s => {
                if (s.textContent.includes('#source-verifier-sidebar')) s.remove();
            });
            this.createStyles();
        }
        
        setApiKey() {
            const provider = this.providers[this.currentProvider];

            if (!provider.requiresKey && !provider.optionalKey) {
                this.updateStatus(this.t('This provider does not require an API key.'));
                return;
            }
            
            const dialog = new OO.ui.MessageDialog();
            
            const textInput = new OO.ui.TextInputWidget({
                placeholder: this.t('Enter your {name} API Key...', { name: provider.name }),
                type: 'password',
                value: (provider.storageKey ? localStorage.getItem(provider.storageKey) : '') || ''
            });
            
            const windowManager = new OO.ui.WindowManager();
            // Append to #mw-teleport-target (lifted above the sidebar by our
            // CSS) so the dialog renders on top when the sidebar overlaps it.
            // Fall back to body if the teleport target is unavailable.
            const dialogHost = document.getElementById('mw-teleport-target') || document.body;
            dialogHost.appendChild(windowManager.$element[0]);
            windowManager.addWindows([dialog]);
            
            windowManager.openWindow(dialog, {
                title: this.t('Set {name} API Key', { name: provider.name }),
                message: $('<div>').append(
                    $('<p>').text(this.t('Enter your {name} API Key to enable source verification:', { name: provider.name })),
                    textInput.$element
                ),
                actions: [
                    {
                        action: 'save',
                        label: this.t('Save'),
                        flags: ['primary', 'progressive']
                    },
                    {
                        action: 'cancel',
                        label: this.t('Cancel'),
                        flags: ['safe']
                    }
                ]
            }).closed.then((data) => {
                if (data && data.action === 'save') {
                    const key = textInput.getValue().trim();
                    if (key) {
                        this.setCurrentApiKey(key);
                        this.updateButtonVisibility();
                        this.updateStatus(this.t('API key set successfully!'));
                        
                        if (this.activeClaim && this.activeSource) {
                            this.updateButtonVisibility();
                        }
                    }
                }
                windowManager.destroy();
            });
        }
        
        removeApiKey() {
            const provider = this.providers[this.currentProvider];
            if (!provider.requiresKey && !provider.optionalKey) {
                this.updateStatus(this.t('This provider does not use a stored API key.'));
                return;
            }
            
            OO.ui.confirm(this.t('Are you sure you want to remove the stored API key?')).done((confirmed) => {
                if (confirmed) {
                    this.removeCurrentApiKey();
                    this.updateButtonVisibility();
                    this.updateStatus(this.t('API key removed successfully!'));
                }
            });
        }
        
        updateStatus(message, isError = false) {
            if (isError) {
                console.error('Verifier Error:', message);
            } else {
                console.log('Verifier Status:', message);
            }
        }
        
        // ========================================
        // CENTRALIZED PROMPT GENERATION
        // ========================================
        
        /**
         * Generates the system prompt for verification
         * @returns {string} The system prompt
         */
        generateSystemPrompt() {
            return generateSystemPrompt();
        }
        
        generateUserPrompt(claim, sourceInfo) {
            return generateUserPrompt(claim, sourceInfo);
        }

        // When the UI is localized, ask the model to write its free-text
        // explanation in that language so the "comments" shown next to each
        // verdict match the rest of the interface. The verdict and reason_type
        // values are parsed programmatically, so they must stay in the English
        // enum; the directive is appended (not spliced) to leave the
        // benchmark-tuned few-shot prompt in core/prompts.js untouched. English
        // wikis get the prompt verbatim.
        localizeSystemPrompt(prompt) {
            const language = PROMPT_LANGUAGES[this.lang];
            if (!language) return prompt;
            return prompt + `\n\nLANGUAGE: Write the "comments" field in ${language}. `
                + 'The "source_quote" field is an exception: it must stay in the source\'s own language, copied verbatim. Never translate it — it is checked against the source text character for character. '
                + `You may quote the source verbatim in its original language, but write your own explanation in ${language}. `
                + 'Keep the "verdict" and "reason_type" values exactly as specified above, in English '
                + '(SUPPORTED, PARTIALLY SUPPORTED, NOT SUPPORTED, SOURCE UNAVAILABLE, contradiction, omission).';
        }

        // Mints the check id, fires the log, and hands the id back so the
        // caller can stash it on the result it just built. Every verdict the
        // user can see gets one — including the ones that never reached an
        // LLM — so the feedback controls are uniformly available.
        //
        // `parsed` is the verdict object ({ verdict, support_score, comments,
        // reason_type }); `context` overrides the active-citation fields for
        // the batch paths, which verify citations other than the selected one.
        //
        // `context.sourceInfo` is the source text the model was shown. Passing
        // it lets the log record the quote together with the outcome of
        // checking it — the pairing is the point, since a quote is only
        // interpretable next to whether it was found. Omit it where there was
        // no source at all (a failed fetch), and the row logs an empty quote.
        logVerification(parsed, context = {}) {
            const checkId = newCheckId();
            const provider = this.providers[this.currentProvider] || {};
            // `in` rather than ??: the collective path passes sourceUrl: null
            // deliberately (several sources, no single one to name), and that
            // must not fall back to the sidebar's active citation.
            const fromContext = (key, fallback) => (key in context ? context[key] : fallback);
            const quoteView = this.buildQuoteView(parsed, context.sourceInfo);
            logVerification(buildLogPayload({
                checkId,
                kind: context.kind,
                articleUrl: window.location.href,
                articleTitle: typeof mw !== 'undefined' ? mw.config.get('wgTitle') : document.title,
                revisionId: this.getArticleRevisionId(),
                citationNumber: fromContext('citationNumber', this.activeCitationNumber),
                sourceUrl: fromContext('sourceUrl', this.activeSourceUrl),
                provider: this.currentProvider,
                model: provider.model || null,
                verdict: parsed?.verdict,
                supportScore: parsed?.support_score,
                reasonType: parsed?.reason_type ?? null,
                claimText: fromContext('claimText', this.activeClaim),
                comments: parsed?.comments,
                sourceQuote: quoteView.quote,
                quoteStatus: quoteView.status,
            }));
            return checkId;
        }

        async verifyClaim() {
            const requiresKey = this.providerRequiresKey();
            const hasKey = !!this.getCurrentApiKey();
            
            // Only require a browser key for providers that need it
            if ((requiresKey && !hasKey) || !this.activeClaim || !this.activeSource) {
                this.updateStatus(this.t('Missing API key (for this provider), claim, or source content'), true);
                return;
            }
            
            const verifyId = ++this.currentVerifyId;
            try {
                this.buttons.verify.setDisabled(true);
                this.buttons.verify.setLabel(this.t('Verifying...'));
                this.buttons.verify.setIcon('clock');
                this.updateStatus(this.t('Verifying claim against source...'));

                const apiResult = await this.callProviderAPI(this.activeClaim, this.activeSource);
                const result = apiResult.text;

                if (verifyId !== this.currentVerifyId) {
                    return;
                }

                this.updateStatus(this.t('Verification complete!'));
                this.displayResult(result);

                // Fire-and-forget logging. Runs before displayResult() rather
                // than after it: the feedback controls displayResult() renders
                // are keyed on the check id minted here, and an unparseable
                // response yields no id (and so no controls) by design.
                this.activeCheckId = null;
                try {
                    const jsonMatch = result.match(/```(?:json)?\s*([\s\S]*?)\s*```/) ||
                                     [null, result.match(/\{[\s\S]*\}/)?.[0]];
                    const parsed = JSON.parse(jsonMatch[1]);
                    this.activeCheckId = this.logVerification(parsed, { sourceInfo: this.activeSource });
                } catch (e) {}

                this.displayResult(result);

            } catch (error) {
                if (verifyId !== this.currentVerifyId) {
                    return;
                }
                console.error('Verification error:', error);
                this.updateStatus(this.t('Error: {message}', { message: error.message }), true);
                document.getElementById('verifier-verdict').textContent = this.t('ERROR');
                document.getElementById('verifier-verdict').className = 'source-unavailable';
                document.getElementById('verifier-comments').textContent = error.message;
                // The results section is only on screen when there is something
                // to show, and a failure counts — without this the error would
                // be written into a hidden element.
                this.hasResult = true;
                this.renderUiState();
            } finally {
                if (verifyId === this.currentVerifyId) {
                    this.buttons.verify.setLabel(this.t('Verify Claim'));
                    this.buttons.verify.setIcon('check');
                    this.updateButtonVisibility();
                }
            }
        }
        
        async callPublicAIAPI(claim, sourceInfo) {
            return callPublicAIAPI({ model: this.providers.publicai.model, systemPrompt: this.localizeSystemPrompt(generateSystemPrompt()), userContent: generateUserPrompt(claim, sourceInfo) });
        }
        
        async callClaudeAPI(claim, sourceInfo) {
            return callClaudeAPI({ apiKey: this.getCurrentApiKey(), model: this.providers.claude.model, systemPrompt: this.localizeSystemPrompt(generateSystemPrompt()), userContent: generateUserPrompt(claim, sourceInfo) });
        }
        
        async callGeminiAPI(claim, sourceInfo) {
            return callGeminiAPI({ apiKey: this.getCurrentApiKey(), model: this.providers.gemini.model, systemPrompt: this.localizeSystemPrompt(generateSystemPrompt()), userContent: generateUserPrompt(claim, sourceInfo) });
        }
        
        async callOpenAIAPI(claim, sourceInfo) {
            return callOpenAIAPI({ apiKey: this.getCurrentApiKey(), model: this.providers.openai.model, systemPrompt: this.localizeSystemPrompt(generateSystemPrompt()), userContent: generateUserPrompt(claim, sourceInfo) });
        }
        
	parseVerificationResult(response) {
	    return parseVerificationResult(response);
	}

        // ========================================
        // SOURCE QUOTE (evidence) METHODS
        // ========================================

        // Checks the model's source_quote against the source text it was
        // actually shown. Returns the shape the renderers and the dataset
        // submission both read: { quote, verified, status }.
        //
        // sourceInfo is the raw "Source URL: ...\n\nSource Content:\n..."
        // blob (or the assembled multi-source text for a group); it is
        // unwrapped here so the comparison sees exactly the body the model saw.
        buildQuoteView(parsed, sourceInfo) {
            // Accepts both shapes that carry a quote: a freshly parsed LLM
            // response (`source_quote`) and a stored report result
            // (`sourceQuote`). The logging path is handed whichever of the two
            // the call site happens to hold.
            const quote = (parsed && (parsed.source_quote ?? parsed.sourceQuote)) || '';
            const sourceText = sourceInfo ? extractSourceText(sourceInfo) : '';
            const check = verifyQuote(sourceText, quote);
            return {
                // `quote` is what the model said, kept for the log. `display`
                // is the part of it actually found in the source — the only
                // text a renderer may show.
                quote,
                display: check.verifiedText,
                verified: check.verified,
                status: check.status,
            };
        }

        // Report results carry the already-computed verification, so the
        // renderers don't re-check (and don't need the source text again).
        quoteViewOf(result) {
            if (!result || !result.sourceQuote) return null;
            return {
                quote: result.sourceQuote,
                display: result.quoteDisplay || '',
                verified: !!result.quoteVerified,
                status: result.quoteStatus,
            };
        }

        // Renders the evidence block: the part of the model's quote that was
        // located in the source, or nothing.
        //
        // Nothing is deliberate. An unlocatable quote used to draw a warning
        // here, but that warning implied the verdict was less trustworthy — a
        // claim there is no evidence for. A model that paraphrases instead of
        // copying may still be judging correctly, and steering an editor away
        // from a correct verdict is a real cost paid against a speculative
        // benefit. quote_status is still logged on every row, so "does an
        // unverified quote predict a worse verdict?" stays answerable; if the
        // benchmark answers yes, the warning will have earned its place.
        quoteHtml(view) {
            if (!view || !view.display) return '';
            // Every character of `display` was found in the source. A partial
            // match shows its surviving fragments ellipsis-joined, which reads
            // as the ordinary elision it is.
            return `<div class="sv-quote">`
                + `<span class="sv-quote-label">${this.escapeHtml(this.t('From the source'))}</span>`
                + `<div class="sv-quote-text">“${this.escapeHtml(view.display)}”</div>`
                + `</div>`;
        }

	displayResult(response) {
	    const verdictEl = document.getElementById('verifier-verdict');
	    const commentsEl = document.getElementById('verifier-comments');
	    const quoteEl = document.getElementById('verifier-quote');

	    const result = this.parseVerificationResult(response);
	    const quoteView = this.buildQuoteView(result, this.activeSource);

	    verdictEl.textContent = this.t(result.verdict);
	    verdictEl.className = '';

	    if (result.verdict === 'SUPPORTED') {
	        verdictEl.classList.add('supported');
	    } else if (result.verdict === 'PARTIALLY SUPPORTED') {
	        verdictEl.classList.add('partially-supported');
	    } else if (result.verdict === 'NOT SUPPORTED') {
	        verdictEl.classList.add('not-supported');
	    } else if (result.verdict === 'SOURCE UNAVAILABLE' || result.verdict === 'PARSE_ERROR') {
	        verdictEl.classList.add('source-unavailable');
	    }

	    const existingTag = document.getElementById('verifier-reason-type');
	    if (existingTag) existingTag.remove();
	    if (result.verdict === 'NOT SUPPORTED' && result.reason_type) {
	        const tag = document.createElement('span');
	        tag.id = 'verifier-reason-type';
	        tag.className = `reason-type-tag reason-type-${result.reason_type}`;
	        tag.textContent = this.reasonTypeLabel(result.reason_type);
	        verdictEl.after(tag);
	    }

	    if (quoteEl) {
	        quoteEl.innerHTML = this.quoteHtml(quoteView);
	    }

	    commentsEl.textContent = result.comments;

	    const nextEl = document.getElementById('verifier-verdict-next');
	    if (nextEl) {
	        const next = this.nextStepFor(result.verdict);
	        nextEl.textContent = next;
	        nextEl.style.display = next ? '' : 'none';
	    }

	    this.hasResult = true;
	    this.renderUiState();

	    console.log('[Verifier] Verdict for action button:', JSON.stringify(result.verdict));
	    this.showActionButton(result.verdict, result.comments);
	}
        
        // ========================================
        // ARTICLE REPORT METHODS
        // ========================================

        collectAllCitations() {
            // Scope to the skin's content container: .reference a targets inline
            // <sup class="reference"> links only — each is a unique DOM element.
            // Footnote backlinks use .mw-cite-backlink, not .reference, so no
            // dedup is needed. The batch runner passes a Parsoid document as the
            // root instead; see core/citations.js.
            return collectCitations(document.getElementById('mw-content-text'), { claimScope: this.claimScope });
        }

        attachGroupMetadata(citations) {
            return attachGroupMetadata(citations);
        }

        showReportView() {
            this.reportMode = true;
            this.settingsOpen = false;
            this.renderUiState();
            this.updateButtonVisibility();
        }

        showSingleCitationView() {
            this.reportMode = false;
            this.settingsOpen = false;
            this.renderUiState();
            this.refreshOverrideButton();
            this.updateButtonVisibility();
        }

        updateReportProgress(current, total, phase, startTime) {
            const progressEl = document.getElementById('verifier-report-progress');
            if (!progressEl) return;

            const pct = total > 0 ? Math.round((current / total) * 100) : 0;
            const elapsed = Date.now() - startTime;
            const elapsedStr = this.formatDuration(elapsed);
            let etaStr = '';
            if (current > 0) {
                const remaining = ((elapsed / current) * (total - current));
                etaStr = this.t(' · ~{duration} remaining', { duration: this.formatDuration(remaining) });
            }

            progressEl.innerHTML = `
                <div class="verifier-progress-bar">
                    <div class="verifier-progress-fill" style="width: ${pct}%"></div>
                </div>
                <div class="verifier-progress-text">
                    ${phase} (${current}/${total}) · ${elapsedStr}${etaStr}
                </div>
            `;
        }

        formatDuration(ms) {
            const s = Math.round(ms / 1000);
            if (this.lang === 'fr') {
                if (s < 60) return `${s} s`;
                const m = Math.floor(s / 60);
                return `${m} min ${s % 60} s`;
            }
            if (s < 60) return `${s}s`;
            const m = Math.floor(s / 60);
            return `${m}m ${s % 60}s`;
        }

        loadReportFilters() {
            // Filter keys match CSS verdict classes: supported, partial, not-supported, unavailable, error
            // By default, hide 'supported' since those citations are usually not actionable.
            const defaults = { supported: true, partial: false, 'not-supported': false, unavailable: false, error: false };
            try {
                const stored = localStorage.getItem('verifier_report_filters');
                if (!stored) return defaults;
                const parsed = JSON.parse(stored);
                return { ...defaults, ...parsed };
            } catch (e) {
                return defaults;
            }
        }

        saveReportFilters() {
            try {
                localStorage.setItem('verifier_report_filters', JSON.stringify(this.reportFilters));
            } catch (e) {}
        }

        toggleReportFilter(verdictClass) {
            this.reportFilters[verdictClass] = !this.reportFilters[verdictClass];
            this.saveReportFilters();
            this.applyReportFilters();
            this.renderReportSummary();
        }

        applyReportFilters() {
            const resultsEl = document.getElementById('verifier-report-results');
            if (!resultsEl) return;
            const classes = ['supported', 'partial', 'not-supported', 'unavailable', 'error'];
            // Solo .verifier-report-card visibility is still driven by these
            // CSS-only filter-hide-* classes (see #verifier-report-results
            // CSS rules in createStyles).
            for (const cls of classes) {
                resultsEl.classList.toggle(`filter-hide-${cls}`, !!this.reportFilters[cls]);
            }

            // Group blocks are filtered by their COLLECTIVE verdict (the one
            // shown in the filter pills), not by the individual per-source
            // rows. Inside a visible group every row stays visible regardless
            // of its verdict — the rows are debug detail.
            //
            // Two group states have no collective verdict to filter on, and
            // they are not the same:
            //
            //  - Pending: the collective check hasn't run yet. getReportUnits()
            //    contributes nothing for the group, so the pills don't count it
            //    either. Stays visible; resolves when the check completes.
            //  - Skipped: verifyGroupCollective() bailed because at most one
            //    source was retrievable, so a combined verdict would just
            //    restate the single per-source one. getReportUnits() then falls
            //    back to counting each MEMBER as its own unit — so the pills do
            //    count these, and the block has to honour the filters the same
            //    way, or the summary claims citations are hidden while they are
            //    still on screen. Hide it once every member's verdict is
            //    filtered off.
            const groups = resultsEl.querySelectorAll('.verifier-report-group');
            groups.forEach(groupEl => {
                const collectiveVerdict = groupEl.dataset.collectiveVerdict;
                let hidden;
                if (collectiveVerdict) {
                    hidden = !!this.reportFilters[collectiveVerdict];
                } else if (groupEl.dataset.collectiveSkipped === 'true') {
                    const rows = groupEl.querySelectorAll('.verifier-report-group-row');
                    hidden = rows.length > 0 && Array.from(rows).every(row => {
                        const cls = classes.find(c => row.classList.contains(`verdict-${c}`));
                        return cls && !!this.reportFilters[cls];
                    });
                } else {
                    hidden = false;
                }
                groupEl.style.display = hidden ? 'none' : '';
            });

            // Show an empty-state hint when every rendered solo card and
            // every group block is hidden by filters.
            let emptyEl = resultsEl.querySelector('.verifier-filter-empty');
            const soloCards = resultsEl.querySelectorAll('.verifier-report-card');
            const hasVisibleSolo = Array.from(soloCards).some(c => {
                const verdictClass = classes.find(cls => c.classList.contains(`verdict-${cls}`));
                return verdictClass && !this.reportFilters[verdictClass];
            });
            const hasVisibleGroup = Array.from(groups).some(g => g.style.display !== 'none');
            const total = soloCards.length + groups.length;
            if (total > 0 && !hasVisibleSolo && !hasVisibleGroup) {
                if (!emptyEl) {
                    emptyEl = document.createElement('div');
                    emptyEl.className = 'verifier-filter-empty';
                    emptyEl.textContent = this.t('All citations are hidden by the current filters. Click a filter above to show them.');
                    resultsEl.appendChild(emptyEl);
                }
            } else if (emptyEl) {
                emptyEl.remove();
            }
        }

        renderReportSummary() {
            const summaryEl = document.getElementById('verifier-report-summary');
            if (!summaryEl) return;

            // Counts/pills are driven by the per-claim units: one verdict per
            // adjacent group (its collective verdict) plus one per solo
            // citation. The individual per-source rows shown inside group
            // blocks are debug detail and don't feed the pills.
            const units = this.getReportUnits();
            const counts = { supported: 0, partial: 0, 'not-supported': 0, unavailable: 0, error: 0 };
            for (const u of units) {
                if (u.verdict === 'SUPPORTED') counts.supported++;
                else if (u.verdict === 'PARTIALLY SUPPORTED') counts.partial++;
                else if (u.verdict === 'NOT SUPPORTED') counts['not-supported']++;
                else if (u.verdict === 'SOURCE UNAVAILABLE') counts.unavailable++;
                else counts.error++;
            }
            const total = units.length;

            const segHtml = (count, cls) => (count > 0 && total > 0) ? `<div class="${cls}" style="width:${(count/total)*100}%"></div>` : '';

            const chip = (key, count, label, color) => {
                const hidden = !!this.reportFilters[key];
                const localizedLabel = this.t(label);
                const titleText = hidden
                    ? this.t('Show {label} citations', { label: localizedLabel })
                    : this.t('Hide {label} citations', { label: localizedLabel });
                return `<button type="button"
                    class="verifier-filter-chip${hidden ? ' verifier-chip-off' : ''}"
                    data-filter="${key}"
                    title="${this.escapeHtml(titleText)}"
                    aria-pressed="${hidden ? 'false' : 'true'}">
                    <span class="dot" style="background:${color}"></span>${count} ${this.escapeHtml(localizedLabel)}
                </button>`;
            };

            const hiddenCount =
                (this.reportFilters.supported ? counts.supported : 0) +
                (this.reportFilters.partial ? counts.partial : 0) +
                (this.reportFilters['not-supported'] ? counts['not-supported'] : 0) +
                (this.reportFilters.unavailable ? counts.unavailable : 0) +
                (this.reportFilters.error ? counts.error : 0);

            // Each unit is one claim; a group unit covers groupSize citations.
            const citationCount = units.reduce((n, u) => n + (u.groupSize || 1), 0);
            const claimsLabel = citationCount === total
                ? this.t(total === 1 ? '{count} citation checked' : '{count} citations checked', { count: total })
                : this.t(total === 1 ? '{citations} citations across {claims} claim' : '{citations} citations across {claims} claims', { citations: citationCount, claims: total });

            summaryEl.innerHTML = `
                <div class="verifier-summary-bar">
                    ${segHtml(counts.supported, 'seg-supported')}
                    ${segHtml(counts.partial, 'seg-partial')}
                    ${segHtml(counts['not-supported'], 'seg-not-supported')}
                    ${segHtml(counts.unavailable, 'seg-unavailable')}
                    ${segHtml(counts.error, 'seg-error')}
                </div>
                <div class="verifier-summary-counts">
                    ${chip('supported', counts.supported, 'supported', '#28a745')}
                    ${chip('partial', counts.partial, 'partial', '#ffc107')}
                    ${chip('not-supported', counts['not-supported'], 'not supported', '#dc3545')}
                    ${chip('unavailable', counts.unavailable, 'unavailable', '#6c757d')}
                    ${counts.error > 0 ? chip('error', counts.error, 'errors', '#adb5bd') : ''}
                </div>
                <div class="verifier-summary-meta">
                    ${claimsLabel}${hiddenCount > 0 ? this.t(' · {count} hidden by filter', { count: hiddenCount }) : ''}${this.reportTokenUsage.input + this.reportTokenUsage.output > 0 ? this.t(' · {input} input + {output} output tokens', { input: this.reportTokenUsage.input.toLocaleString(), output: this.reportTokenUsage.output.toLocaleString() }) : ''}
                </div>
                ${this.reportRevisionId ? `<div class="verifier-summary-meta">${this.t('Revision: ')}<a href="${this.escapeHtml(this.getRevisionPermalinkUrl(this.reportRevisionId) || '#')}" target="_blank" rel="noopener">${this.reportRevisionId}</a></div>` : ''}
            `;

            summaryEl.querySelectorAll('.verifier-filter-chip').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.preventDefault();
                    this.toggleReportFilter(btn.dataset.filter);
                });
            });
        }

        // The reason_type enum itself stays English — it is parsed
        // programmatically and round-trips to the dataset — but the tag shown
        // next to a "not supported" verdict is UI text, so it gets translated.
        reasonTypeLabel(reasonType) {
            return reasonType === 'contradiction' ? this.t('Contradiction') : this.t('Omission');
        }

        verdictClassFor(verdict) {
            switch (verdict) {
                case 'SUPPORTED': return { cls: 'supported', label: this.t('Supported') };
                case 'PARTIALLY SUPPORTED': return { cls: 'partial', label: this.t('Partial') };
                case 'NOT SUPPORTED': return { cls: 'not-supported', label: this.t('Not Supported') };
                case 'SOURCE UNAVAILABLE': return { cls: 'unavailable', label: this.t('Unavailable') };
                default: return { cls: 'error', label: this.t(verdict) };
            }
        }

        attachRefScrollHandler(el, refElement) {
            if (!refElement) return;
            el.addEventListener('click', (e) => {
                if (e.target.closest('.report-card-action') || e.target.closest('.report-card-header-actions') || e.target.closest('.verifier-report-group-edit') || e.target.closest('.report-card-citation-link')) return;
                refElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
                this.clearHighlights();
                const parentRef = refElement.closest('.reference');
                if (parentRef) parentRef.classList.add('verifier-active');
            });
        }

        renderReportCard(result, index) {
            const resultsEl = document.getElementById('verifier-report-results');
            if (!resultsEl) return;

            // Solo citation: render the original card layout unchanged.
            if (!result.groupSize || result.groupSize <= 1) {
                resultsEl.appendChild(this.buildSoloCard(result));
                return;
            }

            // Group of >1: the first citation in the group creates a group
            // container; every subsequent citation appends a row into the
            // existing container located by data-group-id.
            let groupEl = resultsEl.querySelector(`.verifier-report-group[data-group-id="${CSS.escape(result.groupId)}"]`);
            if (!groupEl) {
                groupEl = this.buildGroupBlock(result);
                resultsEl.appendChild(groupEl);
            }
            const rowsEl = groupEl.querySelector('.verifier-report-group-rows');
            rowsEl.appendChild(this.buildGroupRow(result));
        }

        buildSoloCard(result) {
            const { cls: verdictClass, label: verdictLabel } = this.verdictClassFor(result.verdict);
            const card = document.createElement('div');
            card.className = `verifier-report-card verdict-${verdictClass}`;
            const claimExcerpt = result.claimText.length > 80 ? result.claimText.substring(0, 80) + '…' : result.claimText;
            const truncationHtml = (result.truncated && result.verdict !== 'SUPPORTED')
                ? `<div class="report-card-truncated">${this.t('⚠ Source is long, only partially checked.')}</div>`
                : '';
            const reasonTypeHtml = (result.verdict === 'NOT SUPPORTED' && result.reason_type)
                ? `<span class="reason-type-tag reason-type-${result.reason_type}">${this.reasonTypeLabel(result.reason_type)}</span>`
                : '';
            card.innerHTML = `
                <div class="report-card-header">
                    ${result.url
                        ? `<a class="report-card-citation report-card-citation-link" href="${this.escapeHtml(result.url)}" target="_blank" rel="noopener noreferrer">[${result.citationNumber}]</a>`
                        : `<span class="report-card-citation">[${result.citationNumber}]</span>`}
                    <span class="report-card-header-actions">
                        <span class="report-card-verdict ${verdictClass}">${verdictLabel}</span>${reasonTypeHtml}
                    </span>
                </div>
                <div class="report-card-claim">${this.escapeHtml(claimExcerpt)}</div>
                ${this.quoteHtml(this.quoteViewOf(result))}
                ${result.comments ? `<div class="report-card-comment">${this.escapeHtml(result.comments)}</div>` : ''}
                ${truncationHtml}
            `;

            this.attachRefScrollHandler(card, result.refElement);

            const actionDiv = document.createElement('div');
            actionDiv.className = 'report-card-action';

            if (result.refElement && (result.verdict === 'NOT SUPPORTED' || result.verdict === 'PARTIALLY SUPPORTED' || result.verdict === 'SOURCE UNAVAILABLE')) {
                const editBtn = new OO.ui.ButtonWidget({
                    label: this.t('Edit Section'),
                    flags: ['progressive'],
                    icon: 'edit',
                    href: this.buildEditUrl(result.refElement),
                    target: '_blank',
                    framed: false
                });
                actionDiv.appendChild(editBtn.$element[0]);
            }

            if (actionDiv.children.length) {
                card.appendChild(actionDiv);
            }

            const feedback = this.buildFeedbackControls(result);
            if (feedback) card.appendChild(feedback);
            return card;
        }

        buildGroupBlock(firstResult) {
            const groupEl = document.createElement('div');
            groupEl.className = 'verifier-report-group';
            groupEl.dataset.groupId = firstResult.groupId;
            const claimExcerpt = firstResult.claimText.length > 120 ? firstResult.claimText.substring(0, 120) + '…' : firstResult.claimText;
            const numbers = (firstResult.groupCitationNumbers || []).map(n => `[${n}]`).join('');
            groupEl.innerHTML = `
                <div class="verifier-report-group-header">
                    <div class="verifier-report-group-title">
                        <span class="verifier-report-group-badge">${this.escapeHtml(this.t('Group of {size} · {numbers}', { size: firstResult.groupSize, numbers }))}</span>
                    </div>
                    <div class="verifier-report-group-claim">${this.escapeHtml(claimExcerpt)}</div>
                    <div class="verifier-report-group-collective">
                        <div class="verifier-report-group-collective-pending">${this.t('Checking combined sources…')}</div>
                    </div>
                    <div class="verifier-report-group-edit"></div>
                </div>
                <div class="verifier-report-group-rows-label">${this.t('Individual sources')}</div>
                <div class="verifier-report-group-rows"></div>
            `;
            // One shared "Edit Section" button per group: every member is in
            // the same article section by definition, so a per-row button
            // would just be repetition. Wire it to the first member's ref.
            if (firstResult.refElement) {
                const editBtn = new OO.ui.ButtonWidget({
                    label: this.t('Edit Section'),
                    flags: ['progressive'],
                    icon: 'edit',
                    href: this.buildEditUrl(firstResult.refElement),
                    target: '_blank',
                    framed: false
                });
                groupEl.querySelector('.verifier-report-group-edit').appendChild(editBtn.$element[0]);
            }
            return groupEl;
        }

        // Fills the collective-verdict slot of an already-rendered group block
        // and tags the block with data-collective-verdict so the filter logic
        // can show/hide the whole group by its combined verdict.
        renderGroupCollectiveResult(result) {
            const resultsEl = document.getElementById('verifier-report-results');
            if (!resultsEl) return;
            const groupEl = resultsEl.querySelector(`.verifier-report-group[data-group-id="${CSS.escape(result.groupId)}"]`);
            if (!groupEl) return;

            const { cls: verdictClass, label: verdictLabel } = this.verdictClassFor(result.verdict);
            groupEl.dataset.collectiveVerdict = verdictClass;

            const slot = groupEl.querySelector('.verifier-report-group-collective');
            if (!slot) return;

            const reasonTypeHtml = (result.verdict === 'NOT SUPPORTED' && result.reason_type)
                ? `<span class="reason-type-tag reason-type-${result.reason_type}">${this.reasonTypeLabel(result.reason_type)}</span>`
                : '';
            const truncationHtml = (result.truncated && result.verdict !== 'SUPPORTED')
                ? `<div class="report-card-truncated">${this.t('⚠ Combined sources are long, only partially checked.')}</div>`
                : '';
            slot.innerHTML = `
                <div class="verifier-report-group-collective-header">
                    <span class="verifier-report-group-collective-label">${this.t('Combined verdict')}</span>
                    <span class="report-card-verdict ${verdictClass}">${verdictLabel}</span>${reasonTypeHtml}
                </div>
                ${this.quoteHtml(this.quoteViewOf(result))}
                ${result.comments ? `<div class="report-card-comment">${this.escapeHtml(result.comments)}</div>` : ''}
                ${truncationHtml}
            `;

            const feedback = this.buildFeedbackControls(result);
            if (feedback) slot.appendChild(feedback);
        }

        // Called when the collective check is skipped for want of a second
        // retrievable source. Marks the block so applyReportFilters() knows to
        // filter it by its members rather than leaving it permanently visible.
        hideGroupCollectiveSlot(groupId) {
            const resultsEl = document.getElementById('verifier-report-results');
            if (!resultsEl) return;
            const groupEl = resultsEl.querySelector(`.verifier-report-group[data-group-id="${CSS.escape(groupId)}"]`);
            if (!groupEl) return;
            groupEl.dataset.collectiveSkipped = 'true';
            const slot = groupEl.querySelector('.verifier-report-group-collective');
            if (slot) slot.style.display = 'none';
        }

        buildGroupRow(result) {
            const { cls: verdictClass, label: verdictLabel } = this.verdictClassFor(result.verdict);
            const row = document.createElement('div');
            row.className = `verifier-report-group-row verdict-${verdictClass}`;
            const truncationHtml = (result.truncated && result.verdict !== 'SUPPORTED')
                ? `<div class="report-card-truncated">${this.t('⚠ Source is long, only partially checked.')}</div>`
                : '';
            const reasonTypeHtml = (result.verdict === 'NOT SUPPORTED' && result.reason_type)
                ? `<span class="reason-type-tag reason-type-${result.reason_type}">${this.reasonTypeLabel(result.reason_type)}</span>`
                : '';
            row.innerHTML = `
                <div class="verifier-report-group-row-header">
                    ${result.url
                        ? `<a class="report-card-citation report-card-citation-link" href="${this.escapeHtml(result.url)}" target="_blank" rel="noopener noreferrer">[${result.citationNumber}]</a>`
                        : `<span class="report-card-citation">[${result.citationNumber}]</span>`}
                    <span class="report-card-header-actions">
                        <span class="report-card-verdict ${verdictClass}">${verdictLabel}</span>${reasonTypeHtml}
                    </span>
                </div>
                ${this.quoteHtml(this.quoteViewOf(result))}
                ${result.comments ? `<div class="report-card-comment">${this.escapeHtml(result.comments)}</div>` : ''}
                ${truncationHtml}
            `;
            this.attachRefScrollHandler(row, result.refElement);

            const feedback = this.buildFeedbackControls(result);
            if (feedback) row.appendChild(feedback);

            return row;
        }

        // Neutralizes the few characters that would break out of a wikitable
        // cell or start a template. Quoted source text is arbitrary prose from
        // the open web, so it cannot be trusted to be wikitext-safe.
        escapeWikitableCell(str) {
            return String(str == null ? '' : str)
                .replace(/\n/g, ' ')
                .replace(/\|/g, '&#124;')
                .replace(/\{/g, '&#123;')
                .replace(/\}/g, '&#125;');
        }

        escapeHtml(str) {
            const div = document.createElement('div');
            div.textContent = str;
            return div.innerHTML;
        }

        renderReportActions() {
            const actionsEl = document.getElementById('verifier-report-actions');
            if (!actionsEl) return;
            actionsEl.innerHTML = '';

            const copyWikiBtn = new OO.ui.ButtonWidget({
                label: this.t('Copy Report (Wikitext)'),
                flags: ['progressive'],
                icon: 'copy'
            });
            copyWikiBtn.on('click', () => this.copyReportToClipboard('wikitext'));
            actionsEl.appendChild(copyWikiBtn.$element[0]);

            const copyTextBtn = new OO.ui.ButtonWidget({
                label: this.t('Copy Report (Plain Text)'),
                flags: ['safe'],
                icon: 'copy'
            });
            copyTextBtn.on('click', () => this.copyReportToClipboard('plaintext'));
            actionsEl.appendChild(copyTextBtn.$element[0]);
        }

        // The revision the check ran against, recorded so a logged verdict or
        // a talk-page report stays reproducible after the article moves on.
        // `wgRevisionId` is the revision actually on screen and so the one that
        // was read; it differs from `wgCurRevisionId` only when an old revision
        // is being viewed, which is exactly the case where naming the current
        // revision would be a lie.
        getArticleRevisionId() {
            if (typeof mw === 'undefined') return null;
            try {
                return normalizeRevisionId(mw.config.get('wgRevisionId'))
                    ?? normalizeRevisionId(mw.config.get('wgCurRevisionId'));
            } catch (e) {
                return null;
            }
        }

        getRevisionPermalinkUrl(revId) {
            if (!revId || typeof mw === 'undefined') return null;
            try {
                let server = mw.config.get('wgServer') || '';
                if (server.startsWith('//')) server = 'https:' + server;
                const script = mw.config.get('wgScript') || '/w/index.php';
                const title = mw.config.get('wgPageName') || '';
                return `${server}${script}?title=${encodeURIComponent(title)}&oldid=${revId}`;
            } catch (e) {
                return null;
            }
        }

        generateWikitextReport() {
            const articleTitle = typeof mw !== 'undefined' ? mw.config.get('wgTitle') : document.title;
            const revId = this.reportRevisionId;
            let wikitext = `== ${this.t('Citation verification report')} ==\n`;
            wikitext += `${this.t('This is an experimental check of the article sources by [[User:Alaexis/AI_Source_Verification|Citation Verifier]]. Treat it with caution, be aware of its [[User:Alaexis/AI_Source_Verification#Limitations|limitations]] and feel free to leave feedback at [[User_talk:Alaexis/AI_Source_Verification|the talk page]].')}\n\n`;
            if (revId) {
                wikitext += `${this.t('Revision checked: ')}[[Special:PermanentLink/${revId}|${revId}]]\n\n`;
            }
            const submissionConfigured = this.isDatasetSubmissionConfigured();
            wikitext += `{| class="wikitable sortable"\n`;
            wikitext += submissionConfigured
                ? `|-\n${this.t('! # !! Verdict !! Source !! Comments !! class="unsortable" | Submit')}\n`
                : `|-\n${this.t('! # !! Verdict !! Source !! Comments')}\n`;

            // Link a citation number to its footnote anchor on the analyzed
            // revision, so clicks from the report jump to the original citation
            // even after later edits have shifted numbering. HTML entities are
            // used for the square brackets so they don't confuse MediaWiki's
            // wikilink parser.
            const linkNum = (num, refElement) => {
                const refHref = refElement && refElement.getAttribute('href');
                const refAnchor = refHref && refHref.startsWith('#') ? refHref.substring(1) : null;
                return (revId && refAnchor)
                    ? `[[Special:PermanentLink/${revId}#${refAnchor}|&#91;${num}&#93;]]`
                    : `[${num}]`;
            };

            // One row per claim: solo citations, and adjacent groups collapsed
            // to their single combined verdict (members linked, sources listed).
            const reportUnits = this.getReportUnits();
            for (const r of reportUnits) {
                let verdictWiki;
                switch (r.verdict) {
                    case 'SUPPORTED': verdictWiki = this.t('{{tick}} Supported'); break;
                    case 'PARTIALLY SUPPORTED': verdictWiki = this.t('{{bang}} Partially supported'); break;
                    case 'NOT SUPPORTED': verdictWiki = this.t('{{cross}} Not supported'); break;
                    case 'SOURCE UNAVAILABLE': verdictWiki = this.t('{{hmmm}} Source unavailable'); break;
                    default: verdictWiki = r.verdict; break;
                }
                let commentsClean = (r.comments || '').replace(/\n/g, ' ');
                // Verified quote first, as the evidence the reader can check;
                // the model's explanation follows it. Unverified quotes are
                // left out of the on-wiki report entirely.
                // Quote the located text, not the model's raw quote: on a
                // partial match the two differ, and only the former is
                // guaranteed to be in the source.
                if (r.quoteDisplay) {
                    commentsClean = `''"${this.escapeWikitableCell(r.quoteDisplay)}"''<br />`
                        + this.escapeWikitableCell(commentsClean);
                } else {
                    commentsClean = this.escapeWikitableCell(commentsClean);
                }
                if (r.truncated && r.verdict !== 'SUPPORTED') {
                    const note = r.isGroup
                        ? this.t("''(Combined sources are long, only partially checked.)''")
                        : this.t("''(Source is long, only partially checked.)''");
                    commentsClean += (commentsClean ? ' ' : '') + note;
                }
                let citationCell;
                let sourceStr;
                if (r.isGroup) {
                    citationCell = (r.members || []).map(m => linkNum(m.citationNumber, m.refElement)).join('')
                        + ` <small>${this.t('(combined)')}</small>`;
                    const links = (r.members || []).filter(m => m.url).map(m => `[${m.url} ${m.citationNumber}]`);
                    sourceStr = links.length ? links.join(' ') : '—';
                } else {
                    citationCell = linkNum(r.citationNumber, r.refElement);
                    sourceStr = r.url ? `[${r.url} ${this.t('source')}]` : '—';
                }
                if (submissionConfigured) {
                    const submitCell = (r.verdict && r.verdict !== 'ERROR')
                        ? `[${this.buildDatasetSubmissionUrl(r)} ${this.t('Submit')}]`
                        : '—';
                    wikitext += `|-\n| ${citationCell} || ${verdictWiki} || ${sourceStr} || ${commentsClean} || ${submitCell}\n`;
                } else {
                    wikitext += `|-\n| ${citationCell} || ${verdictWiki} || ${sourceStr} || ${commentsClean}\n`;
                }
            }

            wikitext += `|}\n\n`;

            const counts = { supported: 0, partial: 0, notSupported: 0, unavailable: 0 };
            for (const r of reportUnits) {
                if (r.verdict === 'SUPPORTED') counts.supported++;
                else if (r.verdict === 'PARTIALLY SUPPORTED') counts.partial++;
                else if (r.verdict === 'NOT SUPPORTED') counts.notSupported++;
                else counts.unavailable++;
            }
            const citationCount = reportUnits.reduce((n, u) => n + (u.groupSize || 1), 0);
            const claimsPhrase = citationCount === reportUnits.length
                ? this.t(reportUnits.length === 1 ? '{count} citation' : '{count} citations', { count: reportUnits.length })
                : this.t(reportUnits.length === 1 ? '{claims} claim ({citations} citations)' : '{claims} claims ({citations} citations)', { claims: reportUnits.length, citations: citationCount });
            wikitext += this.t("'''Summary:''' {supported} supported, {partial} partially supported, {notSupported} not supported, {unavailable} source unavailable out of {claims}.", { supported: counts.supported, partial: counts.partial, notSupported: counts.notSupported, unavailable: counts.unavailable, claims: claimsPhrase }) + `\n`;

            const provider = this.providers[this.currentProvider];
            let modelDesc;
            if (this.currentProvider === 'publicai') {
                modelDesc = this.t('a PublicAI-hosted open-source LLM');
            } else if (this.currentProvider === 'huggingface') {
                modelDesc = this.t('a HuggingFace-hosted open-source LLM ({model})', { model: provider.model });
            } else if (this.currentProvider === 'liftwing') {
                modelDesc = this.t('a Wikimedia Lift Wing-hosted open-source LLM ({model})', { model: provider.model });
            } else {
                modelDesc = provider.model;
            }
            wikitext += this.t('Generated by [[User:Alaexis/AI_Source_Verification|Citation Verifier]] using {model} on ~~~~~.', { model: modelDesc });
            if (this.reportTokenUsage.input + this.reportTokenUsage.output > 0) {
                wikitext += this.t(' Tokens used: {input} input, {output} output.', { input: this.reportTokenUsage.input.toLocaleString(), output: this.reportTokenUsage.output.toLocaleString() });
            }
            wikitext += `\n`;

            return wikitext;
        }

        generatePlainTextReport() {
            const articleTitle = typeof mw !== 'undefined' ? mw.config.get('wgTitle') : document.title;
            const revId = this.reportRevisionId;
            let text = this.t('Citation Verification Report: {title}', { title: articleTitle }) + `\n`;
            text += this.t('Provider: {name}', { name: this.providers[this.currentProvider].name }) + `\n`;
            if (revId) {
                const permalink = this.getRevisionPermalinkUrl(revId);
                text += this.t('Revision: {rev}', { rev: `${revId}${permalink ? ` (${permalink})` : ''}` }) + `\n`;
            }
            text += `${'='.repeat(60)}\n\n`;

            for (const r of this.getReportUnits()) {
                const claimExcerpt = `${r.claimText.substring(0, 100)}${r.claimText.length > 100 ? '...' : ''}`;
                if (r.isGroup) {
                    const token = (r.groupCitationNumbers || []).map(n => `[${n}]`).join('');
                    text += `${token} ${this.t('(combined)')} ${this.t(r.verdict)}\n`;
                    text += `  ${this.t('Claim: {text}', { text: claimExcerpt })}\n`;
                    const urls = (r.members || []).filter(m => m.url).map(m => `[${m.citationNumber}] ${m.url}`);
                    if (urls.length) text += `  ${this.t('Sources: {urls}', { urls: urls.join(' | ') })}\n`;
                    if (r.quoteDisplay) text += `  ${this.t('Quote: "{text}"', { text: r.quoteDisplay })}\n`;
                    if (r.comments) text += `  ${this.t('Comments: {text}', { text: r.comments })}\n`;
                    if (r.truncated && r.verdict !== 'SUPPORTED') text += `  ${this.t('Note: Combined sources are long, only partially checked.')}\n`;
                } else {
                    text += `[${r.citationNumber}] ${this.t(r.verdict)}\n`;
                    text += `  ${this.t('Claim: {text}', { text: claimExcerpt })}\n`;
                    if (r.url) text += `  ${this.t('Source: {url}', { url: r.url })}\n`;
                    if (r.quoteDisplay) text += `  ${this.t('Quote: "{text}"', { text: r.quoteDisplay })}\n`;
                    if (r.comments) text += `  ${this.t('Comments: {text}', { text: r.comments })}\n`;
                    if (r.truncated && r.verdict !== 'SUPPORTED') text += `  ${this.t('Note: Source is long, only partially checked.')}\n`;
                }
                text += `\n`;
            }

            if (this.reportTokenUsage.input + this.reportTokenUsage.output > 0) {
                text += this.t('Tokens used: {input} input, {output} output', { input: this.reportTokenUsage.input.toLocaleString(), output: this.reportTokenUsage.output.toLocaleString() }) + `\n`;
            }

            return text;
        }

        async copyReportToClipboard(format) {
            const text = format === 'wikitext' ? this.generateWikitextReport() : this.generatePlainTextReport();
            try {
                await navigator.clipboard.writeText(text);
                mw.notify(this.t('Report copied to clipboard!'), { type: 'info', autoHide: true, autoHideSeconds: 3 });
            } catch (e) {
                // Fallback
                const textarea = document.createElement('textarea');
                textarea.value = text;
                document.body.appendChild(textarea);
                textarea.select();
                document.execCommand('copy');
                document.body.removeChild(textarea);
                mw.notify(this.t('Report copied to clipboard!'), { type: 'info', autoHide: true, autoHideSeconds: 3 });
            }
        }

        // Toolforge override only applies to providers that route LLM calls
        // through the Worker's /liftwing and /hf paths — passing workerBase to
        // any other provider would either be ignored or (publicai) point it at
        // a route tf-llm-router doesn't implement.
        llmRouterConfigOverrides() {
            if (useToolforgeLlmRouter() && (this.currentProvider === 'liftwing' || this.currentProvider === 'huggingface')) {
                return { workerBase: TOOLFORGE_LLM_ROUTER_BASE };
            }
            return {};
        }

        async callProviderAPI(claim, sourceInfo) {
            return callProviderAPI(this.currentProvider, { apiKey: this.getCurrentApiKey(), model: this.providers[this.currentProvider].model, systemPrompt: this.localizeSystemPrompt(generateSystemPrompt()), userContent: generateUserPrompt(claim, sourceInfo), ...this.llmRouterConfigOverrides() });
        }

        // Collective (multi-source) variant of callProviderAPI: same provider
        // routing, but the group system prompt and a pre-assembled multi-source
        // user message. `assembledText` comes from assembleGroupSources().
        async callProviderAPIGroup(claim, assembledText) {
            return callProviderAPI(this.currentProvider, { apiKey: this.getCurrentApiKey(), model: this.providers[this.currentProvider].model, systemPrompt: this.localizeSystemPrompt(generateGroupSystemPrompt()), userContent: generateGroupUserPrompt(claim, assembledText), ...this.llmRouterConfigOverrides() });
        }

        // Runs the single collective verification for one adjacent-citation
        // group and renders its verdict into the existing group block. Reads
        // each member's already-fetched source from sourceCache, dedupes sources
        // shared by named refs, and falls back to SOURCE UNAVAILABLE (no LLM
        // call) when none of the grouped sources yielded usable content.
        async verifyGroupCollective(triggerCitation, citations, startTime, delayBetweenCalls, progressCurrent, progressTotal) {
            const groupId = triggerCitation.groupId;
            const members = citations
                .filter(c => c.groupId === groupId)
                .sort((a, b) => (a.groupIndex ?? 0) - (b.groupIndex ?? 0));
            if (members.length === 0) return;

            const claimText = members[0].claimText;
            const groupCitationNumbers = triggerCitation.groupCitationNumbers || members.map(m => m.citationNumber);

            // Dedupe by cache key so a source cited twice in the group (named
            // refs) is sent once, with both citation numbers on its label.
            // Shared with the batch pipeline via core/groups.js — see that
            // file's header for why this isn't reimplemented per caller.
            const entries = groupSourceEntries(members, m => {
                const cacheKey = m.url
                    ? (m.pageNum ? `${m.url}|page=${m.pageNum}` : m.url)
                    : `__nourl_${m.citationNumber}`;
                const fetchResult = m.url
                    ? (this.sourceCache.get(cacheKey) || { content: null, error: null, status: null })
                    : { content: null, error: 'No URL found in reference', status: null };
                return { key: cacheKey, url: m.url || null, content: fetchResult.content, error: fetchResult.error, status: fetchResult.status };
            });
            const truncated = entries.some(e => e.content && e.content.includes('\nTruncated: true'));
            const { text: assembledText, anyAvailable } = assembleGroupSources(entries);

            // When only one source is available the collective verdict would
            // duplicate the individual per-source result, so skip it.
            if (shouldSkipCollective(entries)) {
                this.reportGroupResults.set(groupId, { skipped: true, groupId });
                this.hideGroupCollectiveSlot(groupId);
                // Marking the group skipped changes what getReportUnits()
                // returns for it (members instead of nothing), so the pills and
                // the filter state both have to be recomputed — the success
                // path below does the same. Without this a group skipped as the
                // last step of a run keeps stale counts until the next toggle.
                this.renderReportSummary();
                this.applyReportFilters();
                return;
            }

            const providerConfig = this.providers[this.currentProvider] || {};
            const base = {
                groupId,
                isGroup: true,
                groupSize: members.length,
                groupCitationNumbers,
                citationNumber: groupCitationNumbers.join(', '),
                claimText,
                refElement: members[0].refElement,
                members: members.map(m => ({ citationNumber: m.citationNumber, url: m.url || null, refElement: m.refElement })),
                memberUrls: entries.map(e => e.url).filter(Boolean),
                url: (entries.find(e => e.url) || {}).url || null,
                truncated,
                providerName: providerConfig.name || this.currentProvider || '',
                model: providerConfig.model || '',
            };

            let result;
            if (!anyAvailable) {
                result = { ...base, verdict: 'SOURCE UNAVAILABLE', support_score: 0, comments: this.t('None of the grouped sources could be retrieved.') };
            } else {
                try {
                    const apiResult = await withRetry(
                        () => this.callProviderAPIGroup(claimText, assembledText),
                        {
                            maxRetries: 4,
                            minBackoffMs: 5000,
                            maxBackoffMs: 30000,
                            jitterMs: 0,
                            shouldAbort: () => this.reportCancelled,
                            onAttemptFailed: ({ backoff, willRetry }) => {
                                if (willRetry) {
                                    this.updateReportProgress(
                                        progressCurrent, progressTotal,
                                        this.t('Rate limited, retrying in {secs}s...', { secs: Math.round(backoff / 1000) }),
                                        startTime
                                    );
                                }
                            },
                        }
                    );
                    const parsed = this.parseVerificationResult(apiResult.text);
                    this.reportTokenUsage.input += apiResult.usage.input;
                    this.reportTokenUsage.output += apiResult.usage.output;
                    // The group quote is checked against the assembled text of
                    // every source in the group, so a verbatim quote from any
                    // one of them verifies.
                    const quoteView = this.buildQuoteView(parsed, assembledText);
                    result = {
                        ...base,
                        verdict: parsed.verdict,
                        support_score: parsed.support_score,
                        comments: parsed.comments,
                        reason_type: parsed.reason_type,
                        sourceQuote: quoteView.quote,
                        quoteDisplay: quoteView.display,
                        quoteVerified: quoteView.verified,
                        quoteStatus: quoteView.status,
                    };
                } catch (e) {
                    result = { ...base, verdict: 'ERROR', support_score: null, comments: e.message };
                }
            }

            // Collective verdicts were previously unlogged. They need a check
            // id for the same reason the per-source rows do — they are a
            // verdict the user is shown and can disagree with. kind='group'
            // and the joined citation numbers keep them distinguishable;
            // source_url stays null because there were several.
            if (result.verdict !== 'ERROR') {
                try {
                    result.checkId = this.logVerification(result, {
                        kind: 'group',
                        citationNumber: result.citationNumber,
                        sourceUrl: null,
                        claimText,
                        sourceInfo: assembledText,
                    });
                } catch (e) {}
            }

            this.reportGroupResults.set(groupId, result);
            this.renderGroupCollectiveResult(result);
            this.renderReportSummary();
            this.applyReportFilters();

            // Rate-limit pause after the collective call, matching the per-source path.
            if (!this.reportCancelled) {
                await new Promise(r => setTimeout(r, delayBetweenCalls));
            }
        }

        // Merges per-source results and collective group verdicts into one
        // entry per claim (document order): solo citations pass through; an
        // adjacent group collapses to its collective verdict. Groups whose
        // collective check hasn't completed yet are omitted until it does.
        // Used by the summary counts and the wikitext/plaintext exporters.
        // Shared with the batch pipeline via core/groups.js's
        // mergeReportUnits() — see that file's header.
        getReportUnits() {
            return mergeReportUnits(this.reportResults, this.reportGroupResults);
        }

        async verifyAllCitations() {
            const citations = this.collectAllCitations();
            if (citations.length === 0) {
                mw.notify(this.t('No citations found on this page.'), { type: 'warn', autoHide: true });
                return;
            }

            // Estimate time and show confirmation. Adjacent citations that
            // share a claim get one extra "collective" LLM call per group (in
            // addition to the per-source calls), so account for those.
            const uniqueUrls = new Set(citations.filter(c => c.url).map(c => c.url));
            const multiGroupIds = new Set(citations.filter(c => c.groupSize > 1).map(c => c.groupId));
            const multiGroupCount = multiGroupIds.size;
            const estimatedSeconds = citations.length * 7 + multiGroupCount * 8;
            const estimatedMinutes = Math.ceil(estimatedSeconds / 60);
            const groupNote = multiGroupCount > 0
                ? this.t(
                    multiGroupCount === 1
                        ? '\n\nThis includes {count} combined-source check for adjacent citation groups.'
                        : '\n\nThis includes {count} combined-source checks for adjacent citation groups.',
                    { count: multiGroupCount }
                  )
                : '';

            const confirmed = await new Promise(resolve => {
                OO.ui.confirm(
                    this.t(
                        estimatedMinutes > 1
                            ? 'This will verify {citations} citations from {sources} unique sources.{groupNote}\n\nEstimated time: ~{minutes} minutes.\n\nContinue?'
                            : 'This will verify {citations} citations from {sources} unique sources.{groupNote}\n\nEstimated time: ~{minutes} minute.\n\nContinue?',
                        { citations: citations.length, sources: uniqueUrls.size, groupNote, minutes: estimatedMinutes }
                    )
                ).done(result => resolve(result));
            });
            if (!confirmed) return;

            // Setup
            this.reportMode = true;
            this.reportRunning = true;
            this.reportCancelled = false;
            this.reportResults = [];
            // Collective (multi-source) verdicts for adjacent-citation groups,
            // keyed by groupId. Kept separate from reportResults (which stays
            // per-source for the debug rows); getReportUnits() merges them.
            this.reportGroupResults = new Map();
            this.sourceCache = new Map();
            this.reportTokenUsage = { input: 0, output: 0 };
            this.hasReport = true;
            this.reportRevisionId = this.getArticleRevisionId();

            this.showReportView();
            document.getElementById('verifier-report-results').innerHTML = '';
            document.getElementById('verifier-report-summary').innerHTML = '';
            document.getElementById('verifier-report-actions').innerHTML = '';
            this.applyReportFilters();
            this.updateButtonVisibility();

            const startTime = Date.now();
            const useProxy = this.currentProvider === 'publicai' || this.currentProvider === 'liftwing';
            const delayBetweenCalls = useProxy ? 3000 : 1000;

            // Progress counts every LLM step: one per citation, plus one
            // collective check per adjacent group. `completed` tracks finished
            // steps so the bar/ETA stay sensible across both phases.
            const progressTotal = citations.length + multiGroupCount;
            let completed = 0;

            for (let i = 0; i < citations.length; i++) {
                if (this.reportCancelled) break;

                const citation = citations[i];
                this.updateReportProgress(completed, progressTotal, this.t('Checking citation [{num}]', { num: citation.citationNumber }), startTime);

                let result;

                if (!citation.url) {
                    // No URL found
                    result = {
                        citationNumber: citation.citationNumber,
                        claimText: citation.claimText,
                        url: null,
                        refElement: citation.refElement,
                        verdict: 'SOURCE UNAVAILABLE',
                        support_score: 0,
                        comments: this.t('No URL found in reference'),
                        truncated: false
                    };
                } else {
                    // Fetch source if not cached. Cache value is always the
                    // full { content, error, status } shape so retries on the
                    // same URL preserve the diagnostic for the submission link.
                    const cacheKey = citation.pageNum ? `${citation.url}|page=${citation.pageNum}` : citation.url;

                    if (!this.sourceCache.has(cacheKey)) {
                        this.updateReportProgress(completed, progressTotal, this.t('Fetching source for [{num}]', { num: citation.citationNumber }), startTime);
                        try {
                            const fetchResult = await this.fetchSourceContent(citation.url, citation.pageNum);
                            this.sourceCache.set(cacheKey, fetchResult);
                        } catch (e) {
                            this.sourceCache.set(cacheKey, { content: null, error: e?.message || 'fetch threw', status: null });
                        }
                        // Rate limit delay after fetch
                        if (!this.reportCancelled) {
                            await new Promise(r => setTimeout(r, delayBetweenCalls));
                        }
                    }

                    if (this.reportCancelled) break;

                    const fetchResult = this.sourceCache.get(cacheKey) || { content: null, error: null, status: null };
                    const sourceContent = fetchResult.content;

                    if (!sourceContent) {
                        const statusPart = fetchResult.status != null ? `HTTP ${fetchResult.status}` : null;
                        const reasonPart = fetchResult.error || this.t('Could not fetch source content');
                        const comments = statusPart ? `${statusPart}: ${reasonPart}` : reasonPart;
                        result = {
                            citationNumber: citation.citationNumber,
                            claimText: citation.claimText,
                            url: citation.url,
                            refElement: citation.refElement,
                            verdict: 'SOURCE UNAVAILABLE',
                            support_score: 0,
                            comments,
                            fetchStatus: fetchResult.status,
                            fetchError: fetchResult.error,
                            truncated: false
                        };
                        // Logged like any other verdict: the user sees it and
                        // may well want to tell us the source is actually fine.
                        try {
                            result.checkId = this.logVerification(result, {
                                citationNumber: citation.citationNumber,
                                sourceUrl: citation.url,
                                claimText: citation.claimText,
                            });
                        } catch (e) {}
                    } else {
                        const sourceTruncated = sourceContent.includes('\nTruncated: true');
                        // Verify via LLM. Retry transient failures (429 + 5xx +
                        // network) through the shared core/retry.js helper —
                        // pre-consolidation, this path only retried on 429 and
                        // surfaced 5xx as a hard ERROR even though the benchmark
                        // would have recovered. The [5s, 10s, 20s] backoff curve
                        // is preserved via minBackoffMs/jitterMs, and Cancel
                        // still short-circuits via shouldAbort.
                        this.updateReportProgress(completed, progressTotal, this.t('Verifying citation [{num}]', { num: citation.citationNumber }), startTime);
                        try {
                            const apiResult = await withRetry(
                                () => this.callProviderAPI(citation.claimText, sourceContent),
                                {
                                    maxRetries: 4,
                                    minBackoffMs: 5000,
                                    maxBackoffMs: 30000,
                                    jitterMs: 0,
                                    shouldAbort: () => this.reportCancelled,
                                    onAttemptFailed: ({ backoff, willRetry }) => {
                                        if (willRetry) {
                                            this.updateReportProgress(
                                                completed, progressTotal,
                                                this.t('Rate limited, retrying in {secs}s...', { secs: Math.round(backoff / 1000) }),
                                                startTime
                                            );
                                        }
                                    },
                                }
                            );
                            const parsed = this.parseVerificationResult(apiResult.text);
                            this.reportTokenUsage.input += apiResult.usage.input;
                            this.reportTokenUsage.output += apiResult.usage.output;
                            const quoteView = this.buildQuoteView(parsed, sourceContent);
                            result = {
                                citationNumber: citation.citationNumber,
                                claimText: citation.claimText,
                                url: citation.url,
                                refElement: citation.refElement,
                                verdict: parsed.verdict,
                                support_score: parsed.support_score,
                                comments: parsed.comments,
                                reason_type: parsed.reason_type,
                                sourceQuote: quoteView.quote,
                                quoteDisplay: quoteView.display,
                                quoteVerified: quoteView.verified,
                                quoteStatus: quoteView.status,
                                truncated: sourceTruncated
                            };

                            // Fire-and-forget logging
                            try {
                                result.checkId = this.logVerification(parsed, {
                                    citationNumber: citation.citationNumber,
                                    sourceUrl: citation.url,
                                    claimText: citation.claimText,
                                    sourceInfo: sourceContent,
                                });
                            } catch (e) {}
                        } catch (e) {
                            result = {
                                citationNumber: citation.citationNumber,
                                claimText: citation.claimText,
                                url: citation.url,
                                refElement: citation.refElement,
                                verdict: 'ERROR',
                                support_score: null,
                                comments: e.message,
                                truncated: sourceTruncated
                            };
                        }

                        // Rate limit delay after LLM call
                        if (!this.reportCancelled && i < citations.length - 1) {
                            await new Promise(r => setTimeout(r, delayBetweenCalls));
                        }
                    }
                }

                if (result) {
                    // Carry the group metadata from the citation onto the
                    // result so the renderer and the wikitext exporter can
                    // cluster sibling citations without re-deriving groups.
                    result.groupId = citation.groupId;
                    result.groupSize = citation.groupSize;
                    result.groupIndex = citation.groupIndex;
                    result.groupCitationNumbers = citation.groupCitationNumbers;
                    // Snapshot the provider/model used for this row so that
                    // dataset-submission links stay accurate even if the user
                    // switches providers after the report runs.
                    const providerConfig = this.providers[this.currentProvider] || {};
                    result.providerName = providerConfig.name || this.currentProvider || '';
                    result.model = providerConfig.model || '';
                    this.reportResults.push(result);
                    this.renderReportCard(result, this.reportResults.length - 1);
                    this.renderReportSummary();
                    this.applyReportFilters();
                }

                completed++;

                // When this citation closes an adjacent-citation group, run the
                // collective check: the whole group's sources are cached by now
                // (group members are contiguous and processed in order), so we
                // assemble them and ask for a single verdict over the combination.
                if (isGroupClose(citation) && !this.reportCancelled) {
                    const groupToken = (citation.groupCitationNumbers || []).map(n => `[${n}]`).join('');
                    this.updateReportProgress(completed, progressTotal, this.t('Checking combined sources {token}', { token: groupToken }), startTime);
                    await this.verifyGroupCollective(citation, citations, startTime, delayBetweenCalls, completed, progressTotal);
                    completed++;
                }
            }

            // Finalize
            this.reportRunning = false;
            const finalPhase = this.reportCancelled
                ? this.t(citations.length === 1 ? 'Cancelled after {done} of {total} citation' : 'Cancelled after {done} of {total} citations', { done: this.reportResults.length, total: citations.length })
                : this.t(this.reportResults.length === 1 ? 'Completed: {count} citation checked' : 'Completed: {count} citations checked', { count: this.reportResults.length });
            this.updateReportProgress(completed, progressTotal, finalPhase, startTime);
            this.renderReportSummary();
            this.renderReportActions();
            this.updateButtonVisibility();
        }

        findSectionNumber(refElement) {
            const el = refElement || this.activeRefElement;
            if (!el) return 0;

            const content = document.getElementById('mw-content-text');
            if (!content) return 0;

            const headings = content.querySelectorAll('h2, h3, h4, h5, h6');
            let sectionNumber = 0;

            for (const heading of headings) {
                const position = heading.compareDocumentPosition(el);
                if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
                    sectionNumber++;
                } else {
                    break;
                }
            }

            return sectionNumber;
        }

        buildEditUrl(refElement) {
            const title = mw.config.get('wgPageName');
            const section = this.findSectionNumber(refElement);
            // Goes into the wiki's edit-summary box, so it follows the UI
            // language like the rest of the interface. The link target stays
            // pointing at the English user page — that is where the script
            // lives — and the tool's name is left untranslated, matching how
            // the exported report credits it.
            const summary = this.t('source does not support claim (checked with [[User:Alaexis/AI_Source_Verification|Source Verifier]])');

            const params = { action: 'edit', summary: summary };
            if (section > 0) {
                params.section = section;
            }

            return mw.util.getUrl(title, params);
        }


        showActionButton(verdict, comments = '') {
            const container = document.getElementById('verifier-action-container');
            if (!container) return;

            container.innerHTML = '';

            if (verdict === 'NOT SUPPORTED' || verdict === 'PARTIALLY SUPPORTED' || verdict === 'SOURCE UNAVAILABLE') {
                const btn = new OO.ui.ButtonWidget({
                    label: this.t('Edit Section'),
                    flags: ['progressive'],
                    icon: 'edit',
                    href: this.buildEditUrl(),
                    target: '_blank'
                });
                container.appendChild(btn.$element[0]);
            }

            const feedback = this.buildFeedbackControls({
                checkId: this.activeCheckId,
                citationNumber: this.activeCitationNumber,
                claimText: this.activeClaim,
                url: this.activeSourceUrl,
                verdict,
                comments,
            });
            if (feedback) container.appendChild(feedback);
        }

        isDatasetSubmissionConfigured() {
            return isDatasetSubmissionConfigured();
        }

        buildDatasetSubmissionUrl(result) {
            const provider = this.providers[this.currentProvider] || {};
            const articleUrl = (typeof window !== 'undefined' && window.location)
                ? `${window.location.origin}${window.location.pathname}`
                : '';
            return buildDatasetSubmissionUrl({
                articleUrl,
                citationNumber: result?.citationNumber ?? '',
                claimText: result?.claimText ?? '',
                sourceUrl: result?.url ?? '',
                llmVerdict: result?.verdict ?? '',
                llmRationale: result?.comments ?? '',
                // Only submit a quote we located in the source; an unverified
                // one would pollute the dataset with possible fabrications.
                llmQuote: result?.quoteDisplay ?? '',
                llmQuoteVerified: result?.quoteStatus ?? '',
                llmProvider: result?.providerName ?? provider.name ?? '',
                llmModel: result?.model ?? provider.model ?? '',
                fetchStatus: result?.fetchStatus ?? '',
            });
        }

        // ========================================
        // FEEDBACK
        // ========================================
        //
        // Two destinations, split by what the feedback actually is. A rating
        // is a datapoint: high volume, only useful aggregated, so it goes
        // straight to the worker keyed on the check id. A comment is a
        // conversation: it needs to be public, and it needs to support
        // follow-up questions, so it goes on-wiki as a talk-page section. The
        // check id appears on both sides, which is what lets them be joined.
        //
        // The script never writes the comment itself. Clicking Comment opens
        // Wikipedia's own new-section form with the context preloaded, and the
        // editor writes and publishes there, in the interface they already
        // know — with preview, signature, and native handling of blocks,
        // CAPTCHAs and abuse filters. The cost is that the script never learns
        // whether they went through with it, so the talk section is joined to
        // the check row by the scheduled scrape rather than at click time.

        // Random per-browser token, minted once. Lets repeat clicks from one
        // browser be collapsed without recording anything about the user.
        getFeedbackClientId() {
            try {
                let id = localStorage.getItem('verifier_feedback_client_id');
                if (!id) {
                    id = newCheckId() + newCheckId();
                    localStorage.setItem('verifier_feedback_client_id', id);
                }
                return id;
            } catch (e) {
                return null;  // private mode, or storage disabled
            }
        }

        sendFeedback(fields) {
            return postFeedback(buildFeedbackPayload({
                ...fields,
                clientId: this.getFeedbackClientId(),
            }));
        }

        // Everything the feedback controls need about one displayed verdict,
        // from either a report result object or the sidebar's active state.
        feedbackContextFor(result) {
            const provider = this.providers[this.currentProvider] || {};
            const revisionId = this.getArticleRevisionId();
            return {
                checkId: result?.checkId ?? null,
                articleUrl: (typeof window !== 'undefined' && window.location)
                    ? `${window.location.origin}${window.location.pathname}`
                    : '',
                articleTitle: typeof mw !== 'undefined' ? mw.config.get('wgTitle') : document.title,
                revisionId,
                revisionUrl: this.getRevisionPermalinkUrl(revisionId),
                citationNumber: result?.citationNumber ?? '',
                claimText: result?.claimText ?? '',
                sourceUrl: result?.url ?? '',
                verdict: result?.verdict ?? '',
                comments: result?.comments ?? '',
                providerName: result?.providerName || provider.name || '',
                model: result?.model || provider.model || '',
            };
        }

        // The Yes / No / Comment row. Returns null when the check has no id —
        // an unparseable or errored verdict has nothing to attach feedback to,
        // and offering controls that silently go nowhere would be worse than
        // offering none.
        buildFeedbackControls(result) {
            const context = this.feedbackContextFor(result);
            if (!context.checkId) return null;

            const wrap = document.createElement('div');
            wrap.className = 'verifier-feedback';

            // Two status lines, not one: a confirmation the editor never sees
            // is the same as no confirmation, so each sits immediately below
            // the control that produced it — the rating under the thumbs, the
            // correction under the chips.
            const makeStatus = () => {
                const el = document.createElement('div');
                el.className = 'verifier-feedback-status';
                el.setAttribute('role', 'status');
                return el;
            };
            const setStatusOn = (el) => (msg, isError = false) => {
                el.textContent = msg;
                el.classList.toggle('is-error', isError);
                el.classList.toggle('is-done', !isError && !!msg);
            };

            const status = makeStatus();
            const setStatus = setStatusOn(status);

            const row = document.createElement('div');
            row.className = 'verifier-feedback-row';
            const prompt = document.createElement('span');
            prompt.className = 'verifier-feedback-prompt';
            prompt.textContent = this.t('Was this right?');
            row.appendChild(prompt);

            const correction = document.createElement('div');
            correction.className = 'verifier-feedback-correction';
            correction.hidden = true;
            const correctionStatus = makeStatus();
            const setCorrectionStatus = setStatusOn(correctionStatus);
            let correctedVerdict = null;

            // Icon + label frameless buttons, exactly like Comment below. Two
            // bare emoji beside an icon-and-label button read as decoration
            // rather than as part of the same set; `check` and `close` come
            // from oojs-ui.styles.icons-interactions, which is already loaded,
            // and inherit the dark-mode icon inversion every other icon gets.
            const up = new OO.ui.ButtonWidget({
                label: this.t('Yes'),
                icon: 'check',
                title: this.t('This verdict looks right'),
                framed: false,
            });
            const down = new OO.ui.ButtonWidget({
                label: this.t('No'),
                icon: 'close',
                title: this.t('This verdict looks wrong'),
                framed: false,
            });
            up.$element.addClass('verifier-feedback-thumb');
            down.$element.addClass('verifier-feedback-thumb');
            const rate = (rating, button) => {
                up.setDisabled(true);
                down.setDisabled(true);
                button.$element.addClass('is-chosen');
                (button === up ? down : up).$element.addClass('is-dimmed');
                setStatus(this.t('Thanks — recorded.'));
                this.sendFeedback({ checkId: context.checkId, rating })
                    .catch(() => setStatus(this.t('Could not record that, sorry.'), true));
                // The corrected-verdict chips are only worth asking for when the
                // editor has said the verdict is wrong; after a thumbs-up there
                // is nothing to correct.
                correction.hidden = rating >= 0;
            };
            up.on('click', () => rate(1, up));
            down.on('click', () => rate(-1, down));
            row.appendChild(up.$element[0]);
            row.appendChild(down.$element[0]);

            // Opens Wikipedia's own new-section form with the context already
            // in the edit box. Kept as a real href rather than a window.open
            // so middle-click and open-in-new-tab behave normally; the target
            // is rebuilt if a correction is chosen, so that choice travels
            // into the comment.
            const commentBtn = new OO.ui.ButtonWidget({
                label: this.t('Comment'),
                icon: 'feedback',
                framed: false,
                href: buildCommentUrl(context),
                target: '_blank',
            });
            row.appendChild(commentBtn.$element[0]);

            // A thumbs-down plus one more click yields a labelled example —
            // the same thing the Google Form existed to collect, at a fraction
            // of the friction.
            const correctionLabel = document.createElement('span');
            correctionLabel.className = 'verifier-feedback-prompt';
            correctionLabel.textContent = this.t('What should it have been?');
            correction.appendChild(correctionLabel);
            const chips = VERDICT_LIST.map(verdict => {
                const chip = new OO.ui.ButtonWidget({ label: this.t(verdict), framed: false });
                chip.$element.addClass('verifier-feedback-chip');
                chip.on('click', () => {
                    correctedVerdict = verdict;
                    chips.forEach(c => {
                        c.setDisabled(true);
                        if (c !== chip) c.$element.addClass('is-dimmed');
                    });
                    chip.$element.addClass('is-chosen');
                    setCorrectionStatus(this.t('Thanks — recorded.'));
                    commentBtn.setHref(buildCommentUrl({ ...context, correctedVerdict }));
                    // rating is omitted here: the thumbs-down already counted,
                    // and a second row carrying it would double-count.
                    this.sendFeedback({ checkId: context.checkId, correctedVerdict: verdict })
                        .catch(() => setCorrectionStatus(this.t('Could not record that, sorry.'), true));
                });
                correction.appendChild(chip.$element[0]);
                return chip;
            });
            correction.appendChild(correctionStatus);

            wrap.appendChild(row);
            wrap.appendChild(status);
            wrap.appendChild(correction);
            return wrap;
        }


        clearResult() {
            const verdictEl = document.getElementById('verifier-verdict');
            const commentsEl = document.getElementById('verifier-comments');

            if (verdictEl) {
                verdictEl.textContent = '';
                verdictEl.className = '';
            }
            if (commentsEl) {
                commentsEl.textContent = '';
            }
            const quoteEl = document.getElementById('verifier-quote');
            if (quoteEl) quoteEl.innerHTML = '';
            const nextEl = document.getElementById('verifier-verdict-next');
            if (nextEl) nextEl.textContent = '';
            this.activeCheckId = null;
            this.hasResult = false;
            this.renderUiState();
            const actionContainer = document.getElementById('verifier-action-container');
            if (actionContainer) {
                actionContainer.innerHTML = '';
            }
            const groupEl = document.getElementById('verifier-claim-group-indicator');
            if (groupEl) {
                groupEl.style.display = 'none';
                groupEl.innerHTML = '';
            }
        }

        renderClaimGroupIndicator(refElement) {
            const indicatorEl = document.getElementById('verifier-claim-group-indicator');
            if (!indicatorEl) return;
            const group = this.getCitationGroup(refElement);
            if (!group || group.length <= 1) {
                indicatorEl.style.display = 'none';
                indicatorEl.innerHTML = '';
                return;
            }
            const activeWrapper = refElement.closest('.reference');
            const numbers = group.map(wrapper => {
                const anchor = wrapper.querySelector('a');
                const text = anchor ? anchor.textContent.replace(/[\[\]]/g, '').trim() : '?';
                const isActive = wrapper === activeWrapper;
                const span = `<span class="${isActive ? 'group-active' : ''}">[${this.escapeHtml(text)}]</span>`;
                return span;
            }).join(' ');
            indicatorEl.innerHTML = this.t('Part of a group of {count} citations: {numbers}', { count: group.length, numbers });
            indicatorEl.style.display = '';
        }
    }
    
    if (typeof mw !== 'undefined' && [0, 2, 118].includes(mw.config.get('wgNamespaceNumber'))) {
        mw.loader.using(['mediawiki.util', 'mediawiki.api', 'oojs-ui-core', 'oojs-ui-widgets', 'oojs-ui-windows', 'oojs-ui.styles.icons-interactions']).then(function() {
            $(function() {
                new WikipediaSourceVerifier();
            });
        });
    }
})();
