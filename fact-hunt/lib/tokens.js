// The words of a card's sentence, as tap targets, and the rule for whether a
// tap found the flagged words.
//
// The client renders the sentence from these offsets, one button per word,
// and sends back the index it tapped. The flagged span never leaves the
// server before an answer (design doc, "The tap"), so the page can't give the
// answer away.

// A word: letters and digits, with the joiners that keep "186,842", "6–5",
// "U.S.", "500M" and "don't" whole. Brackets, quotes and sentence punctuation
// are not part of a word.
const WORD = /[\p{L}\p{N}$€£¥₹%]+(?:[.,’'–\-:/][\p{L}\p{N}%]+)*\.?/gu;

/**
 * Word ranges of `text` as [{ start, end }]. A trailing full stop stays only
 * on an abbreviation-like token ("U.S."), never on the sentence's last word.
 */
export function tokenize(text) {
    const s = String(text ?? '');
    const tokens = [];
    WORD.lastIndex = 0;
    let m;
    while ((m = WORD.exec(s))) {
        let end = m.index + m[0].length;
        if (m[0].endsWith('.') && !/\.\p{L}+\.$/u.test(m[0]) && !/^\p{L}\.$/u.test(m[0])) end -= 1;
        if (end > m.index) tokens.push({ start: m.index, end });
    }
    return tokens;
}

const overlaps = (token, span) => token.start < span.end && token.end > span.start;

/**
 * Whether tapping token `index` counts as finding `span`: the tap lands on
 * the flagged words or on the word either side of them. A word away is
 * forgiving to a thumb; two words away is a different part of the sentence.
 */
export function tapMatches(tokens, index, span) {
    if (!Number.isInteger(index) || index < 0 || index >= tokens.length) return false;
    const hits = tokens.map((t, i) => (overlaps(t, span) ? i : -1)).filter(i => i >= 0);
    if (!hits.length) return false;
    return index >= hits[0] - 1 && index <= hits[hits.length - 1] + 1;
}
