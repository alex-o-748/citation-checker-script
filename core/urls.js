// URL extraction helpers for Wikipedia reference elements.
// extractReferenceUrl and extractPageNumber accept a `document` parameter
// for Node callers (CLI, tests). They fall back to `globalThis.document`
// when called without one — that's the userscript path, where the browser
// supplies the global.

const ARCHIVE_HOST_PATTERN = /web\.archive\.org|archive\.today|archive\.is|archive\.ph|webcitation\.org/i;

export function isArchiveUrl(href) {
    return ARCHIVE_HOST_PATTERN.test(href);
}

// Wikimedia-family internal wikilinks (a[href^="http"] resolves to an absolute
// URL, so blue wikilinks like the "ISBN (identifier)" article, and the
// Special:BookSources bookseller-list page that ISBN magic links point to, can
// slip through the http filter). These are never genuine citation sources —
// verifying a claim against a wikilink is meaningless — so exclude them.
const WIKIMEDIA_INTERNAL_PATTERN = /^https?:\/\/[a-z0-9-]+\.(?:wikipedia|wikimedia|wiktionary|wikidata|wikisource|wikiquote|wikibooks|wikinews|wikiversity|wikivoyage)\.org\/wiki\//i;

export function isInternalWikiLink(href) {
    if (!href) return false;
    // Special:BookSources is the page ISBN magic links target; match it
    // directly so localized/mirrored hosts are covered too.
    if (/Special:BookSources/i.test(href)) return true;
    return WIKIMEDIA_INTERNAL_PATTERN.test(href);
}

export function parseArchiveOrgUrl(url) {
    const match = url.match(/^https?:\/\/web\.archive\.org\/web\/(\d+)(?:id_)?\/(https?:\/\/.+)$/);
    if (!match) return null;
    return { timestamp: match[1], originalUrl: match[2] };
}

// Sub-referencing (WMDE Technical Wishes, <ref name="X" details="p. 23" />)
// renders each sub-reference as its own footnote, nested inside the main
// reference's list item. Identical in legacy-parser and Parsoid HTML:
//
//   <li id="cite_note-Miller-10">               main ref: the full citation
//     <span class="reference-text">Miller: Book. 2018.</span>
//     <ol class="mw-subreference-list">
//       <li id="cite_note-11">                  [10.1] — details only
//         <span class="reference-text">p. 627.</span>
//
// The inline marker reads [10.1] and points at the inner <li>, which holds
// only the details — no URL, no title. Rolling out wiki by wiki through 2026
// (dewiki first, enwiki not yet), see
// https://meta.wikimedia.org/wiki/WMDE_Technical_Wishes/Sub-referencing
const SUBREFERENCE_LIST_CLASS = 'mw-subreference-list';

// The main reference's <li> for a sub-reference footnote, or null when the
// footnote is not a sub-reference.
export function subreferenceParent(footnote) {
    const list = footnote && footnote.parentElement;
    if (!list || !list.classList || !list.classList.contains(SUBREFERENCE_LIST_CLASS)) return null;
    return list.closest('li');
}

// True when `node` sits in a sub-reference list nested inside `container` —
// i.e. it belongs to one of container's sub-references, not to container.
function inNestedSubreference(node, container) {
    const list = node.closest('.' + SUBREFERENCE_LIST_CLASS);
    return !!list && list !== container && container.contains(list);
}

// A footnote's own text, without any sub-references nested under it. A main
// reference's textContent would otherwise carry every sub-reference's details,
// and the first "p. 627" among them would be read as the main ref's page.
export function footnoteText(footnote) {
    if (!footnote) return '';
    if (!footnote.querySelector('.' + SUBREFERENCE_LIST_CLASS)) return footnote.textContent;
    const copy = footnote.cloneNode(true);
    for (const list of copy.querySelectorAll('.' + SUBREFERENCE_LIST_CLASS)) list.remove();
    return copy.textContent;
}

