import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildUpsertQuery, upsertFinding } from '../service/findings-store.js';
import { claimHash, sourceUrlHash } from '../core/anchor.js';

test('buildUpsertQuery binds all values and computes hashes internally', () => {
    const finding = {
        wiki: 'enwiki',
        pageId: 12345,
        pageTitle: 'Test Article',
        revisionId: 987654321,
        claimText: 'The sky is blue',
        citationNumber: 1,
        refName: 'ref1',
        sourceUrl: 'https://example.com',
        fetchedAt: new Date('2026-08-17T12:00:00Z'),
        groupId: 'group1',
        isCollective: false,
        verdict: 'SUPPORTED',
        confidence: 95,
        reasonType: null,
        rationale: 'Clear evidence in source',
        sourceQuote: 'The sky appears blue due to Rayleigh scattering.',
        quoteStatus: 'exact',
        provider: 'publicai',
        model: 'qwen3-32b',
        promptVersion: 'v1.0',
        fetchStatus: 200,
        sourceTruncated: false,
        tokensIn: 100,
        tokensOut: 50,
        expiresAt: new Date('2026-09-17T12:00:00Z'),
        published: true,
    };

    const { sql, params } = buildUpsertQuery(finding);

    // Check that SQL has the right structure
    assert.match(sql, /INSERT INTO citation_findings/);
    assert.match(sql, /ON DUPLICATE KEY UPDATE/);
    assert.match(sql, /source_quote/);
    assert.match(sql, /quote_status/);

    // Check that we have the right number of parameters
    const placeholderCount = (sql.match(/\?/g) || []).length;
    assert.equal(placeholderCount, params.length);

    // Check that we have 28 parameters (matching the schema, including
    // source_quote / quote_status added in service/migrations/
    // 002-add-quote-columns.sql)
    assert.equal(params.length, 28);

    // Check that hashes are computed correctly
    const expectedClaimHash = claimHash(finding.claimText);
    const expectedSourceUrlHash = sourceUrlHash(finding.sourceUrl);

    // Find the positions of the hash parameters (should be at positions for claim_hash and source_url_hash)
    assert.deepEqual(params[4], expectedClaimHash);
    assert.deepEqual(params[9], expectedSourceUrlHash);

    // source_quote / quote_status ride alongside rationale, ahead of provider/model
    assert.equal(params[17], finding.sourceQuote);
    assert.equal(params[18], finding.quoteStatus);
});

test('buildUpsertQuery handles collective group findings', () => {
    const finding = {
        wiki: 'enwiki',
        pageId: 12345,
        pageTitle: 'Test Article',
        revisionId: 987654321,
        claimText: 'The sky is blue',
        citationNumber: '1, 2',
        refName: null,
        sourceUrl: 'https://example.com',
        fetchedAt: new Date('2026-08-17T12:00:00Z'),
        groupId: 'group1',
        isCollective: true,
        verdict: 'PARTIALLY SUPPORTED',
        confidence: 75,
        reasonType: 'omission',
        rationale: 'Some evidence missing',
        sourceQuote: null,
        quoteStatus: 'empty',
        provider: 'publicai',
        model: 'qwen3-32b',
        promptVersion: 'v1.0',
        fetchStatus: 200,
        sourceTruncated: true,
        tokensIn: 150,
        tokensOut: 75,
        expiresAt: new Date('2026-09-17T12:00:00Z'),
        published: false,
    };

    const { sql, params } = buildUpsertQuery(finding);

    // Check that collective flag is properly converted to integer
    assert.equal(params[12], 1); // is_collective should be 1 for true

    // Check that source_truncated is properly converted to integer
    assert.equal(params[23], 1); // source_truncated should be 1 for true

    // Check that published is properly converted to integer
    assert.equal(params[27], 0); // published should be 0 for false

    // Check that tokens_in is correctly placed
    assert.equal(params[24], 150); // tokens_in should be 150
    // Check that tokens_out is correctly placed
    assert.equal(params[25], 75); // tokens_out should be 75
});

