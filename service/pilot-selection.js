// Scoring and ranking for the pilot article mix (see service/run-pick-pilot.js).
//
// WHAT THIS SELECTS FOR, AND WHY IT CHANGED (2026-09-16).
//
// The first version of this module selected for articles being edited *right
// now*: recent edit count, plus large boosts for a recently created page and
// for editing concentrated in a burst. That is a good description of a current
// event and a bad description of the thing the pilot actually needs.
//
// The two are not the same, and the gap is the whole problem. A batch of
// suggestions is generated, reviewed by volunteers, and only then surfaced to
// editors — days to weeks after selection. An article picked because it was
// spiking is, by then, an article nobody is working on. Sports events are the
// clearest case: a tournament final takes hundreds of edits in three days and
// then effectively none, ever again. Elections, disasters and recent deaths
// have the same shape. Every one of them topped the old ranking.
//
// So the signals are the same and the signs are different. What this module
// now selects for is an article that is **likely to be edited next month**:
//
//   * **persistence** (the largest single boost) — how many distinct months of
//     the history window the article was edited in. Six months out of six is a
//     page with a standing constituency; one out of six is an event.
//   * **editor breadth** — how many distinct editors made those edits. A page
//     several people watch keeps being maintained; a page one person built
//     over a weekend usually does not.
//   * **sustained edit volume** — the window's edit count with the burst
//     window's edits removed, so an article scores on its floor rather than
//     its spike.
//
// and against:
//
//   * **burst** — edits concentrated in the last few days relative to an even
//     spread. Was the second-largest boost; is now a penalty of the same size.
//   * **novelty** — a page created in the last fortnight. Was the largest
//     boost; is now a penalty. A page that did not exist three weeks ago has
//     no track record of surviving, and most of them are developing stories.
//   * **{{current}} and its siblings** — the tag says in so many words that the
//     article documents a developing event. Was a bonus; is now a penalty.
//     (It is on a handful of articles at any moment — measured at 6 on enwiki,
//     2026-09-09 — so it is a garnish either way, never load-bearing.)
//
// {{failed verification}} is unchanged: an editor has already read the source
// and disputed it, which is the highest-signal criterion available and has
// nothing to do with how busy the page is.
//
// Two hard filters do the rest of the work, because some articles are event
// pages no amount of scoring should let through:
//
//   * **minimum active buckets** — an article edited in fewer than N of the
//     history window's months is rejected outright. This is the filter that
//     kills one-shot event pages, and it is deliberately a filter rather than
//     a weight: no combination of edit volume and fetchable sources should buy
//     a page back in when the evidence says nobody will return to it.
//   * **event-shaped titles** — a year prefix ("2026 US Open", "2025-26 X
//     season") or "at the 2026 Olympics". A forthcoming event page *is*
//     persistently edited in the run-up, so persistence alone does not catch
//     it; the title does. See EVENT_TITLE_PATTERNS.
//
// Selection still runs in two stages against two kinds of signal:
//
//   1. Cheap, SQL-derived signals for the whole base population: the edit and
//      burst counts, the creation date, tag membership, and the bucketed
//      activity profile (service/article-picker.js's selectActivityProfiles).
//      These score a preliminary rank and cut the population to a shortlist
//      worth the cost of stage 2.
//   2. One expensive per-article signal needing a real fetch plus citation
//      extraction: how many of the article's citations have a URL, and how
//      many sit in tables. Only the shortlist pays this.
//
// Every function here is pure — no I/O, no randomness — so the mix logic is
// testable without a database or network connection, matching
// service/article-picker.js's split between query construction and execution.

export const DEFAULT_WEIGHTS = Object.freeze({
    // log2-scaled so volume differentiates without letting one viral article's
    // count of thousands swamp everything else. Applied to the *sustained*
    // count (window minus burst window), not the raw one — see
    // mergeSignals().
    sustainedEditScale: 12,
    // The largest single contributor, and the one the 2026-09-16 rewrite is
    // built around: editing spread across months is the best cheap predictor
    // available that the article will still be edited after the batch ships.
    persistenceBoost: 50,
    editorBreadthBoost: 25,
    failedVerificationBoost: 35,
    // The three ephemerality signals, all subtracted. Sized so that a pure
    // event page — all burst, brand new, tagged — cannot outscore a steadily
    // maintained article no matter how many edits its spike contained.
    burstPenalty: 45,
    noveltyPenalty: 35,
    currentTagPenalty: 40,
    // Multiplied by offlineRatio (0..1) and subtracted — a fully offline
    // article loses more than any single boost is worth, a fully online one
    // loses nothing.
    offlineRatioPenalty: 60,
});

