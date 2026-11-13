// For one suggestion (a claim plus its footnote) and one page's revision
// history after go-live: find the first revision that changed the sentence or
// the footnote, and say how.
//
// "Changed" is always relative to the baseline — the last revision before the
// suggestion went live — never to the revision the batch checked. Edits between
// the check and go-live happened before anyone could see the suggestion.

import { parseFootnotes, precedingProse, flagsAfter, wikitextToPlain, footnoteCluster, footnoteKey } from './wikitext.js';
import { tokenize, alignSuffix, locateAnywhere, similarity, urlKeys, normalizeForUrlSearch } from './match.js';

// Anchor scores are Dice overlaps between the claim and the prose before a
// footnote (analysis/lib/match.js's alignSuffix). Rendered text keeps what
// templates produce and stripped wikitext doesn't, so a correct anchor can
// score well under 1; 0.5 is the floor below which it's more likely the wrong
// footnote occurrence than the right one with some template text missing.
export const MIN_ANCHOR = 0.5;
export const MIN_ANCHOR_ANY_FOOTNOTE = 0.6;
export const MIN_PAGE_MATCH = 0.8;

export const CHANGE_KINDS = Object.freeze({
    SENTENCE_EDITED: 'sentence_edited',
    SENTENCE_REMOVED: 'sentence_removed',
    FOOTNOTE_REMOVED: 'footnote_removed',
    SENTENCE_AND_FOOTNOTE_REMOVED: 'sentence_and_footnote_removed',
    SOURCE_REPLACED: 'source_replaced',
    FLAG_ADDED: 'flag_added',
    FLAG_REMOVED: 'flag_removed',
    FOOTNOTE_ADDED: 'footnote_added',
});

/** Prepares a batch row for tracking. */
export function makeTarget(row) {
    const urls = String(row.source_url || '').split('\n').filter(Boolean);
    return {
        claimTokens: tokenize(row.claim_text),
        refName: row.ref_name ? String(row.ref_name).trim() : null,
        urlKeys: urls.flatMap(urlKeys),
    };
}

/** Parses one revision once; every suggestion on the page shares it. */
export function prepareRevision(wikitext, wiki = 'enwiki') {
    const parsed = parseFootnotes(wikitext ?? '');
    const proseCache = new Map();
    const defCache = new Map();
    let pageTokens = null;
    return {
        wiki,
        parsed,
        markers: parsed.markers,
        prose(index) {
            if (!proseCache.has(index)) {
                const raw = precedingProse(parsed, index);
                proseCache.set(index, { raw, tokens: tokenize(wikitextToPlain(raw)) });
            }
            return proseCache.get(index);
        },
        definitionText(index) {
            if (!defCache.has(index)) defCache.set(index, normalizeForUrlSearch(parsed.markers[index].definition));
            return defCache.get(index);
        },
        pageTokens() {
            if (!pageTokens) pageTokens = tokenize(wikitextToPlain(parsed.text));
            return pageTokens;
        },
        cluster(index) { return footnoteCluster(parsed, index); },
        flags(index) { return flagsAfter(parsed, footnoteCluster(parsed, index)[0], wiki); },
    };
}

function identityMarkers(rev, target) {
    const hits = [];
    rev.markers.forEach((marker, index) => {
        if (target.refName && marker.name === target.refName) { hits.push(index); return; }
        if (target.urlKeys.length) {
            const def = rev.definitionText(index);
            if (target.urlKeys.some(key => def.includes(key))) hits.push(index);
        }
    });
    return hits;
}

function bestAnchor(rev, target, indexes) {
    let best = null;
    for (const index of indexes) {
        const { tokens } = rev.prose(index);
        const { score } = alignSuffix(tokens, target.claimTokens);
        if (!best || score > best.score) best = { index, score };
    }
    return best;
}

