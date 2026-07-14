// {{Wikipedia:USync |repo=https://github.com/alex-o-748/citation-checker-script |ref=refs/heads/main|path=main.js}} 
//Inspired by User:Polygnotus/Scripts/AI_Source_Verification.js
//Inspired by User:Phlsph7/SourceVerificationAIAssistant.js  

(function() {
    'use strict';

// <core-injected>
// --- core/prompts.js ---
// Pure prompt-generation logic. Imported by core/ consumers (CLI, benchmark).
// Also injected byte-identically into main.js between <core-injected> markers.

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

If the source text is not usable, you MUST return verdict SOURCE UNAVAILABLE with confidence 0. Do not attempt to verify the claim - if you cannot find actual article or book content to quote, the source is unavailable.

Respond in JSON format:
{
  "confidence": <number 0-100>,
  "verdict": "<verdict>",
  "reason_type": "<only for NOT SUPPORTED: 'contradiction' or 'omission'>",
  "comments": "<relevant quote and brief explanation>"
}

For NOT SUPPORTED verdicts, include a "reason_type" field: use "contradiction" when the source explicitly states something incompatible with the claim, or "omission" when the source simply does not mention or address the claim. If both apply (source contradicts one part and omits another), use "contradiction". Do not include reason_type for other verdicts.

Confidence guide:
- 80-100: SUPPORTED
- 50-79: PARTIALLY SUPPORTED
- 1-49: NOT SUPPORTED
- 0: SOURCE UNAVAILABLE

<example>
Claim: "The committee published its findings in 1932."
Source text: "History of Modern Economics - Economic Research Council - Google Books Sign in Hidden fields Books Try the new Google Books Check out the new look and enjoy easier access to your favorite features Try it now No thanks My library Help Advanced Book Search Download EPUB Download PDF Plain text Read eBook Get this book in print AbeBooks On Demand Books Amazon Find in a library All sellers About this book Terms of Service Plain text PDF EPUB"

{"source_quote": "", "confidence": 0, "verdict": "SOURCE UNAVAILABLE", "comments": "Google Books interface with no actual book content, only navigation and metadata."}
</example>

<example>
Claim: "The bridge was completed in 1998."
Source text: "Skip to main content Web Archive toolbar... Capture date: 2015-03-12 ... City Tribune - Local News ... The Morrison Bridge project broke ground in 1994 after years of planning. Construction faced multiple delays due to funding shortages. The bridge was finally opened to traffic in August 2002, four years behind schedule. Mayor Davis called it 'a triumph of persistence.'"

{"confidence": 15, "verdict": "NOT SUPPORTED", "reason_type": "contradiction", "comments": "\"finally opened to traffic in August 2002, four years behind schedule\" - Source says the bridge opened in 2002, not 1998. The article is accessible despite being an Internet Archive capture."}
</example>

<example>
Claim: "The company was founded in 1985 by John Smith."
Source text: "Acme Corp was established in 1985. Its founder, John Smith, served as CEO until 2001."

{"confidence": 95, "verdict": "SUPPORTED", "comments": "\"Acme Corp was established in 1985. Its founder, John Smith\" - Definitive match with paraphrasing."}
</example>

<example>
Claim: "The treaty was signed by 45 countries."
Source text: "The treaty, finalized in March, was signed by over 30 nations, though the exact number remains disputed."

{"confidence": 20, "verdict": "NOT SUPPORTED", "reason_type": "contradiction", "comments": "\"signed by over 30 nations\" - Source says \"over 30,\" not 45."}
</example>

<example>
Claim: "The treaty was signed in Paris."
Source text: "It is believed the treaty was signed in Paris, though some historians dispute this."

{"confidence": 60, "verdict": "PARTIALLY SUPPORTED", "comments": "\"It is believed... though some historians dispute this\" - Source hedges this as uncertain; Wikipedia states it as fact."}
</example>

<example>
Claim: "The population increased by 12% between 2010 and 2020."
Source text: "Census data shows significant population growth in the region during the 2010s."

{"confidence": 55, "verdict": "PARTIALLY SUPPORTED", "comments": "\"significant population growth\" - Source confirms growth but doesn't specify 12%."}
</example>

<example>
Claim: "The president resigned on March 3."
Source text: "The president remained in office throughout March."

{"confidence": 5, "verdict": "NOT SUPPORTED", "reason_type": "contradiction", "comments": "\"remained in office throughout March\" - Source directly contradicts the claim."}
</example>

<example>
Claim: "She received the Nobel Prize in Chemistry in 2015."
Source text: "Professor Martin completed her PhD at Oxford in 1998 and joined the faculty at Cambridge in 2003. Her research focuses on organic synthesis and catalysis. She has published over 200 papers and received several university teaching awards."

{"confidence": 10, "verdict": "NOT SUPPORTED", "reason_type": "omission", "comments": "The source discusses her academic career and publications but makes no mention of a Nobel Prize."}
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

    console.log('[Verifier] Source text (first 2000 chars):', sourceText.substring(0, 2000));

    return `Claim: "${claim}"

Source text:
${sourceText}`;
}

// System prompt for the "adjacent citations" / collective-verification path:
// one claim is cited by several adjacent sources, and we judge whether the
// sources TOGETHER support it. Kept deliberately close to generateSystemPrompt
// (same JSON schema, verdict vocabulary, confidence scale, reason_type rules)
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
Only return verdict SOURCE UNAVAILABLE with confidence 0 if NONE of the provided sources contain usable content.

Respond in JSON format:
{
  "confidence": <number 0-100>,
  "verdict": "<verdict>",
  "reason_type": "<only for NOT SUPPORTED: 'contradiction' or 'omission'>",
  "comments": "<note which source(s) support or contradict which part of the claim>"
}

For NOT SUPPORTED verdicts, include a "reason_type" field: use "contradiction" when a source explicitly states something incompatible with the claim, or "omission" when the sources simply do not mention or address the claim. If both apply, use "contradiction". Do not include reason_type for other verdicts.

Confidence guide:
- 80-100: SUPPORTED
- 50-79: PARTIALLY SUPPORTED
- 1-49: NOT SUPPORTED
- 0: SOURCE UNAVAILABLE

<example>
Claim: "The company was founded in 1985 by John Smith, who led it until 2001."
Source [1] (https://example.com/a): "Acme Corp was established in 1985 in Ohio."
Source [2] (https://example.com/b): "John Smith founded Acme Corp and served as its chief executive until 2001."

{"confidence": 92, "verdict": "SUPPORTED", "comments": "Source [1] gives the 1985 founding year; source [2] confirms John Smith as founder and his tenure until 2001. Together they support the whole claim."}
</example>

<example>
Claim: "The treaty was signed in Paris in 1990."
Source [1] (https://example.com/a): [This source could not be retrieved: HTTP 403]
Source [2] (https://example.com/b): "The accord was signed in the French capital in the spring of 1990."

{"confidence": 88, "verdict": "SUPPORTED", "comments": "Source [1] was unavailable, but source [2] states the accord was signed in the French capital (Paris) in 1990, which supports the claim."}
</example>

<example>
Claim: "The bridge, built in 1998, cost $200 million."
Source [1] (https://example.com/a): "The bridge opened to traffic in 1998 after four years of construction."
Source [2] (https://example.com/b): "Funding for the project came from a mix of state and federal grants."

{"confidence": 55, "verdict": "PARTIALLY SUPPORTED", "comments": "Source [1] supports the 1998 date. Neither source states the $200 million cost, so that part is unverified."}
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

// Ordered by the confidence guide in core/prompts.js. Confusion-matrix
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
            confidence: result.confidence ?? null,
            comments: result.comments || '',
            reason_type: result.reason_type || null
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
            return { verdict, confidence: null, comments: '<extracted from non-JSON response>' };
        }
    }

    return {
        verdict: 'PARSE_ERROR',
        confidence: null,
        comments: `Failed to parse AI response: ${response.substring(0, 200)}`
    };
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

const RETRYABLE_STATUS = /^HTTP (429|500|502|503|504)\b/;
const RETRYABLE_NETWORK = /timeout|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i;

function defaultSleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableError(error) {
    const msg = error?.message ?? '';
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

function parseArchiveOrgUrl(url) {
    const match = url.match(/^https?:\/\/web\.archive\.org\/web\/(\d+)(?:id_)?\/(https?:\/\/.+)$/);
    if (!match) return null;
    return { timestamp: match[1], originalUrl: match[2] };
}

function extractHttpUrl(element) {
    if (!element) return null;
    const links = element.querySelectorAll('a[href^="http"]');
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

function extractClaimText(refElement) {
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

    return claimText;
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
async function callOpenAICompatibleChat({ url, apiKey, model, systemPrompt, userContent, label, extraHeaders, extraBody, maxTokens = 2048, temperature = 0.1, responseFormat }) {
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
        throw new Error(`${label} API request failed (${response.status}): ${errorMessage}`);
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

async function callHuggingFaceAPI({ apiKey, model, systemPrompt, userContent, workerBase = 'https://publicai-proxy.alaexis.workers.dev', maxTokens, temperature }) {
    const direct = Boolean(apiKey);
    return callOpenAICompatibleChat({
        url: direct ? HF_DIRECT_URL : `${workerBase}/hf`,
        apiKey: direct ? apiKey : undefined,
        model, systemPrompt, userContent, maxTokens, temperature,
        label: 'HuggingFace',
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

async function callClaudeAPI({ apiKey, model, systemPrompt, userContent, maxTokens = 3000 }) {
    const requestBody = {
        model: model,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: "user", content: userContent }]
    };

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
    return {
        text: data.content[0].text,
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
        case 'openrouter':  return await callOpenRouterAPI(config);
        case 'claude':      return await callClaudeAPI(config);
        case 'gemini':      return await callGeminiAPI(config);
        case 'openai':      return await callOpenAIAPI(config);
        default: throw new Error(`Unknown provider: ${name}`);
    }
}

// --- core/worker.js ---
// Calls to the Cloudflare Worker proxy: source fetching and verification logging.


async function fetchViaProxy(fetchUrl, pageNum, workerBase, sourceUrl) {
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
            return { content: null, error: `Proxy returned non-JSON response (HTTP ${proxyStatus})`, status: proxyStatus };
        }

        const status = (data && typeof data.status === 'number') ? data.status : proxyStatus;

        if (data.error) {
            console.warn('[CitationVerifier] Proxy error:', data.error);
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
            return { content: `${meta}\n\nSource Content:\n${data.content}`, error: null, status };
        }

        if (data.pdf && !pageNum && data.totalPages > 15) {
            console.log('[CitationVerifier] Large PDF without page param, content may be truncated');
        }
        return { content: null, error: 'Source content was empty or too short to verify', status };
    } catch (error) {
        console.error('Proxy fetch failed:', error);
        return { content: null, error: error?.message || String(error), status: null };
    }
}

async function findWaybackSnapshot(url) {
    try {
        const apiUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`;
        const response = await fetch(apiUrl);
        const data = await response.json();
        const snapshot = data?.archived_snapshots?.closest;
        if (snapshot?.available && snapshot.timestamp) {
            return `https://web.archive.org/web/${snapshot.timestamp}id_/${url}`;
        }
    } catch (e) {
        console.warn('[CitationVerifier] Wayback availability check failed:', e?.message);
    }
    return null;
}

// Always returns { content, error, status }. `content` is the formatted source
// text on success and null on any failure; `error` is a short human-readable
// reason when content is null; `status` is the upstream HTTP status code if the
// proxy reports one (`data.status`), otherwise the proxy's own response status,
// or null if we never got a response at all.
async function fetchSourceContent(url, pageNum, { workerBase = 'https://publicai-proxy.alaexis.workers.dev' } = {}) {
    if (isGoogleBooksUrl(url)) {
        console.log('[CitationVerifier] Skipping Google Books URL:', url);
        return { content: null, error: 'Google Books URL skipped (no fetchable content)', status: null };
    }

    const archiveInfo = parseArchiveOrgUrl(url);
    if (archiveInfo) {
        const rawUrl = `https://web.archive.org/web/${archiveInfo.timestamp}id_/${archiveInfo.originalUrl}`;
        console.log('[CitationVerifier] Fetching via Wayback raw endpoint');
        return fetchViaProxy(rawUrl, pageNum, workerBase, url);
    }

    const result = await fetchViaProxy(url, pageNum, workerBase, url);

    if (!result.content) {
        const waybackUrl = await findWaybackSnapshot(url);
        if (waybackUrl) {
            console.log('[CitationVerifier] Live fetch failed, trying Wayback snapshot');
            return fetchViaProxy(waybackUrl, pageNum, workerBase, url);
        }
    }

    return result;
}

function logVerification(payload, { workerBase = 'https://publicai-proxy.alaexis.workers.dev' } = {}) {
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
};

function isDatasetSubmissionConfigured(
    formUrl = DATASET_SUBMISSION_FORM_URL,
    entryIds = DATASET_SUBMISSION_ENTRY_IDS,
) {
    if (!formUrl || formUrl.includes(DATASET_SUBMISSION_PLACEHOLDER)) return false;
    return Object.values(entryIds).every(
        id => typeof id === 'string' && id && !id.includes(DATASET_SUBMISSION_PLACEHOLDER)
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
        const value = fields == null ? undefined : fields[key];
        if (value === undefined || value === null || value === '') continue;
        params.set(entryIds[key], String(value));
    }
    return `${formUrl}?${params.toString()}`;
}
// </core-injected>

    class WikipediaSourceVerifier {
        constructor() {
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
                    color: '#6B21A8', // HF yellow-orange
                    model: 'openai/gpt-oss-20b',
                    requiresKey: false,
                    optionalKey: true
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
            this.sidebarWidth = localStorage.getItem('verifier_sidebar_width') || '400px';
            this.isVisible = localStorage.getItem('verifier_sidebar_visible') === 'true';
            this.buttons = {};
            this.activeClaim = null;
            this.activeSource = null;
            this.activeSourceUrl = null;
            this.activeCitationNumber = null;
            this.activeRefElement = null;
            this.currentFetchId = 0;
            this.currentVerifyId = 0;

            this.sourceTextInput = null;
            this.sourceInputForOverride = false;

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
        
        createUI() {
            const sidebar = document.createElement('div');
            sidebar.id = 'source-verifier-sidebar';
            
            this.createOOUIButtons();
            
            sidebar.innerHTML = `
                <div id="verifier-sidebar-header">
                    <h3><a href="https://en.wikipedia.org/wiki/User:Alaexis/AI_Source_Verification" target="_blank" id="verifier-title-link">Source Verifier</a></h3>
                    <div id="verifier-sidebar-controls">
                        <div id="verifier-close-btn-container"></div>
                    </div>
                </div>
                <div id="verifier-sidebar-content">
                    <div id="verifier-controls">
                        <div id="verifier-provider-container"></div>
                        <div id="verifier-provider-info"></div>
                        <div id="verifier-buttons-container"></div>
                    </div>
                    <div id="verifier-claim-section">
                        <h4>Selected Claim</h4>
                        <div id="verifier-claim-text">Click on a reference number [1] next to a claim to verify it against its source.</div>
                        <div id="verifier-claim-group-indicator" style="display: none;"></div>
                    </div>
                    <div id="verifier-source-section">
                        <h4>Source Content</h4>
                        <div id="verifier-source-text">No source loaded yet.</div>
                        <div id="verifier-source-override-container" style="display: none; margin-top: 8px;"></div>
                        <div id="verifier-source-input-container" style="display: none; margin-top: 10px;">
                            <div id="verifier-source-textarea-container"></div>
                            <div id="verifier-source-buttons" style="margin-top: 8px; display: flex; gap: 8px;">
                                <div id="verifier-load-text-btn-container" style="flex: 1;"></div>
                                <div id="verifier-cancel-text-btn-container" style="flex: 1;"></div>
                            </div>
                        </div>
                    </div>
                    <div id="verifier-results">
                        <h4>Verification Result</h4>
                        <div id="verifier-verdict"></div>
                        <div id="verifier-comments"></div>
                        <div id="verifier-action-container"></div>
                    </div>
                    <div id="verifier-report-view" style="display:none;">
                        <div id="verifier-report-progress"></div>
                        <div id="verifier-report-summary"></div>
                        <div id="verifier-report-results"></div>
                        <div id="verifier-report-actions"></div>
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
        }
        
        createStyles() {
            const style = document.createElement('style');
            style.textContent = `
                #source-verifier-sidebar {
                    position: fixed;
                    top: 0;
                    right: 0;
                    width: ${this.sidebarWidth};
                    height: 100vh;
                    background: #fff;
                    border-left: 2px solid ${this.getCurrentColor()};
                    box-shadow: -2px 0 8px rgba(0,0,0,0.1);
                    z-index: 10000;
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                    font-size: 14px;
                    display: flex;
                    flex-direction: column;
                    transition: all 0.3s ease;
                }
                #verifier-sidebar-header {
                    background: ${this.getCurrentColor()};
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
                }
                #verifier-sidebar-controls {
                    display: flex;
                    gap: 8px;
                }
                #verifier-sidebar-content {
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
                    color: #666;
                    margin-bottom: 10px;
                    padding: 8px;
                    background: #f8f9fa;
                    border-radius: 4px;
                }
                #verifier-provider-info.free-provider {
                    background: #e8f5e9;
                    color: #2e7d32;
                }
                #verifier-provider-info.free-provider a {
                    color: inherit;
                    text-decoration: underline;
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
                    color: ${this.getCurrentColor()};
                    font-size: 14px;
                    font-weight: bold;
                }
                #verifier-claim-text, #verifier-source-text {
                    padding: 10px;
                    background: #f8f9fa;
                    border: 1px solid #ddd;
                    border-radius: 4px;
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
                    color: #54595d;
                    text-decoration: underline;
                    text-decoration-color: #a2a9b1;
                    text-underline-offset: 2px;
                }
                #verifier-source-override-container .verifier-override-link:hover .oo-ui-labelElement-label {
                    color: #202122;
                    text-decoration-color: #54595d;
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
                }
                #verifier-verdict.supported {
                    background: #d4edda;
                    color: #155724;
                    border: 1px solid #c3e6cb;
                }
                #verifier-verdict.partially-supported {
                    background: #fff3cd;
                    color: #856404;
                    border: 1px solid #ffeeba;
                }
                #verifier-verdict.not-supported {
                    background: #f8d7da;
                    color: #721c24;
                    border: 1px solid #f5c6cb;
                }
                #verifier-verdict.source-unavailable {
                    background: #e2e3e5;
                    color: #383d41;
                    border: 1px solid #d6d8db;
                }
                #verifier-comments {
                    padding: 10px;
                    background: #fafafa;
                    border: 1px solid #ddd;
                    border-radius: 4px;
                    font-size: 13px;
                    line-height: 1.5;
                    max-height: 300px;
                    overflow-y: auto;
                }
                #verifier-action-container {
                    margin-top: 10px;
                }
                #verifier-action-container .oo-ui-buttonElement {
                    width: 100%;
                }
                #verifier-title-link {
                    color: white;
                    text-decoration: none;
                }
                #verifier-title-link:hover {
                    text-decoration: underline;
                }
                #verifier-action-container .oo-ui-buttonElement-button {
                    width: 100%;
                    justify-content: center;
                }
                .verifier-action-hint {
                    font-size: 11px;
                    color: #888;
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
                    background: ${this.getCurrentColor()};
                    opacity: 0.5;
                }
                #ca-verifier, #t-verifier {
                    display: none;
                }
                #ca-verifier a, #t-verifier a {
                    color: ${this.getCurrentColor()} !important;
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
                    color: #d33;
                    background: #fef2f2;
                    border: 1px solid #fecaca;
                    padding: 8px;
                    border-radius: 4px;
                }
                .verifier-truncation-warning {
                    margin-top: 6px;
                    padding: 6px 8px;
                    font-size: 12px;
                    color: #856404;
                    background: #fff3cd;
                    border: 1px solid #ffeeba;
                    border-radius: 4px;
                }
                .report-card-truncated {
                    margin-top: 4px;
                    font-size: 11px;
                    color: #856404;
                    background: #fff3cd;
                    border: 1px solid #ffeeba;
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
                    color: ${this.getCurrentColor()};
                    font-size: 14px;
                    font-weight: bold;
                }
                #verifier-report-progress {
                    margin-bottom: 12px;
                }
                .verifier-progress-bar {
                    width: 100%;
                    height: 8px;
                    background: #e0e0e0;
                    border-radius: 4px;
                    overflow: hidden;
                    margin-bottom: 6px;
                }
                .verifier-progress-fill {
                    height: 100%;
                    background: ${this.getCurrentColor()};
                    transition: width 0.3s ease;
                    border-radius: 4px;
                }
                .verifier-progress-text {
                    font-size: 12px;
                    color: #666;
                }
                #verifier-report-summary {
                    padding: 10px;
                    background: #f8f9fa;
                    border: 1px solid #ddd;
                    border-radius: 4px;
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
                .verifier-summary-bar .seg-supported { background: #28a745; }
                .verifier-summary-bar .seg-partial { background: #ffc107; }
                .verifier-summary-bar .seg-not-supported { background: #dc3545; }
                .verifier-summary-bar .seg-unavailable { background: #6c757d; }
                .verifier-summary-bar .seg-error { background: #adb5bd; }
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
                    color: #333;
                    background: #fff;
                    border: 1px solid #ccc;
                    border-radius: 12px;
                    cursor: pointer;
                    user-select: none;
                    transition: opacity 0.15s, background 0.15s;
                }
                .verifier-filter-chip:hover {
                    background: #eef2ff;
                    border-color: #99a;
                }
                .verifier-filter-chip.verifier-chip-off {
                    opacity: 0.5;
                    text-decoration: line-through;
                    background: #f0f0f0;
                }
                .verifier-summary-meta {
                    margin-top: 6px;
                    font-size: 11px;
                    color: #888;
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
                    background: #f8f9fa;
                    border: 1px dashed #ccc;
                    border-radius: 4px;
                    color: #666;
                    font-size: 12px;
                    text-align: center;
                }
                html.skin-theme-clientpref-night .verifier-filter-empty {
                    background: #2a2a3e !important;
                    border-color: #3a3a4e !important;
                    color: #b0b0c0 !important;
                }
                @media (prefers-color-scheme: dark) {
                    html.skin-theme-clientpref-os .verifier-filter-empty {
                        background: #2a2a3e !important;
                        border-color: #3a3a4e !important;
                        color: #b0b0c0 !important;
                    }
                }
                .verifier-report-card {
                    padding: 8px 10px;
                    border: 1px solid #ddd;
                    border-radius: 4px;
                    font-size: 12px;
                    cursor: pointer;
                    background: #fff;
                    border-left: 3px solid #ccc;
                }
                .verifier-report-card:hover {
                    background: #f0f4ff;
                }
                .verifier-report-card.verdict-supported { border-left-color: #28a745; }
                .verifier-report-card.verdict-partial { border-left-color: #ffc107; }
                .verifier-report-card.verdict-not-supported { border-left-color: #dc3545; }
                .verifier-report-card.verdict-unavailable { border-left-color: #6c757d; }
                .verifier-report-card.verdict-error { border-left-color: #adb5bd; }
                .report-card-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 4px;
                }
                .report-card-citation {
                    font-weight: bold;
                }
                .report-card-verdict {
                    font-weight: bold;
                    font-size: 11px;
                    padding: 1px 6px;
                    border-radius: 3px;
                }
                .report-card-verdict.supported { background: #d4edda; color: #155724; }
                .report-card-verdict.partial { background: #fff3cd; color: #856404; }
                .report-card-verdict.not-supported { background: #f8d7da; color: #721c24; }
                .report-card-verdict.unavailable { background: #e2e3e5; color: #383d41; }
                .report-card-verdict.error { background: #e2e3e5; color: #383d41; }
                .reason-type-tag {
                    display: inline-block;
                    font-size: 11px;
                    padding: 1px 6px;
                    border-radius: 3px;
                    margin-left: 6px;
                    font-weight: normal;
                    vertical-align: middle;
                }
                .reason-type-contradiction { background: #f8d7da; color: #721c24; }
                .reason-type-omission { background: #fff3cd; color: #856404; }
                .report-card-claim {
                    color: #555;
                    font-size: 11px;
                    margin-bottom: 2px;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                .report-card-comment {
                    color: #666;
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
                .report-card-action .report-card-feedback-action .oo-ui-buttonElement-button .oo-ui-labelElement-label {
                    color: #54595d;
                    font-weight: normal;
                }
                .report-card-action .report-card-feedback-action .oo-ui-iconElement-icon {
                    opacity: 0.4 !important;
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
                    border: 1px solid #cdd5e0;
                    border-left: 3px solid ${this.getCurrentColor()};
                    border-radius: 4px;
                    background: #f6f8fb;
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
                    color: ${this.getCurrentColor()};
                }
                .verifier-report-group-claim {
                    color: #333;
                    font-size: 12px;
                    line-height: 1.4;
                    margin-bottom: 4px;
                }
                .verifier-report-group-collective {
                    background: #fff;
                    border: 1px solid #e0e4ea;
                    border-radius: 3px;
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
                    color: #333;
                }
                .verifier-report-group-collective-pending {
                    font-size: 11px;
                    color: #888;
                    font-style: italic;
                }
                .verifier-report-group-rows-label {
                    font-size: 10px;
                    text-transform: uppercase;
                    letter-spacing: 0.04em;
                    color: #888;
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
                    background: #fff;
                    border: 1px solid #e0e4ea;
                    border-left: 3px solid #ccc;
                    border-radius: 3px;
                    padding: 5px 8px;
                    cursor: pointer;
                }
                .verifier-report-group-row:hover {
                    background: #f0f4ff;
                }
                .verifier-report-group-row.verdict-supported { border-left-color: #28a745; }
                .verifier-report-group-row.verdict-partial { border-left-color: #ffc107; }
                .verifier-report-group-row.verdict-not-supported { border-left-color: #dc3545; }
                .verifier-report-group-row.verdict-unavailable { border-left-color: #6c757d; }
                .verifier-report-group-row.verdict-error { border-left-color: #adb5bd; }
                .verifier-report-group-row-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 2px;
                }
                #verifier-claim-group-indicator {
                    margin-top: 6px;
                    font-size: 11px;
                    color: #666;
                    line-height: 1.4;
                }
                #verifier-claim-group-indicator .group-active {
                    font-weight: bold;
                    color: ${this.getCurrentColor()};
                }
                html.skin-theme-clientpref-night .verifier-report-group {
                    background: #232336 !important;
                    border-color: #3a3a4e !important;
                }
                html.skin-theme-clientpref-night .verifier-report-group-row,
                html.skin-theme-clientpref-night .verifier-report-group-collective {
                    background: #1a1a2e !important;
                    border-color: #3a3a4e !important;
                    color: #e0e0e0 !important;
                }
                html.skin-theme-clientpref-night .verifier-report-group-row:hover {
                    background: #232336 !important;
                }
                html.skin-theme-clientpref-night .verifier-report-group-claim,
                html.skin-theme-clientpref-night .verifier-report-group-collective-label {
                    color: #d0d0d8 !important;
                }
                html.skin-theme-clientpref-night #verifier-claim-group-indicator {
                    color: #b0b0c0 !important;
                }
                #source-verifier-sidebar .oo-ui-iconElement-icon + .oo-ui-labelElement-label {
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
                    background-color: #e6f3ff;
                    cursor: pointer;
                }
                .reference.verifier-active {
                    background-color: ${this.getCurrentColor()};
                    color: white;
                }
                .claim-highlight {
                    background-color: #fff3cd;
                    border-left: 3px solid ${this.getCurrentColor()};
                    padding-left: 5px;
                    margin-left: -8px;
                }

                /* Dark theme overrides for Wikipedia night mode */
                html.skin-theme-clientpref-night #source-verifier-sidebar {
                    background: #1a1a2e !important;
                    color: #e0e0e0 !important;
                    border-left-color: ${this.getCurrentColor()} !important;
                    box-shadow: -2px 0 8px rgba(0,0,0,0.4) !important;
                }
                html.skin-theme-clientpref-night #source-verifier-sidebar * {
                    color: inherit;
                }
                html.skin-theme-clientpref-night #verifier-sidebar-header {
                    background: ${this.getCurrentColor()} !important;
                    color: white !important;
                }
                html.skin-theme-clientpref-night #verifier-sidebar-header * {
                    color: white !important;
                }
                html.skin-theme-clientpref-night #verifier-sidebar-content {
                    background: #1a1a2e !important;
                    color: #e0e0e0 !important;
                }
                html.skin-theme-clientpref-night #verifier-provider-info {
                    background: #2a2a3e !important;
                    color: #b0b0c0 !important;
                    border-color: #3a3a4e !important;
                }
                html.skin-theme-clientpref-night #verifier-provider-info.free-provider {
                    background: #1a2e1a !important;
                    color: #6ecf6e !important;
                }
                html.skin-theme-clientpref-night #verifier-claim-section h4,
                html.skin-theme-clientpref-night #verifier-source-section h4,
                html.skin-theme-clientpref-night #verifier-results h4 {
                    color: ${this.getCurrentColor()} !important;
                    filter: brightness(1.3);
                }
                html.skin-theme-clientpref-night #verifier-claim-text,
                html.skin-theme-clientpref-night #verifier-source-text {
                    background: #2a2a3e !important;
                    border-color: #3a3a4e !important;
                    color: #e0e0e0 !important;
                }
                html.skin-theme-clientpref-night #verifier-source-override-container .verifier-override-link .oo-ui-labelElement-label {
                    color: #a0a8b3 !important;
                    text-decoration-color: #6a7280 !important;
                }
                html.skin-theme-clientpref-night #verifier-source-override-container .verifier-override-link:hover .oo-ui-labelElement-label {
                    color: #e0e0e0 !important;
                    text-decoration-color: #a0a8b3 !important;
                }
                html.skin-theme-clientpref-night #verifier-verdict {
                    color: #e0e0e0 !important;
                }
                html.skin-theme-clientpref-night #verifier-verdict.supported {
                    background: #1a3a1a !important;
                    color: #6ecf6e !important;
                    border-color: #2a5a2a !important;
                }
                html.skin-theme-clientpref-night #verifier-verdict.partially-supported {
                    background: #3a3a1a !important;
                    color: #e0c060 !important;
                    border-color: #5a5a2a !important;
                }
                html.skin-theme-clientpref-night #verifier-verdict.not-supported {
                    background: #3a1a1a !important;
                    color: #e06060 !important;
                    border-color: #5a2a2a !important;
                }
                html.skin-theme-clientpref-night #verifier-verdict.source-unavailable {
                    background: #2a2a2e !important;
                    color: #a0a0a8 !important;
                    border-color: #3a3a3e !important;
                }
                html.skin-theme-clientpref-night #verifier-comments {
                    background: #2a2a3e !important;
                    border-color: #3a3a4e !important;
                    color: #e0e0e0 !important;
                }
                html.skin-theme-clientpref-night .verifier-action-hint {
                    color: #888 !important;
                }
                html.skin-theme-clientpref-night .verifier-error {
                    color: #ff8080 !important;
                    background: #3a1a1a !important;
                    border-color: #5a2a2a !important;
                }
                html.skin-theme-clientpref-night .reference:hover {
                    background-color: rgba(100, 149, 237, 0.15) !important;
                }
                html.skin-theme-clientpref-night .claim-highlight {
                    background-color: #3a3a1a !important;
                }
                html.skin-theme-clientpref-night #verifier-report-summary {
                    background: #2a2a3e !important;
                    border-color: #3a3a4e !important;
                    color: #e0e0e0 !important;
                }
                html.skin-theme-clientpref-night .verifier-filter-chip {
                    background: #2a2a3e !important;
                    color: #e0e0e0 !important;
                    border-color: #3a3a4e !important;
                }
                html.skin-theme-clientpref-night .verifier-filter-chip:hover {
                    background: #3a3a5e !important;
                    border-color: #5a5a7e !important;
                }
                html.skin-theme-clientpref-night .verifier-filter-chip.verifier-chip-off {
                    background: #1f1f2e !important;
                    color: #8a8a9e !important;
                }
                html.skin-theme-clientpref-night .verifier-summary-meta {
                    color: #a0a0b0 !important;
                }
                html.skin-theme-clientpref-night .verifier-progress-bar {
                    background: #3a3a4e !important;
                }
                html.skin-theme-clientpref-night .verifier-progress-text {
                    color: #b0b0c0 !important;
                }
                html.skin-theme-clientpref-night .verifier-report-card {
                    background: #2a2a3e !important;
                    border-color: #3a3a4e !important;
                    color: #e0e0e0 !important;
                }
                html.skin-theme-clientpref-night .verifier-report-card:hover {
                    background: #3a3a5e !important;
                }
                html.skin-theme-clientpref-night .report-card-claim {
                    color: #b0b0c0 !important;
                }
                html.skin-theme-clientpref-night .report-card-comment {
                    color: #a0a0b0 !important;
                }
                html.skin-theme-clientpref-night .report-card-verdict.supported {
                    background: #1a3a1a !important;
                    color: #6ecf6e !important;
                }
                html.skin-theme-clientpref-night .report-card-verdict.partial {
                    background: #3a3a1a !important;
                    color: #e0c060 !important;
                }
                html.skin-theme-clientpref-night .verifier-truncation-warning,
                html.skin-theme-clientpref-night .report-card-truncated {
                    background: #3a3a1a !important;
                    color: #e0c060 !important;
                    border-color: #5a5a2a !important;
                }
                html.skin-theme-clientpref-night .report-card-verdict.not-supported {
                    background: #3a1a1a !important;
                    color: #e06060 !important;
                }
                html.skin-theme-clientpref-night .report-card-verdict.unavailable {
                    background: #2a2a2e !important;
                    color: #a0a0a8 !important;
                }
                html.skin-theme-clientpref-night .report-card-verdict.error {
                    background: #2a2a2e !important;
                    color: #a0a0a8 !important;
                }
                html.skin-theme-clientpref-night .reason-type-contradiction {
                    background: #3a1a1a !important;
                    color: #e06060 !important;
                }
                html.skin-theme-clientpref-night .reason-type-omission {
                    background: #3a3a1a !important;
                    color: #e0c060 !important;
                }
                html.skin-theme-clientpref-night #verifier-source-textarea-container textarea {
                    background: #2a2a3e !important;
                    color: #e0e0e0 !important;
                    border-color: #3a3a4e !important;
                }
                html.skin-theme-clientpref-night #source-verifier-sidebar .oo-ui-dropdownWidget {
                    background: #2a2a3e !important;
                    border-color: #3a3a4e !important;
                }
                html.skin-theme-clientpref-night #source-verifier-sidebar .oo-ui-dropdownWidget .oo-ui-labelElement-label {
                    color: #e0e0e0 !important;
                }
                html.skin-theme-clientpref-night #source-verifier-sidebar .oo-ui-buttonElement-button {
                    background: #2a2a3e !important;
                    color: #e0e0e0 !important;
                    border-color: #3a3a4e !important;
                }
                html.skin-theme-clientpref-night #source-verifier-sidebar .oo-ui-buttonElement-button .oo-ui-labelElement-label {
                    color: #e0e0e0 !important;
                }
                html.skin-theme-clientpref-night #source-verifier-sidebar .oo-ui-flaggedElement-primary.oo-ui-flaggedElement-progressive .oo-ui-buttonElement-button {
                    background: ${this.getCurrentColor()} !important;
                    color: white !important;
                    border-color: ${this.getCurrentColor()} !important;
                }
                html.skin-theme-clientpref-night #source-verifier-sidebar .oo-ui-flaggedElement-primary.oo-ui-flaggedElement-progressive.oo-ui-widget-disabled .oo-ui-buttonElement-button {
                    background: #3a3a4e !important;
                    color: #888 !important;
                    border-color: #4a4a5e !important;
                    cursor: default !important;
                }
                html.skin-theme-clientpref-night #source-verifier-sidebar .oo-ui-flaggedElement-primary.oo-ui-flaggedElement-progressive .oo-ui-labelElement-label {
                    color: white !important;
                }
                html.skin-theme-clientpref-night #source-verifier-sidebar .oo-ui-flaggedElement-destructive .oo-ui-buttonElement-button {
                    color: #e06060 !important;
                }
                html.skin-theme-clientpref-night #source-verifier-sidebar .oo-ui-iconElement-icon {
                    filter: invert(0.8);
                }
                html.skin-theme-clientpref-night #source-verifier-sidebar .oo-ui-indicatorElement-indicator {
                    filter: invert(0.8);
                }
                html.skin-theme-clientpref-night #source-verifier-sidebar .oo-ui-menuSelectWidget {
                    background: #2a2a3e !important;
                    border-color: #3a3a4e !important;
                }
                html.skin-theme-clientpref-night #source-verifier-sidebar .oo-ui-optionWidget {
                    color: #e0e0e0 !important;
                }
                html.skin-theme-clientpref-night #source-verifier-sidebar .oo-ui-optionWidget-highlighted {
                    background: #3a3a5e !important;
                }
                html.skin-theme-clientpref-night #source-verifier-sidebar .oo-ui-optionWidget-selected {
                    background: ${this.getCurrentColor()} !important;
                    color: white !important;
                }

                /* Support auto dark mode via OS preference */
                @media (prefers-color-scheme: dark) {
                    html.skin-theme-clientpref-os #source-verifier-sidebar {
                        background: #1a1a2e !important;
                        color: #e0e0e0 !important;
                        border-left-color: ${this.getCurrentColor()} !important;
                        box-shadow: -2px 0 8px rgba(0,0,0,0.4) !important;
                    }
                    html.skin-theme-clientpref-os #source-verifier-sidebar * {
                        color: inherit;
                    }
                    html.skin-theme-clientpref-os #verifier-sidebar-header {
                        background: ${this.getCurrentColor()} !important;
                        color: white !important;
                    }
                    html.skin-theme-clientpref-os #verifier-sidebar-header * {
                        color: white !important;
                    }
                    html.skin-theme-clientpref-os #verifier-sidebar-content {
                        background: #1a1a2e !important;
                        color: #e0e0e0 !important;
                    }
                    html.skin-theme-clientpref-os #verifier-provider-info {
                        background: #2a2a3e !important;
                        color: #b0b0c0 !important;
                        border-color: #3a3a4e !important;
                    }
                    html.skin-theme-clientpref-os #verifier-provider-info.free-provider {
                        background: #1a2e1a !important;
                        color: #6ecf6e !important;
                    }
                    html.skin-theme-clientpref-os #verifier-claim-section h4,
                    html.skin-theme-clientpref-os #verifier-source-section h4,
                    html.skin-theme-clientpref-os #verifier-results h4 {
                        color: ${this.getCurrentColor()} !important;
                        filter: brightness(1.3);
                    }
                    html.skin-theme-clientpref-os #verifier-claim-text,
                    html.skin-theme-clientpref-os #verifier-source-text {
                        background: #2a2a3e !important;
                        border-color: #3a3a4e !important;
                        color: #e0e0e0 !important;
                    }
                    html.skin-theme-clientpref-os #verifier-source-override-container .verifier-override-link .oo-ui-labelElement-label {
                        color: #a0a8b3 !important;
                        text-decoration-color: #6a7280 !important;
                    }
                    html.skin-theme-clientpref-os #verifier-source-override-container .verifier-override-link:hover .oo-ui-labelElement-label {
                        color: #e0e0e0 !important;
                        text-decoration-color: #a0a8b3 !important;
                    }
                    html.skin-theme-clientpref-os #verifier-verdict {
                        color: #e0e0e0 !important;
                    }
                    html.skin-theme-clientpref-os #verifier-verdict.supported {
                        background: #1a3a1a !important;
                        color: #6ecf6e !important;
                        border-color: #2a5a2a !important;
                    }
                    html.skin-theme-clientpref-os #verifier-verdict.partially-supported {
                        background: #3a3a1a !important;
                        color: #e0c060 !important;
                        border-color: #5a5a2a !important;
                    }
                    html.skin-theme-clientpref-os #verifier-verdict.not-supported {
                        background: #3a1a1a !important;
                        color: #e06060 !important;
                        border-color: #5a2a2a !important;
                    }
                    html.skin-theme-clientpref-os #verifier-verdict.source-unavailable {
                        background: #2a2a2e !important;
                        color: #a0a0a8 !important;
                        border-color: #3a3a3e !important;
                    }
                    html.skin-theme-clientpref-os #verifier-comments {
                        background: #2a2a3e !important;
                        border-color: #3a3a4e !important;
                        color: #e0e0e0 !important;
                    }
                    html.skin-theme-clientpref-os .verifier-action-hint {
                        color: #888 !important;
                    }
                    html.skin-theme-clientpref-os .verifier-error {
                        color: #ff8080 !important;
                        background: #3a1a1a !important;
                        border-color: #5a2a2a !important;
                    }
                    html.skin-theme-clientpref-os .reference:hover {
                        background-color: rgba(100, 149, 237, 0.15) !important;
                    }
                    html.skin-theme-clientpref-os .claim-highlight {
                        background-color: #3a3a1a !important;
                    }
                    html.skin-theme-clientpref-os #verifier-report-summary {
                        background: #2a2a3e !important;
                        border-color: #3a3a4e !important;
                        color: #e0e0e0 !important;
                    }
                    html.skin-theme-clientpref-os .verifier-filter-chip {
                        background: #2a2a3e !important;
                        color: #e0e0e0 !important;
                        border-color: #3a3a4e !important;
                    }
                    html.skin-theme-clientpref-os .verifier-filter-chip:hover {
                        background: #3a3a5e !important;
                        border-color: #5a5a7e !important;
                    }
                    html.skin-theme-clientpref-os .verifier-filter-chip.verifier-chip-off {
                        background: #1f1f2e !important;
                        color: #8a8a9e !important;
                    }
                    html.skin-theme-clientpref-os .verifier-summary-meta {
                        color: #a0a0b0 !important;
                    }
                    html.skin-theme-clientpref-os .verifier-progress-bar {
                        background: #3a3a4e !important;
                    }
                    html.skin-theme-clientpref-os .verifier-progress-text {
                        color: #b0b0c0 !important;
                    }
                    html.skin-theme-clientpref-os .verifier-report-card {
                        background: #2a2a3e !important;
                        border-color: #3a3a4e !important;
                        color: #e0e0e0 !important;
                    }
                    html.skin-theme-clientpref-os .verifier-report-card:hover {
                        background: #3a3a5e !important;
                    }
                    html.skin-theme-clientpref-os .report-card-claim {
                        color: #b0b0c0 !important;
                    }
                    html.skin-theme-clientpref-os .report-card-comment {
                        color: #a0a0b0 !important;
                    }
                    html.skin-theme-clientpref-os .report-card-verdict.supported {
                        background: #1a3a1a !important;
                        color: #6ecf6e !important;
                    }
                    html.skin-theme-clientpref-os .report-card-verdict.partial {
                        background: #3a3a1a !important;
                        color: #e0c060 !important;
                    }
                    html.skin-theme-clientpref-os .verifier-truncation-warning,
                    html.skin-theme-clientpref-os .report-card-truncated {
                        background: #3a3a1a !important;
                        color: #e0c060 !important;
                        border-color: #5a5a2a !important;
                    }
                    html.skin-theme-clientpref-os .report-card-verdict.not-supported {
                        background: #3a1a1a !important;
                        color: #e06060 !important;
                    }
                    html.skin-theme-clientpref-os .report-card-verdict.unavailable {
                        background: #2a2a2e !important;
                        color: #a0a0a8 !important;
                    }
                    html.skin-theme-clientpref-os .report-card-verdict.error {
                        background: #2a2a2e !important;
                        color: #a0a0a8 !important;
                    }
                    html.skin-theme-clientpref-os .reason-type-contradiction {
                        background: #3a1a1a !important;
                        color: #e06060 !important;
                    }
                    html.skin-theme-clientpref-os .reason-type-omission {
                        background: #3a3a1a !important;
                        color: #e0c060 !important;
                    }
                    html.skin-theme-clientpref-os #verifier-source-textarea-container textarea {
                        background: #2a2a3e !important;
                        color: #e0e0e0 !important;
                        border-color: #3a3a4e !important;
                    }
                    html.skin-theme-clientpref-os #source-verifier-sidebar .oo-ui-dropdownWidget {
                        background: #2a2a3e !important;
                        border-color: #3a3a4e !important;
                    }
                    html.skin-theme-clientpref-os #source-verifier-sidebar .oo-ui-dropdownWidget .oo-ui-labelElement-label {
                        color: #e0e0e0 !important;
                    }
                    html.skin-theme-clientpref-os #source-verifier-sidebar .oo-ui-buttonElement-button {
                        background: #2a2a3e !important;
                        color: #e0e0e0 !important;
                        border-color: #3a3a4e !important;
                    }
                    html.skin-theme-clientpref-os #source-verifier-sidebar .oo-ui-buttonElement-button .oo-ui-labelElement-label {
                        color: #e0e0e0 !important;
                    }
                    html.skin-theme-clientpref-os #source-verifier-sidebar .oo-ui-flaggedElement-primary.oo-ui-flaggedElement-progressive .oo-ui-buttonElement-button {
                        background: ${this.getCurrentColor()} !important;
                        color: white !important;
                        border-color: ${this.getCurrentColor()} !important;
                    }
                    html.skin-theme-clientpref-os #source-verifier-sidebar .oo-ui-flaggedElement-primary.oo-ui-flaggedElement-progressive.oo-ui-widget-disabled .oo-ui-buttonElement-button {
                        background: #3a3a4e !important;
                        color: #888 !important;
                        border-color: #4a4a5e !important;
                        cursor: default !important;
                    }
                    html.skin-theme-clientpref-os #source-verifier-sidebar .oo-ui-flaggedElement-primary.oo-ui-flaggedElement-progressive .oo-ui-labelElement-label {
                        color: white !important;
                    }
                    html.skin-theme-clientpref-os #source-verifier-sidebar .oo-ui-flaggedElement-destructive .oo-ui-buttonElement-button {
                        color: #e06060 !important;
                    }
                    html.skin-theme-clientpref-os #source-verifier-sidebar .oo-ui-iconElement-icon {
                        filter: invert(0.8);
                    }
                    html.skin-theme-clientpref-os #source-verifier-sidebar .oo-ui-indicatorElement-indicator {
                        filter: invert(0.8);
                    }
                    html.skin-theme-clientpref-os #source-verifier-sidebar .oo-ui-menuSelectWidget {
                        background: #2a2a3e !important;
                        border-color: #3a3a4e !important;
                    }
                    html.skin-theme-clientpref-os #source-verifier-sidebar .oo-ui-optionWidget {
                        color: #e0e0e0 !important;
                    }
                    html.skin-theme-clientpref-os #source-verifier-sidebar .oo-ui-optionWidget-highlighted {
                        background: #3a3a5e !important;
                    }
                    html.skin-theme-clientpref-os #source-verifier-sidebar .oo-ui-optionWidget-selected {
                        background: ${this.getCurrentColor()} !important;
                        color: white !important;
                    }
                    html.skin-theme-clientpref-os .verifier-report-group {
                        background: #232336 !important;
                        border-color: #3a3a4e !important;
                    }
                    html.skin-theme-clientpref-os .verifier-report-group-row,
                    html.skin-theme-clientpref-os .verifier-report-group-collective {
                        background: #1a1a2e !important;
                        border-color: #3a3a4e !important;
                        color: #e0e0e0 !important;
                    }
                    html.skin-theme-clientpref-os .verifier-report-group-row:hover {
                        background: #232336 !important;
                    }
                    html.skin-theme-clientpref-os .verifier-report-group-claim,
                    html.skin-theme-clientpref-os .verifier-report-group-collective-label {
                        color: #d0d0d8 !important;
                    }
                    html.skin-theme-clientpref-os #verifier-claim-group-indicator {
                        color: #b0b0c0 !important;
                    }
                }
            `;
            document.head.appendChild(style);
        }
        
        createOOUIButtons() {
            this.buttons.close = new OO.ui.ButtonWidget({
                icon: 'close',
                title: 'Close',
                framed: false,
                classes: ['verifier-close-button']
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
            
            this.buttons.setKey = new OO.ui.ButtonWidget({
                label: 'Set API Key',
                flags: ['primary', 'progressive'],
                disabled: false
            });
            
            this.buttons.verify = new OO.ui.ButtonWidget({
                label: 'Verify Claim',
                flags: ['primary', 'progressive'],
                icon: 'check',
                disabled: true
            });
            
            this.buttons.changeKey = new OO.ui.ButtonWidget({
                label: 'Change Key',
                flags: ['safe'],
                icon: 'edit',
                disabled: false
            });
            
            this.buttons.removeKey = new OO.ui.ButtonWidget({
                label: 'Remove API Key',
                flags: ['destructive'],
                icon: 'trash',
                disabled: false
            });
            
            // Source text input widgets
            this.sourceTextInput = new OO.ui.MultilineTextInputWidget({
                placeholder: 'Paste the source text here...',
                rows: 6,
                autosize: true,
                maxRows: 15
            });
            
            this.buttons.loadText = new OO.ui.ButtonWidget({
                label: 'Load Text',
                flags: ['primary', 'progressive']
            });
            
            this.buttons.cancelText = new OO.ui.ButtonWidget({
                label: 'Cancel',
                flags: ['safe']
            });

            this.buttons.overrideText = new OO.ui.ButtonWidget({
                label: 'Paste source text manually',
                framed: false,
                title: 'Replace the fetched source content with text you paste in (e.g., the full article from The Wikipedia Library)'
            });
            this.buttons.overrideText.$element.addClass('verifier-override-link');

            // Article report buttons
            this.buttons.verifyAll = new OO.ui.ButtonWidget({
                label: 'Verify All Citations',
                flags: ['primary', 'progressive'],
                icon: 'articles'
            });

            this.buttons.stopAll = new OO.ui.ButtonWidget({
                label: 'Stop',
                flags: ['destructive'],
                icon: 'cancel'
            });

            this.buttons.backToReport = new OO.ui.ButtonWidget({
                label: 'Back to Report',
                flags: ['safe'],
                icon: 'arrowPrevious'
            });

            this.updateButtonVisibility();
        }
        
        appendOOUIButtons() {
            document.getElementById('verifier-close-btn-container').appendChild(this.buttons.close.$element[0]);
            document.getElementById('verifier-provider-container').appendChild(this.buttons.providerSelect.$element[0]);
            
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
                    infoEl.textContent = `✓ Using your ${provider.name} API key`;
                } else if (provider.optionalKey) {
                    infoEl.appendChild(document.createTextNode('✓ Free to use. Optional: '));
                    const link = document.createElement('a');
                    link.href = '#';
                    link.textContent = `add your ${provider.name} API key`;
                    link.addEventListener('click', (e) => {
                        e.preventDefault();
                        this.setApiKey();
                    });
                    infoEl.appendChild(link);
                } else {
                    infoEl.textContent = '✓ Free to use';
                }
                infoEl.className = 'free-provider';
            } else if (this.getCurrentApiKey()) {
                infoEl.textContent = `API key configured for ${provider.name}`;
                infoEl.className = '';
            } else {
                infoEl.textContent = `API key required for ${provider.name}`;
                infoEl.className = '';
            }
        }
        
        updateButtonVisibility() {
            const container = document.getElementById('verifier-buttons-container');
            if (!container) return;
            
            container.innerHTML = '';
            
            const hasKey = this.getCurrentApiKey();
            const requiresKey = this.providerRequiresKey();
            const optionalKey = this.providers[this.currentProvider].optionalKey;

            if (!requiresKey || hasKey) {
                // Provider is ready to use
                if (this.reportRunning) {
                    container.appendChild(this.buttons.stopAll.$element[0]);
                } else {
                    const hasClaimAndSource = this.activeClaim && this.activeSource;
                    this.buttons.verify.setDisabled(!hasClaimAndSource);
                    container.appendChild(this.buttons.verify.$element[0]);
                    container.appendChild(this.buttons.verifyAll.$element[0]);

                    if (this.hasReport && !this.reportMode) {
                        container.appendChild(this.buttons.backToReport.$element[0]);
                    }
                }

                const privacyNote = document.createElement('div');
                privacyNote.style.cssText = 'font-size: 11px; color: #72777d; margin-top: 4px;';
                privacyNote.textContent = 'Results are logged for research. Your username is not recorded.';
                container.appendChild(privacyNote);

                // Key-management buttons: required-key providers always show
                // change/remove; optional-key providers show change/remove
                // when a key is stored. The "set key" affordance for the
                // optional-no-key case lives as an inline link inside
                // updateProviderInfo() so it doesn't compete with Verify.
                if (!this.reportRunning) {
                    if (requiresKey || (optionalKey && hasKey)) {
                        container.appendChild(this.buttons.changeKey.$element[0]);
                        container.appendChild(this.buttons.removeKey.$element[0]);
                    }
                }
            } else {
                // Provider needs a key
                this.buttons.verify.setDisabled(true);
                container.appendChild(this.buttons.setKey.$element[0]);
            }
            
            this.updateProviderInfo();
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
                        'Verify',
                        't-verifier',
                        'Verify claims against sources',
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
                    'Citation Verifier installed — click the ',
                    $('<strong>').text('Verify'),
                    ' tab to get started.'
                ),
                { title: 'Citation Verifier', type: 'info', autoHide: true, autoHideSeconds: 8 }
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
                    this.updateStatus('Could not extract claim text', true);
                    return;
                }
                
                this.highlightClaim(refElement, claim);
                refElement.parentElement.classList.add('verifier-active');
                
                this.activeClaim = claim;
                this.activeCitationNumber = refElement.textContent.replace(/[\[\]]/g, '').trim() || null;
                this.activeRefElement = refElement;

                document.getElementById('verifier-claim-text').textContent = claim;
                this.renderClaimGroupIndicator(refElement);

                const refUrl = this.extractReferenceUrl(refElement);
                this.activeSourceUrl = refUrl;
                
                if (!refUrl) {
                    this.showSourceTextInput();
                    this.updateStatus('No URL found in reference. Please paste the source text below.');
                    return;
                }

                if (this.isGoogleBooksUrl(refUrl)) {
                    this.showSourceTextInput();
                    this.updateStatus('Google Books sources cannot be fetched. Please paste the source text below.');
                    return;
                }

                this.hideSourceTextInput();
                this.activeSource = null;
                this.updateButtonVisibility();
                this.updateStatus('Fetching source content...');
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
                    this.updateStatus(`Could not fetch source${status}${reason}. Please paste the source text below.`, true);
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
                            ? ` (page ${pageMatch[1]} of ${pdfMatch[1]})`
                            : ` (${pdfMatch[1]} pages)`;
                        statusHtml = `<span style="color: #2e7d32;">✓ PDF content extracted${pageInfo}</span>`;
                    } else if (contentFetched) {
                        statusHtml = '<span style="color: #2e7d32;">✓ Content fetched successfully</span>';
                    } else {
                        statusHtml = '<em>Content will be fetched by AI during verification.</em>';
                    }
                    const truncationHtml = isTruncated
                        ? '<div class="verifier-truncation-warning">⚠ The source is long and can only be checked partially.</div>'
                        : '';
                    sourceElement.innerHTML = `
                        <strong>Source URL:</strong><br>
                        <a href="${urlMatch[1]}" target="_blank" style="word-break: break-all;">${urlMatch[1]}</a><br><br>
                        ${statusHtml}
                        ${truncationHtml}
                    `;
                } else {
                    sourceElement.textContent = sourceInfo;
                }

                this.updateButtonVisibility();
                this.refreshOverrideButton();
                this.updateStatus(contentFetched ? 'Source fetched. Ready to verify.' : 'Ready to verify claim against source');
                
            } catch (error) {
                console.error('Error handling reference click:', error);
                this.updateStatus(`Error: ${error.message}`, true);
            }
        }
        
        showSourceTextInput(forOverride = false) {
            this.sourceInputForOverride = forOverride;
            document.getElementById('verifier-source-input-container').style.display = 'block';
            if (!forOverride) {
                document.getElementById('verifier-source-text').textContent = 'No URL found. Please paste the source text below:';
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
            const text = this.sourceTextInput.getValue().trim();
            if (!text) {
                this.updateStatus('Please enter some source text', true);
                return;
            }

            this.activeSource = `Manual source text:\n\n${text}`;
            document.getElementById('verifier-source-text').innerHTML = `<strong>Manual Source Text:</strong><br><em>${text.substring(0, 200)}${text.length > 200 ? '...' : ''}</em>`;
            this.sourceInputForOverride = false;
            this.hideSourceTextInput();
            this.updateButtonVisibility();
            this.updateStatus('Source text loaded. Ready to verify.');
        }

        cancelManualSourceText() {
            const wasOverride = this.sourceInputForOverride;
            this.sourceTextInput.setValue('');
            this.sourceInputForOverride = false;
            this.hideSourceTextInput();
            if (!wasOverride) {
                this.activeSource = null;
                document.getElementById('verifier-source-text').textContent = 'No source loaded.';
            }
            this.updateButtonVisibility();
            this.updateStatus('Cancelled');
        }
        
        extractClaimText(refElement) {
            return extractClaimText(refElement);
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
            return fetchSourceContent(url, pageNum);
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
            
            this.buttons.providerSelect.getMenu().on('select', (item) => {
                this.currentProvider = item.getData();
                localStorage.setItem('source_verifier_provider', this.currentProvider);
                this.updateButtonVisibility();
                this.updateTheme();
                this.updateStatus(`Switched to ${this.providers[this.currentProvider].name}`);
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

            this.buttons.overrideText.on('click', () => {
                this.showSourceTextInput(true);
                this.updateStatus('Paste replacement source text below, then click Load Text.');
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
                this.updateStatus('This provider does not require an API key.');
                return;
            }
            
            const dialog = new OO.ui.MessageDialog();
            
            const textInput = new OO.ui.TextInputWidget({
                placeholder: `Enter your ${provider.name} API Key...`,
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
                title: `Set ${provider.name} API Key`,
                message: $('<div>').append(
                    $('<p>').text(`Enter your ${provider.name} API Key to enable source verification:`),
                    textInput.$element
                ),
                actions: [
                    {
                        action: 'save',
                        label: 'Save',
                        flags: ['primary', 'progressive']
                    },
                    {
                        action: 'cancel',
                        label: 'Cancel',
                        flags: ['safe']
                    }
                ]
            }).closed.then((data) => {
                if (data && data.action === 'save') {
                    const key = textInput.getValue().trim();
                    if (key) {
                        this.setCurrentApiKey(key);
                        this.updateButtonVisibility();
                        this.updateStatus('API key set successfully!');
                        
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
                this.updateStatus('This provider does not use a stored API key.');
                return;
            }
            
            OO.ui.confirm('Are you sure you want to remove the stored API key?').done((confirmed) => {
                if (confirmed) {
                    this.removeCurrentApiKey();
                    this.updateButtonVisibility();
                    this.updateStatus('API key removed successfully!');
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

        logVerification(verdict, confidence, reasonType) {
            logVerification({
                article_url: window.location.href,
                article_title: typeof mw !== 'undefined' ? mw.config.get('wgTitle') : document.title,
                citation_number: this.activeCitationNumber,
                source_url: this.activeSourceUrl,
                provider: this.currentProvider,
                verdict: verdict,
                confidence: confidence,
                reason_type: reasonType ?? null,
            });
        }

        async verifyClaim() {
            const requiresKey = this.providerRequiresKey();
            const hasKey = !!this.getCurrentApiKey();
            
            // Only require a browser key for providers that need it
            if ((requiresKey && !hasKey) || !this.activeClaim || !this.activeSource) {
                this.updateStatus('Missing API key (for this provider), claim, or source content', true);
                return;
            }
            
            const verifyId = ++this.currentVerifyId;
            try {
                this.buttons.verify.setDisabled(true);
                this.buttons.verify.setLabel('Verifying...');
                this.buttons.verify.setIcon('clock');
                this.updateStatus('Verifying claim against source...');

                const apiResult = await this.callProviderAPI(this.activeClaim, this.activeSource);
                const result = apiResult.text;

                if (verifyId !== this.currentVerifyId) {
                    return;
                }

                this.updateStatus('Verification complete!');
                this.displayResult(result);

                // Fire-and-forget logging
                try {
                    const jsonMatch = result.match(/```(?:json)?\s*([\s\S]*?)\s*```/) ||
                                     [null, result.match(/\{[\s\S]*\}/)?.[0]];
                    const parsed = JSON.parse(jsonMatch[1]);
                    this.logVerification(parsed.verdict, parsed.confidence, parsed.reason_type);
                } catch (e) {}

            } catch (error) {
                if (verifyId !== this.currentVerifyId) {
                    return;
                }
                console.error('Verification error:', error);
                this.updateStatus(`Error: ${error.message}`, true);
                document.getElementById('verifier-verdict').textContent = 'ERROR';
                document.getElementById('verifier-verdict').className = 'source-unavailable';
                document.getElementById('verifier-comments').textContent = error.message;
            } finally {
                if (verifyId === this.currentVerifyId) {
                    this.buttons.verify.setLabel('Verify Claim');
                    this.buttons.verify.setIcon('check');
                    this.updateButtonVisibility();
                }
            }
        }
        
        async callPublicAIAPI(claim, sourceInfo) {
            return callPublicAIAPI({ model: this.providers.publicai.model, systemPrompt: generateSystemPrompt(), userContent: generateUserPrompt(claim, sourceInfo) });
        }
        
        async callClaudeAPI(claim, sourceInfo) {
            return callClaudeAPI({ apiKey: this.getCurrentApiKey(), model: this.providers.claude.model, systemPrompt: generateSystemPrompt(), userContent: generateUserPrompt(claim, sourceInfo) });
        }
        
        async callGeminiAPI(claim, sourceInfo) {
            return callGeminiAPI({ apiKey: this.getCurrentApiKey(), model: this.providers.gemini.model, systemPrompt: generateSystemPrompt(), userContent: generateUserPrompt(claim, sourceInfo) });
        }
        
        async callOpenAIAPI(claim, sourceInfo) {
            return callOpenAIAPI({ apiKey: this.getCurrentApiKey(), model: this.providers.openai.model, systemPrompt: generateSystemPrompt(), userContent: generateUserPrompt(claim, sourceInfo) });
        }
        
	parseVerificationResult(response) {
	    return parseVerificationResult(response);
	}

	displayResult(response) {
	    const verdictEl = document.getElementById('verifier-verdict');
	    const commentsEl = document.getElementById('verifier-comments');

	    const result = this.parseVerificationResult(response);

	    verdictEl.textContent = result.verdict;
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
	        tag.textContent = result.reason_type === 'contradiction' ? 'Contradiction' : 'Omission';
	        verdictEl.after(tag);
	    }

	    commentsEl.textContent = result.comments;
	    console.log('[Verifier] Verdict for action button:', JSON.stringify(result.verdict));
	    this.showActionButton(result.verdict, result.comments);
	}
        
        // ========================================
        // ARTICLE REPORT METHODS
        // ========================================

        collectAllCitations() {
            // .reference a targets inline <sup class="reference"> links only — each is a unique
            // DOM element. Footnote backlinks use .mw-cite-backlink, not .reference, so no dedup needed.
            const refs = document.querySelectorAll('#mw-content-text .reference a');
            const citations = [];

            refs.forEach(refElement => {
                const href = refElement.getAttribute('href');
                if (!href || !href.startsWith('#')) return;

                const refId = href.substring(1);
                const citationNumber = refElement.textContent.replace(/[\[\]]/g, '').trim();
                const claimText = this.extractClaimText(refElement);
                if (!claimText || claimText.length < 10) return;

                const url = this.extractReferenceUrl(refElement);
                const pageNum = this.extractPageNumber(refElement);

                citations.push({ refElement, citationNumber, claimText, url, pageNum, refId });
            });

            // Attach group metadata: every citation in a contiguous run of refs
            // attached to the same claim shares the same groupId (first
            // member's refId), groupSize and groupCitationNumbers list. The
            // groupIndex is the citation's 0-based position within its group.
            this.attachGroupMetadata(citations);

            return citations;
        }

        attachGroupMetadata(citations) {
            // Key by the <sup class="reference"> wrapper element, not refId:
            // named refs (e.g. {{r|Foo}} cited twice) share the same cite_note
            // href, so a refId-keyed map collides and the second occurrence
            // overwrites the first. Wrapper elements are unique per occurrence.
            const byWrapper = new Map();
            for (const c of citations) {
                const wrapper = c.refElement.closest('.reference');
                if (wrapper) byWrapper.set(wrapper, c);
            }
            const visited = new Set();
            for (const citation of citations) {
                if (visited.has(citation)) continue;
                const groupRefs = this.getCitationGroup(citation.refElement);
                const groupCitations = [];
                for (const wrapper of groupRefs) {
                    const c = byWrapper.get(wrapper);
                    if (c) groupCitations.push(c);
                }
                if (groupCitations.length === 0) continue;
                // Use the first wrapper's id (cite_ref-X-Y, unique per
                // occurrence) as the group id so two groups whose first
                // member is the same named source — e.g. "[3][4]" and a
                // separate "[3][5]" later in the article — don't collide on
                // the data-group-id used by the report renderer.
                const firstWrapper = groupCitations[0].refElement.closest('.reference');
                const groupId = (firstWrapper && firstWrapper.id) || groupCitations[0].refId;
                const groupSize = groupCitations.length;
                const groupCitationNumbers = groupCitations.map(c => c.citationNumber);
                groupCitations.forEach((c, idx) => {
                    c.groupId = groupId;
                    c.groupSize = groupSize;
                    c.groupIndex = idx;
                    c.groupCitationNumbers = groupCitationNumbers;
                    visited.add(c);
                });
            }
        }

        showReportView() {
            this.reportMode = true;
            // Hide single-citation sections
            document.getElementById('verifier-claim-section').style.display = 'none';
            document.getElementById('verifier-source-section').style.display = 'none';
            document.getElementById('verifier-results').style.display = 'none';
            // Show report view
            document.getElementById('verifier-report-view').style.display = 'block';
            this.updateButtonVisibility();
        }

        showSingleCitationView() {
            this.reportMode = false;
            // Show single-citation sections
            document.getElementById('verifier-claim-section').style.display = '';
            document.getElementById('verifier-source-section').style.display = '';
            document.getElementById('verifier-results').style.display = '';
            // Hide report view
            document.getElementById('verifier-report-view').style.display = 'none';
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
                etaStr = ` · ~${this.formatDuration(remaining)} remaining`;
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
            // of its verdict — the rows are debug detail. A group whose
            // collective check hasn't finished yet (no data-collective-verdict)
            // stays visible.
            const groups = resultsEl.querySelectorAll('.verifier-report-group');
            groups.forEach(groupEl => {
                const collectiveVerdict = groupEl.dataset.collectiveVerdict;
                const hidden = collectiveVerdict ? !!this.reportFilters[collectiveVerdict] : false;
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
                    emptyEl.textContent = 'All citations are hidden by the current filters. Click a filter chip above to show them.';
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
                return `<button type="button"
                    class="verifier-filter-chip${hidden ? ' verifier-chip-off' : ''}"
                    data-filter="${key}"
                    title="${hidden ? 'Show' : 'Hide'} ${this.escapeHtml(label)} citations"
                    aria-pressed="${hidden ? 'false' : 'true'}">
                    <span class="dot" style="background:${color}"></span>${count} ${this.escapeHtml(label)}
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
                ? `${total} citation${total === 1 ? '' : 's'} checked`
                : `${citationCount} citations across ${total} claim${total === 1 ? '' : 's'}`;

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
                    ${claimsLabel}${hiddenCount > 0 ? ` · ${hiddenCount} hidden by filter` : ''}${this.reportTokenUsage.input + this.reportTokenUsage.output > 0 ? ` · ${this.reportTokenUsage.input.toLocaleString()} input + ${this.reportTokenUsage.output.toLocaleString()} output tokens` : ''}
                </div>
                ${this.reportRevisionId ? `<div class="verifier-summary-meta">Revision: <a href="${this.escapeHtml(this.getRevisionPermalinkUrl(this.reportRevisionId) || '#')}" target="_blank" rel="noopener">${this.reportRevisionId}</a></div>` : ''}
            `;

            summaryEl.querySelectorAll('.verifier-filter-chip').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.preventDefault();
                    this.toggleReportFilter(btn.dataset.filter);
                });
            });
        }

        verdictClassFor(verdict) {
            switch (verdict) {
                case 'SUPPORTED': return { cls: 'supported', label: 'Supported' };
                case 'PARTIALLY SUPPORTED': return { cls: 'partial', label: 'Partial' };
                case 'NOT SUPPORTED': return { cls: 'not-supported', label: 'Not Supported' };
                case 'SOURCE UNAVAILABLE': return { cls: 'unavailable', label: 'Unavailable' };
                default: return { cls: 'error', label: verdict };
            }
        }

        attachRefScrollHandler(el, refElement) {
            if (!refElement) return;
            el.addEventListener('click', (e) => {
                if (e.target.closest('.report-card-action') || e.target.closest('.report-card-header-actions') || e.target.closest('.verifier-report-group-edit')) return;
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
                ? '<div class="report-card-truncated">⚠ Source is long, only partially checked.</div>'
                : '';
            const reasonTypeHtml = (result.verdict === 'NOT SUPPORTED' && result.reason_type)
                ? `<span class="reason-type-tag reason-type-${result.reason_type}">${result.reason_type === 'contradiction' ? 'Contradiction' : 'Omission'}</span>`
                : '';
            card.innerHTML = `
                <div class="report-card-header">
                    <span class="report-card-citation">[${result.citationNumber}]</span>
                    <span class="report-card-header-actions">
                        <span class="report-card-verdict ${verdictClass}">${verdictLabel}</span>${reasonTypeHtml}
                    </span>
                </div>
                <div class="report-card-claim">${this.escapeHtml(claimExcerpt)}</div>
                ${result.comments ? `<div class="report-card-comment">${this.escapeHtml(result.comments)}</div>` : ''}
                ${truncationHtml}
            `;

            this.attachRefScrollHandler(card, result.refElement);

            const actionDiv = document.createElement('div');
            actionDiv.className = 'report-card-action';

            if (result.refElement && (result.verdict === 'NOT SUPPORTED' || result.verdict === 'PARTIALLY SUPPORTED' || result.verdict === 'SOURCE UNAVAILABLE')) {
                const editBtn = new OO.ui.ButtonWidget({
                    label: 'Edit Section',
                    flags: ['progressive'],
                    icon: 'edit',
                    href: this.buildEditUrl(result.refElement),
                    target: '_blank',
                    framed: false
                });
                actionDiv.appendChild(editBtn.$element[0]);
            }

            if (result.verdict && result.verdict !== 'ERROR' && this.isDatasetSubmissionConfigured()) {
                const submitBtn = this.buildSubmitToDatasetButton(result);
                submitBtn.$element.addClass('report-card-feedback-action');
                actionDiv.appendChild(submitBtn.$element[0]);
            }

            if (actionDiv.children.length) {
                card.appendChild(actionDiv);
            }
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
                        <span class="verifier-report-group-badge">Group of ${firstResult.groupSize} · ${numbers}</span>
                    </div>
                    <div class="verifier-report-group-claim">${this.escapeHtml(claimExcerpt)}</div>
                    <div class="verifier-report-group-collective">
                        <div class="verifier-report-group-collective-pending">Checking combined sources…</div>
                    </div>
                    <div class="verifier-report-group-edit"></div>
                </div>
                <div class="verifier-report-group-rows-label">Individual sources</div>
                <div class="verifier-report-group-rows"></div>
            `;
            // One shared "Edit Section" button per group: every member is in
            // the same article section by definition, so a per-row button
            // would just be repetition. Wire it to the first member's ref.
            if (firstResult.refElement) {
                const editBtn = new OO.ui.ButtonWidget({
                    label: 'Edit Section',
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
                ? `<span class="reason-type-tag reason-type-${result.reason_type}">${result.reason_type === 'contradiction' ? 'Contradiction' : 'Omission'}</span>`
                : '';
            const truncationHtml = (result.truncated && result.verdict !== 'SUPPORTED')
                ? '<div class="report-card-truncated">⚠ Combined sources are long, only partially checked.</div>'
                : '';
            slot.innerHTML = `
                <div class="verifier-report-group-collective-header">
                    <span class="verifier-report-group-collective-label">Combined verdict</span>
                    <span class="report-card-verdict ${verdictClass}">${verdictLabel}</span>${reasonTypeHtml}
                </div>
                ${result.comments ? `<div class="report-card-comment">${this.escapeHtml(result.comments)}</div>` : ''}
                ${truncationHtml}
            `;

            if (result.verdict && result.verdict !== 'ERROR' && this.isDatasetSubmissionConfigured()) {
                const actionDiv = document.createElement('div');
                actionDiv.className = 'report-card-action';
                const submitBtn = this.buildSubmitToDatasetButton(result);
                submitBtn.$element.addClass('report-card-feedback-action');
                actionDiv.appendChild(submitBtn.$element[0]);
                slot.appendChild(actionDiv);
            }
        }

        hideGroupCollectiveSlot(groupId) {
            const resultsEl = document.getElementById('verifier-report-results');
            if (!resultsEl) return;
            const groupEl = resultsEl.querySelector(`.verifier-report-group[data-group-id="${CSS.escape(groupId)}"]`);
            if (!groupEl) return;
            const slot = groupEl.querySelector('.verifier-report-group-collective');
            if (slot) slot.style.display = 'none';
        }

        buildGroupRow(result) {
            const { cls: verdictClass, label: verdictLabel } = this.verdictClassFor(result.verdict);
            const row = document.createElement('div');
            row.className = `verifier-report-group-row verdict-${verdictClass}`;
            const truncationHtml = (result.truncated && result.verdict !== 'SUPPORTED')
                ? '<div class="report-card-truncated">⚠ Source is long, only partially checked.</div>'
                : '';
            const reasonTypeHtml = (result.verdict === 'NOT SUPPORTED' && result.reason_type)
                ? `<span class="reason-type-tag reason-type-${result.reason_type}">${result.reason_type === 'contradiction' ? 'Contradiction' : 'Omission'}</span>`
                : '';
            row.innerHTML = `
                <div class="verifier-report-group-row-header">
                    <span class="report-card-citation">[${result.citationNumber}]</span>
                    <span class="report-card-header-actions">
                        <span class="report-card-verdict ${verdictClass}">${verdictLabel}</span>${reasonTypeHtml}
                    </span>
                </div>
                ${result.comments ? `<div class="report-card-comment">${this.escapeHtml(result.comments)}</div>` : ''}
                ${truncationHtml}
            `;
            this.attachRefScrollHandler(row, result.refElement);

            if (result.verdict && result.verdict !== 'ERROR' && this.isDatasetSubmissionConfigured()) {
                const actionDiv = document.createElement('div');
                actionDiv.className = 'report-card-action';
                const submitBtn = this.buildSubmitToDatasetButton(result);
                submitBtn.$element.addClass('report-card-feedback-action');
                actionDiv.appendChild(submitBtn.$element[0]);
                row.appendChild(actionDiv);
            }

            return row;
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
                label: 'Copy Report (Wikitext)',
                flags: ['progressive'],
                icon: 'copy'
            });
            copyWikiBtn.on('click', () => this.copyReportToClipboard('wikitext'));
            actionsEl.appendChild(copyWikiBtn.$element[0]);

            const copyTextBtn = new OO.ui.ButtonWidget({
                label: 'Copy Report (Plain Text)',
                flags: ['safe'],
                icon: 'copy'
            });
            copyTextBtn.on('click', () => this.copyReportToClipboard('plaintext'));
            actionsEl.appendChild(copyTextBtn.$element[0]);
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
            let wikitext = `== Citation verification report ==\n`;
            wikitext += `This is an experimental check of the article sources by [[User:Alaexis/AI_Source_Verification|Citation Verifier]]. Treat it with caution, be aware of its [[User:Alaexis/AI_Source_Verification#Limitations|limitations]] and feel free to leave feedback at [[User_talk:Alaexis/AI_Source_Verification|the talk page]].\n\n`;
            if (revId) {
                wikitext += `Revision checked: [[Special:PermanentLink/${revId}|${revId}]]\n\n`;
            }
            const submissionConfigured = this.isDatasetSubmissionConfigured();
            wikitext += `{| class="wikitable sortable"\n`;
            wikitext += submissionConfigured
                ? `|-\n! # !! Verdict !! Source !! Comments !! class="unsortable" | Submit\n`
                : `|-\n! # !! Verdict !! Source !! Comments\n`;

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
                    case 'SUPPORTED': verdictWiki = '{{tick}} Supported'; break;
                    case 'PARTIALLY SUPPORTED': verdictWiki = '{{bang}} Partially supported'; break;
                    case 'NOT SUPPORTED': verdictWiki = '{{cross}} Not supported'; break;
                    case 'SOURCE UNAVAILABLE': verdictWiki = '{{hmmm}} Source unavailable'; break;
                    default: verdictWiki = r.verdict; break;
                }
                let commentsClean = (r.comments || '').replace(/\n/g, ' ');
                if (r.truncated && r.verdict !== 'SUPPORTED') {
                    const note = r.isGroup
                        ? "''(Combined sources are long, only partially checked.)''"
                        : "''(Source is long, only partially checked.)''";
                    commentsClean += (commentsClean ? ' ' : '') + note;
                }
                let citationCell;
                let sourceStr;
                if (r.isGroup) {
                    citationCell = (r.members || []).map(m => linkNum(m.citationNumber, m.refElement)).join('')
                        + ' <small>(combined)</small>';
                    const links = (r.members || []).filter(m => m.url).map(m => `[${m.url} ${m.citationNumber}]`);
                    sourceStr = links.length ? links.join(' ') : '—';
                } else {
                    citationCell = linkNum(r.citationNumber, r.refElement);
                    sourceStr = r.url ? `[${r.url} source]` : '—';
                }
                if (submissionConfigured) {
                    const submitCell = (r.verdict && r.verdict !== 'ERROR')
                        ? `[${this.buildDatasetSubmissionUrl(r)} Submit]`
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
                ? `${reportUnits.length} citation${reportUnits.length === 1 ? '' : 's'}`
                : `${reportUnits.length} claim${reportUnits.length === 1 ? '' : 's'} (${citationCount} citations)`;
            wikitext += `'''Summary:''' ${counts.supported} supported, ${counts.partial} partially supported, ${counts.notSupported} not supported, ${counts.unavailable} source unavailable out of ${claimsPhrase}.\n`;

            const provider = this.providers[this.currentProvider];
            let modelDesc;
            if (this.currentProvider === 'publicai') {
                modelDesc = 'a PublicAI-hosted open-source LLM';
            } else if (this.currentProvider === 'huggingface') {
                modelDesc = `a HuggingFace-hosted open-source LLM (${provider.model})`;
            } else {
                modelDesc = provider.model;
            }
            wikitext += `Generated by [[User:Alaexis/AI_Source_Verification|Citation Verifier]] using ${modelDesc} on ~~~~~.`;
            if (this.reportTokenUsage.input + this.reportTokenUsage.output > 0) {
                wikitext += ` Tokens used: ${this.reportTokenUsage.input.toLocaleString()} input, ${this.reportTokenUsage.output.toLocaleString()} output.`;
            }
            wikitext += `\n`;

            return wikitext;
        }

        generatePlainTextReport() {
            const articleTitle = typeof mw !== 'undefined' ? mw.config.get('wgTitle') : document.title;
            const revId = this.reportRevisionId;
            let text = `Citation Verification Report: ${articleTitle}\n`;
            text += `Provider: ${this.providers[this.currentProvider].name}\n`;
            if (revId) {
                const permalink = this.getRevisionPermalinkUrl(revId);
                text += `Revision: ${revId}${permalink ? ` (${permalink})` : ''}\n`;
            }
            text += `${'='.repeat(60)}\n\n`;

            for (const r of this.getReportUnits()) {
                if (r.isGroup) {
                    const token = (r.groupCitationNumbers || []).map(n => `[${n}]`).join('');
                    text += `${token} (combined) ${r.verdict}\n`;
                    text += `  Claim: ${r.claimText.substring(0, 100)}${r.claimText.length > 100 ? '...' : ''}\n`;
                    const urls = (r.members || []).filter(m => m.url).map(m => `[${m.citationNumber}] ${m.url}`);
                    if (urls.length) text += `  Sources: ${urls.join(' | ')}\n`;
                    if (r.comments) text += `  Comments: ${r.comments}\n`;
                    if (r.truncated && r.verdict !== 'SUPPORTED') text += `  Note: Combined sources are long, only partially checked.\n`;
                } else {
                    text += `[${r.citationNumber}] ${r.verdict}\n`;
                    text += `  Claim: ${r.claimText.substring(0, 100)}${r.claimText.length > 100 ? '...' : ''}\n`;
                    if (r.url) text += `  Source: ${r.url}\n`;
                    if (r.comments) text += `  Comments: ${r.comments}\n`;
                    if (r.truncated && r.verdict !== 'SUPPORTED') text += `  Note: Source is long, only partially checked.\n`;
                }
                text += `\n`;
            }

            if (this.reportTokenUsage.input + this.reportTokenUsage.output > 0) {
                text += `Tokens used: ${this.reportTokenUsage.input.toLocaleString()} input, ${this.reportTokenUsage.output.toLocaleString()} output\n`;
            }

            return text;
        }

        async copyReportToClipboard(format) {
            const text = format === 'wikitext' ? this.generateWikitextReport() : this.generatePlainTextReport();
            try {
                await navigator.clipboard.writeText(text);
                mw.notify('Report copied to clipboard!', { type: 'info', autoHide: true, autoHideSeconds: 3 });
            } catch (e) {
                // Fallback
                const textarea = document.createElement('textarea');
                textarea.value = text;
                document.body.appendChild(textarea);
                textarea.select();
                document.execCommand('copy');
                document.body.removeChild(textarea);
                mw.notify('Report copied to clipboard!', { type: 'info', autoHide: true, autoHideSeconds: 3 });
            }
        }

        async callProviderAPI(claim, sourceInfo) {
            return callProviderAPI(this.currentProvider, { apiKey: this.getCurrentApiKey(), model: this.providers[this.currentProvider].model, systemPrompt: generateSystemPrompt(), userContent: generateUserPrompt(claim, sourceInfo) });
        }

        // Collective (multi-source) variant of callProviderAPI: same provider
        // routing, but the group system prompt and a pre-assembled multi-source
        // user message. `assembledText` comes from assembleGroupSources().
        async callProviderAPIGroup(claim, assembledText) {
            return callProviderAPI(this.currentProvider, { apiKey: this.getCurrentApiKey(), model: this.providers[this.currentProvider].model, systemPrompt: generateGroupSystemPrompt(), userContent: generateGroupUserPrompt(claim, assembledText) });
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
            const byKey = new Map();
            for (const m of members) {
                const cacheKey = m.url
                    ? (m.pageNum ? `${m.url}|page=${m.pageNum}` : m.url)
                    : `__nourl_${m.citationNumber}`;
                let entry = byKey.get(cacheKey);
                if (!entry) {
                    const fetchResult = m.url
                        ? (this.sourceCache.get(cacheKey) || { content: null, error: null, status: null })
                        : { content: null, error: 'No URL found in reference', status: null };
                    entry = {
                        citationNumbers: [],
                        url: m.url || null,
                        content: fetchResult.content,
                        error: fetchResult.error,
                        status: fetchResult.status,
                    };
                    byKey.set(cacheKey, entry);
                }
                entry.citationNumbers.push(m.citationNumber);
            }
            const entries = Array.from(byKey.values());
            const truncated = entries.some(e => e.content && e.content.includes('\nTruncated: true'));
            const { text: assembledText, anyAvailable } = assembleGroupSources(entries);

            // When only one source is available the collective verdict would
            // duplicate the individual per-source result, so skip it.
            const availableCount = entries.filter(e => e.content && extractSourceText(e.content).trim()).length;
            if (availableCount <= 1) {
                this.reportGroupResults.set(groupId, { skipped: true, groupId });
                this.hideGroupCollectiveSlot(groupId);
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
                result = { ...base, verdict: 'SOURCE UNAVAILABLE', confidence: 0, comments: 'None of the grouped sources could be retrieved.' };
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
                                        `Rate limited, retrying in ${Math.round(backoff / 1000)}s...`,
                                        startTime
                                    );
                                }
                            },
                        }
                    );
                    const parsed = this.parseVerificationResult(apiResult.text);
                    this.reportTokenUsage.input += apiResult.usage.input;
                    this.reportTokenUsage.output += apiResult.usage.output;
                    result = { ...base, verdict: parsed.verdict, confidence: parsed.confidence, comments: parsed.comments, reason_type: parsed.reason_type };
                } catch (e) {
                    result = { ...base, verdict: 'ERROR', confidence: null, comments: e.message };
                }
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
        getReportUnits() {
            const units = [];
            const seenGroups = new Set();
            for (const r of this.reportResults) {
                if (r.groupSize && r.groupSize > 1) {
                    if (seenGroups.has(r.groupId)) continue;
                    seenGroups.add(r.groupId);
                    const collective = this.reportGroupResults.get(r.groupId);
                    if (collective && !collective.skipped) {
                        units.push(collective);
                    } else if (collective && collective.skipped) {
                        for (const x of this.reportResults) {
                            if (x.groupId === r.groupId) units.push(x);
                        }
                    }
                } else {
                    units.push(r);
                }
            }
            return units;
        }

        async verifyAllCitations() {
            const citations = this.collectAllCitations();
            if (citations.length === 0) {
                mw.notify('No citations found on this page.', { type: 'warn', autoHide: true });
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
                ? `\n\nThis includes ${multiGroupCount} combined-source check${multiGroupCount === 1 ? '' : 's'} for adjacent citation groups.`
                : '';

            const confirmed = await new Promise(resolve => {
                OO.ui.confirm(
                    `This will verify ${citations.length} citations from ${uniqueUrls.size} unique sources.${groupNote}\n\nEstimated time: ~${estimatedMinutes} minute${estimatedMinutes > 1 ? 's' : ''}.\n\nContinue?`
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
            this.reportRevisionId = mw.config.get('wgCurRevisionId') || null;

            this.showReportView();
            document.getElementById('verifier-report-results').innerHTML = '';
            document.getElementById('verifier-report-summary').innerHTML = '';
            document.getElementById('verifier-report-actions').innerHTML = '';
            this.applyReportFilters();
            this.updateButtonVisibility();

            const startTime = Date.now();
            const useProxy = this.currentProvider === 'publicai';
            const delayBetweenCalls = useProxy ? 3000 : 1000;

            // Progress counts every LLM step: one per citation, plus one
            // collective check per adjacent group. `completed` tracks finished
            // steps so the bar/ETA stay sensible across both phases.
            const progressTotal = citations.length + multiGroupCount;
            let completed = 0;

            for (let i = 0; i < citations.length; i++) {
                if (this.reportCancelled) break;

                const citation = citations[i];
                this.updateReportProgress(completed, progressTotal, `Checking citation [${citation.citationNumber}]`, startTime);

                let result;

                if (!citation.url) {
                    // No URL found
                    result = {
                        citationNumber: citation.citationNumber,
                        claimText: citation.claimText,
                        url: null,
                        refElement: citation.refElement,
                        verdict: 'SOURCE UNAVAILABLE',
                        confidence: 0,
                        comments: 'No URL found in reference',
                        truncated: false
                    };
                } else {
                    // Fetch source if not cached. Cache value is always the
                    // full { content, error, status } shape so retries on the
                    // same URL preserve the diagnostic for the submission link.
                    const cacheKey = citation.pageNum ? `${citation.url}|page=${citation.pageNum}` : citation.url;

                    if (!this.sourceCache.has(cacheKey)) {
                        this.updateReportProgress(completed, progressTotal, `Fetching source for [${citation.citationNumber}]`, startTime);
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
                        const reasonPart = fetchResult.error || 'Could not fetch source content';
                        const comments = statusPart ? `${statusPart}: ${reasonPart}` : reasonPart;
                        result = {
                            citationNumber: citation.citationNumber,
                            claimText: citation.claimText,
                            url: citation.url,
                            refElement: citation.refElement,
                            verdict: 'SOURCE UNAVAILABLE',
                            confidence: 0,
                            comments,
                            fetchStatus: fetchResult.status,
                            fetchError: fetchResult.error,
                            truncated: false
                        };
                    } else {
                        const sourceTruncated = sourceContent.includes('\nTruncated: true');
                        // Verify via LLM. Retry transient failures (429 + 5xx +
                        // network) through the shared core/retry.js helper —
                        // pre-consolidation, this path only retried on 429 and
                        // surfaced 5xx as a hard ERROR even though the benchmark
                        // would have recovered. The [5s, 10s, 20s] backoff curve
                        // is preserved via minBackoffMs/jitterMs, and Cancel
                        // still short-circuits via shouldAbort.
                        this.updateReportProgress(completed, progressTotal, `Verifying citation [${citation.citationNumber}]`, startTime);
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
                                                `Rate limited, retrying in ${Math.round(backoff / 1000)}s...`,
                                                startTime
                                            );
                                        }
                                    },
                                }
                            );
                            const parsed = this.parseVerificationResult(apiResult.text);
                            this.reportTokenUsage.input += apiResult.usage.input;
                            this.reportTokenUsage.output += apiResult.usage.output;
                            result = {
                                citationNumber: citation.citationNumber,
                                claimText: citation.claimText,
                                url: citation.url,
                                refElement: citation.refElement,
                                verdict: parsed.verdict,
                                confidence: parsed.confidence,
                                comments: parsed.comments,
                                reason_type: parsed.reason_type,
                                truncated: sourceTruncated
                            };

                            // Fire-and-forget logging
                            try {
                                const savedCitationNumber = this.activeCitationNumber;
                                const savedSourceUrl = this.activeSourceUrl;
                                this.activeCitationNumber = citation.citationNumber;
                                this.activeSourceUrl = citation.url;
                                this.logVerification(parsed.verdict, parsed.confidence, parsed.reason_type);
                                this.activeCitationNumber = savedCitationNumber;
                                this.activeSourceUrl = savedSourceUrl;
                            } catch (e) {}
                        } catch (e) {
                            result = {
                                citationNumber: citation.citationNumber,
                                claimText: citation.claimText,
                                url: citation.url,
                                refElement: citation.refElement,
                                verdict: 'ERROR',
                                confidence: null,
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
                if (citation.groupSize > 1 && citation.groupIndex === citation.groupSize - 1 && !this.reportCancelled) {
                    const groupToken = (citation.groupCitationNumbers || []).map(n => `[${n}]`).join('');
                    this.updateReportProgress(completed, progressTotal, `Checking combined sources ${groupToken}`, startTime);
                    await this.verifyGroupCollective(citation, citations, startTime, delayBetweenCalls, completed, progressTotal);
                    completed++;
                }
            }

            // Finalize
            this.reportRunning = false;
            const finalPhase = this.reportCancelled
                ? `Cancelled after ${this.reportResults.length} of ${citations.length} citations`
                : `Completed: ${this.reportResults.length} citations checked`;
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
            const summary = 'source does not support claim (checked with [[User:Alaexis/AI_Source_Verification|Source Verifier]])';

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
                    label: 'Edit Section',
                    flags: ['progressive'],
                    icon: 'edit',
                    href: this.buildEditUrl(),
                    target: '_blank'
                });
                container.appendChild(btn.$element[0]);
            }

            if (verdict && verdict !== 'ERROR' && this.isDatasetSubmissionConfigured()) {
                const submitBtn = this.buildSubmitToDatasetButton({
                    citationNumber: this.activeCitationNumber,
                    claimText: this.activeClaim,
                    url: this.activeSourceUrl,
                    verdict,
                    comments,
                });
                container.appendChild(submitBtn.$element[0]);
            }
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
                llmProvider: result?.providerName ?? provider.name ?? '',
                llmModel: result?.model ?? provider.model ?? '',
                fetchStatus: result?.fetchStatus ?? '',
            });
        }

        buildSubmitToDatasetButton(result, { label = 'Give feedback' } = {}) {
            return new OO.ui.ButtonWidget({
                label,
                icon: 'feedback',
                framed: false,
                href: this.buildDatasetSubmissionUrl(result),
                target: '_blank',
            });
        }

        clearResult() {
            const verdictEl = document.getElementById('verifier-verdict');
            const commentsEl = document.getElementById('verifier-comments');

            if (verdictEl) {
                verdictEl.textContent = '';
                verdictEl.className = '';
            }
            if (commentsEl) {
                commentsEl.textContent = 'Click "Verify Claim" to verify the selected claim against the source.';
            }
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
            indicatorEl.innerHTML = `Part of a group of ${group.length} citations: ${numbers}`;
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
