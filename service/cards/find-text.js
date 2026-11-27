// Finding a card's sentence in the article's current wikitext.
//
// Two jobs, one pass. First, it answers "is the sentence still there?": a card
// for an error someone already fixed must never be shown. Second, it picks the
// text the Fix screen tells people to search for in the editor ("Search the
// editor for: founded in 1999"), plus the section to open.
//
// The claim comes from rendered HTML and the editor shows wikitext, so the
// sentence itself often isn't in the wikitext verbatim: "[[John Zandig]]",
// "{{convert|84|sqmi}}", a <ref> in the middle. So the search text is the
// shortest run of the claim's words around the flagged words that occurs
// exactly once in the wikitext. Exactly once, because a search that lands on
// the wrong "1999" sends someone to edit the wrong sentence.

// Replace HTML comments with spaces of the same length, so offsets into the
// result are offsets into the original and a heading inside a comment isn't
// counted.
function blankComments(wikitext) {
    return wikitext.replace(/<!--[\s\S]*?(?:-->|$)/g, m => ' '.repeat(m.length));
}

const HEADING = /^(={2,6})[ \t]*(.+?)[ \t]*\1[ \t]*$/gm;

/**
 * The section a wikitext offset is in: { index, title }, index 0 being the
 * lead (title null). Matches MediaWiki's `section=N` numbering for headings
 * written in the page itself, which is all an article's prose normally has.
 */
export function sectionAt(wikitext, offset) {
    const text = blankComments(String(wikitext ?? ''));
    let index = 0;
    let title = null;
    HEADING.lastIndex = 0;
    let m;
    while ((m = HEADING.exec(text)) && m.index < offset) {
        index += 1;
        title = m[2].replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, '$1').replace(/'''?/g, '').trim();
    }
    return { index, title };
}

function countOccurrences(haystack, needle) {
    let count = 0;
    let at = haystack.indexOf(needle);
    while (at >= 0) {
        count += 1;
        if (count > 1) return count;
        at = haystack.indexOf(needle, at + 1);
    }
    return count;
}

// Word boundaries in the claim, as [start, end) pairs.
function wordRanges(text) {
    const ranges = [];
    const re = /\S+/g;
    let m;
    while ((m = re.exec(text))) ranges.push([m.index, m.index + m[0].length]);
    return ranges;
}

// Characters a search text shouldn't end on: trailing punctuation from the
// claim sits outside markup in wikitext (`[[Zandig]].`), so it's trimmed.
const TRIM_END = /[.,;:!?)\]"'”’»]+$/;
const TRIM_START = /^[("'“‘«[]+/;

/**
 * Locates a card's flagged words in the current wikitext.
 *
 * Returns { findText, offset, section: { index, title } }, or null when no run
 * of the claim's words around the span occurs exactly once (the sentence was
 * changed, or is too wrapped in markup to point someone at).
 *
 * `span` is { start, end } into `claim`.
 */
export function locateInWikitext(wikitext, claim, span, { maxWords = 12, minWords = 3 } = {}) {
    const source = String(wikitext ?? '');
    const searchable = blankComments(source);
    const words = wordRanges(claim);
    const first = words.findIndex(([, end]) => end > span.start);
    let last = -1;
    for (let i = words.length - 1; i >= 0; i--) {
        if (words[i][0] < span.end) { last = i; break; }
    }
    if (first < 0 || last < first) return null;

    // Grow the window one word at a time, shortest first, preferring words
    // before the flagged ones ("founded in 1999" reads better than "1999
    // by"). At least `minWords` words, so the search text reads as a phrase.
    const tried = new Set();
    const spanWords = last - first + 1;
    const startExtra = Math.max(0, Math.min(minWords, words.length) - spanWords);
    for (let extra = startExtra; extra <= maxWords; extra++) {
        for (let left = extra; left >= 0; left--) {
            const right = extra - left;
            const a = first - left;
            const b = last + right;
            if (a < 0 || b >= words.length) continue;
            let candidate = claim.slice(words[a][0], words[b][1]);
            // Trim punctuation, but never into the flagged words themselves.
            if (b === last) {
                const keep = claim.slice(words[a][0], span.end);
                candidate = candidate.replace(TRIM_END, '');
                if (candidate.length < keep.length) candidate = keep;
            } else {
                candidate = candidate.replace(TRIM_END, '');
            }
            if (a !== first) candidate = candidate.replace(TRIM_START, '');
            if (tried.has(candidate)) continue;
            tried.add(candidate);
            if (candidate.length < 4) continue;
            if (countOccurrences(searchable, candidate) === 1) {
                const offset = searchable.indexOf(candidate);
                return { findText: candidate, offset, section: sectionAt(source, offset) };
            }
        }
    }
    return null;
}