function sourcePresent(rev, target) {
    if (!target.urlKeys.length) return null;
    return rev.markers.some((_, index) => target.urlKeys.some(key => rev.definitionText(index).includes(key)));
}

/**
 * Locates the suggestion in the baseline revision. Three ways, best first:
 *   'footnote'  a footnote matching the row's ref name or source URL, with
 *               the claim right before it
 *   'claim'     no matching footnote (e.g. {{sfn}} citations, or a URL the
 *               wikitext writes differently), but some footnote has the claim
 *               right before it; that footnote's wikitext becomes the identity
 *   'page'      the claim is somewhere on the page, footnote unknown
 * or null when the claim isn't found at all — typically text that changed
 * between the batch's check and go-live, or that a template generates.
 */
export function locateBaseline(rev, target) {
    if (!target.claimTokens.length) return null;
    const ids = identityMarkers(rev, target);
    const viaFootnote = bestAnchor(rev, target, ids);
    if (viaFootnote && viaFootnote.score >= MIN_ANCHOR) {
        return { method: 'footnote', ...stateAt(rev, target, { method: 'footnote' }) };
    }
    const viaAny = bestAnchor(rev, target, rev.markers.map((_, i) => i));
    if (viaAny && viaAny.score >= MIN_ANCHOR_ANY_FOOTNOTE) {
        const anchor = { method: 'claim', raw: rev.markers[viaAny.index].raw };
        return { ...anchor, ...stateAt(rev, target, anchor) };
    }
    const page = locateAnywhere(rev.pageTokens(), target.claimTokens);
    if (page.score >= MIN_PAGE_MATCH) return { method: 'page', ...stateAt(rev, target, { method: 'page' }) };
    return null;
}

/** Everything about the suggestion that a later revision is compared on. */
export function stateAt(rev, target, anchor) {
    if (anchor.method === 'page') {
        return { pageScore: locateAnywhere(rev.pageTokens(), target.claimTokens).score };
    }
    const ids = anchor.method === 'footnote'
        ? identityMarkers(rev, target)
        : rev.markers.map((m, i) => (m.raw === anchor.raw ? i : -1)).filter(i => i >= 0);
    const best = bestAnchor(rev, target, ids);
    if (!best) return { footnotePresent: false, sourcePresent: sourcePresent(rev, target) };
    const prose = rev.prose(best.index);
    const cluster = rev.cluster(best.index);
    return {
        footnotePresent: true,
        clusterKeys: cluster.map(i => footnoteKey(rev.markers[i])),
        footnoteIndex: best.index,
        footnoteRaw: rev.markers[best.index].raw,
        score: best.score,
        proseTokens: prose.tokens,
        proseRaw: prose.raw,
        flags: rev.flags(best.index),
        sourcePresent: sourcePresent(rev, target),
    };
}

function regionOf(baseline) {
    const { start } = alignSuffix(baseline.proseTokens, baseline.claimTokens ?? []);
    return baseline.proseTokens.slice(start);
}

/**
 * Compares a revision's state with the baseline. Returns the list of changes
 * (empty when nothing about this suggestion changed) and a short detail.
 *
 * The sentence comparison takes the last N tokens before the footnote, N
 * being the length of the claim's region in the baseline. A change elsewhere
 * in the paragraph doesn't move those tokens; a word changed inside the claim
 * does.
 */
