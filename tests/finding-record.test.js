import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toFindingRecords, toCitationNumber, SKIP_REASONS, TTL_MS } from '../service/finding-record.js';
import { buildUpsertQuery } from '../service/findings.js';
import { groupSourceUrlHash, sourceUrlHash } from '../core/anchor.js';
import { PROMPT_VERSION } from '../core/prompts.js';

const NOW = new Date('2026-08-21T12:00:00Z');

function citation(overrides = {}) {
    return {
        citationNumber: '1',
        claimText: 'The bridge opened in 1998.',
        url: 'https://example.com/a',
        pageNum: null,
        source: { content: 'Article body text.', status: 200, error: null, unavailableReason: null, cached: false },
        ...overrides,
    };
}

function article(citations, overrides = {}) {
    return {
        pageId: 12345,
        title: 'Test Article',
        revisionId: 987654321,
        outcome: 'ok',
        citations,
        ...overrides,
    };
}

async function fakeVerifyCitation(claimText, source, ctx) {
    fakeVerifyCitation.calls.push({ claimText, source, ctx });
    return {
        verdict: 'SUPPORTED',
        confidence: 90,
        reasonType: null,
        rationale: 'Clearly stated.',
        provider: 'publicai',
        model: 'qwen3-32b',
        tokensIn: 100,
        tokensOut: 20,
    };
}

async function fakeVerifyGroup(claimText, entries, ctx) {
    fakeVerifyGroup.calls.push({ claimText, entries, ctx });
    return {
        verdict: 'PARTIALLY SUPPORTED',
        confidence: 60,
        reasonType: null,
        rationale: 'Some sources cover it.',
        provider: 'publicai',
        model: 'qwen3-32b',
        tokensIn: 300,
        tokensOut: 40,
    };
}

function baseCtx(overrides = {}) {
    fakeVerifyCitation.calls = [];
    fakeVerifyGroup.calls = [];
    return {
        wiki: 'enwiki',
        now: NOW,
        verifyCitation: fakeVerifyCitation,
        verifyGroup: fakeVerifyGroup,
        ...overrides,
    };
}

// --- toCitationNumber ---

test('toCitationNumber parses a bare integer string', () => {
    assert.equal(toCitationNumber('1'), 1);
    assert.equal(toCitationNumber('42'), 42);
});

test('toCitationNumber returns null for a named-ref multi-number string', () => {
    // core/citations.js can produce "1, 2" for a shared named ref cited twice.
    assert.equal(toCitationNumber('1, 2'), null);
});

test('toCitationNumber returns null for non-numeric content and nullish input', () => {
    assert.equal(toCitationNumber('note 1'), null);
    assert.equal(toCitationNumber('iv'), null);
    assert.equal(toCitationNumber(null), null);
    assert.equal(toCitationNumber(undefined), null);
});

// --- context validation ---

test('toFindingRecords throws without context.wiki', async () => {
    await assert.rejects(
        toFindingRecords(article([citation()]), { now: NOW, verifyCitation: fakeVerifyCitation, verifyGroup: fakeVerifyGroup }),
        TypeError
    );
});

test('toFindingRecords returns nothing for a non-ok article outcome', async () => {
    const { records, skipped } = await toFindingRecords(
        article([], { outcome: 'fetch_failed' }),
        baseCtx()
    );
    assert.deepEqual(records, []);
    assert.deepEqual(skipped, []);
});

test('toFindingRecords returns nothing when an ok article has no citations', async () => {
    const { records, skipped } = await toFindingRecords(article([]), baseCtx());
    assert.deepEqual(records, []);
    assert.deepEqual(skipped, []);
});

// --- solo citation, available ---

