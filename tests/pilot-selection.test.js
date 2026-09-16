import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    DEFAULT_WEIGHTS,
    DEFAULT_THRESHOLDS,
    DEFAULT_OFFLINE_RATIO_CEILING,
    DEFAULT_TABLE_RATIO_CEILING,
    DEFAULT_MIN_ACTIVE_BUCKETS,
    EVENT_TITLE_PATTERNS,
    computeOfflineRatio,
    computeTableRatio,
    recencyFactor,
    burstFactor,
    persistenceFactor,
    editorBreadthFactor,
    isEventShaped,
    isDurable,
    mergeSignals,
    scoreCandidate,
    tierOf,
    preliminaryRank,
    shortlist,
    activityRejection,
    passesActivityFilter,
    contentRejection,
    passesContentFilter,
    finalizeRanking,
    splitFlaggedPool,
    quotaFor,
    allocateWithQuota,
} from '../service/pilot-selection.js';

// A candidate with a clean bill of health on every filter, so a test can
// change exactly the one signal it is about.
const durableSignals = (overrides = {}) => ({
    title: 'Some Subject',
    editCount: 40,
    recentEditCount: 4,
    sustainedEditCount: 36,
    activeBuckets: 6,
    bucketCount: 6,
    distinctEditors: 20,
    idleDays: 1,
    eventShaped: false,
    citationCount: 10,
    offlineRatio: 0.1,
    tableRatio: 0.1,
    ...overrides,
});

test('computeOfflineRatio counts citations with no url as offline', () => {
    assert.equal(computeOfflineRatio([{ url: 'https://x' }, { url: null }, { url: undefined }]), 2 / 3);
    assert.equal(computeOfflineRatio([{ url: 'https://x' }, { url: 'https://y' }]), 0);
    assert.equal(computeOfflineRatio([{ url: null }]), 1);
});

test('computeOfflineRatio returns null for an article with no citations, not 0 or 1', () => {
    assert.equal(computeOfflineRatio([]), null);
    assert.equal(computeOfflineRatio(null), null);
});

test('computeTableRatio counts citations sitting inside a table', () => {
    const inTable = { refElement: { closest: sel => (sel === 'table' ? {} : null) } };
    const inProse = { refElement: { closest: () => null } };
    assert.equal(computeTableRatio([inTable, inTable, inProse, inProse]), 0.5);
    assert.equal(computeTableRatio([inProse]), 0);
    assert.equal(computeTableRatio([inTable]), 1);
});

test('computeTableRatio tolerates citations with no element attached', () => {
    assert.equal(computeTableRatio([]), null);
    assert.equal(computeTableRatio(null), null);
    assert.equal(computeTableRatio([{}, { refElement: null }]), 0);
});

// --- The signals that predict future editing ---

test('persistenceFactor grades how many buckets saw an edit, not how many edits', () => {
    assert.equal(persistenceFactor(1, 6), 0, 'a single active month is an event, not a habit');
    assert.equal(persistenceFactor(6, 6), 1);
    assert.equal(persistenceFactor(3, 6), 0.4);
    assert.equal(persistenceFactor(0, 6), 0);
});

test('persistenceFactor treats an unmeasured profile as no boost, never as persistent', () => {
    assert.equal(persistenceFactor(null, 6), 0);
    assert.equal(persistenceFactor(undefined, 6), 0);
    assert.equal(persistenceFactor(NaN, 6), 0);
    assert.equal(persistenceFactor(4, null), 0);
    assert.equal(persistenceFactor(1, 1), 0, 'one bucket cannot express spread');
});

test('editorBreadthFactor saturates rather than rewarding a crowd without limit', () => {
    assert.equal(editorBreadthFactor(0), 0);
    assert.equal(editorBreadthFactor(null), 0);
    assert.equal(editorBreadthFactor(DEFAULT_THRESHOLDS.editorBreadthTarget), 1);
    assert.equal(editorBreadthFactor(500), 1, 'clamped past the target');
    const few = editorBreadthFactor(2);
    const several = editorBreadthFactor(12);
    assert.ok(few > 0 && few < several && several < 1);
});

