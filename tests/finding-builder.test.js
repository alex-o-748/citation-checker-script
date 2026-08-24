import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assembleFinding, assembleGroupFinding, FINDING_TTL_DAYS } from '../service/finding-builder.js';
import { buildUpsertQuery } from '../service/findings-store.js';

const candidate = { wiki: 'enwiki', pageId: 42, title: 'Test Article', revisionId: 987654321 };

test('a verified citation assembles into a finding with published always false', () => {
    const citation = {
        claimText: 'The bridge opened in 1998.',
        citationNumber: '3',
        url: 'https://example.com/a',
        groupId: null,
        source: { content: 'Source URL: https://example.com/a\n\nSource Content:\nThe bridge opened to traffic in 1998.', status: 200 },
    };
    const verification = {
        verdict: 'SUPPORTED',
        confidence: 90,
        reasonType: null,
        rationale: 'Direct match.',
        sourceQuote: 'The bridge opened to traffic in 1998.',
        quoteStatus: 'exact',
        usage: { input: 100, output: 40 },
        fetchStatus: 200,
    };
    const fetchedAt = new Date('2026-08-22T00:00:00Z');

    const finding = assembleFinding({
        candidate, citation, verification,
        provider: 'publicai', model: 'qwen3-32b', promptVersion: 'v1',
        fetchedAt,
    });

    assert.equal(finding.wiki, 'enwiki');
    assert.equal(finding.pageId, 42);
    assert.equal(finding.pageTitle, 'Test Article');
    assert.equal(finding.revisionId, 987654321);
    assert.equal(finding.claimText, citation.claimText);
    assert.equal(finding.sourceUrl, citation.url);
    assert.equal(finding.verdict, 'SUPPORTED');
    assert.equal(finding.sourceQuote, 'The bridge opened to traffic in 1998.');
    assert.equal(finding.quoteStatus, 'exact');
    assert.equal(finding.provider, 'publicai');
    assert.equal(finding.model, 'qwen3-32b');
    assert.equal(finding.tokensIn, 100);
    assert.equal(finding.tokensOut, 40);
    assert.equal(finding.isCollective, false);
    assert.equal(finding.published, false, 'nothing is published before the §1 threshold exists');
    assert.deepEqual(finding.fetchedAt, fetchedAt);
    assert.deepEqual(
        finding.expiresAt,
        new Date(fetchedAt.getTime() + FINDING_TTL_DAYS * 24 * 60 * 60 * 1000)
    );
});

test('a citation from a named ref carries its recovered ref name into the finding', () => {
    const citation = {
        claimText: 'The bridge opened in 1998.',
        citationNumber: '3',
        refName: 'smith2001',
        url: 'https://example.com/a',
        groupId: null,
        source: { content: 'Source URL: https://example.com/a\n\nSource Content:\nThe bridge opened to traffic in 1998.', status: 200 },
    };
    const verification = {
        verdict: 'SUPPORTED', confidence: 90, reasonType: null, rationale: 'Direct match.',
        sourceQuote: 'The bridge opened to traffic in 1998.', quoteStatus: 'exact',
        usage: { input: 100, output: 40 }, fetchStatus: 200,
    };

    const finding = assembleFinding({
        candidate, citation, verification,
        provider: 'publicai', model: 'qwen3-32b', promptVersion: 'v1',
    });

    assert.equal(finding.refName, 'smith2001');
});

test('a citation from an unnamed ref stores a null ref name, not the string "null"', () => {
    const citation = {
        claimText: 'claim', citationNumber: '1', url: 'https://example.com/a', groupId: null,
        source: { content: 'Source URL: https://example.com/a\n\nSource Content:\ntext', status: 200 },
    };
    const verification = {
        verdict: 'SUPPORTED', confidence: 90, reasonType: null, rationale: null,
        sourceQuote: null, quoteStatus: null, usage: { input: 1, output: 1 }, fetchStatus: 200,
    };

    const finding = assembleFinding({
        candidate, citation, verification,
        provider: 'publicai', model: 'qwen3-32b', promptVersion: 'v1',
    });

    assert.equal(finding.refName, null);
});