test('a solo available citation calls verifyCitation and produces one record', async () => {
    const art = article([citation()]);
    const { records, skipped } = await toFindingRecords(art, baseCtx());

    assert.equal(records.length, 1);
    assert.equal(skipped.length, 0);
    assert.equal(fakeVerifyCitation.calls.length, 1);

    const r = records[0];
    assert.equal(r.wiki, 'enwiki');
    assert.equal(r.pageId, 12345);
    assert.equal(r.pageTitle, 'Test Article');
    assert.equal(r.revisionId, 987654321);
    assert.equal(r.claimText, 'The bridge opened in 1998.');
    assert.equal(r.citationNumber, 1);
    assert.equal(r.refName, null, 'ref_name has no producer yet — must stay an honest null, not fabricated');
    assert.equal(r.sourceUrl, 'https://example.com/a');
    assert.equal(r.groupId, null);
    assert.equal(r.isCollective, false);
    assert.equal(r.verdict, 'SUPPORTED');
    assert.equal(r.confidence, 90);
    assert.equal(r.provider, 'publicai');
    assert.equal(r.model, 'qwen3-32b');
    assert.equal(r.promptVersion, PROMPT_VERSION);
    assert.equal(r.fetchStatus, 200);
    assert.equal(r.sourceTruncated, false);
    assert.equal(r.tokensIn, 100);
    assert.equal(r.tokensOut, 20);
    assert.equal(r.published, false, 'never decided by this module — see §2f');
    assert.deepEqual(r.fetchedAt, NOW);
    assert.deepEqual(r.expiresAt, new Date(NOW.getTime() + TTL_MS.FETCHED));
});

test('verifyCitation is called with the claim text and the raw source object', async () => {
    const art = article([citation({ claimText: 'CLAIM_MARKER', source: { content: 'X', status: 200 } })]);
    await toFindingRecords(art, baseCtx());
    assert.equal(fakeVerifyCitation.calls[0].claimText, 'CLAIM_MARKER');
    assert.equal(fakeVerifyCitation.calls[0].source.content, 'X');
});

test('sourceTruncated passes through from the verifier when present', async () => {
    const truncatingVerify = async () => ({ verdict: 'SUPPORTED', confidence: 80, sourceTruncated: true });
    const art = article([citation()]);
    const { records } = await toFindingRecords(art, baseCtx({ verifyCitation: truncatingVerify }));
    assert.equal(records[0].sourceTruncated, true);
});

// --- no-URL ---

test('a no-URL citation stores SOURCE UNAVAILABLE without calling the verifier', async () => {
    const art = article([citation({ url: null, source: { content: null, status: null, error: null, unavailableReason: 'no_url' } })]);
    const { records, skipped } = await toFindingRecords(art, baseCtx());

    assert.equal(records.length, 1);
    assert.equal(skipped.length, 0);
    assert.equal(fakeVerifyCitation.calls.length, 0, 'no LLM call for a no-URL citation');

    const r = records[0];
    assert.equal(r.verdict, 'SOURCE UNAVAILABLE');
    assert.equal(r.confidence, null);
    assert.equal(r.model, null, 'no natural value — no LLM was called');
    assert.equal(r.provider, null);
    assert.equal(r.promptVersion, PROMPT_VERSION, "set to what's current at write time even though unused");
    assert.equal(r.published, false);
    assert.equal(r.fetchedAt, null);
    assert.equal(r.expiresAt, null, 'no-URL findings never expire by TTL — see §2e');
});

// --- fetch failure (genuine, not refused) ---

test('a genuine fetch failure (404) stores SOURCE UNAVAILABLE with a short TTL', async () => {
    const art = article([citation({ source: { content: null, status: 404, error: 'Not Found', unavailableReason: 'fetch_failed' } })]);
    const { records, skipped } = await toFindingRecords(art, baseCtx());

    assert.equal(records.length, 1);
    assert.equal(skipped.length, 0);
    assert.equal(fakeVerifyCitation.calls.length, 0);

    const r = records[0];
    assert.equal(r.verdict, 'SOURCE UNAVAILABLE');
    assert.equal(r.fetchStatus, 404);
    assert.match(r.rationale, /HTTP 404/);
    assert.deepEqual(r.expiresAt, new Date(NOW.getTime() + TTL_MS.UNAVAILABLE));
});

