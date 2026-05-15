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
    return `You are a fact-checking assistant for Wikipedia. Verify whether claims are supported by the provided source text.

Use this two-step process for every claim:

STEP 1 — Source check (provenance):
Determine whether the source text contains usable article body content.

The source text may begin with a JSON metadata block (publication, author, published date, title, url) followed by a '---' separator and then the article body. This metadata is PROVENANCE only — it confirms the article exists and was published, but it is NOT itself evidence about the claim's content. Step 1 evaluates the article body, which is everything after the '---' separator (or the entire source text if no metadata block is present).

The article body is usable if it contains real article content: paragraphs, quotes, narrative passages, or factual statements. This is true even when surrounded by navigation, headers, footers, captures from web.archive.org, or other page chrome.

The article body is NOT usable if it contains only:
- A library catalog or database metadata (Google Books, WorldCat, JSTOR previews)
- A paywall, login wall, 404 page, cookie consent notice, or JavaScript error
- Bibliographic metadata only (publication name, title, date, author) without article body content
- Just the metadata block at the top with no body content following

If Step 1 fails, return verdict SOURCE UNAVAILABLE. Do not attempt Step 2.

STEP 2 — Claim verification:
If Step 1 passes, identify what the claim asserts (specific dates, numbers, names, events, attributions). Then look in the article body for support, contradiction, or partial coverage.

Rules:
- ONLY use the article body. The metadata block is provenance, NOT evidence about the claim's content. NEVER use outside knowledge.
- The metadata IS evidence only if the claim is specifically about provenance — that is, who published it (matches metadata 'publication'), who wrote it (matches 'author'), or when it was published (matches 'published'). For all other claims, the body must contain the specific assertion.
- For claims with dates: the body must contain the date in some form. Equivalent expressions count — "Wednesday" supports a "January 7, 2026" claim if the article is dated January 7, 2026; abbreviated formats like "7 Jan 2026" count as evidence for "7 January 2026".
- For claims with specific numbers, names, or quoted statements: the body must contain that specific number/name/quote, or a directly equivalent paraphrase.
- Accept paraphrasing and direct implications, but not speculative inferences or logical leaps.
- Distinguish definitive statements from hedged language ("it is believed", "some sources suggest"). Claims stated as facts require body text that makes definitive statements.
- Names from non-Latin scripts (Arabic, Chinese, Japanese, Korean, Russian, Hindi, etc.) may have multiple valid romanizations. "Yasmin"/"Yazmeen", "Chekhov"/"Tchekhov" are variant spellings of the same name; do not treat transliteration differences as factual errors.

Choose ONE verdict based on what the article body says (NOT how confident you feel):

- SUPPORTED: The article body contains all of the claim's specific assertions. Paraphrasing OK if substance matches.
- PARTIALLY SUPPORTED: The article body addresses the claim but contains only some of its specific assertions, OR makes the assertion only with hedged/uncertain language.
- NOT SUPPORTED: The article body addresses the claim's topic but contradicts it, or has no evidence for the claim's specific assertions despite covering the same general subject.
- SOURCE UNAVAILABLE: Step 1 failed — no usable article body content.

Respond in JSON format:
{
  "verdict": "<SUPPORTED | PARTIALLY SUPPORTED | NOT SUPPORTED | SOURCE UNAVAILABLE>",
  "comments": "<direct quote from article body, then brief explanation>"
}

<example>
Claim: "The committee published its findings in 1932."
Source text: "History of Modern Economics - Economic Research Council - Google Books Sign in Hidden fields Books Try the new Google Books Check out the new look and enjoy easier access to your favorite features Try it now No thanks My library Help Advanced Book Search"

{"verdict": "SOURCE UNAVAILABLE", "comments": "Google Books interface only — no article body content to verify the claim against."}
</example>

<example>
Claim: "The bridge was completed in 1998."
Source text: "Skip to main content Web Archive toolbar... Capture date: 2015-03-12 ... City Tribune - Local News ... The Morrison Bridge project broke ground in 1994 after years of planning. Construction faced multiple delays due to funding shortages. The bridge was finally opened to traffic in August 2002, four years behind schedule. Mayor Davis called it 'a triumph of persistence.'"

{"verdict": "NOT SUPPORTED", "comments": "Body: 'finally opened to traffic in August 2002, four years behind schedule.' Body addresses the bridge's completion but contradicts 1998."}
</example>

<example>
Claim: "The company was founded in 1985 by John Smith."
Source text: "Acme Corp was established in 1985. Its founder, John Smith, served as CEO until 2001."

{"verdict": "SUPPORTED", "comments": "Body: 'Acme Corp was established in 1985. Its founder, John Smith.' Both 1985 founding and John Smith as founder match."}
</example>

<example>
Claim: "The treaty was signed by 45 countries."
Source text: "The treaty, finalized in March, was signed by over 30 nations, though the exact number remains disputed."

{"verdict": "NOT SUPPORTED", "comments": "Body: 'signed by over 30 nations.' Body addresses signatory count but says 'over 30,' not 45."}
</example>

<example>
Claim: "The treaty was signed in Paris."
Source text: "It is believed the treaty was signed in Paris, though some historians dispute this."

{"verdict": "PARTIALLY SUPPORTED", "comments": "Body: 'It is believed the treaty was signed in Paris, though some historians dispute this.' Body hedges this as uncertain; claim states it as fact."}
</example>

<example>
Claim: "The population increased by 12% between 2010 and 2020."
Source text: "Census data shows significant population growth in the region during the 2010s."

{"verdict": "PARTIALLY SUPPORTED", "comments": "Body: 'significant population growth in the region during the 2010s.' Body confirms growth but does not specify 12%."}
</example>

<example>
Claim: "On 7 January 2026, Yemeni government forces captured Aden."
Source text: "{
  \\"source_citation_metadata\\": {
    \\"publication\\": \\"Al Jazeera\\",
    \\"published\\": \\"2026-01-07\\",
    \\"title\\": \\"Saudi-led coalition strikes Yemen\\"
  }
}

---

Saudi-backed forces move on Aden as Yemen secessionist leader vanishes | News | Al Jazeera ... Published On 7 Jan 2026 ... Saudi-backed ground forces on Wednesday moved on the Yemeni city of Aden, a stronghold of the southern secessionists."

{"verdict": "SUPPORTED", "comments": "Body: 'Published On 7 Jan 2026 ... Saudi-backed ground forces on Wednesday moved on the Yemeni city of Aden.' Body contains both the date (in abbreviated form) and the event."}
</example>

<example>
Claim: "The Wildlife Area has logged the sighting of more than 280 species of birds."
Source text: "{
  \\"source_citation_metadata\\": {
    \\"publication\\": \\"Nature Reserve of Orange County\\",
    \\"title\\": \\"Wildlife Area Overview\\"
  }
}

---

The Wildlife Area is managed as part of the Nature Reserve of Orange County. With both water and upland dry parcels for habitat, the Wildlife Area has logged the sighting of many bird species over the years. The area also supports field instruction and ecological research."

{"verdict": "PARTIALLY SUPPORTED", "comments": "Body: 'has logged the sighting of many bird species.' Body addresses bird species sightings but says 'many' — does not confirm the specific number 280. Metadata is provenance only and contains no species count."}
</example>

<example>
Claim: "According to The New Yorker, Bettencourt resigned in December 2008."
Source text: "{
  \\"source_citation_metadata\\": {
    \\"publication\\": \\"The New Yorker\\",
    \\"published\\": \\"2008-12-15\\",
    \\"title\\": \\"Texas Tax Assessor Steps Down\\"
  }
}

---

Bettencourt's resignation came after months of speculation. The decision shocked many in the Texas political world. He decided to step down shortly after winning re-election."

{"verdict": "SUPPORTED", "comments": "Metadata: publication = 'The New Yorker', published = '2008-12-15' — both match the claim's provenance assertion (in The New Yorker, December 2008). Body confirms Bettencourt resigned. Both provenance and content elements verified."}
</example>

<example>
Claim: "The president resigned on March 3."
Source text: "The president remained in office throughout March."

{"verdict": "NOT SUPPORTED", "comments": "Body: 'remained in office throughout March.' Body directly contradicts the claim of a March 3 resignation."}
</example>`;
}

