import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    DEFAULT_WEIGHTS,
    DEFAULT_THRESHOLDS,
    DEFAULT_OFFLINE_RATIO_CEILING,
    computeOfflineRatio,
    recencyFactor,
    burstFactor,
    isCurrentEvent,
    mergeSignals,
    scoreCandidate,
    tierOf,
    preliminaryRank,
    shortlist,
    passesOfflineFilter,
    finalizeRanking,
} from '../service/pilot-selection.js';

test('computeOfflineRatio counts citations with no url as offline', () => {
    assert.equal(computeOfflineRatio([{ url: 'https://x' }, { url: null }, { url: undefined }]), 2 / 3);
    assert.equal(computeOfflineRatio([{ url: 'https://x' }, { url: 'https://y' }]), 0);
    assert.equal(computeOfflineRatio([{ url: null }]), 1);
});

test('computeOfflineRatio returns null for an article with no citations, not 0 or 1', () => {
    assert.equal(computeOfflineRatio([]), null);
    assert.equal(computeOfflineRatio(null), null);
});

// --- The two untagged current-events signals ---

test('recencyFactor is flat inside the fresh window, zero past stale, linear between', () => {
    assert.equal(recencyFactor(0), 1);
    assert.equal(recencyFactor(14), 1);
    assert.equal(recencyFactor(180), 0);
    assert.equal(recencyFactor(500), 0);
    assert.ok(Math.abs(recencyFactor(97) - 0.5) < 0.01, 'midpoint of 14..180 is roughly half');
});

test('recencyFactor treats an unknown age as no boost, never as fresh', () => {
    assert.equal(recencyFactor(null), 0);
    assert.equal(recencyFactor(undefined), 0);
    assert.equal(recencyFactor(NaN), 0);
});

test('burstFactor normalizes against the baseline an even editing pattern would produce', () => {
    const baseline = 3 / 14;
    // An evenly edited article has exactly the baseline share in the burst
    // window — it must earn nothing, or every article collects the boost.
    assert.equal(burstFactor(baseline, baseline), 0);
    assert.equal(burstFactor(1, baseline), 1, 'every edit inside the burst window');
    assert.equal(burstFactor(0, baseline), 0);
    assert.ok(burstFactor(0.6, baseline) > 0.4 && burstFactor(0.6, baseline) < 0.6);
});

test('burstFactor clamps and treats a missing ratio as no boost', () => {
    assert.equal(burstFactor(null, 0.2), 0);
    assert.equal(burstFactor(2, 0.2), 1);
    assert.equal(burstFactor(-1, 0.2), 0);
});

test('isCurrentEvent fires on the tag, on a new article, or on a burst — independently', () => {
    assert.ok(isCurrentEvent({ currentTag: true, ageDays: 4000, burstRatio: 0 }), 'tag alone');
    assert.ok(isCurrentEvent({ ageDays: 5, burstRatio: 0 }), 'newly created alone');
    assert.ok(isCurrentEvent({ ageDays: 4000, burstRatio: 0.9, burstBaseline: 3 / 14 }), 'burst alone');
    assert.ok(!isCurrentEvent({ ageDays: 4000, burstRatio: 3 / 14, burstBaseline: 3 / 14 }),
        'an old, evenly edited article is not a current event');
});

test('a decades-old article in the news still reads as current, which recency alone would miss', () => {
    const signals = { ageDays: 7000, burstRatio: 0.95, burstBaseline: 3 / 14 };
    assert.equal(recencyFactor(signals.ageDays), 0);
    assert.ok(isCurrentEvent(signals));
    assert.equal(tierOf(signals), 'current');
});

// --- mergeSignals ---

test('mergeSignals derives age and burst ratio, and tests tags by page id', () => {
    const now = new Date('2026-09-09T00:00:00Z');
    const merged = mergeSignals([
        { pageId: 1, title: 'New Story', revisionId: 10, editCount: 40, recentEditCount: 38 },
        { pageId: 2, title: 'Old Steady', revisionId: 20, editCount: 40, recentEditCount: 9 },
    ], {
        currentTagIds: new Set([1]),
        failedVerificationIds: new Set([2]),
        creationDates: new Map([
            [1, new Date('2026-09-04T00:00:00Z')],
            [2, new Date('2010-01-01T00:00:00Z')],
        ]),
        burstBaseline: 3 / 14,
        now,
    });

    assert.equal(merged[0].currentTag, true);
    assert.equal(merged[0].failedVerification, false);
    assert.equal(merged[0].ageDays, 5);
    assert.equal(merged[0].burstRatio, 38 / 40);
    assert.equal(merged[1].ageDays > 6000, true);
    assert.equal(merged[1].burstRatio, 9 / 40);
    assert.deepEqual(merged.map(c => c.offlineRatio), [null, null]);
});

test('mergeSignals leaves age null when the creation date is unknown', () => {
    const merged = mergeSignals([{ pageId: 9, editCount: 5, recentEditCount: 1 }]);
    assert.equal(merged[0].ageDays, null);
    assert.equal(merged[0].createdAt, null);
    assert.equal(scoreCandidate(merged[0]) < DEFAULT_WEIGHTS.recencyBoost, true,
        'no creation date must not manufacture a recency boost');
});

test('mergeSignals leaves burstRatio null when the article has no edits counted', () => {
    const merged = mergeSignals([{ pageId: 9, editCount: 0, recentEditCount: 0 }]);
    assert.equal(merged[0].burstRatio, null);
});

// --- Scoring ---