test('recencyFactor is flat inside the fresh window, zero past stale, linear between', () => {
    assert.equal(recencyFactor(0), 1);
    assert.equal(recencyFactor(14), 1);
    assert.equal(recencyFactor(180), 0);
    assert.equal(recencyFactor(500), 0);
    assert.ok(Math.abs(recencyFactor(97) - 0.5) < 0.01, 'midpoint of 14..180 is roughly half');
});

test('recencyFactor treats an unknown age as neutral, never as fresh', () => {
    assert.equal(recencyFactor(null), 0);
    assert.equal(recencyFactor(undefined), 0);
    assert.equal(recencyFactor(NaN), 0);
});

test('burstFactor normalizes against the baseline an even editing pattern would produce', () => {
    const baseline = 3 / 30;
    // An evenly edited article has exactly the baseline share in the burst
    // window — it must register nothing, or every article collects the penalty.
    assert.equal(burstFactor(baseline, baseline), 0);
    assert.equal(burstFactor(1, baseline), 1, 'every edit inside the burst window');
    assert.equal(burstFactor(0, baseline), 0);
    assert.ok(burstFactor(0.6, baseline) > 0.5 && burstFactor(0.6, baseline) < 0.6);
});

test('burstFactor clamps and treats a missing ratio as neutral', () => {
    assert.equal(burstFactor(null, 0.2), 0);
    assert.equal(burstFactor(2, 0.2), 1);
    assert.equal(burstFactor(-1, 0.2), 0);
});

// --- Event-shaped titles ---

test('isEventShaped catches year-anchored occasion titles', () => {
    for (const title of [
        '2026 US Open (tennis)',
        '2026 Atlantic hurricane season',
        '2026 in film',
        '2025-26 Premier League',
        '2025–26 UEFA Champions League',
        'Athletics at the 2026 Summer Olympics',
        'Kenya at the 2026 Commonwealth Games',
        'Deaths in September 2026',
    ]) {
        assert.equal(isEventShaped(title), true, `${title} should read as an occasion`);
    }
});

test('isEventShaped leaves subjects alone, including the ones an event is named after', () => {
    for (const title of [
        'US Open (tennis)',
        'Stanley Cup',
        'Premier League',
        'Summer Olympic Games',
        'Monsoon season',
        'Hurricane preparedness',
        'Blink-182',
        'Boeing 737 MAX',
        '1984 (novel)',
    ]) {
        assert.equal(isEventShaped(title), false, `${title} is a subject, not an occasion`);
    }
});

test('isEventShaped tolerates a missing title', () => {
    assert.equal(isEventShaped(null), false);
    assert.equal(isEventShaped(undefined), false);
    assert.equal(isEventShaped(''), false);
});

// Guards the comment on EVENT_TITLE_PATTERNS: every pattern is anchored on a
// four-digit year, which is what keeps "US Open" from matching alongside
// "2026 US Open". A bare topic word here would take out real subjects.
test('every event-title pattern is anchored on a year or an explicit date form', () => {
    for (const pattern of EVENT_TITLE_PATTERNS) {
        assert.match(pattern.source, /(1\\d\{3\}|2\\d\{3\}|Deaths in)/,
            `${pattern} must be year-anchored, not a bare topic word`);
    }
});

// --- mergeSignals ---