/**
 * Parses source info and generates the user message
 * @param {string} claim - The claim to verify
 * @param {string} sourceInfo - The source information
 * @returns {string} The user message content
 */
function generateUserPrompt(claim, sourceInfo) {
    let sourceText;

    if (sourceInfo.startsWith('Manual source text:')) {
        sourceText = sourceInfo.replace(/^Manual source text:\s*\n\s*/, '');
    } else if (sourceInfo.includes('Source Content:')) {
        const contentMatch = sourceInfo.match(/Source Content:\n([\s\S]*)/);
        sourceText = contentMatch ? contentMatch[1] : sourceInfo;
    } else {
        sourceText = sourceInfo;
    }

    console.log('[Verifier] Source text (first 2000 chars):', sourceText.substring(0, 2000));

    return `Claim: "${claim}"

Source text:
${sourceText}`;
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

const FALLBACK_VERDICT_PATTERNS = [
    { prefix: 'NOT SUPPORTED',      canonical: 'NOT SUPPORTED' },
    { prefix: 'PARTIALLY',          canonical: 'PARTIALLY SUPPORTED' },
    { prefix: 'SOURCE UNAVAILABLE', canonical: 'SOURCE UNAVAILABLE' },
    { prefix: 'UNAVAILABLE',        canonical: 'SOURCE UNAVAILABLE' },
    { prefix: 'SUPPORTED',          canonical: 'SUPPORTED' },
];

function canonicalizeFallbackVerdict(raw) {
    const v = raw.toUpperCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
    for (const { prefix, canonical } of FALLBACK_VERDICT_PATTERNS) {
        if (v.startsWith(prefix)) return canonical;
    }
    return null;
}

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
            comments: result.comments || ''
        };
    } catch (e) {
        // fall through to the markdown-emphasis recovery
    }

    // Strip "**" and "__"-style emphasis so e.g. "**Verdict:** SUPPORTED"
    // becomes "Verdict: SUPPORTED", then capture the canonical word(s).
    const stripped = trimmed.replace(/\*+|__+/g, '');
    const match = stripped.match(/verdict[\s:"']+([A-Z][A-Z _]*)/i);
    if (match) {
        const verdict = canonicalizeFallbackVerdict(match[1]);
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

// --- core/urls.js ---
// URL extraction helpers for Wikipedia reference elements.
// extractReferenceUrl and extractPageNumber accept a `document` parameter
// for Node callers (CLI, tests). They fall back to `globalThis.document`
// when called without one — that's the userscript path, where the browser
// supplies the global.

function extractHttpUrl(element) {
    if (!element) return null;
    // First look for archive links (prioritize these)
    const archiveLink = element.querySelector('a[href*="web.archive.org"], a[href*="archive.today"], a[href*="archive.is"], a[href*="archive.ph"], a[href*="webcitation.org"]');
    if (archiveLink) return archiveLink.href;

    // Fall back to any http link
    const links = element.querySelectorAll('a[href^="http"]');
    if (links.length === 0) return null;
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

// --- core/citoid.js ---
// Pure Citoid metadata fetching + header prepending. Imported by core/ consumers
// (benchmark, userscript). Browser-safe — uses the standard `fetch` API only.
// Also injected byte-identically into main.js between <core-injected> markers.

const CITOID_ENDPOINT = 'https://en.wikipedia.org/api/rest_v1/data/citation/mediawiki-basefields/';
const DEFAULT_USER_AGENT = 'citation-checker-script/1.0 (+https://github.com/alex-o-748/citation-checker-script)';
const DEFAULT_TIMEOUT_MS = 10000;

/**
 * Fetch Citoid metadata for a source URL. Returns the first translator entry
 * (Citoid returns a JSON array; we use element [0]) or null on any failure.
 *
 * Citoid's `mediawiki-basefields` format returns Zotero base fields, which is
 * more consistent across source types than the bare `mediawiki` format.
 *
 * @param {string} sourceUrl - URL to look up.
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=10000] - Per-request timeout.
 * @param {string} [opts.userAgent] - User-Agent header. Wikimedia's rate-limit
 *   policy is more lenient with identifying user-agents.
 * @returns {Promise<object|null>}
 */
async function fetchCitoidMetadata(sourceUrl, opts = {}) {
    if (!sourceUrl) return null;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
    const url = CITOID_ENDPOINT + encodeURIComponent(sourceUrl);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, {
            headers: { 'User-Agent': userAgent },
            signal: controller.signal,
        });
        clearTimeout(timer);
        if (!response.ok) return null;
        const data = await response.json();
        return Array.isArray(data) && data.length > 0 ? data[0] : null;
    } catch (e) {
        clearTimeout(timer);
        return null;
    }
}

/**
 * Build the 5-field metadata header from Citoid data. Returns null if no
 * meaningful fields are populated (in which case no header should be prepended).
 *
 * Field selection is deliberately minimal — `publication`, `published`,
 * `author`, `title`, `url`. Excluded fields (abstractNote, accessDate, ISSN,
 * DOI, libraryCatalog, etc.) either duplicate body content or contribute no
 * claim-verification signal.
 *
 * @param {object|null} citoidData - Result of fetchCitoidMetadata.
 * @param {string} sourceUrl - Echoed into the header for the model's convenience.
 * @returns {object|null} Header object, or null if no meaningful fields.
 */
function buildCitoidHeader(citoidData, sourceUrl) {
    if (!citoidData) return null;
    const header = {};

    if (citoidData.publicationTitle) {
        header.publication = String(citoidData.publicationTitle).trim();
    } else if (citoidData.websiteTitle) {
        header.publication = String(citoidData.websiteTitle).trim();
    }

    if (citoidData.date) {
        const d = String(citoidData.date).trim();
        if (d) header.published = d;
    }

    // Citoid returns author/creators as arrays of [first, last] pairs.
    const authorArray = Array.isArray(citoidData.author) ? citoidData.author
        : Array.isArray(citoidData.creators) ? citoidData.creators
        : null;
    if (authorArray) {
        const formatted = authorArray
            .filter(a => Array.isArray(a) && a.length >= 2)
            .map(([first, last]) => `${first} ${last}`.trim())
            .filter(s => s.length > 0)
            .join(', ');
        if (formatted) header.author = formatted;
    }

    if (citoidData.title) {
        const t = String(citoidData.title).trim();
        if (t) header.title = t;
    }

    header.url = sourceUrl;

    // Suppress headers that have nothing useful (URL alone is not enough — we
    // do not want to teach the model that the metadata block existing means
    // anything special when no actual provenance fields were extracted).
    const hasMeaningful = header.publication || header.published || header.author || header.title;
    if (!hasMeaningful) return null;
    return header;
}

/**
 * Prepend a metadata header to source text using the canonical format:
 * pretty-printed JSON block, blank line, '---' separator, blank line, body.
 *
 * If the header is null, returns the source text unchanged.
 *
 * @param {object|null} header - Result of buildCitoidHeader.
 * @param {string} sourceText - The article body text.
 * @returns {string}
 */
function prependMetadataHeader(header, sourceText) {
    if (!header) return sourceText;
    const headerJson = JSON.stringify({ source_citation_metadata: header }, null, 2);
    return `${headerJson}\n\n---\n\n${sourceText}`;
}

/**
 * Convenience: fetch Citoid metadata and prepend the header to source text in
 * one call. On any Citoid failure (timeout, 4xx, network error, empty data,
 * no useful fields) the source text is returned unchanged — Citoid is purely
 * additive and never blocks verification.
 *
 * @param {string} sourceText - The article body text.
 * @param {string} sourceUrl - URL the source text was fetched from.
 * @param {object} [opts] - Forwarded to fetchCitoidMetadata.
 * @returns {Promise<string>} Augmented source text (or original on failure).
 */
async function augmentWithCitoid(sourceText, sourceUrl, opts = {}) {
    const citoid = await fetchCitoidMetadata(sourceUrl, opts);
    const header = buildCitoidHeader(citoid, sourceUrl);
    return prependMetadataHeader(header, sourceText);
}

// --- core/providers.js ---
// LLM provider dispatch. Pure HTTP routing — callers build the prompt.

// Shared call shape for OpenAI-compatible chat-completion upstreams.
// Used by PublicAI/HF (proxy-routed; key injected upstream), HF when the
// caller supplies their own bearer token (direct call to the HF router),
// OpenRouter (which adds attribution headers and surfaces per-call cost),
// and the benchmark runner (which calls direct PublicAI/OpenAI endpoints
// with bearer auth from environment variables).
async function callOpenAICompatibleChat({ url, apiKey, model, systemPrompt, userContent, label, extraHeaders, extraBody, maxTokens = 2048, temperature = 0.1 }) {
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
async function callOpenRouterAPI({ apiKey, model, systemPrompt, userContent, maxTokens, temperature, extraBody }) {
    return callOpenAICompatibleChat({
        url: 'https://openrouter.ai/api/v1/chat/completions',
        apiKey,
        model, systemPrompt, userContent, maxTokens, temperature, extraBody,
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


async function fetchSourceContent(url, pageNum, { workerBase = 'https://publicai-proxy.alaexis.workers.dev', augment = true } = {}) {
    if (isGoogleBooksUrl(url)) {
        console.log('[CitationVerifier] Skipping Google Books URL:', url);
        return null;
    }

    try {
        let proxyUrl = `${workerBase}/?fetch=${encodeURIComponent(url)}`;
        if (pageNum) {
            proxyUrl += `&page=${pageNum}`;
        }
        const response = await fetch(proxyUrl);
        const data = await response.json();

        if (data.error) {
            console.warn('[CitationVerifier] Proxy error:', data.error);
            return null;
        }

        if (data.content && data.content.length > 100) {
            // Proxy caps fetched content around 12k chars. If we're at or
            // above that, the source was almost certainly truncated and
            // only partially sent to the model.
            const isTruncated = data.truncated === true || data.content.length >= 12000;
            let meta = `Source URL: ${url}`;
            if (data.pdf) {
                meta += `\nPDF: ${data.totalPages} pages`;
                if (data.page) {
                    meta += ` (extracted page ${data.page})`;
                }
            }
            if (isTruncated) {
                meta += `\nTruncated: true`;
            }
            const body = augment ? await augmentWithCitoid(data.content, url) : data.content;
            return `${meta}\n\nSource Content:\n${body}`;
        }

        // If PDF was large and we didn't request a specific page, retry
        // with the citation page if available
        if (data.pdf && !pageNum && data.totalPages > 15) {
            console.log('[CitationVerifier] Large PDF without page param, content may be truncated');
        }
    } catch (error) {
        console.error('Proxy fetch failed:', error);
    }
    return null; // Falls back to manual input
}

function logVerification(payload, { workerBase = 'https://publicai-proxy.alaexis.workers.dev' } = {}) {
    // Wrap the fetch POST in try/catch exactly as main.js does.
    // `payload` replaces the constructed object in main.js — caller supplies
    //   { article_url, article_title, citation_number, source_url, provider, verdict, confidence }.
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
            await mw.loader.using(['oojs-ui-core', 'oojs-ui-widgets', 'oojs-ui-windows']);
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
                .verifier-filter-chip.hidden {
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
                html.skin-theme-clientpref-night .verifier-report-group-row {
                    background: #1a1a2e !important;
                    border-color: #3a3a4e !important;
                    color: #e0e0e0 !important;
                }
                html.skin-theme-clientpref-night .verifier-report-group-claim {
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
                html.skin-theme-clientpref-night .verifier-filter-chip.hidden {
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
                    html.skin-theme-clientpref-os .verifier-filter-chip.hidden {
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
            if (typeof mw !== 'undefined' && [0, 118].includes(mw.config.get('wgNamespaceNumber'))) {
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
                const sourceInfo = await this.fetchSourceContent(refUrl, pageNum);

                if (fetchId !== this.currentFetchId) {
                    return;
                }

                if (!sourceInfo) {
                    this.showSourceTextInput();
                    this.updateStatus('Could not fetch source. Please paste the source text below.');
                    return;
                }

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

        logVerification(verdict, confidence) {
            logVerification({
                article_url: window.location.href,
                article_title: typeof mw !== 'undefined' ? mw.config.get('wgTitle') : document.title,
                citation_number: this.activeCitationNumber,
                source_url: this.activeSourceUrl,
                provider: this.currentProvider,
                verdict: verdict,
                confidence: confidence,
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
                    this.logVerification(parsed.verdict, parsed.confidence);
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

	    commentsEl.textContent = result.comments;
	    console.log('[Verifier] Verdict for action button:', JSON.stringify(result.verdict));
	    this.showActionButton(result.verdict);
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

            // Group blocks are visible iff at least one of their rows has a
            // verdict whose chip is currently enabled. Inside a visible
            // group, every row stays visible regardless of its verdict — the
            // user needs to see how each source contributed to decide
            // whether collective coverage is adequate.
            const groups = resultsEl.querySelectorAll('.verifier-report-group');
            groups.forEach(groupEl => {
                const rows = groupEl.querySelectorAll('.verifier-report-group-row');
                const hasVisibleRow = Array.from(rows).some(row => {
                    const verdictClass = classes.find(cls => row.classList.contains(`verdict-${cls}`));
                    return verdictClass && !this.reportFilters[verdictClass];
                });
                groupEl.style.display = hasVisibleRow ? '' : 'none';
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

            const counts = { supported: 0, partial: 0, 'not-supported': 0, unavailable: 0, error: 0 };
            for (const r of this.reportResults) {
                if (r.verdict === 'SUPPORTED') counts.supported++;
                else if (r.verdict === 'PARTIALLY SUPPORTED') counts.partial++;
                else if (r.verdict === 'NOT SUPPORTED') counts['not-supported']++;
                else if (r.verdict === 'SOURCE UNAVAILABLE') counts.unavailable++;
                else counts.error++;
            }
            const total = this.reportResults.length;

            const segHtml = (count, cls) => count > 0 ? `<div class="${cls}" style="width:${(count/total)*100}%"></div>` : '';

            const chip = (key, count, label, color) => {
                const hidden = !!this.reportFilters[key];
                return `<button type="button"
                    class="verifier-filter-chip${hidden ? ' hidden' : ''}"
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

            // Count distinct claims (groups). Solo citations are 1-member
            // groups, so total claims = number of distinct groupIds among
            // the results so far.
            const claimIds = new Set();
            for (const r of this.reportResults) {
                claimIds.add(r.groupId || r.refId || `__solo_${claimIds.size}`);
            }
            const claimCount = claimIds.size;
            const claimsLabel = claimCount === total
                ? `${total} citations checked`
                : `${total} citations across ${claimCount} claim${claimCount === 1 ? '' : 's'}`;

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
                if (e.target.closest('.report-card-action') || e.target.closest('.verifier-report-group-edit')) return;
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
            card.innerHTML = `
                <div class="report-card-header">
                    <span class="report-card-citation">[${result.citationNumber}]</span>
                    <span class="report-card-verdict ${verdictClass}">${verdictLabel}</span>
                </div>
                <div class="report-card-claim">${this.escapeHtml(claimExcerpt)}</div>
                ${result.comments ? `<div class="report-card-comment">${this.escapeHtml(result.comments)}</div>` : ''}
                ${truncationHtml}
            `;

            this.attachRefScrollHandler(card, result.refElement);

            if (result.refElement && (result.verdict === 'NOT SUPPORTED' || result.verdict === 'PARTIALLY SUPPORTED' || result.verdict === 'SOURCE UNAVAILABLE')) {
                const actionDiv = document.createElement('div');
                actionDiv.className = 'report-card-action';
                const editBtn = new OO.ui.ButtonWidget({
                    label: 'Edit Section',
                    flags: ['progressive'],
                    icon: 'edit',
                    href: this.buildEditUrl(result.refElement),
                    target: '_blank',
                    framed: false
                });
                actionDiv.appendChild(editBtn.$element[0]);
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
                    <div class="verifier-report-group-edit"></div>
                </div>
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

        buildGroupRow(result) {
            const { cls: verdictClass, label: verdictLabel } = this.verdictClassFor(result.verdict);
            const row = document.createElement('div');
            row.className = `verifier-report-group-row verdict-${verdictClass}`;
            const truncationHtml = (result.truncated && result.verdict !== 'SUPPORTED')
                ? '<div class="report-card-truncated">⚠ Source is long, only partially checked.</div>'
                : '';
            row.innerHTML = `
                <div class="verifier-report-group-row-header">
                    <span class="report-card-citation">[${result.citationNumber}]</span>
                    <span class="report-card-verdict ${verdictClass}">${verdictLabel}</span>
                </div>
                ${result.comments ? `<div class="report-card-comment">${this.escapeHtml(result.comments)}</div>` : ''}
                ${truncationHtml}
            `;
            this.attachRefScrollHandler(row, result.refElement);
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
            wikitext += `{| class="wikitable sortable"\n`;
            wikitext += `|-\n! # !! Verdict !! Source !! Comments\n`;

            for (const r of this.reportResults) {
                let verdictWiki;
                switch (r.verdict) {
                    case 'SUPPORTED': verdictWiki = '{{tick}} Supported'; break;
                    case 'PARTIALLY SUPPORTED': verdictWiki = '{{bang}} Partially supported'; break;
                    case 'NOT SUPPORTED': verdictWiki = '{{cross}} Not supported'; break;
                    case 'SOURCE UNAVAILABLE': verdictWiki = '{{hmmm}} Source unavailable'; break;
                    default: verdictWiki = r.verdict; break;
                }
                const sourceStr = r.url ? `[${r.url} source]` : '—';
                let commentsClean = (r.comments || '').replace(/\n/g, ' ');
                if (r.truncated && r.verdict !== 'SUPPORTED') {
                    commentsClean += (commentsClean ? ' ' : '') + "''(Source is long, only partially checked.)''";
                }
                // Link the citation number to the footnote anchor on the analyzed revision,
                // so clicks from the report jump to the original citation even after later edits
                // have shifted citation numbering. HTML entities are used for the square brackets
                // in the display text so they don't confuse MediaWiki's wikilink parser.
                const refHref = r.refElement && r.refElement.getAttribute('href');
                const refAnchor = refHref && refHref.startsWith('#') ? refHref.substring(1) : null;
                let citationCell = (revId && refAnchor)
                    ? `[[Special:PermanentLink/${revId}#${refAnchor}|&#91;${r.citationNumber}&#93;]]`
                    : `[${r.citationNumber}]`;
                // Flag grouped citations so editors reading the wikitext can
                // see which rows belong to the same multi-source claim. Using
                // a group token rather than rowspan keeps the table sortable.
                if (r.groupSize && r.groupSize > 1 && r.groupCitationNumbers) {
                    const groupToken = r.groupCitationNumbers.map(n => `[${n}]`).join('');
                    citationCell += ` <small>(group ${groupToken})</small>`;
                }
                wikitext += `|-\n| ${citationCell} || ${verdictWiki} || ${sourceStr} || ${commentsClean}\n`;
            }

            wikitext += `|}\n\n`;

            const counts = { supported: 0, partial: 0, notSupported: 0, unavailable: 0 };
            for (const r of this.reportResults) {
                if (r.verdict === 'SUPPORTED') counts.supported++;
                else if (r.verdict === 'PARTIALLY SUPPORTED') counts.partial++;
                else if (r.verdict === 'NOT SUPPORTED') counts.notSupported++;
                else counts.unavailable++;
            }
            wikitext += `'''Summary:''' ${counts.supported} supported, ${counts.partial} partially supported, ${counts.notSupported} not supported, ${counts.unavailable} source unavailable out of ${this.reportResults.length} citations.\n`;

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

            for (const r of this.reportResults) {
                text += `[${r.citationNumber}] ${r.verdict}\n`;
                text += `  Claim: ${r.claimText.substring(0, 100)}${r.claimText.length > 100 ? '...' : ''}\n`;
                if (r.url) text += `  Source: ${r.url}\n`;
                if (r.comments) text += `  Comments: ${r.comments}\n`;
                if (r.truncated && r.verdict !== 'SUPPORTED') text += `  Note: Source is long, only partially checked.\n`;
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

        async verifyAllCitations() {
            const citations = this.collectAllCitations();
            if (citations.length === 0) {
                mw.notify('No citations found on this page.', { type: 'warn', autoHide: true });
                return;
            }

            // Estimate time and show confirmation
            const uniqueUrls = new Set(citations.filter(c => c.url).map(c => c.url));
            const estimatedSeconds = citations.length * 7;
            const estimatedMinutes = Math.ceil(estimatedSeconds / 60);

            const confirmed = await new Promise(resolve => {
                OO.ui.confirm(
                    `This will verify ${citations.length} citations from ${uniqueUrls.size} unique sources.\n\nEstimated time: ~${estimatedMinutes} minute${estimatedMinutes > 1 ? 's' : ''}.\n\nContinue?`
                ).done(result => resolve(result));
            });
            if (!confirmed) return;

            // Setup
            this.reportMode = true;
            this.reportRunning = true;
            this.reportCancelled = false;
            this.reportResults = [];
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

            for (let i = 0; i < citations.length; i++) {
                if (this.reportCancelled) break;

                const citation = citations[i];
                this.updateReportProgress(i, citations.length, `Checking citation [${citation.citationNumber}]`, startTime);

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
                    // Fetch source if not cached
                    const cacheKey = citation.pageNum ? `${citation.url}|page=${citation.pageNum}` : citation.url;

                    if (!this.sourceCache.has(cacheKey)) {
                        this.updateReportProgress(i, citations.length, `Fetching source for [${citation.citationNumber}]`, startTime);
                        try {
                            const sourceContent = await this.fetchSourceContent(citation.url, citation.pageNum);
                            this.sourceCache.set(cacheKey, sourceContent);
                        } catch (e) {
                            this.sourceCache.set(cacheKey, null);
                        }
                        // Rate limit delay after fetch
                        if (!this.reportCancelled) {
                            await new Promise(r => setTimeout(r, delayBetweenCalls));
                        }
                    }

                    if (this.reportCancelled) break;

                    const sourceContent = this.sourceCache.get(cacheKey);

                    if (!sourceContent) {
                        result = {
                            citationNumber: citation.citationNumber,
                            claimText: citation.claimText,
                            url: citation.url,
                            refElement: citation.refElement,
                            verdict: 'SOURCE UNAVAILABLE',
                            confidence: 0,
                            comments: 'Could not fetch source content',
                            truncated: false
                        };
                    } else {
                        const sourceTruncated = sourceContent.includes('\nTruncated: true');
                        // Verify via LLM
                        this.updateReportProgress(i, citations.length, `Verifying citation [${citation.citationNumber}]`, startTime);
                        try {
                            const apiResult = await this.callProviderAPI(citation.claimText, sourceContent);
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
                                truncated: sourceTruncated
                            };

                            // Fire-and-forget logging
                            try {
                                const savedCitationNumber = this.activeCitationNumber;
                                const savedSourceUrl = this.activeSourceUrl;
                                this.activeCitationNumber = citation.citationNumber;
                                this.activeSourceUrl = citation.url;
                                this.logVerification(parsed.verdict, parsed.confidence);
                                this.activeCitationNumber = savedCitationNumber;
                                this.activeSourceUrl = savedSourceUrl;
                            } catch (e) {}
                        } catch (e) {
                            // Check for rate limiting (429)
                            let retried = false;
                            if (e.message && e.message.includes('429')) {
                                for (let attempt = 0; attempt < 3; attempt++) {
                                    if (this.reportCancelled) break;
                                    const backoff = [5000, 10000, 20000][attempt];
                                    this.updateReportProgress(i, citations.length, `Rate limited, retrying in ${backoff/1000}s...`, startTime);
                                    await new Promise(r => setTimeout(r, backoff));
                                    try {
                                        const retryApiResult = await this.callProviderAPI(citation.claimText, sourceContent);
                                        const parsed = this.parseVerificationResult(retryApiResult.text);
                                        this.reportTokenUsage.input += retryApiResult.usage.input;
                                        this.reportTokenUsage.output += retryApiResult.usage.output;
                                        result = {
                                            citationNumber: citation.citationNumber,
                                            claimText: citation.claimText,
                                            url: citation.url,
                                            refElement: citation.refElement,
                                            verdict: parsed.verdict,
                                            confidence: parsed.confidence,
                                            comments: parsed.comments,
                                            truncated: sourceTruncated
                                        };
                                        retried = true;
                                        break;
                                    } catch (retryErr) {
                                        if (!retryErr.message?.includes('429')) {
                                            break;
                                        }
                                    }
                                }
                            }
                            if (!retried) {
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
                    this.reportResults.push(result);
                    this.renderReportCard(result, this.reportResults.length - 1);
                    this.renderReportSummary();
                    this.applyReportFilters();
                }
            }

            // Finalize
            this.reportRunning = false;
            const finalPhase = this.reportCancelled
                ? `Cancelled after ${this.reportResults.length} of ${citations.length} citations`
                : `Completed: ${this.reportResults.length} citations checked`;
            this.updateReportProgress(this.reportResults.length, citations.length, finalPhase, startTime);
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


        showActionButton(verdict) {
            const container = document.getElementById('verifier-action-container');
            if (!container) return;

            container.innerHTML = '';

            if (verdict !== 'NOT SUPPORTED' && verdict !== 'PARTIALLY SUPPORTED' && verdict !== 'SOURCE UNAVAILABLE') return;

            const btn = new OO.ui.ButtonWidget({
                label: 'Edit Section',
                flags: ['progressive'],
                icon: 'edit',
                href: this.buildEditUrl(),
                target: '_blank'
            });

            container.appendChild(btn.$element[0]);
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
    
    if (typeof mw !== 'undefined' && [0, 118].includes(mw.config.get('wgNamespaceNumber'))) {
        mw.loader.using(['mediawiki.util', 'mediawiki.api', 'oojs-ui-core', 'oojs-ui-widgets', 'oojs-ui-windows']).then(function() {
            $(function() {
                new WikipediaSourceVerifier();
            });
        });
    }
})();