test('a network-level failure with no status still stores SOURCE UNAVAILABLE', async () => {
    const art = article([citation({ source: { content: null, status: null, error: 'network error', unavailableReason: 'fetch_failed' } })]);
    const { records } = await toFindingRecords(art, baseCtx());
    assert.equal(records[0].verdict, 'SOURCE UNAVAILABLE');
    assert.match(records[0].rationale, /network error/);
    assert.equal(records[0].fetchStatus, null);
});

// --- refused (403/429) — must be skipped, never stored ---

for (const status of [403, 429]) {
    test(`a ${status} refusal is skipped, not stored as SOURCE UNAVAILABLE`, async () => {
        const art = article([citation({ source: { content: null, status, error: 'Forbidden', unavailableReason: 'fetch_failed' } })]);
        const { records, skipped } = await toFindingRecords(art, baseCtx());

        assert.equal(records.length, 0);
        assert.equal(fakeVerifyCitation.calls.length, 0);
        assert.equal(skipped.length, 1);
        assert.equal(skipped[0].reason, SKIP_REASONS.BLOCKED_FETCH);
        assert.equal(skipped[0].url, 'https://example.com/a');
    });
}

// --- stub source fetching (sourceFetchEnabled: false) ---

test('a URL-bearing citation is skipped as stub when sourceFetchEnabled is false, never stored as SOURCE UNAVAILABLE', async () => {
    const art = article([citation({ source: { content: null, status: null, error: 'source fetching not wired up', unavailableReason: 'fetch_failed' } })]);
    const { records, skipped } = await toFindingRecords(art, baseCtx({ sourceFetchEnabled: false }));

    assert.equal(records.length, 0);
    assert.equal(fakeVerifyCitation.calls.length, 0);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].reason, SKIP_REASONS.STUB_SOURCE_FETCH);
});

test('a no-URL citation is unaffected by sourceFetchEnabled: false — it was never going to be fetched either way', async () => {
    const art = article([citation({ url: null, source: { content: null, status: null, error: null, unavailableReason: 'no_url' } })]);
    const { records, skipped } = await toFindingRecords(art, baseCtx({ sourceFetchEnabled: false }));
    assert.equal(records.length, 1);
    assert.equal(records[0].verdict, 'SOURCE UNAVAILABLE');
    assert.equal(skipped.length, 0);
});

// --- collective groups ---

function groupCitations({ n = 3, overrides = [] } = {}) {
    const groupCitationNumbers = Array.from({ length: n }, (_, i) => String(i + 1));
    return Array.from({ length: n }, (_, i) => citation({
        citationNumber: String(i + 1),
        url: `https://example.com/${i + 1}`,
        groupId: 'cite_ref-shared-0', // a Parsoid DOM id — deliberately NOT what ends up stored
        groupSize: n,
        groupIndex: i,
        groupCitationNumbers,
        source: { content: 'Body text.', status: 200, error: null, unavailableReason: null, cached: false },
        ...(overrides[i] || {}),
    }));
}

test('a group of 3 available citations produces 4 records: 3 per-source + 1 collective', async () => {
    const art = article(groupCitations({ n: 3 }));
    const { records, skipped } = await toFindingRecords(art, baseCtx());

    assert.equal(records.length, 4);
    assert.equal(skipped.length, 0);
    assert.equal(fakeVerifyCitation.calls.length, 3, 'one per-source call per member');
    assert.equal(fakeVerifyGroup.calls.length, 1, 'exactly one collective call for the group');

    const perSource = records.filter(r => !r.isCollective);
    const collective = records.filter(r => r.isCollective);
    assert.equal(perSource.length, 3);
    assert.equal(collective.length, 1);

    for (const r of perSource) {
        assert.equal(r.verdict, 'SUPPORTED', 'per-source rows keep their own verdict, not the collective one');
    }
    assert.equal(collective[0].verdict, 'PARTIALLY SUPPORTED');
    assert.equal(collective[0].confidence, 60);
});