test('mergeSignals derives age, burst, persistence and idleness from the raw signals', () => {
    const now = new Date('2026-09-16T00:00:00Z');
    const merged = mergeSignals([
        { pageId: 1, title: '2026 Some Final', revisionId: 10, editCount: 300, recentEditCount: 290 },
        { pageId: 2, title: 'Old Steady', revisionId: 20, editCount: 40, recentEditCount: 4 },
    ], {
        currentTagIds: new Set([1]),
        failedVerificationIds: new Set([2]),
        creationDates: new Map([
            [1, new Date('2026-09-11T00:00:00Z')],
            [2, new Date('2010-01-01T00:00:00Z')],
        ]),
        activityProfiles: new Map([
            [1, { historyEditCount: 300, activeBuckets: 1, bucketCount: 6, bucketCounts: [300, 0, 0, 0, 0, 0], distinctEditors: 40, lastEditAt: new Date('2026-09-15T00:00:00Z') }],
            [2, { historyEditCount: 220, activeBuckets: 6, bucketCount: 6, bucketCounts: [40, 30, 35, 40, 45, 30], distinctEditors: 25, lastEditAt: new Date('2026-09-14T00:00:00Z') }],
        ]),
        burstBaseline: 3 / 30,
        now,
    });

    assert.equal(merged[0].currentTag, true);
    assert.equal(merged[0].ageDays, 5);
    assert.equal(merged[0].burstRatio, 290 / 300);
    assert.equal(merged[0].sustainedEditCount, 10);
    assert.equal(merged[0].activeBuckets, 1);
    assert.equal(merged[0].eventShaped, true);
    assert.equal(merged[0].idleDays, 1);

    assert.equal(merged[1].failedVerification, true);
    assert.ok(merged[1].ageDays > 6000);
    assert.equal(merged[1].sustainedEditCount, 36);
    assert.equal(merged[1].activeBuckets, 6);
    assert.equal(merged[1].eventShaped, false);
    assert.deepEqual(merged.map(c => c.offlineRatio), [null, null]);
});

test('mergeSignals leaves every unmeasured signal null rather than defaulting it', () => {
    const merged = mergeSignals([{ pageId: 9, title: 'No Profile', editCount: 5, recentEditCount: 1 }]);
    assert.equal(merged[0].ageDays, null);
    assert.equal(merged[0].createdAt, null);
    assert.equal(merged[0].activeBuckets, null);
    assert.equal(merged[0].distinctEditors, null);
    assert.equal(merged[0].lastEditAt, null);
    assert.equal(merged[0].idleDays, null);
    assert.equal(scoreCandidate(merged[0]) < DEFAULT_WEIGHTS.persistenceBoost, true,
        'a missing profile must not manufacture a persistence boost');
});

test('mergeSignals falls back to the raw count when the burst count is unknown', () => {
    const merged = mergeSignals([{ pageId: 9, title: 'X', editCount: 12, recentEditCount: null }]);
    assert.equal(merged[0].burstRatio, null);
    assert.equal(merged[0].sustainedEditCount, 12, 'unmeasured burst must not zero out the volume term');
});

// --- Scoring ---

test('scoreCandidate rewards sustained volume logarithmically', () => {
    const low = scoreCandidate({ sustainedEditCount: 1 });
    const high = scoreCandidate({ sustainedEditCount: 1000 });
    assert.ok(high > low);
    assert.ok(high - low < DEFAULT_WEIGHTS.sustainedEditScale * 11);
});

test('scoreCandidate scores the spike out of the volume term', () => {
    // Same 300 edits in the window; one article got them steadily, the other
    // in three days. The volume term must not reward the second for its spike.
    const steady = scoreCandidate({ sustainedEditCount: 270 });
    const spike = scoreCandidate({ sustainedEditCount: 10 });
    assert.ok(steady > spike + 40);
});

test('scoreCandidate applies each term additively, with the ephemeral ones subtracted', () => {
    const base = scoreCandidate({ sustainedEditCount: 10 });

    assert.equal(scoreCandidate({ sustainedEditCount: 10, failedVerification: true }) - base,
        DEFAULT_WEIGHTS.failedVerificationBoost);
    assert.equal(scoreCandidate({ sustainedEditCount: 10, activeBuckets: 6, bucketCount: 6 }) - base,
        DEFAULT_WEIGHTS.persistenceBoost);
    assert.equal(
        scoreCandidate({ sustainedEditCount: 10, distinctEditors: DEFAULT_THRESHOLDS.editorBreadthTarget }) - base,
        DEFAULT_WEIGHTS.editorBreadthBoost);

    assert.equal(base - scoreCandidate({ sustainedEditCount: 10, currentTag: true }),
        DEFAULT_WEIGHTS.currentTagPenalty);
    assert.equal(base - scoreCandidate({ sustainedEditCount: 10, ageDays: 1 }),
        DEFAULT_WEIGHTS.noveltyPenalty);
    assert.equal(base - scoreCandidate({ sustainedEditCount: 10, burstRatio: 1, burstBaseline: 0 }),
        DEFAULT_WEIGHTS.burstPenalty);
});

