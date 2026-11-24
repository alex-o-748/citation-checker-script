// The lead section, its sentences, and the body it summarizes.
//
// A lead has a different sourcing standard from the body: per WP:LEADCITE a
// lead statement needs no citation of its own when the body covers it. So the
// lead gets a check of its own — every lead sentence against the body text
// (core/lead-check.js) — and lead citations' omission and partial verdicts are
// demoted rather than reported (isLeadDemotedVerdict, below). Design:
// docs/design-plans/2026-10-22-lead-checks.md.
//
// Works on both HTML shapes the tool sees, and on any of the three root shapes
// collectCitations() is called with:
//   Parsoid (batch)      <section data-mw-section-id="0"> is the lead; later
//                        sections are the body
//   browser skin         .mw-parser-output children before the first heading
//                        are the lead; the first heading starts the body
//
// Nothing here is Node-specific. Inlined into main.js (scripts/sync-main.js),
// so every top-level name carries a LEAD_ / lead / body prefix: the inlined
// modules share one scope there.

import { MAINTENANCE_MARKER_RE, MIN_CLAIM_LENGTH, splitSentences } from './claim.js';
import { VERDICTS, canonicalizeVerdict } from './verdicts.js';

// The body sent with a lead check is capped like a source is: 100,000 chars
// is core/worker.js's WORKER_CONTENT_CAP, so a body under it is a prompt the
// providers already handle. Above it, sections are kept by relevance to the
// lead (articleBody) and the check is marked truncated.
export const LEAD_BODY_MAX_CHARS = 100000;

// Lead blocks that hold no lead prose: the infobox (a summary too, with its
// own citations, checked as citations), images, hatnotes, navigation, and
// maintenance boxes. The lead check reads lead <p>s only.
const LEAD_NON_PROSE_CONTAINER = [
    'table', 'figure', 'blockquote', '.infobox', '.hatnote', '.sidebar', '.navbox', '.ambox',
    '.mbox-small', '.metadata', '.shortdescription', '.thumb', '.gallery', '.toc', '#toc',
].join(', ');

// Subtrees whose text is never prose: footnote markers, edit links,
// TemplateStyles CSS, and .noprint inline maintenance templates
// ([citation needed]) — the same things core/claim.js leaves out of a claim.
// Exported for core/uncited.js, which reads body paragraphs the same way.
export const LEAD_TEXT_NOISE = '.reference, .mw-ref, .mw-editsection, style, script, link, meta, .noprint, .ts-fix-template';

// Footnote lists and bibliographies. Their text is never body.
//
// A footnote list says nothing about its section: short articles often put
// {{reflist}} straight under their last content section, with no heading of
// its own, and that section is body. A "Notes" or "References" section is
// dropped anyway, by name, or because nothing is left once its list is.
//
// A bibliography (.refbegin: Further reading, Sources, a list of works
// consulted) marks its section as an appendix when it is nearly all the
// section holds — fewer than BODY_APPENDIX_MAX_PROSE chars of anything else,
// an introductory line at most. That catches "Further reading" under any
// heading in any language, intro and subsections included.
const BODY_FOOTNOTE_LIST = '.reflist, .mw-references-wrap, ol.references';
const BODY_BIBLIOGRAPHY = '.refbegin';
const BODY_APPENDIX_MAX_PROSE = 300;

// Everything else that is on the page but is not body text.
const BODY_NOISE = `${LEAD_TEXT_NOISE}, .navbox, .metadata, .hatnote, .sidebar, .infobox, `
    + '.catlinks, .printfooter, .mw-empty-elt, .shortdescription';