test('every member of a group shares the SAME group_id as the collective row, and it is not the Parsoid DOM id', async () => {
    const art = article(groupCitations({ n: 3 }));
    const { records } = await toFindingRecords(art, baseCtx());

    const groupIds = new Set(records.map(r => r.groupId));
    assert.equal(groupIds.size, 1, 'all 4 rows must share one group_id');
    const [groupId] = groupIds;
    assert.notEqual(groupId, 'cite_ref-shared-0', 'must not be the revision-scoped Parsoid DOM id — see §2b');
    assert.match(groupId, /^[0-9a-f]{64}$/, 'must be the hex groupSourceUrlHash — 32 bytes');
});

test('the collective row\'s group_id equals its own source_url_hash, per design (one derivation, two columns)', async () => {
    const art = article(groupCitations({ n: 2 }));
    const { records } = await toFindingRecords(art, baseCtx());
    const collective = records.find(r => r.isCollective);

    const { params } = buildUpsertQuery(collective);
    // source_url_hash is params[9] (see the column order in buildUpsertQuery).
    const storedSourceUrlHash = params[9];
    assert.deepEqual(storedSourceUrlHash, Buffer.from(collective.groupId, 'hex'));
    assert.deepEqual(storedSourceUrlHash, groupSourceUrlHash(collective.sourceUrls));
});

test('the collective row\'s source_url_hash is independent of member order (matches core/anchor.js)', async () => {
    const a = groupCitations({ n: 3 });
    const b = [a[2], a[0], a[1]]; // reordered
    const [recA] = (await toFindingRecords(article(a), baseCtx())).records.filter(r => r.isCollective);
    const [recB] = (await toFindingRecords(article(b), baseCtx())).records.filter(r => r.isCollective);
    assert.equal(recA.groupId, recB.groupId);
});

test('collective citation_number is the lowest member number when every member parses', async () => {
    const art = article(groupCitations({ n: 3 })); // citation numbers '1','2','3'
    const { records } = await toFindingRecords(art, baseCtx());
    const collective = records.find(r => r.isCollective);
    assert.equal(collective.citationNumber, 1);
});

test('collective citation_number is null when any member fails to parse as an integer', async () => {
    const art = article(groupCitations({ n: 2, overrides: [{}, { citationNumber: 'iv' }] }));
    const { records } = await toFindingRecords(art, baseCtx());
    const collective = records.find(r => r.isCollective);
    assert.equal(collective.citationNumber, null);
});

test('a group where one member is refused (403) and the rest are available: member is skipped, group gets a real collective verdict', async () => {
    const art = article(groupCitations({
        n: 3,
        overrides: [{}, { source: { content: null, status: 403, error: 'Forbidden' } }, {}],
    }));
    const { records, skipped } = await toFindingRecords(art, baseCtx());

    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].reason, SKIP_REASONS.BLOCKED_FETCH);
    assert.equal(skipped[0].isCollective, false);

    const perSource = records.filter(r => !r.isCollective);
    assert.equal(perSource.length, 2, 'only the 2 available members get their own row');

    const collective = records.find(r => r.isCollective);
    assert.ok(collective, 'the group still gets a collective verdict — some content was available');
    assert.equal(fakeVerifyGroup.calls.length, 1);
    // The blocked member's status is still passed to the group verifier as
    // context — that's an existing, separate concern (assembleGroupSources
    // already labels partial coverage); only the STORAGE decision differs.
    const blockedEntry = fakeVerifyGroup.calls[0].entries.find(e => e.status === 403);
    assert.ok(blockedEntry, 'the verifier still sees the blocked member for partial-coverage reasoning');
});

test('a group where every member is refused (403) is skipped entirely — no collective row either', async () => {
    const art = article(groupCitations({
        n: 2,
        overrides: [
            { source: { content: null, status: 403, error: 'Forbidden' } },
            { source: { content: null, status: 429, error: 'Too Many Requests' } },
        ],
    }));
    const { records, skipped } = await toFindingRecords(art, baseCtx());

    assert.equal(records.length, 0, 'no per-source rows and no collective row');
    assert.equal(fakeVerifyGroup.calls.length, 0);
    assert.equal(skipped.length, 3, '2 per-source skips + 1 collective skip');
    assert.ok(skipped.every(s => s.reason === SKIP_REASONS.BLOCKED_FETCH));
    const collectiveSkip = skipped.find(s => s.isCollective);
    assert.ok(collectiveSkip);
});