export const DEFAULT_THRESHOLDS = Object.freeze({
    // Full novelty penalty at or below freshDays old, none at or above
    // staleDays, linear between.
    freshDays: 14,
    staleDays: 180,
    // Distinct editors at which editorBreadthFactor saturates. Not a cap on
    // anything real — past roughly this many people, "several editors watch
    // this page" is already established and more adds no information.
    editorBreadthTarget: 30,
    // persistenceFactor at or above which tierOf() calls an article durable.
    // Labels the reported mix; the score itself grades persistence
    // continuously.
    durableFactor: 0.6,
});

// Minimum distinct history buckets (months, at the default 30-day bucket) an
// article must have been edited in. 3 of 6 is deliberately lenient — the point
// is to exclude the one-and-two-month spikes, not to demand a perfect record.
export const DEFAULT_MIN_ACTIVE_BUCKETS = 3;

// An article whose last edit is older than this is dropped even if its history
// is otherwise persistent: a suggestion on a page nobody has opened in three
// weeks waits a long time to be seen.
export const DEFAULT_MAX_IDLE_DAYS = 21;

// Share of the pilot reserved for articles carrying {{failed verification}}.
//
// A quota rather than a bigger weight, because the two populations the pilot
// wants barely overlap. The quota is a floor, not a partition: flagged
// articles compete for the remaining slots on score like anything else, and an
// unfillable quota (fewer flagged articles in the base pool than the quota
// reserves) simply leaves those slots to the general ranking rather than
// padding them.
export const DEFAULT_FLAGGED_QUOTA_SHARE = 0.4;

// Share of the pilot reserved for biographies of living people.
//
// Asked for by participants in both the 2026-09-10 enwiki thread and the
// 2026-09-14 volunteer call. Levivich's reason is about *consequence*, not
// density: a citation that genuinely fails matters more on a BLP than on a
// railway line. A second reason, offered by Peter and agreed as also good,
// is practical — BLPs lean on news and other web-accessible sources, so more
// of their citations are fetchable at all.
//
// A floor rather than a weight, and a modest one, for the same reason the
// flagged quota is a floor: high-activity BLPs already score well on the
// durability signals (a watched biography is edited every month by several
// people), so this is insurance that a few are present, not a thumb on the
// scale. If a run reports more BLPs selected than the quota reserves, the
// quota never bound and the mix got there on its own.
export const DEFAULT_BLP_QUOTA_SHARE = 0.15;

// Above this fraction of citations lacking a URL, an article is excluded
// outright rather than merely penalized: the sweep can only fetch a URL, so
// a majority-offline article mostly returns SOURCE UNAVAILABLE regardless of
// verdict quality, which tests source-fetcher luck, not the model. Tunable —
// passed through service/run-pick-pilot.js's --offline-ratio-max.
export const DEFAULT_OFFLINE_RATIO_CEILING = 0.6;

// Above this share of citations sitting inside a <table>, an article is
// excluded.
//
// This predates the rewrite above and survives it: the current-events signals
// selected for tournament draws almost perfectly, and a first real run
// returned six 2026 US Open draw pages plus a dozen other results tables —
// roughly 40% of the pilot. Scoring for durability removes most of that
// population at the source, but a *recurring* results page (an annual league
// table edited every season) is durable and still worthless to verify.
//
// They are worthless because the claim an extractor pulls from a bracket cell
// is "6-4, 7-5, 6-2" or a seeding number: long enough to clear
// MIN_CLAIM_LENGTH, meaningless to ask a model about, and the citation behind
// it is a draw sheet rather than prose. The same goes for discographies,
// episode lists and "X at the Y Games" medal tables.
//
// Prose articles are not near this line — an infobox and a couple of tables
// put a normal article in the 5-20% range, while a results page is 80-100%.
export const DEFAULT_TABLE_RATIO_CEILING = 0.5;