export function extractHttpUrl(element) {
    if (!element) return null;
    // Skip internal wikilinks (ISBN article, Special:BookSources, etc.) — a
    // book-only citation whose sole links are these would otherwise be
    // "verified" against a Wikipedia navigation page rather than a real source.
    // Also skip links inside nested sub-references: those are another
    // footnote's details (see subreferenceParent), not this one's source.
    const links = Array.from(element.querySelectorAll('a[href^="http"]'))
        .filter(link => !isInternalWikiLink(link.href) && !inNestedSubreference(link, element));
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

export function extractReferenceUrl(refElement, doc = globalThis.document) {
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

    const url = urlFromFootnote(refTarget, doc);
    if (url) return url;

    // A sub-reference's own footnote is just its details ("p. 627."); the
    // source is in the main reference it hangs off. The details are tried
    // first because a link there (a Google Books page, a specific article of a
    // legal code) is a deep link to the exact place cited.
    const mainRef = subreferenceParent(refTarget);
    if (mainRef) {
        const mainUrl = urlFromFootnote(mainRef, doc);
        if (mainUrl) {
            console.log('[CitationVerifier] Resolved sub-reference via its main reference:', refId);
            return mainUrl;
        }
    }

    console.log('[CitationVerifier] No http links in refTarget. innerHTML:', refTarget.innerHTML.substring(0, 500));
    return null;
}

// The source URL a single footnote <li> names: a direct link, else the full
// citation a Harvard/sfn short-cite points at. Null when it names neither.
function urlFromFootnote(refTarget, doc) {
    // Try to extract a direct HTTP URL from the footnote
    const directUrl = extractHttpUrl(refTarget);
    if (directUrl) return directUrl;

    // Harvard/sfn citation support: the footnote may contain only a
    // short-cite linking to the full citation via a #CITEREF anchor.
    // Follow that link to resolve the actual source URL.
    const citerefLink = Array.from(refTarget.querySelectorAll('a[href^="#CITEREF"]'))
        .find(link => !inNestedSubreference(link, refTarget));
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
    }
    return null;
}

export function extractPageNumber(refElement, doc = globalThis.document) {
    const href = refElement.getAttribute('href');
    if (!href) return null;

    const fragmentIndex = href.indexOf('#');
    if (fragmentIndex === -1) return null;

    const refTarget = doc.getElementById(href.substring(fragmentIndex + 1));
    if (!refTarget) return null;

    // footnoteText, not textContent: a main reference's <li> also contains
    // its sub-references' details. A sub-reference's own <li> is only its
    // details, which is exactly the locator. Deliberately no fallback to its
    // main reference: a page there ("pp. 600–700") is the whole work's range,
    // and fetching only its first page would hide the cited one.
    const text = footnoteText(refTarget);
    // Match patterns like "p. 42", "pp. 42-43", "p.42", "page 42", "pages 42–43"
    const match = text.match(/\bp(?:p|ages?)?\.?\s*(\d+)/i);
    if (match) {
        console.log('[CitationVerifier] Extracted page number:', match[1]);
        return parseInt(match[1], 10);
    }
    return null;
}

export function isGoogleBooksUrl(url) {
    return /books\.google\./.test(url);
}

// The footnote as an editor reads it — "Camarota, Steven A. (March 12, 2025).
// "Foreign-Born Number …". CIS.org." — for the model, which otherwise sees only
// the source's body text and can't tell who published it or when
// (docs/design-plans/2026-11-08-fixable-causes-of-disputed-verdicts.md §1).
//
// Elements removed before reading the text, all chrome rather than citation:
// jump-back links ("↑", "1 2 3"), nested sub-references (another footnote's
// details), CS1's and dewiki's access dates (when an editor read the page,
// not when it was published — the model could take one for the other),
// TemplateStyles <style>/<link> (whose CSS is text to textContent), COinS
// metadata, and CS1 maintenance/error messages hidden by CSS.
const FOOTNOTE_CHROME_SELECTOR = [
    '.mw-cite-backlink',
    '.' + SUBREFERENCE_LIST_CLASS,
    '.reference-accessdate',
    '.Abrufdatum',
    'style', 'link', 'script',
    '.Z3988',
    '.cs1-maint', '.cs1-hidden-error', '.citation-comment',
].join(',');

