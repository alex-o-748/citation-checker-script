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
export async function fetchCitoidMetadata(sourceUrl, opts = {}) {
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
export function buildCitoidHeader(citoidData, sourceUrl) {
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
export function prependMetadataHeader(header, sourceText) {
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
export async function augmentWithCitoid(sourceText, sourceUrl, opts = {}) {
    const citoid = await fetchCitoidMetadata(sourceUrl, opts);
    const header = buildCitoidHeader(citoid, sourceUrl);
    return prependMetadataHeader(header, sourceText);
}
