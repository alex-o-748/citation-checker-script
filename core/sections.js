// Resolves which article section a citation lives in, for the "Edit Section"
// link (?action=edit&section=N).
//
// The section index in that URL is MediaWiki's own index over the page's
// *wikitext*, assigned while parsing. Counting rendered headings in the DOM is
// a reimplementation of that numbering, and the two drift apart in both
// directions:
//
//   - Headings that render but consume no number of their own — a transcluded
//     heading (its edit link is `section=T-1`, pointing at the template), the
//     "Contents" <h2> that legacy skins put *inside* #mw-content-text, or a
//     heading injected by another gadget — make a naive count too high, so the
//     link opens a later section.
//   - Headings that are numbered but that a naive count misses — a level-1
//     `=Heading=` when the selector starts at h2, or anything MediaWiki
//     numbered that the skin did not render inside #mw-content-text — make the
//     count too low, so the link opens an earlier section.
//
// MediaWiki already publishes the correct answer next to every heading it
// rendered: the `[edit]` link carries `section=N`. Read that instead of
// re-deriving it. Counting only survives as a fallback for pages that render
// no edit links at all (__NOEDITSECTION__).

const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6';
// Both the source and VisualEditor edit links carry the index; either will do.
const SECTION_PARAM_RE = /[?&]section=([^&#]+)/;
const DOCUMENT_POSITION_FOLLOWING = 4;

function contentRoot(doc) {
    return doc.getElementById('mw-content-text');
}

// Headings that precede `el` in document order, nearest last.
function headingsBefore(el, root) {
    const before = [];
    for (const heading of root.querySelectorAll(HEADING_SELECTOR)) {
        if (heading.compareDocumentPosition(el) & DOCUMENT_POSITION_FOLLOWING) {
            before.push(heading);
        } else {
            break;
        }
    }
    return before;
}

// The section index MediaWiki assigned to a heading, or null when the heading
// carries no usable edit link. `T-` prefixed indices belong to a transcluded
// template, not to this page, so they count as unusable — the caller walks
// further back to the page section that contains the transclusion.
export function sectionIndexOfHeading(heading) {
    // MW 1.43+ wraps the <h2> and its edit link in <div class="mw-heading">;
    // older output keeps the .mw-editsection span inside the heading itself.
    const scope = heading.closest('.mw-heading') || heading;
    for (const link of scope.querySelectorAll('.mw-editsection a[href]')) {
        const match = SECTION_PARAM_RE.exec(link.getAttribute('href') || '');
        if (!match) continue;
        const index = Number.parseInt(decodeURIComponent(match[1]), 10);
        if (Number.isInteger(index) && index > 0) return index;
    }
    return null;
}

// Returns MediaWiki's section index for the section containing refElement, or
// 0 for the lead (and for anything we cannot resolve — callers omit the
// section parameter on 0, which edits the whole page rather than the wrong
// part of it).
export function findSectionNumber(refElement, doc = refElement && refElement.ownerDocument) {
    if (!refElement || !doc) return 0;
    const root = contentRoot(doc);
    if (!root) return 0;

    const before = headingsBefore(refElement, root);
    if (before.length === 0) return 0;

    let sawEditLink = false;
    for (let i = before.length - 1; i >= 0; i--) {
        const index = sectionIndexOfHeading(before[i]);
        if (index !== null) return index;
        if ((before[i].closest('.mw-heading') || before[i]).querySelector('.mw-editsection')) {
            // A heading with an edit link we deliberately skipped (transcluded,
            // `section=T-n`). Keep walking; the page's own enclosing section is
            // the right target.
            sawEditLink = true;
        }
    }

    // No heading above this citation carries an index. Either the page
    // suppresses edit links entirely or the skin renders them somewhere we
    // don't recognise — fall back to the ordinal count, which is right on the
    // common case of a page whose headings map 1:1 onto its wikitext sections.
    return sawEditLink ? 0 : before.filter(h => h.tagName !== 'H1').length;
}

// The anchor MediaWiki gave a heading (`#History`), which is what identifies a
// section independently of its position. MW 1.43+ puts the id on the <hN>
// itself; older output puts it on an inner <span class="mw-headline">.
function anchorOfHeading(heading) {
    if (heading.id) return heading.id;
    const headline = heading.querySelector('.mw-headline[id]');
    return headline ? headline.id : null;
}

function headingText(heading) {
    const clone = heading.cloneNode(true);
    for (const el of clone.querySelectorAll('.mw-editsection')) el.remove();
    return (clone.textContent || '').replace(/\s+/g, ' ').trim();
}

// Everything we know about the section a citation sits in: the index as of the
// revision the browser rendered, plus the anchor and heading text that identify
// it no matter how the article is edited afterwards.
//
// The index alone is a position, and positions expire. A section inserted above
// this one after the page was rendered shifts every index below it, and
// `?action=edit&section=N` is resolved against the *current* wikitext — so a
// link built from a stale render silently opens a different section. The anchor
// survives that; re-resolve it against the live section list before navigating
// (see resolveSectionIndex).
export function sectionTargetFor(refElement, doc = refElement && refElement.ownerDocument) {
    if (!refElement || !doc) return null;
    const root = contentRoot(doc);
    if (!root) return null;

    const before = headingsBefore(refElement, root);
    for (let i = before.length - 1; i >= 0; i--) {
        const index = sectionIndexOfHeading(before[i]);
        if (index === null) continue;
        return { index, anchor: anchorOfHeading(before[i]), line: headingText(before[i]) };
    }
    // The lead has no heading, and no edit link to read an index from, but it is
    // always section 0 — that never shifts.
    return { index: findSectionNumber(refElement, doc), anchor: null, line: null };
}

// Given the live section list from action=parse&prop=sections, returns the
// index that currently addresses `target`'s section, or null when it can no
// longer be found (heading renamed or removed — the caller should fall back to
// editing the whole page rather than guessing a neighbour).
//
// Anchors are unique per page (MediaWiki disambiguates repeats with _2, _3), so
// they are matched first. Heading text is the fallback for the case where an
// anchor changed but the wording did not.
export function resolveSectionIndex(sections, target) {
    if (!target) return null;
    if (target.index === 0) return 0;
    if (!Array.isArray(sections)) return null;

    const numbered = sections
        .map(section => ({
            index: Number.parseInt(String(section.index), 10),
            anchor: section.anchor,
            line: typeof section.line === 'string' ? section.line.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() : '',
        }))
        // `T-n` entries belong to a transcluded template, not to this page's
        // wikitext, and parseInt would read "T-1" as NaN anyway.
        .filter(section => Number.isInteger(section.index) && section.index > 0);

    if (target.anchor) {
        const hit = numbered.find(section => section.anchor === target.anchor);
        if (hit) return hit.index;
    }

    if (target.line) {
        const byText = numbered.filter(section => section.line === target.line);
        if (byText.length === 1) return byText[0].index;
        if (byText.length > 1) {
            // Duplicate heading text: take whichever sits closest to where the
            // section was when the page rendered.
            return byText.reduce((best, section) =>
                Math.abs(section.index - target.index) < Math.abs(best.index - target.index) ? section : best
            ).index;
        }
    }

    return null;
}

// Debug aid: pairs every heading in the article body with the index a naive
// ordinal count would give it and the index MediaWiki actually assigned, so a
// divergence can be located on a specific page.
export function auditSectionNumbering(doc) {
    const root = contentRoot(doc);
    if (!root) return [];
    let counted = 0;
    return Array.from(root.querySelectorAll(HEADING_SELECTOR)).map(heading => {
        if (heading.tagName !== 'H1') counted++;
        const actual = sectionIndexOfHeading(heading);
        return {
            text: (heading.textContent || '').replace(/\s*\[\s*edit\s*\]\s*$/i, '').trim(),
            tag: heading.tagName,
            counted,
            actual,
            matches: actual === counted,
        };
    });
}