// Titles that name an occasion rather than a subject.
//
// These are excluded regardless of score, because the persistence signal
// cannot catch them on its own: an article about a *forthcoming* event is
// edited steadily for months beforehand and looks exactly like a durable page
// right up until the event happens and the editing stops for good.
//
// Kept deliberately small and literal. Every pattern here is anchored on a
// four-digit year, which is what makes it safe: "2026 US Open" is an occasion,
// "US Open" is a subject, and the second is untouched. Widening this to bare
// topic words (cup, final, championship, season) would take out "Stanley Cup"
// and "Monsoon season" with them — if this list ever needs to grow, grow it
// with year-anchored patterns, not vocabulary.
// A year prefix alone is NOT enough, and assuming it was is a mistake this
// filter already made once. Measured against the two batches selected under
// the old criteria, 68 of 200 titles carried a year — overwhelmingly fixtures
// and elections, but a real minority were open-ended situations that stay live
// for months: "2026 Yemen offensives", "2026-2027 El Nino event", "2026
// Nepal-Tibet floods", "2026 Nigerien coup attempt", "2026 in the United
// Kingdom". Those are exactly the articles the persistence signal handles
// correctly on its own, and the title rule was overriding it.
//
// So the year is the guard and the vocabulary is the test. A scheduled
// occasion has a date in its name *and* says what kind of occasion it is.
const YEAR = String.raw`(?:1\d{3}|2\d{3})`;

// Only ever consulted for a title that already carries a year — which is what
// keeps "Stanley Cup", "Monsoon season" and "US Open" out of it. Note \bOpen\b
// does not match "OpenAI".
const SCHEDULED_OCCASION = new RegExp(String.raw`\b(?:` + [
    // Competitions and fixtures
    'Open', 'Cup', 'Championships?', 'Masters', 'Olympics', 'Games', 'Grand Prix',
    'Challenger', 'Classic', 'Invitational', 'Tournament', 'League', 'Trophy',
    'Series', 'Playoffs?', 'Finals?', 'Qualifiers?', 'Qualifying', 'Qualification',
    'Singles', 'Doubles', 'Squads', 'Season', 'Tour', 'Conference',
    'football team', 'football game',
    // Scheduled political and civic events
    'Elections?', 'Primaries', 'Primary', 'Referendum', 'Census',
    // Scheduled culture
    'Festival', 'Awards?', 'Contest', 'Expo',
].join('|') + String.raw`)\b`, 'i');

export const EVENT_TITLE_PATTERNS = Object.freeze([
    // "2026 US Open (tennis)", "2026-27 F.C. Copenhagen season",
    // "2028 Republican Party presidential primaries".
    //
    // The lookahead excludes a work *titled* with a year, where the year is
    // the whole title and what follows is a parenthesized disambiguator:
    // "1984 (novel)", "1917 (2019 film)". Those are subjects.
    {
        test: title => new RegExp(String.raw`^${YEAR}(?:[-–—]\d{2,4})?[ _](?!\()`).test(title)
            && SCHEDULED_OCCASION.test(title),
    },
    // "Athletics at the 2026 Summer Olympics", "Kenya at the 2026 Games" —
    // "at the <year>" is already a fixture construction, so it stands alone.
    new RegExp(String.raw`\bat the ${YEAR}[ _]`, 'i'),
    // "Deaths in September 2026"
    /^Deaths in[ _]/i,
]);

/** Whether a title names a scheduled occasion rather than a subject. */
export function isEventShaped(title) {
    if (typeof title !== 'string' || !title) return false;
    return EVENT_TITLE_PATTERNS.some(pattern => pattern.test(title));
}

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
 * Share of citations attached to table cells rather than running prose.
 *
 * Reads the `refElement` collectCitations() already returns, so this costs
 * nothing beyond the parse stage 2 has done anyway — no second fetch, no
 * second DOM. See DEFAULT_TABLE_RATIO_CEILING for why it matters.
 */
export function computeTableRatio(citations) {
    if (!citations || citations.length === 0) return null;
    const inTable = citations.filter(c => c?.refElement?.closest?.('table')).length;
    return inTable / citations.length;
}

/**
 * 1 for an article no older than freshDays, 0 at staleDays and beyond, linear
 * between. Feeds the *novelty penalty* — a brand-new page is the one least
 * likely to still be worked on once a batch ships.
 *
 * An unknown age scores 0 rather than being treated as fresh: a missing
 * creation date must not manufacture a penalty any more than it once was
 * allowed to manufacture a boost.
 */