// The point of the 2026-09-16 rewrite, stated as an assertion: the article
// that was edited most is not the article to pick.
test('a steadily maintained article outscores a far busier finished event', () => {
    const event = {
        title: '2026 Some Final', editCount: 300, sustainedEditCount: 12,
        activeBuckets: 1, bucketCount: 6, distinctEditors: 60,
        burstRatio: 0.96, burstBaseline: 3 / 30, ageDays: 6, currentTag: true,
    };
    const steady = {
        title: 'Some Subject', editCount: 45, sustainedEditCount: 41,
        activeBuckets: 6, bucketCount: 6, distinctEditors: 18,
        burstRatio: 0.09, burstBaseline: 3 / 30, ageDays: 5000,
    };
    assert.ok(scoreCandidate(steady) > scoreCandidate(event),
        'the event has 6x the edits and must still lose');
});

test('scoreCandidate only applies the offline penalty once offlineRatio is a number', () => {
    const unknown = scoreCandidate({ sustainedEditCount: 10, offlineRatio: null });
    const known = scoreCandidate({ sustainedEditCount: 10 });
    assert.equal(unknown, known, 'null offlineRatio must not be treated as 0 (fully online)');
    assert.equal(known - scoreCandidate({ sustainedEditCount: 10, offlineRatio: 0.5 }),
        DEFAULT_WEIGHTS.offlineRatioPenalty * 0.5);
});

test('isDurable and tierOf read persistence, not edit volume', () => {
    assert.equal(isDurable({ activeBuckets: 6, bucketCount: 6 }), true);
    assert.equal(isDurable({ activeBuckets: 2, bucketCount: 6 }), false);
    assert.equal(isDurable({ activeBuckets: null, bucketCount: 6 }), false);

    assert.equal(tierOf({ activeBuckets: 6, bucketCount: 6, failedVerification: true }), 'durable+flagged');
    assert.equal(tierOf({ activeBuckets: 1, bucketCount: 6, failedVerification: true }), 'flagged');
    assert.equal(tierOf({ activeBuckets: 6, bucketCount: 6 }), 'durable');
    assert.equal(tierOf({ activeBuckets: 1, bucketCount: 6 }), 'baseline');
    assert.equal(tierOf({ editCount: 9999 }), 'baseline', 'volume alone never reads as durable');
});

test('preliminaryRank sorts descending by score without mutating input order', () => {
    const candidates = [
        { title: 'low', sustainedEditCount: 1 },
        { title: 'high', sustainedEditCount: 1, activeBuckets: 6, bucketCount: 6, failedVerification: true },
        { title: 'mid', sustainedEditCount: 1, activeBuckets: 6, bucketCount: 6 },
    ];
    const ranked = preliminaryRank(candidates);
    assert.deepEqual(ranked.map(c => c.title), ['high', 'mid', 'low']);
    assert.equal(candidates[0].title, 'low', 'input array left untouched');
});

test('shortlist truncates the preliminary ranking to the requested size', () => {
    const candidates = Array.from({ length: 10 }, (_, i) => ({ title: `t${i}`, sustainedEditCount: i }));
    const short = shortlist(candidates, { size: 3 });
    assert.deepEqual(short.map(c => c.title), ['t9', 't8', 't7']);
});

// --- Stage-1 filter: does this article have a future ---