// Appendix sections, by heading, for the five sidebar languages. Matched
// after lowercasing. A bibliography is also caught by BODY_BIBLIOGRAPHY; the names
// catch the ones that are lists of links (See also, External links).
//
// English "Bibliography" is deliberately absent: on enwiki it is as often a
// writer's list of works (body, and what a lead's "she wrote twelve novels"
// summarizes) as a list of sources, and a sources list is usually a .refbegin
// anyway. frwiki's and eswiki's are lists of sources by convention.
const LEAD_APPENDIX_HEADINGS = new Set([
    // en
    'see also', 'notes', 'references', 'footnotes', 'citations', 'sources', 'further reading',
    'external links', 'works cited', 'notes and references', 'references and notes',
    'explanatory notes', 'cited sources', 'general references',
    // ru
    'см. также', 'примечания', 'литература', 'ссылки', 'источники', 'комментарии', 'сноски',
    // fr
    'voir aussi', 'notes et références', 'références', 'bibliographie', 'liens externes',
    'articles connexes',
    // es
    'véase también', 'referencias', 'notas', 'bibliografía', 'enlaces externos', 'fuentes',
    // he
    'ראו גם', 'הערות שוליים', 'הערות', 'קישורים חיצוניים', 'לקריאה נוספת', 'מקורות',
]);

const BODY_BLOCK_ELEMENTS = new Set([
    'P', 'LI', 'DD', 'DT', 'TR', 'CAPTION', 'FIGCAPTION', 'BLOCKQUOTE', 'DIV', 'UL', 'OL', 'DL', 'TABLE',
]);

function isLeadHeading(el) {
    return /^H[2-6]$/.test(el.tagName) || el.classList.contains('mw-heading');
}

/**
 * Splits an article into its lead and body, as two lists of top-level
 * elements. The body is empty when the article has no headings.
 */
export function splitLeadAndBody(root) {
    if (!root) return { lead: [], body: [] };
    const section0 = root.querySelector('section[data-mw-section-id="0"]');
    if (section0) {
        const body = [];
        for (let n = section0.nextElementSibling; n; n = n.nextElementSibling) body.push(n);
        return { lead: [section0], body };
    }
    const container = (typeof root.matches === 'function' && root.matches('.mw-parser-output'))
        ? root
        : (root.querySelector('.mw-parser-output') || root);
    const lead = [];
    const body = [];
    for (const child of container.children) {
        if (body.length === 0 && !isLeadHeading(child)) lead.push(child);
        else body.push(child);
    }
    return { lead, body };
}

