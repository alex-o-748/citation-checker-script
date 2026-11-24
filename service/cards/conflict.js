// The conflict check for Fact Hunt cards: one model call per candidate
// finding that (1) points at the words in the claim and in the source quote
// that disagree, and (2) says whether both statements could still be true.
//
// A card is made only when both spans are found verbatim and
// both_can_be_true is false. See docs/design-plans/
// 2026-11-23-fact-hunt-app.md, "A difference is not always an error": on
// 15 benchmark contradictions, "make the article match its source" was right
// for 4. The rest were numbers that move over time, a different scope (one
// year's winners against a career total; a range inside a wider range), or a
// different book. "Could both be true?" is the test that separates them.
//
// The model points at words; it never writes a correction. The spans are
// checked against the texts, so every highlighted character on a card came
// from the article or the source.

// Bump whenever the prompt text changes: tests/cards-conflict.test.js pins a
// hash of the system prompt against it, and cards store it so a rebuild knows
// which cached decisions are still valid.
export const CONFLICT_PROMPT_VERSION = 'c1';

export function generateConflictSystemPrompt() {
    return `You compare one sentence from a Wikipedia article with a passage from the source the sentence cites. A checker has already judged that the passage contradicts the sentence. Your job is to point at the exact words that disagree, and to decide whether both statements could still be true.

Answer with JSON only, in this shape:
{"claim_span": "...", "quote_span": "...", "both_can_be_true": true, "reason": "..."}

- claim_span: the shortest run of words from the sentence that the passage contradicts, copied character for character. Usually a number, a date, a name or a short phrase.
- quote_span: the shortest run of words from the passage that says something different, copied character for character.
- both_can_be_true: true if the sentence and the passage could both be true at once. That includes when they describe different times (a figure that changes over time, or a passage older or newer than the sentence), different places, a different scope (one year's figure against a total, a range inside a wider range), a different edition, book, person or thing, or when the passage simply does not rule the sentence out. false only when they cannot both be true.
- reason: one short sentence saying why.

If nothing in the passage really disagrees with the sentence, use "" for both spans and true for both_can_be_true.

Examples:

Sentence: The bridge opened to traffic in 1998.
Passage: The bridge was finally opened to traffic in August 2002, four years behind schedule.
{"claim_span": "1998", "quote_span": "August 2002", "both_can_be_true": false, "reason": "A bridge opens to traffic once; 1998 and 2002 cannot both be right."}

Sentence: As of 2024, the chain operates twelve restaurants.
Passage: Only nine restaurants are still open today.
{"claim_span": "twelve", "quote_span": "nine", "both_can_be_true": true, "reason": "The number of restaurants changes over time, and the passage may describe a different date."}

Sentence: The series has won 10 awards at the ceremony, more than any other.
Passage: Best Strategy Game - Tactics Chronicles
{"claim_span": "10 awards", "quote_span": "Best Strategy Game - Tactics Chronicles", "both_can_be_true": true, "reason": "The passage lists one year's winners; it cannot refute a total across all years."}`;
}

export function generateConflictUserPrompt({ articleTitle, claim, quote, sourceLabel }) {
    const source = sourceLabel ? `Passage (from ${sourceLabel}):` : 'Passage:';
    return `Article: ${articleTitle || '(unknown)'}\nSentence: ${claim}\n${source} ${quote}`;
}

function extractJsonObject(text) {
    const s = String(text ?? '');
    const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = fenced ? fenced[1] : s;
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('no JSON object');
    return JSON.parse(body.slice(start, end + 1));
}

const QUOTE_FOLDS = [[/[‘’‛′]/g, "'"], [/[“”„″]/g, '"'], [/[‐‑‒–—―]/g, '-'], [/ /g, ' ']];

function foldChar(ch) {
    let c = ch;
    for (const [re, to] of QUOTE_FOLDS) c = c.replace(re, to);
    // Keep one character per character, so offsets map back: 'İ' lowercases
    // to two code units and would shift every index after it.
    const lower = c.toLowerCase();
    return lower.length === c.length ? lower : c;
}

