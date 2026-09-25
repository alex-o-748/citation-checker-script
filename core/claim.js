// Extracts the prose claim text bearing a given citation from a parsed
// Wikipedia Document. Works with both browser DOM and JSDOM.

export const MAINTENANCE_MARKER_RE = /\[(failed verification|verification needed|citation needed|better source[^\]]*|dubious[^\]]*|unreliable source[^\]]*|clarification needed|disputed[^\]]*|page needed|when\??|where\??|who\??|why\??|by whom\??|according to whom\??|original research[^\]]*|specify[^\]]*|vague|opinion|fact|когда\??|где\??|кто\??|кем\??|почему\??|какой\??|какая\??|какие\??|нет АИ|АИ\??|источник не указан[^\]]*|не в источнике|уточнить|прояснить|значимость факта\??|неавторитетный источник\??)\]/giu;

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

// Elements whose text is never article prose. <style> is the one that bites:
// TemplateStyles emits an inline stylesheet inside the rendered template
// (ru.wikipedia's {{Когда?}} puts one right in the sentence), and its CSS
// would otherwise be read as claim text. .noprint marks inline maintenance
// templates ([citation needed], [когда?], ...) on every wiki, which is a
// language-independent way to drop them — MAINTENANCE_MARKER_RE only knows
// the wordings someone has listed.
const NON_PROSE_SELECTOR = 'style, script, .noprint, .ts-fix-template';

function isNonProse(node) {
    return node.nodeType === ELEMENT_NODE
        && typeof node.matches === 'function'
        && node.matches(NON_PROSE_SELECTOR)
        && !node.classList.contains('reference');
}

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
        // Skip a non-prose subtree whole — unless the endpoint sits inside it,
        // in which case skipping would walk past the end to the root's end.
        node = isNonProse(node) && !node.contains(endBefore)
            ? followingSkippingSubtree(node, root)
            : following(node, root);
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
// the start of a new sentence, then returns the last piece. Naive about
// abbreviations and initials: "Dr. Smith", "А. С. Пушкин" and "в 1837 г.
// Пушкин" all split after the period, cutting the claim short. The batch
// pipeline therefore replaces this with sentencex, which carries per-language
// abbreviation lists (service/sentences.js); the userscript keeps this
// version, where sentence scope is an opt-in and an editor reads the claim.
//
// "Looks like the start of a sentence" is any uppercase letter (\p{Lu}, so
// Cyrillic, Greek, accented Latin all count — an ASCII-only class silently
// made sentence scope a no-op on ru.wikipedia), a digit, or an opening quote
// or bracket, including the «» and „“ quotes non-English wikis use.
const SENTENCE_SPLIT_RE = /(?<=[.!?…])\s+(?=[\p{Lu}\p{Lt}\d"'(«„“‘])/u;

// Returns just the final sentence of `text` — the sentence immediately
// preceding wherever `text` ends. Used for the batch pipeline's stricter
// claim scope (see extractClaimText's `scope` option); returns the whole
// string unchanged if no sentence boundary is found.
export function lastSentence(text) {
    if (!text) return text;
    const parts = text.split(SENTENCE_SPLIT_RE);
    return parts[parts.length - 1].trim();
}

// Claims shorter than this are not a checkable statement: a bare name at the
// start of a list item ("R. Sankar[9] - ..."), a lone date, a stray bullet.
export const MIN_CLAIM_LENGTH = 10;

// Reason code for a citation that was skipped because the text preceding it is
// too short to check. Carried as `skipReason` on collectCitations() entries and
// as `reasonType` on a SKIPPED verdict (core/verdicts.js), so a skipped
// citation is recorded and visible rather than silently dropped.
export const CLAIM_TOO_SHORT = 'claim_too_short';

export function isClaimTooShort(claimText, minLength = MIN_CLAIM_LENGTH) {
    return !claimText || claimText.trim().length < minLength;
}

// `splitLastSentence` narrows the claim under scope 'sentence'. The default is
// lastSentence() above, which is what the userscript uses; the batch pipeline
// injects a sentencex-backed splitter (service/sentences.js) that knows each
// language's abbreviations, so "А. С. Пушкин" or "Dr. Smith" isn't cut in two.
// It is injected rather than imported because sentencex is a native Node
// module and this file also runs in the browser, inlined into main.js.
export function extractClaimText(refElement, { scope = 'paragraph', splitLastSentence = lastSentence } = {}) {
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

    // Applied last, after the paragraph-scope text is settled — narrowing to
    // the final sentence is a separate concern from finding the claim's
    // boundary in the first place.
    //
    // There is deliberately no "too short, use the whole container instead"
    // fallback, here or above. There used to be one, from the first version
    // of main.js: a claim under MIN_CLAIM_LENGTH was replaced by the
    // container's full text. In a list item like
    //   "R. Sankar[9] - former Chief Minister of Kerala. First Congress ..."
    // the text before [9] is just "R. Sankar", so the claim became the whole
    // bullet — including everything *after* the citation — and sentence scope
    // then kept only the last sentence, which is the one furthest from [9].
    // A claim is only ever text that precedes its citation. When that text is
    // too short to be a claim, callers skip the citation and say so (see
    // isClaimTooShort() and CLAIM_TOO_SHORT) rather than guess.
    if (scope === 'sentence') {
        claimText = splitLastSentence(claimText);
    }

    return claimText;
}
