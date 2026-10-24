// Uncited sentences: the body text no citation covers.
//
// Every prose sentence is checked by exactly one of three things:
//
//   a citation follows it in its paragraph   its source   (core/prompts.js)
//   it is in the lead                        the body     (core/lead-check.js)
//   neither                                  the model's general knowledge
//                                                         (core/uncited-check.js)
//
// This module finds the third group. Design:
// docs/design-plans/2026-10-23-uncited-text-check.md.
//
// The rule, in one sentence: **a sentence counts as cited when a citation
// marker sits in it or anywhere after it in the same paragraph.** So the
// uncited text of a paragraph is the run of whole sentences after the one
// holding its last marker, or the whole paragraph when it has none. That is
// Wikipedia's own reading of a paragraph-final citation (it may cover the
// sentences before it), and it is fixed by the page alone: unlike the claim
// scope, no user setting moves it, so one result serves every scope and can
// be cached per revision. A sentence with a marker mid-way ("X, according to
// Smith,[1] was the largest") is cited: the citation is in it, and the words
// after the marker are not a sentence an editor would read on their own.
//
// The lead is left out when the article has a body: the lead check reads every
// lead sentence against the body, cited or not. An article with no headings
// has no body and so no lead check, and there its paragraphs are read here
// instead, so that no prose is left to nothing.
//
// Nothing here is Node-specific: it is inlined into main.js
// (scripts/sync-main.js), so top-level names carry an UNCITED_ / uncited
// prefix for that shared scope.

import { MAINTENANCE_MARKER_RE, MIN_CLAIM_LENGTH, splitSentences } from './claim.js';
import { LEAD_TEXT_NOISE, bodyParagraphs, leadParagraphs } from './lead.js';

// Sentences checked per article, at most. A poorly sourced article can hold
// hundreds of uncited sentences, and each one costs model time while the
// check only ever reports a few (UNCITED_MAX_FINDINGS in uncited-check.js).
// The first ones in article order are kept; `capped` records that the rest
// were left out.
export const UNCITED_MAX_SENTENCES = 150;

// The opening paragraph goes with every call so the model knows what the
// article is about. A first paragraph is usually a few hundred characters;
// this is a ceiling.
export const UNCITED_OPENING_MAX_CHARS = 1000;

// A citation marker: what core/claim.js treats as a claim boundary.
const UNCITED_MARKER = '.reference';

// A sentence ending in a colon introduces what follows it: "Awards that she
// received include:", "Eiffel said:". The list or quotation after it is not
// part of the paragraph, and it is where the citation usually is, so the
// lead-in is left out rather than read as an uncited claim. On the
// 2026-10-23 sample (six enwiki articles), 20 of 120 uncited sentences were
// lead-ins like these.
const UNCITED_LEAD_IN_RE = /[:：]\s*$/u;

function uncitedClean(text) {
    return text
        .replace(/\s+/g, ' ')
        .replace(MAINTENANCE_MARKER_RE, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// The paragraph's prose text, cleaned as a lead sentence is (core/lead.js),
// and `citedChars`: how much of that text comes before its last citation
// marker (0 when there is none). Cleaning a prefix gives a prefix of the
// cleaned whole, so `citedChars` is an offset into `text`.
//
// A walk, never a DOM Range: Range boundary checks are O(document) under
// JSDOM (see CLAUDE.md, "Claim extraction must not use DOM Range").
function uncitedParagraphText(block) {
    let raw = '';
    let lastMarkerAt = -1;
    const walk = node => {
        for (const child of node.childNodes) {
            if (child.nodeType === 3) {
                raw += child.data;
            } else if (child.nodeType === 1) {
                if (child.matches(UNCITED_MARKER)) lastMarkerAt = raw.length;
                else if (!child.matches(LEAD_TEXT_NOISE)) walk(child);
            }
        }
    };
    walk(block);
    const text = uncitedClean(raw);
    const citedChars = lastMarkerAt < 0 ? 0 : uncitedClean(raw.slice(0, lastMarkerAt)).length;
    return { text, citedChars };
}

function uncitedOpening(root) {
    const first = leadParagraphs(root)[0];
    if (!first) return '';
    const { text } = uncitedParagraphText(first);
    return text.length > UNCITED_OPENING_MAX_CHARS
        ? `${text.slice(0, UNCITED_OPENING_MAX_CHARS).trimEnd()}…`
        : text;
}

/**
 * Every uncited body sentence, in article order:
 *
 *   {
 *     sentences:  [{ index, paragraphIndex, sectionTitle, text, start }],
 *     paragraphs: [{ index, sectionTitle, text, block }],
 *     opening,    // the lead's first paragraph, for context ('' with no body)
 *     total,      // uncited sentences found, before the cap
 *     capped,     // true when total > maxSentences
 *     usesLead,   // true for an article with no headings: its lead was read
 *   }
 *
 * `paragraphs` holds only paragraphs with an uncited sentence; `text` is the
 * whole paragraph (citation markers left out) and each sentence's `start` is
 * its offset there, so a caller can show the text before a sentence as
 * context. `block` is the <p>, for highlighting; a batch caller drops it.
 * Sentences shorter than `minLength` are left out, as a claim that short is,
 * and so are lead-ins ending in a colon (UNCITED_LEAD_IN_RE).
 *
 * `splitSentences` defaults to core/claim.js's; the batch injects sentencex
 * (service/sentences.js), as it does for the lead.
 */
export function uncitedSentences(root, {
    splitSentences: split = splitSentences,
    minLength = MIN_CLAIM_LENGTH,
    maxSentences = UNCITED_MAX_SENTENCES,
} = {}) {
    let blocks = bodyParagraphs(root);
    const usesLead = blocks.length === 0;
    if (usesLead) blocks = leadParagraphs(root).map(block => ({ block, sectionTitle: null }));

    const sentences = [];
    const paragraphs = [];
    let total = 0;
    for (const { block, sectionTitle } of blocks) {
        const { text, citedChars } = uncitedParagraphText(block);
        if (!text) continue;
        const found = [];
        let cursor = 0;
        for (const sentence of split(text)) {
            const at = text.indexOf(sentence, cursor);
            // A splitter that rewrites text (none does today) can't be
            // located; such a sentence counts as cited rather than guessed at.
            if (at < 0) continue;
            cursor = at + sentence.length;
            if (at < citedChars || sentence.length < minLength || UNCITED_LEAD_IN_RE.test(sentence)) continue;
            found.push({ text: sentence, start: at });
        }
        if (found.length === 0) continue;
        total += found.length;
        const room = maxSentences - sentences.length;
        if (room <= 0) continue;
        const paragraphIndex = paragraphs.length;
        paragraphs.push({ index: paragraphIndex, sectionTitle, text, block });
        for (const s of found.slice(0, room)) {
            sentences.push({ index: sentences.length, paragraphIndex, sectionTitle, text: s.text, start: s.start });
        }
    }
    return {
        sentences,
        paragraphs,
        opening: usesLead ? '' : uncitedOpening(root),
        total,
        capped: total > sentences.length,
        usesLead,
    };
}
