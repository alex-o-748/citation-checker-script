import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    isGroupClose,
    groupSourceEntries,
    shouldSkipCollective,
    hasUnreadSource,
    mergeReportUnits,
    isJudgedUnavailable,
    JUDGED_UNAVAILABLE_REASON,
} from '../core/groups.js';
import { assembleGroupSources } from '../core/prompts.js';

const withContent = body => `Source URL: https://example.com\n\nSource Content:\n${body}`;

test('isGroupClose fires only on the last member of a multi-member group', () => {
    assert.equal(isGroupClose({ groupSize: 3, groupIndex: 0 }), false);
    assert.equal(isGroupClose({ groupSize: 3, groupIndex: 1 }), false);
    assert.equal(isGroupClose({ groupSize: 3, groupIndex: 2 }), true);
});

test('isGroupClose is false for solo citations', () => {
    assert.equal(isGroupClose({ groupSize: 1, groupIndex: 0 }), false);
    assert.equal(isGroupClose({ groupSize: undefined, groupIndex: undefined }), false);
    assert.equal(isGroupClose({}), false);
    assert.equal(isGroupClose(null), false);
});

test('groupSourceEntries keeps distinct sources as separate entries', () => {
    const members = [
        { citationNumber: '5' },
        { citationNumber: '6' },
    ];
    const entries = groupSourceEntries(members, m => ({
        key: `key-${m.citationNumber}`,
        url: `https://example.com/${m.citationNumber}`,
        content: withContent(`body ${m.citationNumber}`),
        error: null,
        status: 200,
    }));

    assert.equal(entries.length, 2);
    assert.deepEqual(entries[0].citationNumbers, ['5']);
    assert.deepEqual(entries[1].citationNumbers, ['6']);
});

test('groupSourceEntries dedupes members sharing the same source key', () => {
    // Two citations backed by the same named <ref> (or the same url|page=N).
    const members = [
        { citationNumber: '5' },
        { citationNumber: '6' },
        { citationNumber: '7' },
    ];
    const entries = groupSourceEntries(members, m => ({
        key: m.citationNumber === '7' ? 'other' : 'shared',
        url: 'https://example.com/shared',
        content: withContent('shared body'),
        error: null,
        status: 200,
    }));

    assert.equal(entries.length, 2);
    const shared = entries.find(e => e.url === 'https://example.com/shared');
    assert.deepEqual(shared.citationNumbers, ['5', '6']);
});

test('groupSourceEntries defaults missing fields to null', () => {
    const entries = groupSourceEntries(
        [{ citationNumber: '9' }],
        () => ({ key: 'k' })
    );
    assert.deepEqual(entries, [{ citationNumbers: ['9'], url: null, citation: null, content: null, error: null, status: null }]);
});

test('shouldSkipCollective is true with zero available sources', () => {
    const entries = [
        { content: null, url: 'https://a', error: 'fetch failed', status: null },
        { content: null, url: 'https://b', error: null, status: 404 },
    ];
    assert.equal(shouldSkipCollective(entries), true);
});

test('shouldSkipCollective is true with exactly one available source', () => {
    const entries = [
        { content: withContent('usable text'), url: 'https://a', error: null, status: 200 },
        { content: null, url: 'https://b', error: null, status: 403 },
    ];
    assert.equal(shouldSkipCollective(entries), true);
});

test('shouldSkipCollective is false with two or more available sources', () => {
    const entries = [
        { content: withContent('usable text A'), url: 'https://a', error: null, status: 200 },
        { content: withContent('usable text B'), url: 'https://b', error: null, status: 200 },
    ];
    assert.equal(shouldSkipCollective(entries), false);
});

test('shouldSkipCollective treats whitespace-only extracted text as unavailable', () => {
    const entries = [
        { content: withContent('   \n  '), url: 'https://a', error: null, status: 200 },
        { content: withContent('real text'), url: 'https://b', error: null, status: 200 },
    ];
    assert.equal(shouldSkipCollective(entries), true);
});

test('mergeReportUnits passes solo citations through unchanged', () => {
    const solo = { citationNumber: '1', verdict: 'SUPPORTED' };
    const units = mergeReportUnits([solo], new Map());
    assert.deepEqual(units, [solo]);
});

test('mergeReportUnits collapses a completed group to its collective verdict', () => {
    const results = [
        { citationNumber: '5', groupId: 'g1', groupSize: 2, verdict: 'PARTIALLY SUPPORTED' },
        { citationNumber: '6', groupId: 'g1', groupSize: 2, verdict: 'PARTIALLY SUPPORTED' },
    ];
    const collective = { groupId: 'g1', verdict: 'SUPPORTED' };
    const groupResults = new Map([['g1', collective]]);

    const units = mergeReportUnits(results, groupResults);
    assert.deepEqual(units, [collective]);
});

test('mergeReportUnits falls back to per-source members when the collective was skipped', () => {
    const results = [
        { citationNumber: '5', groupId: 'g1', groupSize: 2, verdict: 'SOURCE UNAVAILABLE' },
        { citationNumber: '6', groupId: 'g1', groupSize: 2, verdict: 'PARTIALLY SUPPORTED' },
    ];
    const groupResults = new Map([['g1', { skipped: true, groupId: 'g1' }]]);

    const units = mergeReportUnits(results, groupResults);
    assert.deepEqual(units, results);
});