// Text of `node` with LEAD_TEXT_NOISE subtrees left out, whitespace and
// maintenance markers cleaned the way core/claim.js cleans a claim.
function leadProseText(node) {
    let text = '';
    const walk = n => {
        for (const child of n.childNodes) {
            if (child.nodeType === 3) text += child.data;
            else if (child.nodeType === 1 && !child.matches(LEAD_TEXT_NOISE)) walk(child);
        }
    };
    walk(node);
    return text
        .replace(/\s+/g, ' ')
        .replace(MAINTENANCE_MARKER_RE, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * The lead's prose paragraphs, in order: lead <p>s outside the infobox,
 * tables, figures, hatnotes and the like, that hold any text.
 */
export function leadParagraphs(root) {
    const blocks = [];
    for (const node of splitLeadAndBody(root).lead) {
        const candidates = node.matches('p') ? [node] : node.querySelectorAll('p');
        for (const p of candidates) {
            if (p.closest(LEAD_NON_PROSE_CONTAINER)) continue;
            if (leadProseText(p)) blocks.push(p);
        }
    }
    return blocks;
}

/**
 * Every lead sentence, in order: `{ index, paragraphIndex, text, block }`,
 * where `block` is the lead <p> it came from (for highlighting). Sentences
 * shorter than MIN_CLAIM_LENGTH are left out, as a claim that short is.
 *
 * `splitSentences` defaults to core/claim.js's; the batch pipeline injects
 * sentencex (service/sentences.js), as it does for sentence-scope claims.
 */
export function leadSentences(root, { splitSentences: split = splitSentences, minLength = MIN_CLAIM_LENGTH } = {}) {
    const sentences = [];
    leadParagraphs(root).forEach((block, paragraphIndex) => {
        for (const text of split(leadProseText(block))) {
            if (text.length < minLength) continue;
            sentences.push({ index: sentences.length, paragraphIndex, text, block });
        }
    });
    return sentences;
}

/**
 * Sets `inLead` on each citation from collectCitations(): true when its
 * marker sits in a lead prose paragraph. Infobox citations, though in the
 * lead section, are false — demotion applies to lead prose only.
 */
export function markLeadCitations(citations, root) {
    const blocks = new Set(leadParagraphs(root));
    for (const c of citations) {
        const p = c.refElement && c.refElement.closest('p');
        c.inLead = Boolean(p && blocks.has(p));
    }
    return citations;
}

function bodyHeadingText(heading) {
    const clone = heading.cloneNode(true);
    for (const el of clone.querySelectorAll('.mw-editsection')) el.remove();
    return clone.textContent.replace(/\s+/g, ' ').trim();
}

function bodySectionText(parts) {
    return parts.join('')
        .replace(MAINTENANCE_MARKER_RE, '')
        .split('\n')
        .map(line => line.replace(/[ \t ]+/g, ' ').trim())
        .filter(Boolean)
        .join('\n');
}

// The body's sections in document order: { level, heading, text, paragraphs }.
// One pass, walking the body's nodes; Parsoid's nested <section>s and the
// skin's flat markup come out the same, since headings are met in order.
// `paragraphs` are the section's own <p> elements, for core/uncited.js;
// articleBody() leaves them out, so the body it returns stays plain data.
function collectBodySections(nodes) {
    const sections = [];
    let current = null;
    const start = (level, heading) => {
        current = { level, heading, parts: [], paragraphs: [], hasBibliography: false };
        sections.push(current);
    };
    const walk = node => {
        if (node.nodeType === 3) {
            if (current) current.parts.push(node.data);
            return;
        }
        if (node.nodeType !== 1) return;
        if (/^H[2-6]$/.test(node.tagName)) {
            start(Number(node.tagName[1]), bodyHeadingText(node));
            return;
        }
        if (node.matches(BODY_BIBLIOGRAPHY)) {
            if (current) current.hasBibliography = true;
            return;
        }
        if (node.matches(BODY_FOOTNOTE_LIST)) return;
        if (node.matches(BODY_NOISE)) return;
        if (node.tagName === 'P' && current) current.paragraphs.push(node);
        for (const child of node.childNodes) walk(child);
        if (!current) return;
        if (BODY_BLOCK_ELEMENTS.has(node.tagName)) current.parts.push('\n');
        else if (node.tagName === 'TD' || node.tagName === 'TH') current.parts.push(' ');
    };
    for (const node of nodes) walk(node);

    // An appendix takes its subsections with it: "Further reading > Books".
    const kept = [];
    let appendixLevel = null;
    for (const s of sections) {
        if (appendixLevel !== null && s.level > appendixLevel) continue;
        appendixLevel = null;
        const text = bodySectionText(s.parts);
        const bibliography = s.hasBibliography && text.length < BODY_APPENDIX_MAX_PROSE;
        if (bibliography || LEAD_APPENDIX_HEADINGS.has(s.heading.toLowerCase())) {
            appendixLevel = s.level;
            continue;
        }
        if (text) kept.push({ level: s.level, heading: s.heading, text, paragraphs: s.paragraphs });
    }
    return kept;
}

function bodySectionBlock(s) {
    const bar = '='.repeat(s.level);
    return `${bar} ${s.heading} ${bar}\n${s.text}`;
}

function leadWords(text) {
    return new Set((text.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || []));
}

/**
 * The article body, as the text a lead check reads:
 *
 *   { text, sections: [{ level, heading, text }], chars, totalChars, truncated }
 *
 * `text` is every kept section under a wikitext-style heading line
 * ("== Early life =="), so the model can name the section its quote came
 * from. The lead is never part of it — every lead sentence would support
 * itself — nor are reference lists, navigation, or appendix sections.
 *
 * Over `maxChars`, see fitBody().
 */
export function articleBody(root, { maxChars = LEAD_BODY_MAX_CHARS, leadText = '' } = {}) {
    const sections = collectBodySections(splitLeadAndBody(root).body)
        .map(({ level, heading, text }) => ({ level, heading, text }));
    return fitBody(sections, { maxChars, leadText });
}

/**
 * The body's prose paragraphs, in order: `{ block, sectionTitle }`, where
 * `block` is the <p> and `sectionTitle` the heading of the section it is in.
 * The same body articleBody() reads (no appendix sections, navigation or
 * reference lists), and only <p>s outside tables, figures, quotations and
 * the like, as for lead prose. Empty when the article has no headings.
 */
export function bodyParagraphs(root) {
    const paragraphs = [];
    for (const section of collectBodySections(splitLeadAndBody(root).body)) {
        for (const block of section.paragraphs) {
            if (!block.closest(LEAD_NON_PROSE_CONTAINER)) paragraphs.push({ block, sectionTitle: section.heading });
        }
    }
    return paragraphs;
}

/**
 * Fits body sections into `maxChars`, in articleBody()'s shape. Whole
 * sections are kept by how many of the lead's words (`leadText`, 4+ letters)
 * they contain, then put back in article order, and `truncated` is set:
 * absence is then discounted, as on a truncated source. A single section
 * larger than the whole budget keeps its start.
 *
 * Separate from articleBody() so the lead check can shrink a body a model
 * rejected as too long (core/lead-check.js) without the article's DOM.
 */
export function fitBody(sections, { maxChars = LEAD_BODY_MAX_CHARS, leadText = '' } = {}) {
    const blocks = sections.map(bodySectionBlock);
    const full = blocks.join('\n\n');
    if (full.length <= maxChars) {
        return { text: full, sections, chars: full.length, totalChars: full.length, truncated: false };
    }

    const wanted = leadWords(leadText);
    const ranked = sections
        .map((s, i) => {
            const words = leadWords(s.text);
            let score = 0;
            for (const w of wanted) if (words.has(w)) score++;
            return { i, score };
        })
        .sort((a, b) => (b.score - a.score) || (a.i - b.i));

    const keep = new Set();
    let used = 0;
    for (const { i } of ranked) {
        const cost = blocks[i].length + 2;
        if (used + cost > maxChars) continue;
        keep.add(i);
        used += cost;
    }
    let kept = sections.filter((_, i) => keep.has(i));
    let text = kept.map(bodySectionBlock).join('\n\n');
    if (kept.length === 0 && sections.length > 0) {
        const top = sections[ranked[0].i];
        kept = [{ ...top, text: top.text.slice(0, Math.max(0, maxChars - top.heading.length - 20)) }];
        text = bodySectionBlock(kept[0]);
    }
    return { text, sections: kept, chars: text.length, totalChars: full.length, truncated: true };
}

/**
 * Whether a lead citation's verdict is demoted rather than reported:
 * PARTIALLY SUPPORTED, or NOT SUPPORTED as an omission.
 *
 * Crediting a lead citation with the summary around it — the claim it gets
 * spans uncited summary sentences its source was never meant to cover —
 * always comes back as "the source doesn't mention it", never as a
 * contradiction. In the lead the standard is "the body covers it", which the
 * lead check judges, so these verdicts are shown apart and not counted.
 * A contradiction, SOURCE UNAVAILABLE, or a NOT SUPPORTED with no
 * reason_type is reported as anywhere else.
 *
 * Callers apply it only to citations in lead prose (markLeadCitations), and
 * only where a lead check runs: demoting without one hides a real failure
 * with nothing to replace it.
 */
export function isLeadDemotedVerdict(verdict, reasonType) {
    const v = canonicalizeVerdict(verdict);
    if (v === VERDICTS.PARTIALLY_SUPPORTED) return true;
    return v === VERDICTS.NOT_SUPPORTED && String(reasonType || '').toLowerCase() === 'omission';
}