// Archive boilerplate, as text: the "Archived" in CS1's "Archived from the
// original on …" is a link, not an element of its own, so it can't be removed
// structurally. English (CS1, {{webarchive}}) and Russian (ruwiki's cite
// templates and {{webarchive}}), the two wikis the batch runs on; elsewhere it
// passes through, labeled as what it is, which the model reads correctly.
// Russian patterns avoid \b, which only knows ASCII word characters. None
// takes the phrase's closing period: it stands in for the one the phrase
// interrupted ("1992 … Архивная копия … Wayback Machine. Гарант"), and a
// doubled one is collapsed afterwards.
const FOOTNOTE_BOILERPLATE_PATTERNS = [
    /\s*\bArchived\b(?:\s*\([^)]*\))?\s+from\s+the\s+original\b(?:\s*\([^)]*\))?\s+on\s+[^.;]{1,40}/gi,
    /\s*\bArchived\b[^.;]{0,40}?\bat\s+(?:the\s+)?(?:Wayback\s+Machine|archive\.(?:today|is|ph)|WebCite|Ghostarchive)/gi,
    /\s*\bRetrieved\s+(?:on\s+)?[^.;]{1,30}?\d{4}/g,
    /\s*Архивн(?:ая|ые)\s+копи[яи][^.;]{0,60}?(?:Wayback\s+Machine|archive\.(?:today|is|ph)|WebCite)/g,
    /\s*Архивировано[^.;]{0,60}/g,
    /\s*Дата\s+обращения:?\s*[^.;]{1,30}/g,
];

// A footnote is a citation, but it can also carry an editor's note or a long
// |quote=. The prompt wants what the source *is*, so keep the opening.
export const REFERENCE_TEXT_MAX_CHARS = 600;

function cleanFootnoteText(element) {
    if (!element) return '';
    const copy = element.cloneNode(true);
    for (const node of copy.querySelectorAll(FOOTNOTE_CHROME_SELECTOR)) node.remove();
    // Hidden by inline style (dewiki's COinS span, some templates' tracking
    // spans) — never shown to the editor, so never shown to the model.
    for (const node of copy.querySelectorAll('[style]')) {
        if (/display\s*:\s*none/i.test(node.getAttribute('style'))) node.remove();
    }
    let text = copy.textContent.replace(/\s+/g, ' ');
    for (const pattern of FOOTNOTE_BOILERPLATE_PATTERNS) text = text.replace(pattern, '');
    return text
        // Removing a phrase leaves its neighbours' punctuation behind:
        // "2017. Archived … 2020." -> "2017.." and "2021, abgerufen …." -> "2021,."
        .replace(/\s+([.,;:])/g, '$1')
        .replace(/\.(?:\s*\.)+/g, '.')
        .replace(/[,;:]\s*\./g, '.')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^[.,;:\s]+|[,;:\s]+$/g, '');
}

function capReferenceText(text) {
    if (text.length <= REFERENCE_TEXT_MAX_CHARS) return text;
    const cut = text.slice(0, REFERENCE_TEXT_MAX_CHARS);
    const lastSpace = cut.lastIndexOf(' ');
    return `${(lastSpace > REFERENCE_TEXT_MAX_CHARS * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()} …`;
}

// The full citation a Harvard/sfn short cite ("Smith 2010, p. 5") points at,
// cleaned the same way; '' when the footnote is not a short cite.
function citerefTarget(footnote, doc) {
    const link = Array.from(footnote.querySelectorAll('a[href^="#CITEREF"]'))
        .find(a => !inNestedSubreference(a, footnote));
    if (!link || !doc) return '';
    return cleanFootnoteText(doc.getElementById(link.getAttribute('href').substring(1)));
}

function footnoteCitation(footnote, doc) {
    const own = cleanFootnoteText(footnote);
    const full = citerefTarget(footnote, doc);
    return full && !own.includes(full) ? `${own} ${full}`.trim() : own;
}

/**
 * The text of the footnote a citation marker points at, as the editor sees it
 * in the reference list, without backlinks, access dates or archive
 * boilerplate — or null when there is no footnote, or it is empty.
 *
 * A Harvard/sfn short cite gets the full citation it links to appended; a
 * sub-reference ([10.1], details only) gets its main reference's citation in
 * front of its details. Capped at REFERENCE_TEXT_MAX_CHARS.
 */
export function extractReferenceText(refElement, doc = globalThis.document) {
    const refId = refElement && refElement.getAttribute && refElement.getAttribute('href');
    const fragmentIndex = refId ? refId.indexOf('#') : -1;
    if (fragmentIndex === -1 || !doc) return null;
    const footnote = doc.getElementById(refId.substring(fragmentIndex + 1));
    if (!footnote) return null;

    let text = footnoteCitation(footnote, doc);
    const mainRef = subreferenceParent(footnote);
    if (mainRef) {
        const main = footnoteCitation(mainRef, doc);
        text = main ? `${main} ${text}`.trim() : text;
    }
    return text ? capReferenceText(text) : null;
}
