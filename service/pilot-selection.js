// Scoring and ranking for the 100-article pilot mix (see service/run-pick-pilot.js).
//
// Selection runs in two stages against two different kinds of signal:
//
//   1. Cheap, SQL-derived signals available for the whole base population:
//      recent edit count (service/article-picker.js's selectTopEdited()),
//      {{current}} tag membership, and {{failed verification}} tag membership
//      (both via the existing template-transclusion criteria). These score a
//      preliminary rank and cut the base population down to a shortlist worth
//      the cost of stage 2.
//   2. Expensive, per-article signals that need a real fetch + citation
//      extraction: how many of an article's citations even have a URL. Only
//      the shortlist pays this cost, not the whole base population — the same
//      reason service/run-pick-pilot.js's shortlist stage exists at all.
//
// Every function here is pure — no I/O, no randomness — so the mix logic is
// testable without a database or network connection, matching
// service/article-picker.js's split between query construction and execution.

export const DEFAULT_WEIGHTS = Object.freeze({
    // log2-scaled so edit count differentiates without letting one viral
    // article's count of thousands swamp the two boosts below entirely.
    editCountScale: 12,
    currentEventBoost: 50,
    failedVerificationBoost: 35,
    // Multiplied by offlineRatio (0..1) and subtracted — a fully offline
    // article loses more than either boost is worth, a fully online one
    // loses nothing.
    offlineRatioPenalty: 60,
});

// Above this fraction of citations lacking a URL, an article is excluded
// outright rather than merely penalized: the sweep can only fetch a URL, so
// a majority-offline article mostly returns SOURCE UNAVAILABLE regardless of
// verdict quality, which tests source-fetcher luck, not the model. Tunable —
// passed through service/run-pick-pilot.js's --offline-ratio-max.
export const DEFAULT_OFFLINE_RATIO_CEILING = 0.6;

/**
 * Fraction of citations with no URL at all — core/citations.js's collectCitations()
 * leaves `url` null/undefined for a bare {{cite book}}/{{cite journal}} with no
 * `url=`, which is exactly "this citation cannot be fetched". Returns null for
 * an article with zero citations: nothing to score, not "fully online".
 */
export function computeOfflineRatio(citations) {
    if (!citations || citations.length === 0) return null;
    const offline = citations.filter(c => !c?.url).length;
    return offline / citations.length;
}

/**
 * Attaches the two boolean tag signals to every row of the top-edited base
 * population. `currentEventIds` / `failedVerificationIds` are Sets of pageId,
 * built from service/article-picker.js's selectCandidates() output for the
 * 'current-event' and 'failed-verification' criteria respectively — full
 * membership sets, not per-candidate lookups, so this stays O(n).
 */
export function mergeSignals(topEdited, {
    currentEventIds = new Set(),
    failedVerificationIds = new Set(),
} = {}) {
    return topEdited.map(candidate => ({
        ...candidate,
        currentEvent: currentEventIds.has(candidate.pageId),
        failedVerification: failedVerificationIds.has(candidate.pageId),
        offlineRatio: null,
        citationCount: null,
    }));
}

function editCountComponent(editCount, weights) {
    return weights.editCountScale * Math.log2((editCount ?? 0) + 1);
}

/**
 * Composite score. Safe to call before offlineRatio is known (stage 1 —
 * offlineRatio is null, so the penalty term is simply skipped) and after
 * (stage 2 — the penalty applies).
 */
export function scoreCandidate(signals, weights = DEFAULT_WEIGHTS) {
    let score = editCountComponent(signals.editCount, weights);
    if (signals.currentEvent) score += weights.currentEventBoost;
    if (signals.failedVerification) score += weights.failedVerificationBoost;
    if (typeof signals.offlineRatio === 'number') {
        score -= weights.offlineRatioPenalty * signals.offlineRatio;
    }
    return score;
}

// Labels the mix's composition so a run's tier breakdown (how many pilot
// slots came from which signal combination) is visible without recomputing
// it from raw booleans — service/run-pick-pilot.js prints this per article.
export function tierOf(signals) {
    if (signals.currentEvent && signals.failedVerification) return 'current+flagged';
    if (signals.failedVerification) return 'flagged';
    if (signals.currentEvent) return 'current';
    return 'baseline';
}

/**
 * Stage-1 ranking: scores every candidate on the cheap signals alone
 * (offlineRatio not yet known) and sorts descending. Used to build the
 * shortlist that stage 2's per-article fetch will actually run against.
 */
export function preliminaryRank(candidates, weights = DEFAULT_WEIGHTS) {
    return candidates
        .map(c => ({ ...c, preliminaryScore: scoreCandidate(c, weights) }))
        .sort((a, b) => b.preliminaryScore - a.preliminaryScore);
}

export function shortlist(candidates, { size = 300, weights = DEFAULT_WEIGHTS } = {}) {
    return preliminaryRank(candidates, weights).slice(0, size);
}

/**
 * Stage-2 (final) ranking, after offlineRatio/citationCount have been filled
 * in on the shortlist. Drops anything with no citations at all (nothing to
 * verify) or with an offlineRatio above the ceiling (mostly unfetchable),
 * then scores and sorts the remainder.
 */
export function finalizeRanking(candidates, {
    limit = 100,
    offlineRatioCeiling = DEFAULT_OFFLINE_RATIO_CEILING,
    weights = DEFAULT_WEIGHTS,
} = {}) {
    const usable = candidates.filter(c =>
        (c.citationCount ?? 0) > 0
        && (c.offlineRatio === null || c.offlineRatio === undefined || c.offlineRatio <= offlineRatioCeiling)
    );

    return usable
        .map(c => ({ ...c, score: scoreCandidate(c, weights), tier: tierOf(c) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
}