test('a no-URL citation assembles without provider/model/fetchedAt/expiresAt', () => {
    const citation = {
        claimText: 'A claim from an offline book.',
        citationNumber: '5',
        url: null,
        groupId: null,
        source: { content: null, status: null, unavailableReason: 'no_url' },
    };
    const verification = {
        verdict: 'SOURCE UNAVAILABLE',
        confidence: null,
        reasonType: null,
        rationale: null,
        sourceQuote: null,
        quoteStatus: null,
        usage: null,
        fetchStatus: null,
    };

    const finding = assembleFinding({
        candidate, citation, verification,
        provider: 'publicai', model: 'qwen3-32b', promptVersion: 'v1',
    });

    assert.equal(finding.verdict, 'SOURCE UNAVAILABLE');
    assert.equal(finding.provider, null, 'no model ran, so no provider is claimed');
    assert.equal(finding.model, null);
    assert.equal(finding.fetchedAt, null);
    assert.equal(finding.expiresAt, null, 'nothing fetched means nothing to expire');
    assert.equal(finding.promptVersion, 'v1', "still set, even though no LLM ran — matches the maintainer's 2026-08-20 decision");
    assert.equal(finding.published, false);
});

test('a fetch failure keeps its status but still assembles without a provider', () => {
    const citation = {
        claimText: 'claim',
        citationNumber: '1',
        url: 'https://example.com/dead',
        groupId: null,
        source: { content: null, status: 403, unavailableReason: 'fetch_failed' },
    };
    const verification = {
        verdict: 'SOURCE UNAVAILABLE',
        confidence: null,
        reasonType: null,
        rationale: null,
        sourceQuote: null,
        quoteStatus: null,
        usage: null,
        fetchStatus: 403,
    };

    const finding = assembleFinding({
        candidate, citation, verification,
        provider: 'publicai', model: 'qwen3-32b', promptVersion: 'v1',
    });

    assert.equal(finding.fetchStatus, 403, '403 stays distinguishable from a dead link at the storage layer too');
    assert.equal(finding.provider, null);
});

test('assembled findings feed buildUpsertQuery without error', () => {
    const citation = {
        claimText: 'The bridge opened in 1998.',
        citationNumber: '3',
        url: 'https://example.com/a',
        groupId: null,
        source: { content: 'Source URL: https://example.com/a\n\nSource Content:\nThe bridge opened to traffic in 1998.', status: 200 },
    };
    const verification = {
        verdict: 'SUPPORTED',
        confidence: 90,
        reasonType: null,
        rationale: 'Direct match.',
        sourceQuote: 'The bridge opened to traffic in 1998.',
        quoteStatus: 'exact',
        usage: { input: 100, output: 40 },
        fetchStatus: 200,
    };

    const finding = assembleFinding({
        candidate, citation, verification,
        provider: 'publicai', model: 'qwen3-32b', promptVersion: 'v1',
    });

    const { sql, params } = buildUpsertQuery(finding);
    assert.equal((sql.match(/\?/g) || []).length, params.length);
});

const groupMembers = [
    {
        claimText: 'The bridge, built in 1998, cost $200 million.',
        citationNumber: '5',
        url: 'https://a.example',
        groupId: 'g1',
        source: { content: 'Source URL: https://a.example\n\nSource Content:\nThe bridge opened in 1998.', status: 200 },
    },
    {
        claimText: 'The bridge, built in 1998, cost $200 million.',
        citationNumber: '6',
        url: 'https://b.example',
        groupId: 'g1',
        source: { content: 'Source URL: https://b.example\n\nSource Content:\nFunding came from state grants.', status: 200 },
    },
];

const groupVerification = {
    skipped: false,
    groupId: 'g1',
    memberCitationNumbers: ['5', '6'],
    verdict: 'PARTIALLY SUPPORTED',
    confidence: 80,
    reasonType: null,
    rationale: 'Only the date is confirmed.',
    sourceQuote: 'The bridge opened in 1998.',
    quoteStatus: 'exact',
    usage: { input: 200, output: 50 },
};

