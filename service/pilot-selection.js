// Scoring and ranking for the 100-article pilot mix (see service/run-pick-pilot.js).
//
// Selection runs in two stages against two different kinds of signal:
//
//   1. Cheap, SQL-derived signals available for the whole base population:
//      recent edit count, how much of that editing is a burst, how recently
//      the article was created, and whether it carries a {{current}} or
//      {{failed verification}} tag. These score a preliminary rank and cut
//      the base population down to a shortlist worth the cost of stage 2.
//   2. One expensive per-article signal that needs a real fetch plus citation
//      extraction: how many of the article's citations even have a URL. Only
//      the shortlist pays this, and the runner stops as soon as it has enough
//      survivors.
//
// WHY CURRENT EVENTS ARE NOT DETECTED BY THE {{current}} TAG. The first cut of
// this module leaned on that tag. Measured against enwiki on 2026-09-09, it
// was on **6 articles** — the tag goes up in the first hours of a breaking
// story and comes off within days, so it can contribute at most a handful of
// rows to a 100-article pilot. The two signals that actually carry the
// current-events bias are therefore untagged and unfakeable:
//
//   * **recency** — when the article was created. A page that did not exist
//     three weeks ago and is being edited heavily now is a developing story
//     almost by construction.
//   * **burst** — what share of the window's edits landed in the last few
//     days. This is what separates a breaking story (nearly all of them) from
//     a perennially busy page like a head of state's biography (edits spread
//     evenly), which recency alone cannot do: a decades-old article can become
//     today's news.
//
// The tag is kept as a bonus on top, because when it *is* present it is
// unambiguous — just never as the thing the mix depends on.
//
// Every function here is pure — no I/O, no randomness — so the mix logic is
// testable without a database or network connection, matching
// service/article-picker.js's split between query construction and execution.

export const DEFAULT_WEIGHTS = Object.freeze({
    // log2-scaled so edit count differentiates without letting one viral
    // article's count of thousands swamp the boosts below entirely.
    editCountScale: 12,
    // The two untagged current-events signals, deliberately the largest
    // single contributors: together they outweigh anything else a candidate
    // can accumulate.
    recencyBoost: 45,
    burstBoost: 45,
    // Present on a handful of articles at any moment — a bonus, not a
    // load-bearing signal. See the header.
    currentTagBoost: 40,
    failedVerificationBoost: 35,
    // Multiplied by offlineRatio (0..1) and subtracted — a fully offline
    // article loses more than any single boost is worth, a fully online one
    // loses nothing.
    offlineRatioPenalty: 60,
});

