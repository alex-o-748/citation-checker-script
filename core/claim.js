// Extracts the prose claim text bearing a given citation from a parsed
// Wikipedia Document. Works with both browser DOM and JSDOM.

export const MAINTENANCE_MARKER_RE = /\[(failed verification|verification needed|citation needed|better source[^\]]*|dubious[^\]]*|unreliable source[^\]]*|clarification needed|disputed[^\]]*|page needed|when\??|where\??|who\??|why\??|by whom\??|according to whom\??|original research[^\]]*|specify[^\]]*|vague|opinion|fact)\]/gi;

// Normalizes a raw DOM text run into clean prose: strips reference numbers and
// maintenance markers, collapses whitespace. Whitespace must be normalized
// BEFORE the marker strip (Wikipedia's {{failed verification}} et al. use
// white-space:nowrap and emit U+00A0 between the words, which the literal-space
// alternatives in MAINTENANCE_MARKER_RE would otherwise fail to match) AND
// AFTER (removing a marker that had a leading/trailing space leaves a double
// space behind).
export function cleanProse(text) {
    return text
        .replace(/\[\d+\]/g, '')            // Remove reference numbers like [1], [2]
        .replace(/\s+/g, ' ')               // Normalize whitespace (incl. NBSP) so the marker regex matches
        .replace(MAINTENANCE_MARKER_RE, '') // Remove maintenance markers like [failed verification]
        .replace(/\s+/g, ' ')               // Collapse the gap left by the marker strip
        .trim();
}

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

export function extractClaimText(refElement) {
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

    // Get the text content and clean it up.
    let claimText = cleanProse(extractionRange.toString());

    // If we got nothing meaningful, fall back to the container text
    if (!claimText || claimText.length < 10) {
        claimText = cleanProse(container.textContent);
    }

    return claimText;
}

// Text of a Wikipedia section heading, minus the [edit] section-edit
// affordance. Handles both the legacy shape (`<h2><span class="mw-headline">…
// </span><span class="mw-editsection">[edit]</span></h2>`) and the modern
// `.mw-heading` wrapper shape (edit link is a sibling of the bare <h2>).
function headingText(h) {
    const headline = h.querySelector('.mw-headline');
    let text;
    if (headline) {
        text = headline.textContent;
    } else {
        const clone = h.cloneNode(true);
        clone.querySelectorAll('.mw-editsection').forEach(n => n.remove());
        text = clone.textContent;
    }
    return text.replace(/\[edit\]/gi, '').replace(/\s+/g, ' ').trim();
}

// True iff `a` precedes `b` in document order. 4 === DOCUMENT_POSITION_FOLLOWING
// (b follows a), spelled numerically to avoid depending on a `Node` global that
// isn't present under the JSDOM/Node path the benchmark and CLI use.
function precedesInDocument(a, b) {
    return (a.compareDocumentPosition(b) & 4) !== 0;
}

// Returns a breadcrumb of the section heading(s) the claim sits under, e.g.
// "Club career › Wolverhampton Wanderers", or '' if the claim is above the
// first heading. Walks the headings preceding the claim's container and keeps
// each step up to a strictly higher-level heading (lower numeric level) to
// reconstruct the H2 › H3 › … ancestry.
export function extractSectionTitle(refElement) {
    const document = refElement.ownerDocument;
    const container = refElement.closest('p, li, td, div, section') || refElement;
    const root = refElement.closest('#mw-content-text')
        || (document && document.body)
        || (document && document.documentElement);
    if (!root) return '';

    const headings = Array.from(root.querySelectorAll('h1, h2, h3, h4, h5, h6'));

    // Nearest heading (in document order) that precedes the claim's container.
    let nearestIdx = -1;
    for (let i = 0; i < headings.length; i++) {
        if (precedesInDocument(headings[i], container)) {
            nearestIdx = i;
        } else {
            break;
        }
    }
    if (nearestIdx === -1) return '';

    const crumbs = [];
    let level = Infinity;
    for (let i = nearestIdx; i >= 0; i--) {
        const h = headings[i];
        const hLevel = parseInt(h.tagName.charAt(1), 10);
        if (hLevel < level) {
            const text = headingText(h);
            if (text) crumbs.unshift(text);
            level = hLevel;
            if (hLevel <= 2) break; // reached the top-level section
        }
    }
    return crumbs.join(' › ');
}

// Gathers disambiguation context around a claim for the LLM prompt: the full
// surrounding paragraph and the section-heading breadcrumb. The article title
// is environment-specific (mw.config in the browser, URL in the CLI/benchmark)
// so callers supply it; this stays pure DOM-in, strings-out.
export function extractClaimContext(refElement) {
    const container = refElement.closest('p, li, td, div, section');
    return {
        paragraph: container ? cleanProse(container.textContent) : '',
        sectionTitle: extractSectionTitle(refElement),
    };
}
