import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    isGroupClose,
    groupSourceEntries,
    shouldSkipCollective,
    mergeReportUnits,
} from '../core/groups.js';

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
    assert.deepEqual(entries, [{ citationNumbers: ['9'], url: null, content: null, error: null, status: null }]);
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
