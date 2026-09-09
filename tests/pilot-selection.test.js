import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    DEFAULT_WEIGHTS,
    DEFAULT_OFFLINE_RATIO_CEILING,
    computeOfflineRatio,
    mergeSignals,
    scoreCandidate,
    tierOf,
    preliminaryRank,
    shortlist,
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

test('mergeSignals attaches tag membership by pageId and leaves offline signals unset', () => {
    const topEdited = [
        { pageId: 1, title: 'A', revisionId: 10, editCount: 50 },
        { pageId: 2, title: 'B', revisionId: 20, editCount: 5 },
    ];
    const merged = mergeSignals(topEdited, {
        currentEventIds: new Set([1]),
        failedVerificationIds: new Set([2]),
    });

    assert.deepEqual(merged.map(c => c.currentEvent), [true, false]);
    assert.deepEqual(merged.map(c => c.failedVerification), [false, true]);
    assert.deepEqual(merged.map(c => c.offlineRatio), [null, null]);
    assert.deepEqual(merged.map(c => c.citationCount), [null, null]);
});

test('mergeSignals defaults to empty sets, so nothing is flagged', () => {
    const merged = mergeSignals([{ pageId: 1, editCount: 1 }]);
    assert.equal(merged[0].currentEvent, false);
    assert.equal(merged[0].failedVerification, false);
});

test('scoreCandidate rewards edit count logarithmically', () => {
    const low = scoreCandidate({ editCount: 1 });
    const high = scoreCandidate({ editCount: 1000 });
    assert.ok(high > low);
    // log2(1001) ~= 9.97, so the gap is bounded, not linear in edit count.
    assert.ok(high - low < DEFAULT_WEIGHTS.editCountScale * 11);
});

test('scoreCandidate applies both boosts additively', () => {
    const base = scoreCandidate({ editCount: 10 });
    const currentOnly = scoreCandidate({ editCount: 10, currentEvent: true });
    const both = scoreCandidate({ editCount: 10, currentEvent: true, failedVerification: true });

    assert.equal(currentOnly - base, DEFAULT_WEIGHTS.currentEventBoost);
    assert.equal(both - currentOnly, DEFAULT_WEIGHTS.failedVerificationBoost);
});

test('scoreCandidate only applies the offline penalty once offlineRatio is a number', () => {
    const unknown = scoreCandidate({ editCount: 10, offlineRatio: null });
    const known = scoreCandidate({ editCount: 10 });
    assert.equal(unknown, known, 'null offlineRatio must not be treated as 0 (fully online)');

    const halfOffline = scoreCandidate({ editCount: 10, offlineRatio: 0.5 });
    assert.equal(known - halfOffline, DEFAULT_WEIGHTS.offlineRatioPenalty * 0.5);
});

test('tierOf labels every combination of the two tag signals', () => {
    assert.equal(tierOf({ currentEvent: true, failedVerification: true }), 'current+flagged');
    assert.equal(tierOf({ currentEvent: false, failedVerification: true }), 'flagged');
    assert.equal(tierOf({ currentEvent: true, failedVerification: false }), 'current');
    assert.equal(tierOf({ currentEvent: false, failedVerification: false }), 'baseline');
});

test('preliminaryRank sorts descending by score without mutating input order', () => {
    const candidates = [
        { title: 'low', editCount: 1 },
        { title: 'high', editCount: 1, currentEvent: true, failedVerification: true },
        { title: 'mid', editCount: 1, currentEvent: true },
    ];
    const ranked = preliminaryRank(candidates);
    assert.deepEqual(ranked.map(c => c.title), ['high', 'mid', 'low']);
    assert.equal(candidates[0].title, 'low', 'input array left untouched');
});

test('shortlist truncates the preliminary ranking to the requested size', () => {
    const candidates = Array.from({ length: 10 }, (_, i) => ({ title: `t${i}`, editCount: i }));
    const short = shortlist(candidates, { size: 3 });
    assert.equal(short.length, 3);
    assert.deepEqual(short.map(c => c.title), ['t9', 't8', 't7']);
});

test('finalizeRanking drops candidates with zero citations', () => {
    const candidates = [
        { title: 'has-citations', editCount: 5, citationCount: 3, offlineRatio: 0 },
        { title: 'no-citations', editCount: 100, citationCount: 0, offlineRatio: null },
    ];
    const ranked = finalizeRanking(candidates);
    assert.deepEqual(ranked.map(c => c.title), ['has-citations']);
});

test('finalizeRanking excludes articles above the offline-ratio ceiling', () => {
    const candidates = [
        { title: 'mostly-online', editCount: 1, citationCount: 10, offlineRatio: 0.3 },
        { title: 'mostly-offline', editCount: 1, citationCount: 10, offlineRatio: 0.9 },
    ];
    const ranked = finalizeRanking(candidates, { offlineRatioCeiling: DEFAULT_OFFLINE_RATIO_CEILING });
    assert.deepEqual(ranked.map(c => c.title), ['mostly-online']);
});

test('finalizeRanking keeps an article whose offlineRatio was never computed (fetch failed) out via citationCount, not the ceiling', () => {
    const candidates = [{ title: 'unfetched', editCount: 999, citationCount: 0, offlineRatio: null }];
    assert.deepEqual(finalizeRanking(candidates), []);
});

test('finalizeRanking sorts the survivors by score and applies limit, tagging tier', () => {
    const candidates = [
        { title: 'baseline', editCount: 1, citationCount: 5, offlineRatio: 0 },
        { title: 'flagged', editCount: 1, citationCount: 5, offlineRatio: 0, failedVerification: true },
        { title: 'current-flagged', editCount: 1, citationCount: 5, offlineRatio: 0, currentEvent: true, failedVerification: true },
    ];
    const ranked = finalizeRanking(candidates, { limit: 2 });
    assert.deepEqual(ranked.map(c => c.title), ['current-flagged', 'flagged']);
    assert.equal(ranked[0].tier, 'current+flagged');
    assert.equal(ranked[1].tier, 'flagged');
});