export function recencyFactor(ageDays, { freshDays, staleDays } = DEFAULT_THRESHOLDS) {
    if (typeof ageDays !== 'number' || Number.isNaN(ageDays)) return 0;
    if (ageDays <= freshDays) return 1;
    if (ageDays >= staleDays) return 0;
    return (staleDays - ageDays) / (staleDays - freshDays);
}

/**
 * How concentrated an article's editing is, normalized against what an evenly
 * edited article would score. Feeds the *burst penalty*.
 *
 * `burstRatio` is edits in the short window over edits in the whole window.
 * `baseline` is the ratio the two window lengths produce on their own (3 days
 * of a 30-day window is 0.1), so an evenly edited page normalizes to 0 and one
 * edited entirely within the burst window to 1. Without that subtraction every
 * article would collect most of the penalty just for existing.
 */
export function burstFactor(burstRatio, baseline = 0) {
    if (typeof burstRatio !== 'number' || Number.isNaN(burstRatio)) return 0;
    if (baseline >= 1) return 0;
    return Math.min(1, Math.max(0, (burstRatio - baseline) / (1 - baseline)));
}

/**
 * How spread out an article's editing is across the history window: 0 when
 * every edit landed in a single bucket, 1 when every bucket saw at least one.
 *
 * Counting *which* buckets were touched rather than how many edits each holds
 * is the point — it is a record of people coming back, which is the thing
 * being predicted. An unmeasured profile scores 0, never a boost.
 */
export function persistenceFactor(activeBuckets, bucketCount) {
    if (typeof activeBuckets !== 'number' || Number.isNaN(activeBuckets)) return 0;
    if (typeof bucketCount !== 'number' || bucketCount < 2) return 0;
    return Math.min(1, Math.max(0, (activeBuckets - 1) / (bucketCount - 1)));
}

/**
 * How many different people edited the article, log-scaled and saturating at
 * `target`. One prolific editor and thirty occasional ones produce the same
 * edit count and very different odds of anyone showing up next month.
 */
export function editorBreadthFactor(distinctEditors, { editorBreadthTarget } = DEFAULT_THRESHOLDS) {
    if (typeof distinctEditors !== 'number' || Number.isNaN(distinctEditors) || distinctEditors <= 0) return 0;
    if (!(editorBreadthTarget > 1)) return 0;
    return Math.min(1, Math.log2(1 + distinctEditors) / Math.log2(1 + editorBreadthTarget));
}

/**
 * Attaches every stage-1 signal to the top-edited base population.
 *
 * `currentTagIds` / `failedVerificationIds` are Sets of pageId from
 * service/article-picker.js's selectTagMembership() — membership tested
 * against this pool's own ids, not a capped pull of the whole tagged
 * population (see that function's comment for why the cap was wrong).
 * `creationDates` is a Map<pageId, Date> from selectCreationDates();
 * `activityProfiles` a Map<pageId, profile> from selectActivityProfiles().
 */
export function mergeSignals(topEdited, {
    currentTagIds = new Set(),
    failedVerificationIds = new Set(),
    blpIds = new Set(),
    creationDates = new Map(),
    activityProfiles = new Map(),
    burstBaseline = 0,
    now = new Date(),
} = {}) {
    return topEdited.map(candidate => {
        const created = creationDates.get(candidate.pageId) ?? null;
        const profile = activityProfiles.get(candidate.pageId) ?? null;
        const editCount = candidate.editCount ?? 0;
        const recentEditCount = candidate.recentEditCount;

        return {
            ...candidate,
            currentTag: currentTagIds.has(candidate.pageId),
            failedVerification: failedVerificationIds.has(candidate.pageId),
            isBlp: blpIds.has(candidate.pageId),
            createdAt: created ? created.toISOString() : null,
            ageDays: created ? (now.getTime() - created.getTime()) / 86400000 : null,
            burstRatio: editCount > 0 && recentEditCount != null
                ? recentEditCount / editCount
                : null,
            burstBaseline,
            // The window's edits with the burst window's removed: what the
            // article does when it is not spiking. An unmeasured burst count
            // falls back to the raw count rather than scoring the article at
            // zero volume.
            sustainedEditCount: recentEditCount == null
                ? editCount
                : Math.max(0, editCount - recentEditCount),
            historyEditCount: profile?.historyEditCount ?? null,
            activeBuckets: profile?.activeBuckets ?? null,
            bucketCount: profile?.bucketCount ?? null,
            bucketCounts: profile?.bucketCounts ?? null,
            distinctEditors: profile?.distinctEditors ?? null,
            lastEditAt: profile?.lastEditAt ? profile.lastEditAt.toISOString() : null,
            idleDays: profile?.lastEditAt
                ? (now.getTime() - profile.lastEditAt.getTime()) / 86400000
                : null,
            eventShaped: isEventShaped(candidate.title),
            offlineRatio: null,
            tableRatio: null,
            citationCount: null,
        };
    });
}