test('mergeReportUnits omits a group whose collective check has not completed yet', () => {
    const results = [
        { citationNumber: '5', groupId: 'g1', groupSize: 2, verdict: 'SUPPORTED' },
        { citationNumber: '6', groupId: 'g1', groupSize: 2, verdict: 'SUPPORTED' },
    ];
    const units = mergeReportUnits(results, new Map());
    assert.deepEqual(units, []);
});

test('mergeReportUnits interleaves solo citations and groups in document order', () => {
    const solo1 = { citationNumber: '1', verdict: 'SUPPORTED' };
    const solo2 = { citationNumber: '4', verdict: 'NOT SUPPORTED' };
    const member5 = { citationNumber: '2', groupId: 'g1', groupSize: 2, verdict: 'PARTIALLY SUPPORTED' };
    const member6 = { citationNumber: '3', groupId: 'g1', groupSize: 2, verdict: 'PARTIALLY SUPPORTED' };
    const collective = { groupId: 'g1', verdict: 'SUPPORTED' };
    const groupResults = new Map([['g1', collective]]);

    const units = mergeReportUnits([solo1, member5, member6, solo2], groupResults);
    assert.deepEqual(units, [solo1, collective, solo2]);
});

test('hasUnreadSource: any source with no usable text, including a header with an empty body', () => {
    assert.equal(hasUnreadSource([{ content: withContent('a') }, { content: withContent('b') }]), false);
    assert.equal(hasUnreadSource([{ content: withContent('a') }, { content: null, error: '403' }]), true);
    assert.equal(hasUnreadSource([{ content: withContent('a') }, { content: withContent('   ') }]), true);
    // A named ref cited twice is one entry: nothing went unread.
    assert.equal(hasUnreadSource(groupSourceEntries(
        [{ citationNumber: 3 }, { citationNumber: 3 }],
        () => ({ key: 'same', content: withContent('a') })
    )), false);
});

// Garbage [44][45], 2026-11-17: ProQuest returned a login page, Springer a
// paywall preview. Both fetched fine, both members' own checks said SOURCE
// UNAVAILABLE, and the combined check still ran and said PARTIALLY SUPPORTED
// on the preview's abstract.
test('a source its own check judged unavailable counts as unread for the group', () => {
    const entries = groupSourceEntries([
        { citationNumber: '44', url: 'https://proquest.example/x' },
        { citationNumber: '45', url: 'https://springer.example/y' },
    ], m => ({
        key: m.url, url: m.url,
        content: withContent(m.citationNumber === '44' ? 'Login required.' : 'Abstract: thrift stores, flea markets…'),
        status: 200, error: null,
        judgedUnavailable: true,
    }));
    assert.ok(shouldSkipCollective(entries), 'no source left to combine');
    assert.ok(hasUnreadSource(entries));
    for (const e of entries) {
        assert.equal(e.content, null);
        assert.equal(e.status, null, 'not shown to the model as "HTTP 200"');
        assert.equal(e.error, JUDGED_UNAVAILABLE_REASON);
    }
});

test('with two readable sources left, the collective still runs and labels the judged-unavailable one', () => {
    const entries = groupSourceEntries([
        { citationNumber: '1', url: 'https://a.example' },
        { citationNumber: '2', url: 'https://b.example' },
        { citationNumber: '3', url: 'https://paywall.example' },
    ], m => ({
        key: m.url, url: m.url, content: withContent(`PAGE ${m.citationNumber}`), status: 200,
        judgedUnavailable: m.citationNumber === '3',
    }));
    assert.equal(shouldSkipCollective(entries), false);
    assert.ok(hasUnreadSource(entries));
    const { text } = assembleGroupSources(entries);
    assert.match(text, /PAGE 1/);
    assert.match(text, /PAGE 2/);
    assert.doesNotMatch(text, /PAGE 3/, "the preview's text is not sent");
    assert.ok(text.includes(`[This source could not be retrieved: ${JUDGED_UNAVAILABLE_REASON}]`));
});

test('one member judging a shared source unavailable is enough, whichever member comes first', () => {
    for (const first of [true, false]) {
        const entries = groupSourceEntries([
            { citationNumber: '1', url: 'https://a.example' },
            { citationNumber: '2', url: 'https://a.example' },
        ], m => ({
            key: m.url, url: m.url, content: withContent('text'), status: 200,
            judgedUnavailable: (m.citationNumber === '1') === first,
        }));
        assert.equal(entries.length, 1);
        assert.equal(entries[0].content, null);
    }
});

test('isJudgedUnavailable: only a SOURCE UNAVAILABLE verdict, never an ERROR', () => {
    assert.ok(isJudgedUnavailable('SOURCE UNAVAILABLE'));
    assert.ok(isJudgedUnavailable('Source unavailable'));
    for (const v of ['ERROR', 'SKIPPED', 'SUPPORTED', 'PARTIALLY SUPPORTED', 'NOT SUPPORTED', null, undefined]) {
        assert.equal(isJudgedUnavailable(v), false, String(v));
    }
});
