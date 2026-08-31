// Extracts the prose claim text bearing a given citation from a parsed
// Wikipedia Document. Works with both browser DOM and JSDOM.

export const MAINTENANCE_MARKER_RE = /\[(failed verification|verification needed|citation needed|better source[^\]]*|dubious[^\]]*|unreliable source[^\]]*|clarification needed|disputed[^\]]*|page needed|when\??|where\??|who\??|why\??|by whom\??|according to whom\??|original research[^\]]*|specify[^\]]*|vague|opinion|fact)\]/gi;

const TEXT_NODE = 3;

// --- Text-between-two-points, without Range -------------------------------
//
// This file used to express "the text between these two nodes" with a DOM
// Range (setStartAfter / setEndBefore / toString). That reads well and is fast
// in a browser, where Range is native. Under JSDOM — which is what the batch
// runner and the benchmark use — it is quadratic in the size of the article:
// Range.toString() tests every text node for containment, containment compares
// boundary points, and jsdom's boundary comparison walks forward from one node
// through the rest of the document looking for the other. Each call is
// therefore O(document), and it is made once per citation plus once per
// adjacent citation pair, so extraction cost grew with the square of the
// article's length.
//
// The walk below is bounded by the two endpoints instead of by the document,
// which makes it O(text actually spanned). It is also faster in the browser,
// since it allocates nothing.

// Next node in document order, descending into children.
function following(node, root) {
    if (node.firstChild) return node.firstChild;
    return followingSkippingSubtree(node, root);
}

// Next node in document order that is not inside `node`'s own subtree.
function followingSkippingSubtree(node, root) {
    for (let n = node; n && n !== root; n = n.parentNode) {
        if (n.nextSibling) return n.nextSibling;
    }
    return null;
}

// Nearest common ancestor of two nodes, used to bound a walk to the smallest
// subtree that can contain the text between them.
function commonAncestor(a, b) {
    const ancestors = new Set();
    for (let n = a; n; n = n.parentNode) ancestors.add(n);
    for (let n = b; n; n = n.parentNode) {
        if (ancestors.has(n)) return n;
    }
    return null;
}

// Concatenates the text of every node strictly between two points, in document
// order: after `startAfter` (or from the start of `root`, when null) and before
// `endBefore`.
//
// Equivalent to the Range this replaces: both boundaries fall *between* nodes
// rather than inside a text node, so no text node is ever partially covered and
// "every text node the range contains" is exactly "every text node in this
// walk".
export function textBetween(startAfter, endBefore, root) {
    let node = startAfter ? followingSkippingSubtree(startAfter, root) : root.firstChild;
    let text = '';
    while (node && node !== endBefore) {
        if (node.nodeType === TEXT_NODE) text += node.data;
        node = following(node, root);
    }
    return text;
}

// True iff the DOM range strictly between two .reference wrapper elements (in
// document order: refA before refB) contains no non-whitespace text. This is
// the rule that defines whether two adjacent citations attach to the same
// claim — a comma or any other punctuation between them counts as text and
// breaks the group.
export function hasTextBetween(refA, refB) {
    const root = commonAncestor(refA, refB);
    if (!root) return false;
    return textBetween(refA, refB, root).replace(/\s+/g, '').length > 0;
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
//
// \p{Lu} (Unicode "uppercase letter") rather than a hand-enumerated Latin
// range: the previous [A-Z0-9"'(À-Ü] matched only Latin (plus the Latin-1
// Supplement block added for French/German/Spanish) and silently missed
// every other cased script — Cyrillic capitals included. On fully-Cyrillic
// text that meant the regex never matched at all, so lastSentence() always
// fell through to its "no boundary found" fallback and returned the whole
// multi-sentence span, defeating sentence-scope claim narrowing entirely on
// e.g. ru.wikipedia (confirmed against a real batch-pipeline run there,
// 2026-08-31). \p{Lu} covers Cyrillic, Greek, Armenian, and any other cased
// script generically; scripts with no case distinction (CJK, Arabic, Hebrew,
// Thai, ...) still can't match here, same as before this fix — that's an
// inherent limit of "does the next sentence start with a capital", not
// something this regex can special-case its way out of, and it degrades the
// same safe way the header above already describes (whole span kept, not
// truncated).
const SENTENCE_SPLIT_RE = /(?<=[.!?])\s+(?=[\p{Lu}0-9"'(])/u;

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

    // Extract the text from the boundary to the current reference. With no
    // previous-ref boundary, that means the whole container up to this point.
    let claimText = claimStartNode
        ? textBetween(claimStartNode, currentRef, commonAncestor(claimStartNode, currentRef))
        : textBetween(null, currentRef, container);

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