function sustainedEditComponent(candidate, weights) {
    const count = candidate.sustainedEditCount ?? candidate.editCount ?? 0;
    return weights.sustainedEditScale * Math.log2(count + 1);
}

/**
 * Composite score. Safe to call before offlineRatio is known (stage 1 —
 * offlineRatio is null, so the penalty term is simply skipped) and after
 * (stage 2 — the penalty applies).
 */
export function scoreCandidate(signals, weights = DEFAULT_WEIGHTS, thresholds = DEFAULT_THRESHOLDS) {
    let score = sustainedEditComponent(signals, weights);

    score += weights.persistenceBoost * persistenceFactor(signals.activeBuckets, signals.bucketCount);
    score += weights.editorBreadthBoost * editorBreadthFactor(signals.distinctEditors, thresholds);
    if (signals.failedVerification) score += weights.failedVerificationBoost;

    score -= weights.burstPenalty * burstFactor(signals.burstRatio, signals.burstBaseline ?? 0);
    score -= weights.noveltyPenalty * recencyFactor(signals.ageDays, thresholds);
    if (signals.currentTag) score -= weights.currentTagPenalty;

    if (typeof signals.offlineRatio === 'number') {
        score -= weights.offlineRatioPenalty * signals.offlineRatio;
    }
    return score;
}

/** Whether an article's editing is spread widely enough to read as durable. */
export function isDurable(signals, thresholds = DEFAULT_THRESHOLDS) {
    return persistenceFactor(signals.activeBuckets, signals.bucketCount) >= thresholds.durableFactor;
}

