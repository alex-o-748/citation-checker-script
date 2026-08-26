import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assembleFinding, FINDING_TTL_DAYS } from '../service/assemble.js';
import { buildUpsertQuery } from '../service/findings.js';

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
        supportScore: 90,
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
        supportScore: null,
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
        supportScore: null,
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
        supportScore: 90,
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