/**
 * Finds `needle` in `haystack`, returning { start, end } offsets into the
 * original haystack, or null. Exact first; then a match that folds case,
 * quote style, dashes and runs of whitespace — the differences a model
 * introduces when it copies a span. Nothing fuzzier: a span that isn't in
 * the text is never shown.
 */
export function locateSpan(haystack, needle) {
    const text = String(haystack ?? '');
    const target = String(needle ?? '').trim();
    if (!target) return null;
    const exact = text.indexOf(target);
    if (exact >= 0) return { start: exact, end: exact + target.length };

    // Build a folded copy of the haystack with an index map back to originals,
    // collapsing whitespace runs to one space.
    const folded = [];
    const map = [];
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (/\s/.test(ch)) {
            if (folded.length && folded[folded.length - 1] === ' ') continue;
            folded.push(' ');
        } else {
            folded.push(foldChar(ch));
        }
        map.push(i);
    }
    const foldedNeedle = target.split('').map(ch => (/\s/.test(ch) ? ' ' : foldChar(ch))).join('').replace(/ +/g, ' ');
    const at = folded.join('').indexOf(foldedNeedle);
    if (at < 0) return null;
    const start = map[at];
    const end = map[at + foldedNeedle.length - 1] + 1;
    return { start, end };
}

/**
 * Parses and checks the model's answer against the texts it was shown.
 *
 * Returns { ok: true, keep, claimSpan, quoteSpan, bothCanBeTrue, reason } or
 * { ok: false, error }. `keep` is true only when both spans were located and
 * the model said both statements cannot be true. A span the model invented,
 * or two spans that say the same thing, is an error: the card is dropped
 * rather than shown with a highlight that isn't there.
 */
export function parseConflictResult(text, { claim, quote }) {
    let parsed;
    try {
        parsed = extractJsonObject(text);
    } catch {
        return { ok: false, error: 'parse_error' };
    }
    if (typeof parsed?.both_can_be_true !== 'boolean') return { ok: false, error: 'no_both_can_be_true' };
    const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : '';
    const claimText = typeof parsed.claim_span === 'string' ? parsed.claim_span.trim() : '';
    const quoteText = typeof parsed.quote_span === 'string' ? parsed.quote_span.trim() : '';

    if (parsed.both_can_be_true) {
        return { ok: true, keep: false, bothCanBeTrue: true, reason, claimSpan: null, quoteSpan: null };
    }
    if (!claimText || !quoteText) return { ok: false, error: 'empty_span' };

    const claimSpan = locateSpan(claim, claimText);
    if (!claimSpan) return { ok: false, error: 'claim_span_not_found' };
    const quoteSpan = locateSpan(quote, quoteText);
    if (!quoteSpan) return { ok: false, error: 'quote_span_not_found' };

    const shownClaim = claim.slice(claimSpan.start, claimSpan.end);
    const shownQuote = quote.slice(quoteSpan.start, quoteSpan.end);
    if (shownClaim.split('').map(foldChar).join('') === shownQuote.split('').map(foldChar).join('')) {
        return { ok: false, error: 'spans_identical' };
    }
    // A span covering most of the sentence points at nothing in particular,
    // and a card built on it would have no words to tap.
    if (claimSpan.end - claimSpan.start > Math.max(60, claim.length * 0.6)) {
        return { ok: false, error: 'claim_span_too_long' };
    }

    return {
        ok: true,
        keep: true,
        bothCanBeTrue: false,
        reason,
        claimSpan: { ...claimSpan, text: shownClaim },
        quoteSpan: { ...quoteSpan, text: shownQuote },
    };
}

/**
 * Runs the conflict check for one finding. `callModel({ systemPrompt,
 * userContent })` resolves to { text, usage } (core/providers.js's shape).
 * Model and network errors propagate: the runner decides whether a failure
 * halts the build or skips the finding.
 */
export async function checkConflict({ articleTitle, claim, quote, sourceLabel }, { callModel }) {
    const response = await callModel({
        systemPrompt: generateConflictSystemPrompt(),
        userContent: generateConflictUserPrompt({ articleTitle, claim, quote, sourceLabel }),
    });
    return {
        ...parseConflictResult(response?.text, { claim, quote }),
        usage: response?.usage ?? null,
        promptVersion: CONFLICT_PROMPT_VERSION,
    };
}