test('activityRejection names the reason rather than returning a bare boolean', () => {
    assert.equal(activityRejection(durableSignals()), null);
    assert.equal(activityRejection(durableSignals({ eventShaped: true })), 'event-title');
    assert.equal(activityRejection(durableSignals({ activeBuckets: 2 })), 'low-persistence');
    assert.equal(activityRejection(durableSignals({ idleDays: 60 })), 'idle');
});

// The case the whole filter exists for: an article whose entire history fits
// inside the window is a new event page, and a missing measurement must not
// read as a good one.
test('activityRejection rejects an article with no measured history at all', () => {
    assert.equal(activityRejection(durableSignals({ activeBuckets: null })), 'no-history');
    assert.equal(activityRejection(durableSignals({ activeBuckets: undefined })), 'no-history');
});

test('activityRejection lets each check be turned off independently', () => {
    assert.equal(activityRejection(durableSignals({ eventShaped: true }), { allowEventTitles: true }), null);
    assert.equal(activityRejection(durableSignals({ activeBuckets: null }), { minActiveBuckets: 0 }), null);
    assert.equal(activityRejection(durableSignals({ idleDays: 60 }), { maxIdleDays: 90 }), null);
    assert.equal(passesActivityFilter(durableSignals({ activeBuckets: 2 }), { minActiveBuckets: 2 }), true);
});

test('activityRejection tolerates an unmeasured idle time', () => {
    assert.equal(activityRejection(durableSignals({ idleDays: null })), null);
});

test('DEFAULT_MIN_ACTIVE_BUCKETS demands spread without demanding a perfect record', () => {
    assert.ok(DEFAULT_MIN_ACTIVE_BUCKETS > 1, 'one active month is exactly the event shape');
    assert.ok(DEFAULT_MIN_ACTIVE_BUCKETS < 6, 'a month off must not disqualify a live article');
});

// --- Stage-2 filter: is there anything here worth verifying ---

test('contentRejection needs citations, enough of them fetchable, and enough in prose', () => {
    assert.equal(contentRejection({ citationCount: 10, offlineRatio: 0.3, tableRatio: 0.1 }), null);
    assert.equal(contentRejection({ citationCount: 10, offlineRatio: 0.9, tableRatio: 0.1 }), 'offline-sources');
    assert.equal(contentRejection({ citationCount: 10, offlineRatio: 0.1, tableRatio: 0.95 }), 'table-heavy',
        'a results page is excluded even though every one of its sources is fetchable');
    assert.equal(contentRejection({ citationCount: 0 }), 'no-citations',
        'a fetch failure or a citation-free article has nothing to verify');
    assert.equal(
        passesContentFilter({ citationCount: 10, offlineRatio: 0.9, tableRatio: 0.95 },
            { offlineRatioCeiling: 0.95, tableRatioCeiling: 0.99 }),
        true, 'both ceilings are configurable');
});

test('contentRejection treats an unmeasured ratio as unknown, not as good', () => {
    // A fetch that failed leaves both ratios null; citationCount is what
    // rejects it, so a null must not be compared against a ceiling.
    assert.equal(contentRejection({ citationCount: 5, offlineRatio: null, tableRatio: null }), null);
    assert.equal(contentRejection({ citationCount: 0, offlineRatio: null, tableRatio: null }), 'no-citations');
});

test('finalizeRanking drops the rows either filter rejects', () => {
    const candidates = [
        durableSignals({ title: 'keeper' }),
        durableSignals({ title: 'mostly-offline', offlineRatio: 0.9 }),
        durableSignals({ title: 'no-citations', citationCount: 0 }),
        durableSignals({ title: 'results-page', tableRatio: 0.95 }),
        durableSignals({ title: '2026 Some Final', eventShaped: true }),
        durableSignals({ title: 'one-month-wonder', activeBuckets: 1 }),
        durableSignals({ title: 'abandoned', idleDays: 90 }),
    ];
    const ranked = finalizeRanking(candidates);
    assert.deepEqual(ranked.map(c => c.title), ['keeper']);
});

