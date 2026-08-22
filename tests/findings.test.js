import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildUpsertQuery, buildBulkUpsertQuery, upsertFinding, DEFAULT_BULK_CHUNK_SIZE } from '../service/findings.js';
import { claimHash, sourceUrlHash, groupSourceUrlHash } from '../core/anchor.js';

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
    
    // Check that we have the right number of parameters
    const placeholderCount = (sql.match(/\?/g) || []).length;
    assert.equal(placeholderCount, params.length);
    
    // Check that we have 26 parameters (matching the schema)
    assert.equal(params.length, 26);
    
    // Check that hashes are computed correctly
    const expectedClaimHash = claimHash(finding.claimText);
    const expectedSourceUrlHash = sourceUrlHash(finding.sourceUrl);
    
    // Find the positions of the hash parameters (should be at positions for claim_hash and source_url_hash)
    assert.deepEqual(params[4], expectedClaimHash);
    assert.deepEqual(params[9], expectedSourceUrlHash);
});

test('buildUpsertQuery handles collective group findings', () => {
    const finding = {
        wiki: 'enwiki',
        pageId: 12345,
        pageTitle: 'Test Article',
        revisionId: 987654321,
        claimText: 'The sky is blue',
        // buildUpsertQuery does no citation_number coercion itself — that's
        // service/finding-record.js's toCitationNumber() job, upstream of
        // this function. A realistic collective finding therefore already
        // carries an integer (or null) here, never the raw "1, 2" string
        // core/citations.js's collectCitations() can produce for a group.
        citationNumber: 1,
        refName: null,
        sourceUrl: 'https://example.com',
        fetchedAt: new Date('2026-08-17T12:00:00Z'),
        groupId: 'group1',
        isCollective: true,
        verdict: 'PARTIALLY SUPPORTED',
        confidence: 75,
        reasonType: 'omission',
        rationale: 'Some evidence missing',
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
    assert.equal(params[21], 1); // source_truncated should be 1 for true
    
    // Check that published is properly converted to integer
    assert.equal(params[25], 0); // published should be 0 for false
    
    // Check that tokens_in is correctly placed
    assert.equal(params[22], 150); // tokens_in should be 150
    // Check that tokens_out is correctly placed
    assert.equal(params[23], 75); // tokens_out should be 75
});

test('buildUpsertQuery handles no-URL findings with empty-string hash', () => {
    // Decided 2026-08-20: no-URL / SOURCE UNAVAILABLE findings ARE stored.
    // Convention for the fields with no natural value since no LLM was
    // called: model stays null, prompt_version is set to whatever's
    // current at write time, published stays 0. See "Design question,
    // resolved" in docs/design-plans/2026-08-17-toolsdb-findings-store.md.
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

    // model (index 18) stays null; promptVersion (index 19) is still set
    assert.equal(params[18], null);
    assert.equal(params[19], 'v1.0');

    // published stays 0 for an unpublished no-URL finding
    assert.equal(params[25], 0);
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
    assert.equal(call.params.length, 26);
});

// --- buildBulkUpsertQuery ---

function makeFinding(overrides = {}) {
    return {
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
        provider: 'publicai',
        model: 'qwen3-32b',
        promptVersion: 'v1.0',
        fetchStatus: 200,
        sourceTruncated: false,
        tokensIn: 100,
        tokensOut: 50,
        expiresAt: new Date('2026-09-17T12:00:00Z'),
        published: true,
        ...overrides,
    };
}

test('buildBulkUpsertQuery rejects an empty or missing findings array', () => {
    assert.throws(() => buildBulkUpsertQuery([]), TypeError);
    assert.throws(() => buildBulkUpsertQuery(null), TypeError);
    assert.throws(() => buildBulkUpsertQuery(undefined), TypeError);
});

test('buildBulkUpsertQuery rejects a non-positive-integer chunkSize', () => {
    assert.throws(() => buildBulkUpsertQuery([makeFinding()], { chunkSize: 0 }), RangeError);
    assert.throws(() => buildBulkUpsertQuery([makeFinding()], { chunkSize: -1 }), RangeError);
    assert.throws(() => buildBulkUpsertQuery([makeFinding()], { chunkSize: 1.5 }), RangeError);
});

test('buildBulkUpsertQuery with N findings under the chunk size returns one chunk with N*26 placeholders', () => {
    const findings = [makeFinding({ pageId: 1 }), makeFinding({ pageId: 2 }), makeFinding({ pageId: 3 })];
    const chunks = buildBulkUpsertQuery(findings);

    assert.equal(chunks.length, 1);
    const { sql, params } = chunks[0];
    assert.match(sql, /INSERT INTO citation_findings/);
    assert.match(sql, /ON DUPLICATE KEY UPDATE/);
    assert.equal(params.length, 3 * 26);
    assert.equal((sql.match(/\?/g) || []).length, params.length);
});

test('buildBulkUpsertQuery splits findings across chunk boundaries in input order', () => {
    const findings = Array.from({ length: DEFAULT_BULK_CHUNK_SIZE + 1 }, (_, i) => makeFinding({ pageId: i }));
    const chunks = buildBulkUpsertQuery(findings);

    assert.equal(chunks.length, 2, 'one findings past the default chunk size must start a second chunk');
    assert.equal(chunks[0].params.length, DEFAULT_BULK_CHUNK_SIZE * 26);
    assert.equal(chunks[1].params.length, 1 * 26);

    // Order is preserved: the first param of each row is `wiki`, constant
    // here, so check pageId (the 2nd param of every 26-wide row) instead.
    assert.equal(chunks[0].params[1], 0);
    assert.equal(chunks[1].params[1], DEFAULT_BULK_CHUNK_SIZE);
});

test('buildBulkUpsertQuery respects a custom chunkSize', () => {
    const findings = Array.from({ length: 5 }, (_, i) => makeFinding({ pageId: i }));
    const chunks = buildBulkUpsertQuery(findings, { chunkSize: 2 });
    assert.equal(chunks.length, 3); // 2, 2, 1
    assert.equal(chunks[0].params.length, 2 * 26);
    assert.equal(chunks[1].params.length, 2 * 26);
    assert.equal(chunks[2].params.length, 1 * 26);
});

test('a single-finding bulk chunk produces the same params as buildUpsertQuery for that finding — the two builders cannot drift apart', () => {
    const finding = makeFinding();
    const single = buildUpsertQuery(finding);
    const bulk = buildBulkUpsertQuery([finding]);

    assert.equal(bulk.length, 1);
    assert.deepEqual(bulk[0].params, single.params);
});

test('buildBulkUpsertQuery computes source_url_hash per-row via core/anchor.js, same as buildUpsertQuery', () => {
    const findings = [
        makeFinding({ sourceUrl: 'https://a.example.com' }),
        makeFinding({ sourceUrl: 'https://b.example.com' }),
    ];
    const [{ params }] = buildBulkUpsertQuery(findings);

    // source_url_hash is param index 9 within each 26-wide row.
    assert.deepEqual(params[9], sourceUrlHash('https://a.example.com'));
    assert.deepEqual(params[9 + 26], sourceUrlHash('https://b.example.com'));
    assert.notDeepEqual(params[9], params[9 + 26]);
});

test('buildBulkUpsertQuery hashes a collective finding\'s source_url_hash from sourceUrls, not sourceUrl', () => {
    const finding = makeFinding({
        isCollective: true,
        sourceUrl: 'https://a.example.com; https://b.example.com',
        sourceUrls: ['https://a.example.com', 'https://b.example.com'],
    });
    const [{ params }] = buildBulkUpsertQuery([finding]);
    assert.deepEqual(params[9], groupSourceUrlHash(['https://a.example.com', 'https://b.example.com']));
});