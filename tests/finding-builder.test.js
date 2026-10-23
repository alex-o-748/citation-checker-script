import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assembleFinding, assembleGroupFinding, assembleLeadFinding, assembleUncitedFinding, articleSourceUrl, CHECK_KINDS, FINDING_TTL_DAYS } from '../service/finding-builder.js';
import { LEAD_PROMPT_VERSION } from '../core/lead-check.js';
import { UNCITED_PROMPT_VERSION } from '../core/uncited-check.js';
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

const soloArgs = (overrides = {}) => ({
    candidate,
    citation: {
        claimText: 'c', citationNumber: '1', url: 'https://example.com/a', groupId: null,
        source: { content: 'Source Content:\\ntext', status: 200, error: null },
    },
    verification: {
        verdict: 'SUPPORTED', supportScore: 90, reasonType: null, rationale: 'ok',
        sourceQuote: null, quoteStatus: 'empty', usage: { input: 1, output: 1 }, fetchStatus: 200,
    },
    provider: 'publicai', model: 'qwen3-32b', promptVersion: 'v1',
    ...overrides,
});

test('every finding carries a check_id — 16 hex, fresh per row', () => {
    const a = assembleFinding(soloArgs());
    const b = assembleFinding(soloArgs());
    assert.match(a.checkId, /^[0-9a-f]{16}$/, '16 hex: 8 is the userscript\'s low-volume budget, not a sweep\'s');
    assert.notEqual(a.checkId, b.checkId, 'two rows in one run must not collide');
});

test('check_id is injectable, so the module stays testable without a random source', () => {
    assert.equal(assembleFinding(soloArgs({ checkId: 'deadbeefdeadbeef' })).checkId, 'deadbeefdeadbeef');
});

test('a collective finding gets its own check_id, distinct from its members\'', () => {
    const members = [
        { claimText: 'c', citationNumber: '2', url: 'https://a.example/x', groupId: 'g1', source: { content: 'a', status: 200 } },
        { claimText: 'c', citationNumber: '3', url: 'https://b.example/x', groupId: 'g1', source: { content: 'b', status: 200 } },
    ];
    const group = assembleGroupFinding({
        candidate, members,
        verification: {
            skipped: false, groupId: 'g1', memberCitationNumbers: ['2', '3'],
            verdict: 'SUPPORTED', supportScore: 90, reasonType: null, rationale: 'ok',
            sourceQuote: null, quoteStatus: 'empty', usage: { input: 1, output: 1 },
        },
        provider: 'publicai', model: 'qwen3-32b', promptVersion: 'v1',
    });
    const member = assembleFinding(soloArgs());
    assert.match(group.checkId, /^[0-9a-f]{16}$/);
    assert.notEqual(group.checkId, member.checkId, 'a separate row from a separate model call');
});

test('a fetch failure carries the fetcher\'s own message onto the finding', () => {
    const citation = {
        claimText: 'The bridge opened in 1998.',
        citationNumber: '3',
        url: 'https://example.invalid/a',
        groupId: null,
        source: {
            content: null, status: null,
            error: 'getaddrinfo ENOTFOUND example.invalid',
            unavailableReason: 'fetch_failed',
        },
    };
    const finding = assembleFinding({
        candidate, citation,
        verification: {
            verdict: 'SOURCE UNAVAILABLE', supportScore: null, reasonType: 'fetch_failed',
            rationale: null, sourceQuote: null, quoteStatus: null, usage: null, fetchStatus: null,
        },
        provider: 'publicai', model: 'qwen3-32b', promptVersion: 'v1',
    });

    assert.equal(finding.fetchError, 'getaddrinfo ENOTFOUND example.invalid');
    assert.equal(finding.fetchStatus, null, 'a DNS failure never gets an HTTP status');
    assert.equal(finding.reasonType, 'fetch_failed');
});

