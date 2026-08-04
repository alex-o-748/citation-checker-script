// Verifies that a model-supplied `source_quote` actually occurs in the source
// text, so the UI can present it as evidence rather than as more model prose.
//
// The LLM is asked to copy a passage verbatim, but models paraphrase, "fix"
// punctuation, or occasionally invent a plausible-sounding sentence. Rather
// than trusting the field, we look it up. A quote we cannot locate is never
// shown as a confirmed quote — the design is deliberately conservative: it is
// better to fall back to the plain rationale than to display a passage the
// source may not contain.
//
// Matching is normalized (case, curly quotes, dashes, whitespace, ligature-ish
// unicode) because near-universal reformatting would otherwise sink almost
// every real quote. It is NOT fuzzy: no edit distance, no token overlap. A
// passage either occurs in the source under normalization or it doesn't.
//
// Non-contiguous quotes joined by an ellipsis ("A ... B") are supported: each
// segment must occur, in order.

// A quote shorter than this (after normalization) is not evidence — "1985" or
// "the bridge" would match almost any source by accident.
const MIN_QUOTE_CHARS = 12;

// Ellipsis forms models use to join non-contiguous fragments.
const ELLIPSIS_SPLIT = /\s*(?:\[\s*(?:\.\.\.|…)\s*\]|\.\.\.\.?|…)\s*/g;

const CHAR_FOLD = [
    // All quotation marks fold to one character: models routinely swap ' for "
    // when copying, and the distinction carries no evidentiary weight here.
    [/[‘’‚‛′´`'“”„‟″«»"]/g, '"'],
    [/[‐-―−]/g, '-'],                      // hyphens, dashes, minus
    [/­/g, ''],                                      // soft hyphen
    [/[  -   　]/g, ' '],    // exotic spaces
    [/[​-‍﻿]/g, ''],                       // zero-width junk
];

/**
 * Canonical form used for substring comparison. Lossy by design — it throws
 * away exactly the differences (case, quote style, dash style, whitespace
 * runs, line breaks) that a model routinely introduces when copying.
 * @param {string} text
 * @returns {string}
 */
export function normalizeForMatch(text) {
    if (text == null) return '';
    let out = String(text);
    try {
        out = out.normalize('NFKC');
    } catch (e) {
        // Environments without full Unicode data: normalization is an
        // optimization here, not a requirement.
    }
    for (const [pattern, replacement] of CHAR_FOLD) {
        out = out.replace(pattern, replacement);
    }
    return out.replace(/\s+/g, ' ').trim().toLowerCase();
}

// Models often wrap the quote in quotation marks even when told not to, and
// sometimes trail a citation marker or a stray period. Strip the wrapper only
// when it is balanced, so a quote that legitimately opens with a quoted phrase
// survives intact.
function unwrap(quote) {
    let q = String(quote).trim();
    const pairs = [['"', '"'], ["'", "'"], ['“', '”'], ['‘', '’'], ['«', '»']];
    let changed = true;
    while (changed) {
        changed = false;
        for (const [open, close] of pairs) {
            if (q.length > 2 && q.startsWith(open) && q.endsWith(close)) {
                q = q.slice(open.length, q.length - close.length).trim();
                changed = true;
            }
        }
    }
    return q;
}

/**
 * Checks whether `quote` occurs in `sourceText`.
 *
 * @param {string} sourceText - The source body the model was shown (already
 *   unwrapped from its "Source Content:" framing by extractSourceText).
 * @param {string} quote - The model's `source_quote` field.
 * @returns {{verified: boolean, status: string, segments: Array<{text: string, found: boolean}>}}
 *   status is one of:
 *     'empty'      - no quote was offered (expected for omission / unavailable)
 *     'no-source'  - we have no source text to check against (e.g. cached
 *                    result restored without its source); quote is unproven
 *     'too-short'  - quote too short to be meaningful evidence
 *     'exact'      - occurs verbatim, byte for byte
 *     'normalized' - occurs after whitespace/punctuation/case normalization
 *     'partial'    - some ellipsis-joined segments found, others not
 *     'not-found'  - does not occur in the source
 *   `verified` is true only for 'exact' and 'normalized'.
 */
export function verifyQuote(sourceText, quote) {
    const raw = quote == null ? '' : String(quote).trim();
    if (!raw) return { verified: false, status: 'empty', segments: [] };

    const cleaned = unwrap(raw);
    const source = sourceText == null ? '' : String(sourceText);
    if (!source.trim()) return { verified: false, status: 'no-source', segments: [] };

    if (normalizeForMatch(cleaned).length < MIN_QUOTE_CHARS) {
        return { verified: false, status: 'too-short', segments: [] };
    }

    if (source.includes(cleaned)) {
        return { verified: true, status: 'exact', segments: [{ text: cleaned, found: true }] };
    }

    const haystack = normalizeForMatch(source);
    // String.split with a /g regex is safe (split resets lastIndex), but the
    // regex is recreated per call anyway to avoid any shared-state surprise.
    const rawSegments = cleaned.split(new RegExp(ELLIPSIS_SPLIT.source, 'g'))
        .map(s => s.trim())
        .filter(Boolean);

    let cursor = 0;
    const segments = [];
    for (const segment of rawSegments) {
        const needle = normalizeForMatch(segment);
        // Ignore fragments too short to carry meaning (a dangling "in 1985"
        // after an ellipsis); they neither confirm nor refute the match.
        if (needle.length < MIN_QUOTE_CHARS && rawSegments.length > 1) {
            segments.push({ text: segment, found: true });
            continue;
        }
        const at = needle ? haystack.indexOf(needle, cursor) : -1;
        if (at === -1) {
            segments.push({ text: segment, found: false });
        } else {
            segments.push({ text: segment, found: true });
            cursor = at + needle.length;
        }
    }

    const foundCount = segments.filter(s => s.found).length;
    if (foundCount === segments.length && segments.length > 0) {
        return { verified: true, status: 'normalized', segments };
    }
    if (foundCount > 0) {
        return { verified: false, status: 'partial', segments };
    }
    return { verified: false, status: 'not-found', segments };
}

// Verdicts for which a supporting/contradicting passage should exist in the
// source. Omission and unavailable verdicts have nothing to quote by
// definition, so a missing quote there is correct, not a failure.
const QUOTE_EXPECTED = new Set(['SUPPORTED', 'PARTIALLY SUPPORTED']);

/**
 * Whether a quote is expected for this verdict — used to decide if a missing
 * quote is worth surfacing to the user or is simply not applicable.
 * @param {string} verdict - Canonical UPPERCASE verdict.
 * @param {string|null} reasonType - 'contradiction' | 'omission' | null.
 * @returns {boolean}
 */
export function quoteExpectedFor(verdict, reasonType) {
    if (QUOTE_EXPECTED.has(verdict)) return true;
    return verdict === 'NOT SUPPORTED' && reasonType === 'contradiction';
}