export const DEFAULT_THRESHOLDS = Object.freeze({
    // Full recency boost at or below freshDays old, none at or above
    // staleDays, linear between.
    freshDays: 14,
    staleDays: 180,
    // What counts as "a current event" for tier labelling (which drives the
    // run's reported mix), independent of the score itself.
    currentAgeDays: 30,
    currentBurstFactor: 0.5,
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
 * 1 for an article no older than freshDays, 0 at staleDays and beyond, linear
 * between. An unknown age scores 0 rather than being treated as fresh — a
 * missing creation date must not manufacture a boost.
 */
export function recencyFactor(ageDays, { freshDays, staleDays } = DEFAULT_THRESHOLDS) {
    if (typeof ageDays !== 'number' || Number.isNaN(ageDays)) return 0;
    if (ageDays <= freshDays) return 1;
    if (ageDays >= staleDays) return 0;
    return (staleDays - ageDays) / (staleDays - freshDays);
}

/**
 * How concentrated an article's editing is, normalized against what an evenly
 * edited article would score.
 *
 * `burstRatio` is edits in the short window over edits in the whole window.
 * `baseline` is the ratio the two window lengths produce on their own (3 days
 * of a 14-day window is 0.214), so an evenly edited page normalizes to 0 and
 * one edited entirely within the burst window to 1. Without that subtraction
 * every article would collect most of the burst boost just for existing.
 */
export function burstFactor(burstRatio, baseline = 0) {
    if (typeof burstRatio !== 'number' || Number.isNaN(burstRatio)) return 0;
    if (baseline >= 1) return 0;
    return Math.min(1, Math.max(0, (burstRatio - baseline) / (1 - baseline)));
}

/**
 * Whether an article reads as a current event — by the tag, by being new, or
 * by its editing being a burst. Used for the tier label the run reports its
 * mix in, not for the score (which grades all three continuously).
 */
export function isCurrentEvent(signals, thresholds = DEFAULT_THRESHOLDS) {
    if (signals.currentTag) return true;
    if (typeof signals.ageDays === 'number' && signals.ageDays <= thresholds.currentAgeDays) return true;
    return burstFactor(signals.burstRatio, signals.burstBaseline ?? 0) >= thresholds.currentBurstFactor;
}

/**
 * Attaches every stage-1 signal to the top-edited base population.
 *
 * `currentTagIds` / `failedVerificationIds` are Sets of pageId from
 * service/article-picker.js's selectTagMembership() — membership tested
 * against this pool's own ids, not a capped pull of the whole tagged
 * population (see that function's comment for why the cap was wrong).
 * `creationDates` is a Map<pageId, Date> from selectCreationDates().
 */
export function mergeSignals(topEdited, {
    currentTagIds = new Set(),
    failedVerificationIds = new Set(),
    creationDates = new Map(),
    burstBaseline = 0,
    now = new Date(),
} = {}) {
    return topEdited.map(candidate => {
        const created = creationDates.get(candidate.pageId) ?? null;
        const editCount = candidate.editCount ?? 0;
        return {
            ...candidate,
            currentTag: currentTagIds.has(candidate.pageId),
            failedVerification: failedVerificationIds.has(candidate.pageId),
            createdAt: created ? created.toISOString() : null,
            ageDays: created ? (now.getTime() - created.getTime()) / 86400000 : null,
            burstRatio: editCount > 0 && candidate.recentEditCount != null
                ? candidate.recentEditCount / editCount
                : null,
            burstBaseline,
            offlineRatio: null,
            citationCount: null,
        };
    });
}

function editCountComponent(editCount, weights) {
    return weights.editCountScale * Math.log2((editCount ?? 0) + 1);
}

/**
 * Composite score. Safe to call before offlineRatio is known (stage 1 —
 * offlineRatio is null, so the penalty term is simply skipped) and after
 * (stage 2 — the penalty applies).
 */
export function scoreCandidate(signals, weights = DEFAULT_WEIGHTS, thresholds = DEFAULT_THRESHOLDS) {
    let score = editCountComponent(signals.editCount, weights);
    score += weights.recencyBoost * recencyFactor(signals.ageDays, thresholds);
    score += weights.burstBoost * burstFactor(signals.burstRatio, signals.burstBaseline ?? 0);
    if (signals.currentTag) score += weights.currentTagBoost;
    if (signals.failedVerification) score += weights.failedVerificationBoost;
    if (typeof signals.offlineRatio === 'number') {
        score -= weights.offlineRatioPenalty * signals.offlineRatio;
    }
    return score;
}

// Labels the mix's composition so a run's tier breakdown (how many pilot
// slots came from which signal combination) is visible without recomputing
// it from raw signals — service/run-pick-pilot.js prints this per run.
export function tierOf(signals, thresholds = DEFAULT_THRESHOLDS) {
    const current = isCurrentEvent(signals, thresholds);
    if (current && signals.failedVerification) return 'current+flagged';
    if (signals.failedVerification) return 'flagged';
    if (current) return 'current';
    return 'baseline';
}

/**
 * Stage-1 ranking: scores every candidate on the cheap signals alone
 * (offlineRatio not yet known) and sorts descending. This order is also the
 * order stage 2 fetches in, so the runner can stop early with the best
 * candidates already checked.
 */
export function preliminaryRank(candidates, weights = DEFAULT_WEIGHTS, thresholds = DEFAULT_THRESHOLDS) {
    return candidates
        .map(c => ({ ...c, preliminaryScore: scoreCandidate(c, weights, thresholds) }))
        .sort((a, b) => b.preliminaryScore - a.preliminaryScore);
}

export function shortlist(candidates, {
    size = 300, weights = DEFAULT_WEIGHTS, thresholds = DEFAULT_THRESHOLDS,
} = {}) {
    return preliminaryRank(candidates, weights, thresholds).slice(0, size);
}

/**
 * Whether a candidate survives stage 2: it has citations to check, and enough
 * of them are fetchable. Split out from finalizeRanking() so the runner can
 * apply it per article as it goes and stop once it has enough survivors,
 * rather than fetching the whole shortlist first.
 */
export function passesOfflineFilter(candidate, offlineRatioCeiling = DEFAULT_OFFLINE_RATIO_CEILING) {
    if ((candidate.citationCount ?? 0) <= 0) return false;
    if (candidate.offlineRatio === null || candidate.offlineRatio === undefined) return true;
    return candidate.offlineRatio <= offlineRatioCeiling;
}

/**
 * Stage-2 (final) ranking, after offlineRatio/citationCount have been filled
 * in. Drops anything with no citations at all (nothing to verify) or with an
 * offlineRatio above the ceiling, then scores and sorts the remainder.
 */
export function finalizeRanking(candidates, {
    limit = 100,
    offlineRatioCeiling = DEFAULT_OFFLINE_RATIO_CEILING,
    weights = DEFAULT_WEIGHTS,
    thresholds = DEFAULT_THRESHOLDS,
} = {}) {
    return candidates
        .filter(c => passesOfflineFilter(c, offlineRatioCeiling))
        .map(c => ({ ...c, score: scoreCandidate(c, weights, thresholds), tier: tierOf(c, thresholds) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
}