test('finalizeRanking sorts the survivors by score and applies limit, tagging tier', () => {
    const candidates = [
        durableSignals({ title: 'baseline', activeBuckets: 3 }),
        durableSignals({ title: 'flagged', activeBuckets: 3, failedVerification: true }),
        durableSignals({ title: 'durable-flagged', failedVerification: true }),
    ];
    const ranked = finalizeRanking(candidates, { limit: 2 });
    assert.deepEqual(ranked.map(c => c.title), ['durable-flagged', 'flagged']);
    assert.deepEqual(ranked.map(c => c.tier), ['durable+flagged', 'flagged']);
});

test('DEFAULT_THRESHOLDS keeps the fresh window inside the stale window', () => {
    assert.ok(DEFAULT_THRESHOLDS.freshDays < DEFAULT_THRESHOLDS.staleDays);
});

// --- The flagged quota ---

test('quotaFor rounds the share and clamps it to 0..1', () => {
    assert.equal(quotaFor(100, 0.4), 40);
    assert.equal(quotaFor(100, 0), 0);
    assert.equal(quotaFor(100, 2), 100);
    assert.equal(quotaFor(100, -1), 0);
    assert.equal(quotaFor(7, 0.4), 3);
});

test('splitFlaggedPool separates the pools, each keeping its order', () => {
    const { flagged, rest } = splitFlaggedPool([
        { title: 'a', failedVerification: true },
        { title: 'b' },
        { title: 'c', failedVerification: true },
    ]);
    assert.deepEqual(flagged.map(c => c.title), ['a', 'c']);
    assert.deepEqual(rest.map(c => c.title), ['b']);
});

// The reason the quota exists: the flagged population is much the smaller of
// the two and scores no better on the durability signals, so ranking alone
// does not blend the populations — it drops the flagged ones.
test('without a quota the larger general pool crowds flagged articles out', () => {
    const candidates = [
        ...Array.from({ length: 5 }, (_, i) => durableSignals({
            title: `busy-${i}`, sustainedEditCount: 400, distinctEditors: 80,
        })),
        durableSignals({ title: 'cockroach', sustainedEditCount: 8, distinctEditors: 3, failedVerification: true }),
    ];

    const noQuota = finalizeRanking(candidates, { limit: 5 });
    assert.ok(!noQuota.some(c => c.failedVerification), 'crowded out entirely');

    const withQuota = finalizeRanking(candidates, { limit: 5, flaggedQuota: 2 });
    assert.equal(withQuota.filter(c => c.failedVerification).length, 1,
        'the quota is a floor — it takes every flagged article available, not a padded two');
    assert.equal(withQuota.length, 5, 'and the remaining slots still get filled');
});

test('allocateWithQuota reserves flagged slots but still returns one score-ordered list', () => {
    const scored = [
        { title: 'top', score: 100 },
        { title: 'mid', score: 90 },
        { title: 'flagged-low', score: 10, failedVerification: true },
    ];
    const got = allocateWithQuota(scored, { limit: 2, flaggedQuota: 1 });
    assert.deepEqual(got.map(c => c.title), ['top', 'flagged-low'],
        'one reserved slot, one earned; output sorted by score');
});

test('allocateWithQuota never exceeds the limit or double-counts a flagged article', () => {
    const scored = [
        { title: 'a', score: 30, failedVerification: true },
        { title: 'b', score: 20, failedVerification: true },
        { title: 'c', score: 10 },
    ];
    const got = allocateWithQuota(scored, { limit: 2, flaggedQuota: 2 });
    assert.equal(got.length, 2);
    assert.deepEqual(got.map(c => c.title), ['a', 'b']);
});

test('an unfillable quota leaves its slots to the general ranking rather than padding', () => {
    const scored = [
        { title: 'a', score: 30 },
        { title: 'b', score: 20 },
        { title: 'c', score: 10 },
    ];
    const got = allocateWithQuota(scored, { limit: 3, flaggedQuota: 2 });
    assert.deepEqual(got.map(c => c.title), ['a', 'b', 'c']);
});