test('buildUpsertQuery handles no-URL findings with empty-string hash', () => {
    // Decided 2026-08-20: no-URL / SOURCE UNAVAILABLE findings ARE stored.
    // Convention for the fields with no natural value since no LLM was
    // called: model stays null, prompt_version is set to whatever's
    // current at write time, published stays 0. See "Design question,
    // resolved" in docs/design-plans/2026-08-17-toolsdb-findings-store.md.
    // No LLM ran, so there is no quote to record either — quoteStatus stays
    // null (not 'empty': 'empty' means the model was asked and offered
    // nothing; here it was never asked at all).
    const finding = {
        wiki: 'enwiki',
        pageId: 12345,
        pageTitle: 'Test Article',
        revisionId: 987654321,
        claimText: 'The sky is blue',
        citationNumber: 1,
        refName: null,
        sourceUrl: null, // No URL
        fetchedAt: new Date('2026-08-17T12:00:00Z'),
        groupId: null,
        isCollective: false,
        verdict: 'SOURCE UNAVAILABLE',
        confidence: 0,
        reasonType: 'no_url',
        rationale: 'No URL found in reference',
        sourceQuote: null,
        quoteStatus: null,
        provider: null,
        model: null, // no LLM was called
        promptVersion: 'v1.0', // current prompt version at write time
        fetchStatus: null,
        sourceTruncated: false,
        tokensIn: 0,
        tokensOut: 0,
        expiresAt: null,
        published: false,
    };

    const { sql, params } = buildUpsertQuery(finding);

    // Check that null sourceUrl produces the empty-string hash
    const expectedSourceUrlHash = sourceUrlHash(null);
    assert.deepEqual(params[9], expectedSourceUrlHash);

    // source_quote / quote_status (indices 17, 18) stay null
    assert.equal(params[17], null);
    assert.equal(params[18], null);

    // model (index 20) stays null; promptVersion (index 21) is still set
    assert.equal(params[20], null);
    assert.equal(params[21], 'v1.0');

    // published stays 0 for an unpublished no-URL finding
    assert.equal(params[27], 0);
});

// Fake query function for testing upsertFinding
async function fakeQuery(sql, params) {
    // Record the call for inspection
    fakeQuery.calls = fakeQuery.calls || [];
    fakeQuery.calls.push({ sql, params });

    // Return a mock result
    return { affectedRows: 1, insertId: 1 };
}

test('upsertFinding calls query with the constructed SQL and parameters', async () => {
    const finding = {
        wiki: 'enwiki',
        pageId: 12345,
        pageTitle: 'Test Article',
        revisionId: 987654321,
        claimText: 'The sky is blue',
        citationNumber: 1,
        refName: null,
        sourceUrl: 'https://example.com',
        fetchedAt: new Date('2026-08-17T12:00:00Z'),
        groupId: null,
        isCollective: false,
        verdict: 'SUPPORTED',
        confidence: 95,
        reasonType: null,
        rationale: 'Clear evidence in source',
        sourceQuote: 'Clear evidence in source.',
        quoteStatus: 'exact',
        provider: 'publicai',
        model: 'qwen3-32b',
        promptVersion: 'v1.0',
        fetchStatus: 200,
        sourceTruncated: false,
        tokensIn: 100,
        tokensOut: 50,
        expiresAt: new Date('2026-09-17T12:00:00Z'),
        published: true,
    };

    fakeQuery.calls = [];
    const result = await upsertFinding(fakeQuery, finding);

    // Check that query was called once
    assert.equal(fakeQuery.calls.length, 1);

    // Check that the result is returned
    assert.deepEqual(result, { affectedRows: 1, insertId: 1 });

    // Check that the SQL contains the expected structure
    const call = fakeQuery.calls[0];
    assert.match(call.sql, /INSERT INTO citation_findings/);
    assert.match(call.sql, /ON DUPLICATE KEY UPDATE/);

    // Check that we have the right number of parameters
    assert.equal(call.params.length, 28);
});