// Labels the mix's composition so a run's tier breakdown (how many pilot
// slots came from which signal combination) is visible without recomputing
// it from raw signals — service/run-pick-pilot.js prints this per run.
export function tierOf(signals, thresholds = DEFAULT_THRESHOLDS) {
    const durable = isDurable(signals, thresholds);
    if (durable && signals.failedVerification) return 'durable+flagged';
    if (signals.failedVerification) return 'flagged';
    if (durable) return 'durable';
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

// --- Filters ---
//
// Both return a reason string or null, rather than a boolean, so a run can
// report *why* the pool shrank. That report is not a nicety: the commitment
// made to volunteers on the 2026-09-14 call was to "share how we generated
// it" before a batch ships, and "412 candidates, term by term" is the
// shareable form of that.

/**
 * Stage-1 rejection: the article's own history says it has no future, or its
 * title names an occasion. Applied before a fetch is spent on it.
 *
 * An unmeasured profile (no rows in the history window) does NOT pass — a
 * missing measurement must not read as a good one. That case is an article
 * whose entire history is younger than the window, i.e. exactly the new
 * event page this filter exists for.
 */
export function activityRejection(candidate, {
    minActiveBuckets = DEFAULT_MIN_ACTIVE_BUCKETS,
    maxIdleDays = DEFAULT_MAX_IDLE_DAYS,
    allowEventTitles = false,
} = {}) {
    if (!allowEventTitles && candidate.eventShaped) return 'event-title';
    if (minActiveBuckets > 0) {
        if (typeof candidate.activeBuckets !== 'number') return 'no-history';
        if (candidate.activeBuckets < minActiveBuckets) return 'low-persistence';
    }
    if (typeof maxIdleDays === 'number' && typeof candidate.idleDays === 'number'
        && candidate.idleDays > maxIdleDays) {
        return 'idle';
    }
    return null;
}

export function passesActivityFilter(candidate, options) {
    return activityRejection(candidate, options) === null;
}

/**
 * Stage-2 rejection: it has citations to check, enough of them are fetchable,
 * and enough are attached to prose rather than to table cells. Split out from
 * finalizeRanking() so the runner can apply it per article as it goes and stop
 * once it has enough survivors, rather than fetching the whole shortlist
 * first.
 *
 * An unmeasured ratio (null — a fetch that failed) passes here and is caught
 * by the citationCount check instead, so a missing measurement never silently
 * counts as a good one.
 */
export function contentRejection(candidate, {
    offlineRatioCeiling = DEFAULT_OFFLINE_RATIO_CEILING,
    tableRatioCeiling = DEFAULT_TABLE_RATIO_CEILING,
} = {}) {
    if ((candidate.citationCount ?? 0) <= 0) return 'no-citations';
    if (typeof candidate.offlineRatio === 'number' && candidate.offlineRatio > offlineRatioCeiling) {
        return 'offline-sources';
    }
    if (typeof candidate.tableRatio === 'number' && candidate.tableRatio > tableRatioCeiling) {
        return 'table-heavy';
    }
    return null;
}

export function passesContentFilter(candidate, options) {
    return contentRejection(candidate, options) === null;
}

/**
 * Splits a ranking into the flagged pool and everything else, each keeping
 * its relative order. The runner fetches the flagged pool first so a quota
 * for that (much smaller) population can actually be filled — which pool an
 * article is fetched from has no bearing on its score, only on whether it
 * gets looked at before the fetch budget runs out.
 */
export function splitFlaggedPool(candidates) {
    return {
        flagged: candidates.filter(c => c.failedVerification),
        rest: candidates.filter(c => !c.failedVerification),
    };
}

export function quotaFor(limit, share = DEFAULT_FLAGGED_QUOTA_SHARE) {
    return Math.round(limit * Math.min(1, Math.max(0, share)));
}

/**
 * Takes `limit` candidates from a scored, descending ranking, reserving slots
 * for flagged articles and for BLPs before filling the rest by score. Returns
 * the selection in score order, so the output reads as one ranking.
 *
 * Both reserves behave the same way, and the way the flagged one always has:
 * a floor, not a partition. An article in either population still competes for
 * the remaining slots on score, an unfillable reserve leaves its slots to the
 * general ranking rather than padding them, and an article that is both is
 * taken once.
 */
export function allocateWithQuota(scored, { limit = 100, flaggedQuota = 0, blpQuota = 0 } = {}) {
    const taken = new Set();

    // An article already reserved by the previous quota still counts toward
    // this one — it is in the mix, which is what the quota asks for — so the
    // two reserves never spend two slots on one article.
    const reserve = (predicate, count) => {
        let added = 0;
        for (const candidate of scored) {
            if (added >= count || taken.size >= limit) break;
            if (!predicate(candidate)) continue;
            taken.add(candidate);
            added++;
        }
    };

    reserve(c => c.failedVerification, flaggedQuota);
    reserve(c => c.isBlp, blpQuota);

    for (const candidate of scored) {
        if (taken.size >= limit) break;
        taken.add(candidate);
    }
    return [...taken].sort((a, b) => b.score - a.score);
}

/**
 * Stage-2 (final) ranking, after offlineRatio/citationCount have been filled
 * in. Applies both filters — the activity one again, so a caller that skipped
 * it cannot slip an event page through here — scores and sorts the remainder,
 * then applies the flagged quota.
 */
export function finalizeRanking(candidates, {
    limit = 100,
    flaggedQuota = 0,
    blpQuota = 0,
    offlineRatioCeiling = DEFAULT_OFFLINE_RATIO_CEILING,
    tableRatioCeiling = DEFAULT_TABLE_RATIO_CEILING,
    minActiveBuckets = DEFAULT_MIN_ACTIVE_BUCKETS,
    maxIdleDays = DEFAULT_MAX_IDLE_DAYS,
    allowEventTitles = false,
    weights = DEFAULT_WEIGHTS,
    thresholds = DEFAULT_THRESHOLDS,
} = {}) {
    const scored = candidates
        .filter(c => passesContentFilter(c, { offlineRatioCeiling, tableRatioCeiling }))
        .filter(c => passesActivityFilter(c, { minActiveBuckets, maxIdleDays, allowEventTitles }))
        .map(c => ({ ...c, score: scoreCandidate(c, weights, thresholds), tier: tierOf(c, thresholds) }))
        .sort((a, b) => b.score - a.score);

    return allocateWithQuota(scored, { limit, flaggedQuota, blpQuota });
}