test('scoreCandidate rewards edit count logarithmically', () => {
    const low = scoreCandidate({ editCount: 1 });
    const high = scoreCandidate({ editCount: 1000 });
    assert.ok(high > low);
    assert.ok(high - low < DEFAULT_WEIGHTS.editCountScale * 11);
});

test('scoreCandidate applies each boost additively', () => {
    const base = scoreCandidate({ editCount: 10 });
    assert.equal(scoreCandidate({ editCount: 10, currentTag: true }) - base,
        DEFAULT_WEIGHTS.currentTagBoost);
    assert.equal(scoreCandidate({ editCount: 10, failedVerification: true }) - base,
        DEFAULT_WEIGHTS.failedVerificationBoost);
    assert.equal(scoreCandidate({ editCount: 10, ageDays: 1 }) - base,
        DEFAULT_WEIGHTS.recencyBoost);
    assert.equal(scoreCandidate({ editCount: 10, burstRatio: 1, burstBaseline: 0 }) - base,
        DEFAULT_WEIGHTS.burstBoost);
});

test('the two untagged current-events signals together outweigh the {{current}} tag', () => {
    // The point of the rewrite: the tag was on 6 enwiki articles, so the mix
    // cannot depend on it.
    const untagged = scoreCandidate({ editCount: 10, ageDays: 2, burstRatio: 1, burstBaseline: 3 / 14 });
    const taggedOnly = scoreCandidate({ editCount: 10, currentTag: true });
    assert.ok(untagged > taggedOnly);
});

test('scoreCandidate only applies the offline penalty once offlineRatio is a number', () => {
    const unknown = scoreCandidate({ editCount: 10, offlineRatio: null });
    const known = scoreCandidate({ editCount: 10 });
    assert.equal(unknown, known, 'null offlineRatio must not be treated as 0 (fully online)');
    assert.equal(known - scoreCandidate({ editCount: 10, offlineRatio: 0.5 }),
        DEFAULT_WEIGHTS.offlineRatioPenalty * 0.5);
});

test('tierOf labels every combination', () => {
    assert.equal(tierOf({ currentTag: true, failedVerification: true }), 'current+flagged');
    assert.equal(tierOf({ ageDays: 3, failedVerification: true }), 'current+flagged');
    assert.equal(tierOf({ ageDays: 4000, failedVerification: true }), 'flagged');
    assert.equal(tierOf({ ageDays: 3 }), 'current');
    assert.equal(tierOf({ ageDays: 4000 }), 'baseline');
});

test('preliminaryRank sorts descending by score without mutating input order', () => {
    const candidates = [
        { title: 'low', editCount: 1 },
        { title: 'high', editCount: 1, currentTag: true, failedVerification: true, ageDays: 1 },
        { title: 'mid', editCount: 1, currentTag: true },
    ];
    const ranked = preliminaryRank(candidates);
    assert.deepEqual(ranked.map(c => c.title), ['high', 'mid', 'low']);
    assert.equal(candidates[0].title, 'low', 'input array left untouched');
});

test('shortlist truncates the preliminary ranking to the requested size', () => {
    const candidates = Array.from({ length: 10 }, (_, i) => ({ title: `t${i}`, editCount: i }));
    const short = shortlist(candidates, { size: 3 });
    assert.deepEqual(short.map(c => c.title), ['t9', 't8', 't7']);
});

// --- Stage-2 filter ---

test('passesOfflineFilter needs citations and enough of them fetchable', () => {
    assert.equal(passesOfflineFilter({ citationCount: 10, offlineRatio: 0.3 }), true);
    assert.equal(passesOfflineFilter({ citationCount: 10, offlineRatio: 0.9 }), false);
    assert.equal(passesOfflineFilter({ citationCount: 0, offlineRatio: null }), false,
        'a fetch failure or a citation-free article has nothing to verify');
    assert.equal(passesOfflineFilter({ citationCount: 10, offlineRatio: 0.9 }, 0.95), true,
        'ceiling is configurable');
});

test('finalizeRanking drops the same rows passesOfflineFilter rejects', () => {
    const candidates = [
        { title: 'mostly-online', editCount: 1, citationCount: 10, offlineRatio: 0.3 },
        { title: 'mostly-offline', editCount: 1, citationCount: 10, offlineRatio: 0.9 },
        { title: 'no-citations', editCount: 100, citationCount: 0, offlineRatio: null },
    ];
    const ranked = finalizeRanking(candidates, { offlineRatioCeiling: DEFAULT_OFFLINE_RATIO_CEILING });
    assert.deepEqual(ranked.map(c => c.title), ['mostly-online']);
});

test('finalizeRanking sorts the survivors by score and applies limit, tagging tier', () => {
    const candidates = [
        { title: 'baseline', editCount: 1, citationCount: 5, offlineRatio: 0, ageDays: 4000 },
        { title: 'flagged', editCount: 1, citationCount: 5, offlineRatio: 0, ageDays: 4000, failedVerification: true },
        { title: 'current-flagged', editCount: 1, citationCount: 5, offlineRatio: 0, ageDays: 2, failedVerification: true },
    ];
    const ranked = finalizeRanking(candidates, { limit: 2 });
    assert.deepEqual(ranked.map(c => c.title), ['current-flagged', 'flagged']);
    assert.deepEqual(ranked.map(c => c.tier), ['current+flagged', 'flagged']);
});

test('DEFAULT_THRESHOLDS keeps the fresh window inside the stale window', () => {
    assert.ok(DEFAULT_THRESHOLDS.freshDays < DEFAULT_THRESHOLDS.staleDays);
});