// --- The BLP quota ---
//
// Same mechanism as the flagged quota, for a population asked for by
// participants in the 2026-09-10 enwiki thread and the 2026-09-14 call.

test('the BLP quota reserves slots a pure score ranking would not have given', () => {
    const scored = [
        ...Array.from({ length: 5 }, (_, i) => ({ title: `top-${i}`, score: 100 - i })),
        { title: 'blp-low', score: 5, isBlp: true },
    ];

    const noQuota = allocateWithQuota(scored, { limit: 5 });
    assert.ok(!noQuota.some(c => c.isBlp), 'outscored entirely');

    const withQuota = allocateWithQuota(scored, { limit: 5, blpQuota: 1 });
    assert.ok(withQuota.some(c => c.title === 'blp-low'));
    assert.equal(withQuota.length, 5);
});

test('an article that is both flagged and a BLP is taken once and counts for both', () => {
    const scored = [
        { title: 'both', score: 10, failedVerification: true, isBlp: true },
        { title: 'plain-a', score: 9 },
        { title: 'plain-b', score: 8 },
    ];
    const got = allocateWithQuota(scored, { limit: 3, flaggedQuota: 1, blpQuota: 1 });
    assert.equal(got.length, 3);
    assert.equal(got.filter(c => c.title === 'both').length, 1);
    assert.deepEqual(got.map(c => c.title), ['both', 'plain-a', 'plain-b'],
        'the two reserves did not spend two slots on one article');
});

test('the two quotas together never exceed the limit', () => {
    const scored = [
        ...Array.from({ length: 6 }, (_, i) => ({ title: `f${i}`, score: 50 - i, failedVerification: true })),
        ...Array.from({ length: 6 }, (_, i) => ({ title: `b${i}`, score: 40 - i, isBlp: true })),
    ];
    const got = allocateWithQuota(scored, { limit: 4, flaggedQuota: 6, blpQuota: 6 });
    assert.equal(got.length, 4);
});

test('an unfillable BLP quota leaves its slots to the general ranking', () => {
    const scored = [{ title: 'a', score: 3 }, { title: 'b', score: 2 }];
    const got = allocateWithQuota(scored, { limit: 2, blpQuota: 2 });
    assert.deepEqual(got.map(c => c.title), ['a', 'b']);
});

test('finalizeRanking threads the BLP quota through both filters', () => {
    const candidates = [
        ...Array.from({ length: 3 }, (_, i) => durableSignals({
            title: `busy-${i}`, sustainedEditCount: 500, distinctEditors: 60,
        })),
        durableSignals({ title: 'quiet-blp', sustainedEditCount: 5, distinctEditors: 4, isBlp: true }),
        // A BLP the content filter rejects must not be bought back by the quota.
        durableSignals({ title: 'offline-blp', isBlp: true, offlineRatio: 0.95 }),
    ];
    const ranked = finalizeRanking(candidates, { limit: 3, blpQuota: 2 });

    assert.equal(ranked.length, 3);
    assert.ok(ranked.some(c => c.title === 'quiet-blp'), 'the quota reached past the score ranking');
    assert.ok(!ranked.some(c => c.title === 'offline-blp'), 'a quota is not an exemption from the filters');
});

test('mergeSignals reads BLP membership by page id', () => {
    const merged = mergeSignals([
        { pageId: 1, title: 'A Living Person', editCount: 10, recentEditCount: 1 },
        { pageId: 2, title: 'A Bridge', editCount: 10, recentEditCount: 1 },
    ], { blpIds: new Set([1]) });

    assert.equal(merged[0].isBlp, true);
    assert.equal(merged[1].isBlp, false);
});

test('BLP membership is a quota only — it does not touch the score', () => {
    const base = { sustainedEditCount: 10, activeBuckets: 6, bucketCount: 6, distinctEditors: 20 };
    assert.equal(scoreCandidate({ ...base, isBlp: true }), scoreCandidate(base));
});