test('a collective group verdict assembles with a joined source_url and citation_number', () => {
    const fetchedAt = new Date('2026-08-22T00:00:00Z');
    const finding = assembleGroupFinding({
        candidate, members: groupMembers, verification: groupVerification,
        provider: 'publicai', model: 'qwen3-32b', promptVersion: 'v1',
        fetchedAt,
    });

    assert.equal(finding.isCollective, true);
    assert.equal(finding.groupId, 'g1');
    assert.equal(finding.citationNumber, '5, 6');
    assert.equal(finding.refName, null);
    assert.equal(finding.sourceUrl, 'https://a.example\nhttps://b.example', 'sorted, newline-joined member URLs — §6a');
    assert.equal(finding.claimText, groupMembers[0].claimText);
    assert.equal(finding.verdict, 'PARTIALLY SUPPORTED');
    assert.equal(finding.provider, 'publicai');
    assert.equal(finding.tokensIn, 200);
    assert.equal(finding.published, false);
    assert.deepEqual(finding.fetchedAt, fetchedAt);
    assert.deepEqual(
        finding.expiresAt,
        new Date(fetchedAt.getTime() + FINDING_TTL_DAYS * 24 * 60 * 60 * 1000)
    );
});

test('a collective finding\'s source_url_hash never collides with a member\'s (§6a)', () => {
    // The bug this whole function exists to fix: a null/empty collective
    // source_url hashes identically to a no-URL member's, silently
    // overwriting one row with the other on the unique key.
    const finding = assembleGroupFinding({
        candidate, members: groupMembers, verification: groupVerification,
        provider: 'publicai', model: 'qwen3-32b', promptVersion: 'v1',
    });
    const noUrlMemberFinding = assembleFinding({
        candidate,
        citation: { claimText: 'x', citationNumber: '7', url: null, groupId: 'g1', source: { content: null, status: null } },
        verification: { verdict: 'SOURCE UNAVAILABLE', confidence: null, reasonType: null, rationale: null, sourceQuote: null, quoteStatus: null, usage: null, fetchStatus: null },
        provider: 'publicai', model: 'qwen3-32b', promptVersion: 'v1',
    });

    assert.notEqual(finding.sourceUrl, noUrlMemberFinding.sourceUrl);
    const { params: groupParams } = buildUpsertQuery(finding);
    const { params: memberParams } = buildUpsertQuery(noUrlMemberFinding);
    // source_url_hash is params[9] in buildUpsertQuery's positional list.
    assert.notDeepEqual(groupParams[9], memberParams[9]);
});

test('assembleGroupFinding refuses a skipped verifyGroup() result', () => {
    assert.throws(
        () => assembleGroupFinding({
            candidate, members: groupMembers, verification: { skipped: true, groupId: 'g1' },
            provider: 'publicai', model: 'qwen3-32b', promptVersion: 'v1',
        }),
        TypeError
    );
});

test('a collective finding assembled from a group with a no-URL member still assembles', () => {
    const members = [
        groupMembers[0],
        { claimText: groupMembers[0].claimText, citationNumber: '9', url: null, groupId: 'g1', source: { content: null, status: null } },
        groupMembers[1],
    ];
    const finding = assembleGroupFinding({
        candidate, members, verification: { ...groupVerification, memberCitationNumbers: ['5', '9', '6'] },
        provider: 'publicai', model: 'qwen3-32b', promptVersion: 'v1',
    });
    assert.equal(finding.citationNumber, '5, 9, 6', 'the no-URL member is still listed');
    assert.equal(finding.sourceUrl, 'https://a.example\nhttps://b.example', 'but contributes no URL to the joined list');
});

test('assembled group findings feed buildUpsertQuery without error', () => {
    const finding = assembleGroupFinding({
        candidate, members: groupMembers, verification: groupVerification,
        provider: 'publicai', model: 'qwen3-32b', promptVersion: 'v1',
    });
    const { sql, params } = buildUpsertQuery(finding);
    assert.equal((sql.match(/\?/g) || []).length, params.length);
});
