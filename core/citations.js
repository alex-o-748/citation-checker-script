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

import { extractClaimText, getCitationGroup } from './claim.js';
import { extractReferenceUrl, extractPageNumber } from './urls.js';

// Claims shorter than this are extraction noise (a stray bullet, a lone date)
// rather than a verifiable statement. Matches main.js's original threshold.
export const MIN_CLAIM_LENGTH = 10;

// Returns the fragment id a footnote anchor points at, or null if the href
// isn't a footnote link.
//
// The two HTML sources render the same anchor differently:
//   browser DOM   href="#cite_note-1"
//   Parsoid REST  href="./Article_title#cite_note-1"
// main.js's original guard was `href.startsWith('#')`, which is correct for the
// browser and rejects *every* citation in Parsoid output. Keying on the
// fragment covers both.
export function refIdFromHref(href) {
    if (!href) return null;
    const hashIndex = href.indexOf('#');
    if (hashIndex === -1) return null;
    const refId = href.slice(hashIndex + 1);
    return refId || null;
}

export function collectCitations(root, { minClaimLength = MIN_CLAIM_LENGTH } = {}) {
    if (!root) return [];
    // A Document has no ownerDocument; an Element does. Either can be the root.
    const doc = root.ownerDocument || root;

    const citations = [];
    for (const refElement of root.querySelectorAll('.reference a')) {
        const refId = refIdFromHref(refElement.getAttribute('href'));
        if (!refId) continue;

        const claimText = extractClaimText(refElement);
        if (!claimText || claimText.length < minClaimLength) continue;

        citations.push({
            refElement,
            refId,
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
export function attachGroupMetadata(citations) {
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
