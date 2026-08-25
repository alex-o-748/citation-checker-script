// Extracts the prose claim text bearing a given citation from a parsed
// Wikipedia Document. Works with both browser DOM and JSDOM.

export const MAINTENANCE_MARKER_RE = /\[(failed verification|verification needed|citation needed|better source[^\]]*|dubious[^\]]*|unreliable source[^\]]*|clarification needed|disputed[^\]]*|page needed|when\??|where\??|who\??|why\??|by whom\??|according to whom\??|original research[^\]]*|specify[^\]]*|vague|opinion|fact)\]/gi;

// True iff the DOM range strictly between two .reference wrapper elements (in
// document order: refA before refB) contains no non-whitespace text. This is
// the rule that defines whether two adjacent citations attach to the same
// claim — a comma or any other punctuation between them counts as text and
// breaks the group.
export function hasTextBetween(refA, refB) {
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
export function getCitationGroup(refElement) {
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
export function lastSentence(text) {
    if (!text) return text;
    const parts = text.split(SENTENCE_SPLIT_RE);
    return parts[parts.length - 1].trim();
}

export function extractClaimText(refElement, { scope = 'paragraph' } = {}) {
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