test('a group where every member fails for a genuine (non-refusal) reason stores a real SOURCE UNAVAILABLE collective row', async () => {
    const art = article(groupCitations({
        n: 2,
        overrides: [
            { source: { content: null, status: 404, error: 'Not Found' } },
            { source: { content: null, status: 500, error: 'Server Error' } },
        ],
    }));
    const { records, skipped } = await toFindingRecords(art, baseCtx());

    const perSource = records.filter(r => !r.isCollective);
    assert.equal(perSource.length, 2, 'both genuinely-unavailable members get their own SOURCE UNAVAILABLE row');
    assert.ok(perSource.every(r => r.verdict === 'SOURCE UNAVAILABLE'));

    const collective = records.find(r => r.isCollective);
    assert.ok(collective, 'a genuine (non-refusal) failure is a real, storable signal');
    assert.equal(collective.verdict, 'SOURCE UNAVAILABLE');
    assert.equal(collective.rationale, 'None of the grouped sources could be retrieved.');
    assert.equal(fakeVerifyGroup.calls.length, 0, 'no LLM call when nothing was available');
    assert.deepEqual(collective.expiresAt, new Date(NOW.getTime() + TTL_MS.UNAVAILABLE));
    assert.equal(skipped.length, 0);
});

test('a group where every member is a no-URL citation stores a real SOURCE UNAVAILABLE collective row with no TTL', async () => {
    const art = article(groupCitations({
        n: 2,
        overrides: [
            { url: null, source: { content: null, status: null, error: null, unavailableReason: 'no_url' } },
            { url: null, source: { content: null, status: null, error: null, unavailableReason: 'no_url' } },
        ],
    }));
    const { records } = await toFindingRecords(art, baseCtx());
    const collective = records.find(r => r.isCollective);
    assert.ok(collective);
    assert.equal(collective.verdict, 'SOURCE UNAVAILABLE');
    assert.equal(collective.expiresAt, null, 'a fully no-URL group never becomes fetchable, same as a solo no-URL citation');
});

test('a group stubbed for source fetching (sourceFetchEnabled: false) is skipped entirely as stub, not stored as unavailable', async () => {
    const art = article(groupCitations({ n: 2 }));
    const { records, skipped } = await toFindingRecords(art, baseCtx({ sourceFetchEnabled: false }));

    assert.equal(records.length, 0);
    assert.equal(fakeVerifyGroup.calls.length, 0);
    assert.ok(skipped.every(s => s.reason === SKIP_REASONS.STUB_SOURCE_FETCH));
    assert.equal(skipped.filter(s => s.isCollective).length, 1);
});

test('groupId links per-source rows to their collective row identically across two independent articles with the same source set', async () => {
    // Not a dedup claim (that lives in the unique key/ON DUPLICATE KEY UPDATE,
    // provable only against real MariaDB) — just that this module derives the
    // SAME identity for the same inputs, which is the precondition for dedup
    // to work at all.
    const artA = article(groupCitations({ n: 2 }), { pageId: 1 });
    const artB = article(groupCitations({ n: 2 }), { pageId: 2 });
    const recA = (await toFindingRecords(artA, baseCtx())).records.find(r => r.isCollective);
    const recB = (await toFindingRecords(artB, baseCtx())).records.find(r => r.isCollective);
    assert.equal(recA.groupId, recB.groupId);
});

// --- fields this module deliberately never decides ---

test('published is always false, regardless of verdict', async () => {
    const art = article([citation()]);
    const { records } = await toFindingRecords(art, baseCtx());
    assert.equal(records[0].published, false);
});

test('a solo citation gets group_id null and is_collective false', async () => {
    const art = article([citation()]);
    const { records } = await toFindingRecords(art, baseCtx());
    assert.equal(records[0].groupId, null);
    assert.equal(records[0].isCollective, false);
});