export function compareStates(baseline, current) {
    const kinds = [];
    const detail = {};
    if (baseline.method === 'page') {
        if (current.pageScore < baseline.pageScore - 1e-9) {
            kinds.push(current.pageScore < MIN_ANCHOR ? CHANGE_KINDS.SENTENCE_REMOVED : CHANGE_KINDS.SENTENCE_EDITED);
            detail.pageScore = round(current.pageScore);
        }
        return { kinds, detail };
    }
    if (!current.footnotePresent) {
        kinds.push(current.claimElsewhere >= MIN_PAGE_MATCH ? CHANGE_KINDS.FOOTNOTE_REMOVED : CHANGE_KINDS.SENTENCE_AND_FOOTNOTE_REMOVED);
        return { kinds, detail };
    }
    const region = baseline.region;
    const now = current.proseTokens.slice(Math.max(0, current.proseTokens.length - region.length));
    if (current.score < MIN_ANCHOR) {
        kinds.push(CHANGE_KINDS.SENTENCE_REMOVED);
        detail.similarity = round(similarity(region, now));
    } else if (now.join(' ') !== region.join(' ')) {
        kinds.push(CHANGE_KINDS.SENTENCE_EDITED);
        detail.similarity = round(similarity(region, now));
    }
    if (baseline.sourcePresent === true && current.sourcePresent === false) kinds.push(CHANGE_KINDS.SOURCE_REPLACED);
    const newFootnotes = subtractMultiset(current.clusterKeys, baseline.clusterKeys);
    if (newFootnotes.length) {
        kinds.push(CHANGE_KINDS.FOOTNOTE_ADDED);
        detail.footnotes_added = newFootnotes;
    }
    const added = subtractMultiset(current.flags, baseline.flags);
    if (added.length) {
        kinds.push(CHANGE_KINDS.FLAG_ADDED);
        detail.flags = added;
    }
    const removed = subtractMultiset(baseline.flags, current.flags);
    if (removed.length) {
        kinds.push(CHANGE_KINDS.FLAG_REMOVED);
        detail.flags_removed = removed;
    }
    return { kinds, detail };
}

function subtractMultiset(a = [], b = []) {
    const left = [...b];
    const out = [];
    for (const x of a) {
        const i = left.indexOf(x);
        if (i >= 0) left.splice(i, 1); else out.push(x);
    }
    return out;
}

function round(x) { return Math.round(x * 1000) / 1000; }

/**
 * Tracks one suggestion across a page's revisions.
 *
 * @param {object} target       makeTarget(row)
 * @param {object} baselineRev  prepareRevision() of the last revision before go-live
 * @param {Array<{meta, rev}>} revisions  later revisions in time order; `rev`
 *   is prepareRevision() output, or null when the text is unavailable
 *   (deleted/suppressed), which is skipped and counted.
 */
export function trackSuggestion(target, baselineRev, revisions) {
    const located = locateBaseline(baselineRev, target);
    if (!located) return { located: null, first: null, end: null, skipped: 0 };
    located.claimTokens = target.claimTokens;
    if (located.method !== 'page') located.region = regionOf(located);

    const anchor = { method: located.method, raw: located.raw };
    let first = null;
    let end = null;
    let skipped = 0;
    let previous = { meta: null, state: located };
    for (const { meta, rev } of revisions) {
        if (!rev) { skipped++; continue; }
        const state = stateAt(rev, target, anchor);
        if (located.method !== 'page' && !state.footnotePresent) {
            state.claimElsewhere = locateAnywhere(rev.pageTokens(), target.claimTokens).score;
        }
        const { kinds, detail } = compareStates(located, state);
        if (kinds.length && !first) {
            first = { meta, kinds, detail, before: describe(previous.state), after: describe(state) };
        }
        end = { meta, kinds, detail };
        previous = { meta, state };
    }
    return { located, first, end, skipped };
}

// Short, human-readable before/after for the review sample.
function describe(state) {
    if (!state) return null;
    if (state.pageScore !== undefined) return { prose: '', footnote: '' };
    if (!state.footnotePresent) return { prose: '(footnote not found)', footnote: '' };
    return {
        prose: clip(state.proseRaw.trim(), 600, true),
        footnote: clip(state.footnoteRaw, 400) + (state.flags?.length ? ` {{${state.flags.join('}} {{')}}}` : ''),
    };
}

function clip(text, n, fromEnd = false) {
    if (text.length <= n) return text;
    return fromEnd ? `…${text.slice(text.length - n)}` : `${text.slice(0, n)}…`;
}