test('a successfully fetched source leaves fetchError empty', () => {
    const finding = assembleFinding({
        candidate,
        citation: {
            claimText: 'c', citationNumber: '1', url: 'https://example.com/a', groupId: null,
            source: { content: 'Source Content:\ntext', status: 200, error: null },
        },
        verification: {
            verdict: 'SUPPORTED', supportScore: 90, reasonType: null, rationale: 'ok',
            sourceQuote: null, quoteStatus: 'empty', usage: { input: 1, output: 1 }, fetchStatus: 200,
        },
        provider: 'publicai', model: 'qwen3-32b', promptVersion: 'v1',
    });
    assert.equal(finding.fetchError, null);
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
        verdict: 'SUPPORTED', supportScore: 90, reasonType: null, rationale: 'Direct match.',
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
        verdict: 'SUPPORTED', supportScore: 90, reasonType: null, rationale: null,
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
    supportScore: 80,
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
        verification: { verdict: 'SOURCE UNAVAILABLE', supportScore: null, reasonType: null, rationale: null, sourceQuote: null, quoteStatus: null, usage: null, fetchStatus: null },
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

const leadResult = (extra = {}) => ({
    index: 0, text: 'Test Article is a bridge opened in 1998.', verdict: 'NOT SUPPORTED', reasonType: 'omission',
    supportScore: 5, sourceQuote: '', quoteStatus: 'empty', quoteText: null, section: null, comments: 'Not in the body.',
    outcome: 'not_covered', bodyTruncated: false, usage: { input: 900, output: 40 }, error: null, ...extra,
});

test('a lead-check result assembles into a lead_body row against the article itself', () => {
    const fetchedAt = new Date('2026-10-23T00:00:00Z');
    const finding = assembleLeadFinding({
        candidate: { ...candidate, isBlp: false }, result: leadResult({ section: 'History', bodyTruncated: true }),
        provider: 'liftwing', model: 'm', fetchedAt, checkId: 'abc',
    });
    assert.equal(finding.checkKind, CHECK_KINDS.LEAD_BODY);
    assert.equal(finding.claimText, 'Test Article is a bridge opened in 1998.');
    assert.equal(finding.citationNumber, null);
    assert.equal(finding.sourceUrl, 'https://en.wikipedia.org/w/index.php?curid=42');
    assert.equal(finding.sourceUrl, articleSourceUrl(candidate), 'by page, so a re-sweep updates it in place');
    assert.equal(finding.promptVersion, LEAD_PROMPT_VERSION);
    assert.equal(finding.verdict, 'NOT SUPPORTED');
    assert.equal(finding.reasonType, 'omission');
    assert.equal(finding.rationale, 'Not in the body.');
    assert.equal(finding.bodySection, 'History');
    assert.equal(finding.sourceTruncated, true, 'a body cut to fit is a truncated source');
    assert.equal(finding.sectionTitle, null, 'it is in the lead');
    assert.equal(finding.inLead, true);
    assert.equal(finding.leadDemoted, false);
    assert.equal(finding.provider, 'liftwing');
    assert.equal(finding.tokensIn, 900);
    assert.equal(finding.published, false);
    assert.equal(finding.checkId, 'abc');
    // The lead and a citation can carry the same sentence; the URL keeps them apart in uniq_finding.
    const { params } = buildUpsertQuery(finding);
    assert.equal(params.at(-2), 'lead_body');
});

test('a lead sentence the check could not answer is an ERROR row with its reason, and no model credited', () => {
    const finding = assembleLeadFinding({
        candidate, result: leadResult({ verdict: null, reasonType: null, usage: null, error: 'retries_exhausted' }),
        provider: 'liftwing', model: 'm',
    });
    assert.equal(finding.verdict, 'ERROR');
    assert.equal(finding.reasonType, 'retries_exhausted');
    assert.equal(finding.provider, null);
    assert.match(finding.rationale, /retries_exhausted/);
});

test('citation findings carry in_lead and lead_demoted', () => {
    const citation = {
        claimText: 'c', citationNumber: '1', url: 'https://example.com/a', inLead: true,
        source: { content: 'x', status: 200 },
    };
    const verification = { verdict: 'PARTIALLY SUPPORTED', usage: { input: 1, output: 1 } };
    const plain = assembleFinding({ candidate, citation: { ...citation, inLead: false }, verification, provider: 'p', model: 'm', promptVersion: 'v2' });
    assert.equal(plain.checkKind, CHECK_KINDS.CITATION);
    assert.equal(plain.inLead, false);
    assert.equal(plain.leadDemoted, false);
    const demoted = assembleFinding({ candidate, citation, verification, provider: 'p', model: 'm', promptVersion: 'v2', leadDemoted: true });
    assert.equal(demoted.inLead, true);
    assert.equal(demoted.leadDemoted, true);
    const group = assembleGroupFinding({
        candidate, members: [{ ...citation, groupId: 'g' }, { ...citation, citationNumber: '2', groupId: 'g' }],
        verification: { ...verification, skipped: false, groupId: 'g' }, provider: 'p', model: 'm', promptVersion: 'v2', leadDemoted: true,
    });
    assert.equal(group.inLead, true);
    assert.equal(group.leadDemoted, true);
});

// --- uncited-text check ---

const uncitedResult = (extra = {}) => ({
    index: 3, text: 'It was designed by Gustave Eiffel.', sectionTitle: 'History', excerpt: 'Gustave Eiffel',
    excerptStatus: 'exact', comments: 'It was designed by Anna Holt.', confidence: 'high',
    usage: { input: 400, output: 30 }, ...extra,
});

test('an uncited-text finding assembles into a NOT SUPPORTED / doubtful row against the article', () => {
    const finding = assembleUncitedFinding({
        candidate: { ...candidate, isBlp: true }, result: uncitedResult(), provider: 'liftwing', model: 'm', checkId: 'u1',
    });
    assert.equal(finding.checkKind, CHECK_KINDS.UNCITED);
    assert.equal(finding.verdict, 'NOT SUPPORTED');
    assert.equal(finding.reasonType, 'doubtful');
    assert.equal(finding.supportScore, null, 'the model gives no score, only a confidence');
    assert.equal(finding.uncitedConfidence, 'high');
    assert.equal(finding.claimText, 'It was designed by Gustave Eiffel.');
    assert.equal(finding.rationale, 'It was designed by Anna Holt.');
    assert.equal(finding.sourceQuote, 'Gustave Eiffel', 'the doubted words, from the article: the row\'s source');
    assert.equal(finding.quoteStatus, 'exact');
    assert.equal(finding.sourceUrl, articleSourceUrl(candidate));
    assert.equal(finding.sectionTitle, 'History');
    assert.equal(finding.citationNumber, null);
    assert.equal(finding.inLead, false);
    assert.equal(finding.sourceTruncated, false);
    assert.equal(finding.isBlp, true);
    assert.equal(finding.promptVersion, UNCITED_PROMPT_VERSION);
    assert.equal(finding.provider, 'liftwing');
    assert.equal(finding.tokensIn, 400);
    assert.equal(finding.published, false);
    const { params } = buildUpsertQuery(finding);
    assert.equal(params.at(-2), 'uncited');
});

test('an uncited sentence a failed call left unchecked is an ERROR row with no model credited', () => {
    const finding = assembleUncitedFinding({
        candidate, result: { index: 3, text: 'It is painted red.', sectionTitle: 'History', error: 'retries_exhausted' },
        provider: 'liftwing', model: 'm',
    });
    assert.equal(finding.verdict, 'ERROR');
    assert.equal(finding.reasonType, 'retries_exhausted');
    assert.equal(finding.provider, null);
    assert.equal(finding.uncitedConfidence, null);
    assert.match(finding.rationale, /retries_exhausted/);
});

test('other rows carry no uncited confidence', () => {
    const lead = assembleLeadFinding({ candidate, result: leadResult(), provider: 'p', model: 'm' });
    assert.equal(lead.uncitedConfidence, null);
});
