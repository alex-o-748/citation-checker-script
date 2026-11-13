// Fuzzy matching between a claim (rendered text from a batch file) and
// revisions of the article's wikitext, reduced by analysis/lib/wikitext.js.
//
// Everything compares token sequences after normalisation: NFKC, lower case,
// quotes and dashes folded, punctuation dropped. That is what makes "the same
// sentence" survive re-wrapping, a curly quote swapped for a straight one, or
// a link added around a word — none of those are the change this analysis is
// looking for.

export function normalizeText(text) {
    return String(text ?? '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[‘’‚‛′ʼ`]/g, "'")
        .replace(/[“”„‟″«»]/g, '"')
        .replace(/[‐-―−]/g, '-')
        .replace(/ё/g, 'е');
}

export function tokenize(text) {
    return normalizeText(text).match(/[\p{L}\p{N}]+/gu) ?? [];
}

function counts(tokens) {
    const map = new Map();
    for (const t of tokens) map.set(t, (map.get(t) ?? 0) + 1);
    return map;
}

/**
 * Where in `segment` (tokens) does `claim` (tokens) sit? Claims are the text
 * immediately before a footnote, so the claim is a suffix of the segment; the
 * question is only how far back it starts. Scans every start position from
 * the end and keeps the one with the best Dice overlap between the suffix and
 * the claim (multiset). Returns { start, score }: score 1 is an exact multiset
 * match, 0 nothing in common.
 */
export function alignSuffix(segment, claim) {
    if (!claim.length || !segment.length) return { start: segment.length, score: 0 };
    const need = counts(claim);
    const have = new Map();
    let overlap = 0;
    let best = { start: segment.length, score: 0 };
    for (let start = segment.length - 1; start >= 0; start--) {
        const t = segment[start];
        const n = (have.get(t) ?? 0) + 1;
        have.set(t, n);
        if (n <= (need.get(t) ?? 0)) overlap++;
        const len = segment.length - start;
        const score = (2 * overlap) / (len + claim.length);
        if (score > best.score) best = { start, score };
        // Past twice the claim's length the score can only fall; stop early.
        if (len > 2 * claim.length + 20) break;
    }
    return best;
}

/** Share of the claim's tokens (multiset) found anywhere in `tokens`. */
export function containment(claim, tokens) {
    if (!claim.length) return 0;
    const have = counts(tokens);
    let hit = 0;
    for (const t of claim) {
        const n = have.get(t) ?? 0;
        if (n > 0) { hit++; have.set(t, n - 1); }
    }
    return hit / claim.length;
}

/**
 * Best match for the claim anywhere in a page: the share of the claim's
 * token 3-grams that occur in the page, at their best-agreeing offset. Used
 * only when the footnote itself can't be found (it was removed, or it was
 * never identifiable), to tell "footnote removed, sentence kept" from "both
 * gone".
 */
export function locateAnywhere(pageTokens, claim, k = 3) {
    if (claim.length < k) {
        const needle = claim.join(' ');
        return { score: needle && ` ${pageTokens.join(' ')} `.includes(` ${needle} `) ? 1 : 0, offset: -1 };
    }
    const index = new Map();
    for (let i = 0; i + k <= pageTokens.length; i++) {
        const key = pageTokens.slice(i, i + k).join(' ');
        const list = index.get(key);
        if (list) list.push(i); else index.set(key, [i]);
    }
    const votes = new Map();
    const shingles = claim.length - k + 1;
    for (let j = 0; j < shingles; j++) {
        const hits = index.get(claim.slice(j, j + k).join(' '));
        if (!hits) continue;
        for (const pos of hits) {
            const offset = pos - j;
            votes.set(offset, (votes.get(offset) ?? 0) + 1);
        }
    }
    // The 3-grams only find candidate positions; one changed word knocks out
    // three of them, so they make a poor score. Score each of the best few
    // offsets by how much of the claim appears, in order, in the page around
    // it (LCS / claim length).
    const candidates = [...votes].sort((a, b) => b[1] - a[1]).slice(0, 5);
    let best = { score: 0, offset: -1 };
    for (const [offset] of candidates) {
        const from = Math.max(0, offset - 5);
        const window = pageTokens.slice(from, offset + claim.length + 5);
        const score = lcsLength(claim, window) / claim.length;
        if (score > best.score) best = { score, offset };
    }
    return best;
}

function lcsLength(a, b) {
    let prev = new Array(b.length + 1).fill(0);
    for (let i = 1; i <= a.length; i++) {
        const cur = new Array(b.length + 1).fill(0);
        for (let j = 1; j <= b.length; j++) {
            cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
        }
        prev = cur;
    }
    return prev[b.length];
}

/** 2·LCS / (|a|+|b|) over tokens: 1 identical, 0 nothing in common. */
export function similarity(a, b) {
    if (!a.length && !b.length) return 1;
    if (!a.length || !b.length) return 0;
    return (2 * lcsLength(a, b)) / (a.length + b.length);
}

/**
 * URL forms that identify a cited source in wikitext. A batch row's
 * source_url is whatever the rendered link pointed at — often a Wayback
 * snapshot — while the wikitext holds both url= and archive-url=, so the
 * original behind a Wayback URL is accepted too.
 */
export function urlKeys(url) {
    if (!url) return [];
    const keys = new Set();
    const add = u => {
        let s = String(u).trim();
        try { s = decodeURI(s); } catch { /* leave as is */ }
        s = s.replace(/&amp;/g, '&').replace(/^(?:https?:)?\/\//i, '').replace(/^www\./i, '').replace(/[/#]+$/, '').toLowerCase();
        if (s.length >= 8) keys.add(s);
    };
    add(url);
    const wayback = /web\.archive\.org\/web\/[^/]+\/(.+)$/i.exec(url);
    if (wayback) add(wayback[1]);
    return [...keys];
}

export function normalizeForUrlSearch(text) {
    let s = String(text ?? '').replace(/&amp;/g, '&');
    try { s = decodeURI(s); } catch { /* leave as is */ }
    return s.replace(/(?:https?:)?\/\/(?:www\.)?/gi, '').toLowerCase();
}
