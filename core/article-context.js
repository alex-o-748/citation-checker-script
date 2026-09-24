// Where in the article a citation sits: its section heading, the paragraph
// around it, and the article's categories.
//
// Consumed by the severity pass (core/severity.js), which needs this context to
// judge whether the unsupported part of a claim is central — the batch pipeline
// cuts claims down to one sentence, and a sentence alone doesn't show what it
// is doing in the article. See
// docs/design-plans/2026-09-24-severity-ranking-for-flagged-claims.md.
//
// Deliberately separate from core/citations.js rather than more fields on
// collectCitations(): citations.js is inlined into main.js, and the userscript
// has no use for any of this yet. Nothing here is Node-specific, so it can
// move into the sync list if the userscript ever wants it.

// Paragraphs are context for the model, not evidence, and a few hundred tokens
// is plenty to see what a sentence is doing. A list item or table cell can be
// much longer than a prose paragraph, so this is a ceiling, not a typical size.
export const MAX_PARAGRAPH_CHARS = 2000;

// The block a claim is read as part of. A citation in a list item or a table
// cell has no <p>, and the item or cell is the nearest equivalent.
const PARAGRAPH_SELECTOR = 'p, li, dd, td, th, caption, blockquote';

// h1 is left out on purpose: in the browser DOM it is the page title, which
// sits outside #mw-content-text anyway, and Parsoid output has none.
const HEADING_SELECTOR = 'h2, h3, h4, h5, h6';

function cleanText(text) {
    return text.replace(/\s+/g, ' ').trim();
}

// Heading text without the "[edit]" link the browser skin puts inside or
// beside it. Parsoid headings carry no edit link, so this is a no-op there.
function headingText(heading) {
    const clone = heading.cloneNode(true);
    for (const el of clone.querySelectorAll('.mw-editsection')) el.remove();
    return cleanText(clone.textContent);
}

// Paragraph text without the footnote markers ("[12]") and inline styles that
// Parsoid and the skin both embed in running text.
function paragraphText(block, maxChars) {
    const clone = block.cloneNode(true);
    for (const el of clone.querySelectorAll('.reference, .mw-ref, style, link, .mw-editsection')) el.remove();
    const text = cleanText(clone.textContent);
    if (!text) return null;
    return text.length > maxChars ? `${text.slice(0, maxChars).trimEnd()}…` : text;
}

/**
 * Adds `sectionTitle` and `paragraphText` to each citation from
 * collectCitations(), in place.
 *
 * `sectionTitle` is the heading path to the citation ("Career > Music"),
 * or null in the lead — null is meaningful, since a lead sentence summarizes
 * the body and is often sourced there instead.
 *
 * One pass over the document, not a backwards search per citation: a
 * per-citation walk to the nearest heading is O(section) each, and the
 * browser DOM has no <section> wrappers, so a long flat article would make
 * this quadratic — the trap core/claim.js's header describes. querySelectorAll
 * returns matches in document order, so headings and citation markers come
 * back interleaved and the current heading is simply the last one seen.
 */
export function attachArticleContext(citations, root, { maxParagraphChars = MAX_PARAGRAPH_CHARS } = {}) {
    if (!root || citations.length === 0) return citations;

    const byRef = new Map(citations.map(c => [c.refElement, c]));
    // Index = heading level - 2, so path[0] is the h2.
    const path = [];
    const paragraphCache = new Map();

    for (const el of root.querySelectorAll(`${HEADING_SELECTOR}, .reference a`)) {
        if (/^H[2-6]$/.test(el.tagName)) {
            // Old Vector puts a "Contents" h2 inside the table of contents.
            if (el.closest('.toc, #toc')) continue;
            const level = Number(el.tagName[1]) - 2;
            path.length = level;
            path[level] = headingText(el);
            continue;
        }

        const citation = byRef.get(el);
        if (!citation) continue;

        // A skipped level (h2 then h4) leaves a hole; drop it rather than
        // printing "History >  > Detail".
        const title = path.filter(Boolean).join(' > ');
        citation.sectionTitle = title || null;

        const block = el.closest(PARAGRAPH_SELECTOR);
        if (!block) {
            citation.paragraphText = null;
        } else {
            // Several citations usually share one paragraph; clone it once.
            if (!paragraphCache.has(block)) paragraphCache.set(block, paragraphText(block, maxParagraphChars));
            citation.paragraphText = paragraphCache.get(block);
        }
    }

    // A citation the loop never reached (not under `root`) still gets the
    // fields, so consumers can rely on them being present.
    for (const c of citations) {
        if (!('sectionTitle' in c)) c.sectionTitle = null;
        if (!('paragraphText' in c)) c.paragraphText = null;
    }
    return citations;
}

/**
 * The article's categories, as names with spaces ("Living people"), from
 * Parsoid's category links:
 *
 *   <link rel="mw:PageProp/Category" href="./Category:Living_people#Smith">
 *
 * Read from the article HTML the pipeline already fetched, so a --titles-file
 * run gets them with no Wiki Replicas query. The namespace prefix is dropped
 * without being checked, because it is localized ("Категория:" on ruwiki).
 *
 * Parsoid only: the browser DOM renders categories outside #mw-content-text.
 */
export function articleCategories(root) {
    if (!root) return [];
    const names = new Set();
    for (const link of root.querySelectorAll('link[rel~="mw:PageProp/Category"]')) {
        const href = link.getAttribute('href') || '';
        const target = href.replace(/^\.\//, '').split('#')[0];
        const colon = target.indexOf(':');
        if (colon === -1) continue;
        let name = target.slice(colon + 1);
        try {
            name = decodeURIComponent(name);
        } catch {
            // Leave a malformed escape as-is rather than dropping the category.
        }
        name = name.replace(/_/g, ' ').trim();
        if (name) names.add(name);
    }
    return [...names];
}
