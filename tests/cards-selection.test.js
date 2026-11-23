import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    buildCandidateQuery, normalizeFinding, candidateRejection, isTimeVarying, cardIdFor,
    CARD_QUOTE_STATUSES,
} from '../service/cards/selection.js';

const base = {
    wiki: 'enwiki', page_id: '42', page_title: 'Combat Zone Wrestling', revision_id: '1329482180',
    claim_text: 'CZW is a promotion founded in 1999 by John Zandig.',
    source_url: 'https://lastwordonsports.com/prowrestling/2022/06/28/combat-zone-wrestling/',
    verdict: 'NOT SUPPORTED', reason_type: 'contradiction',
    source_quote: 'CZW was born in a simpler time, way back in 1998', quote_status: 'exact',
    source_truncated: '0', is_collective: '0', check_kind: 'citation', lead_demoted: '0', is_blp: '0',
};
const finding = (over = {}) => normalizeFinding({ ...base, ...over });

test('a verified contradiction on a whole source is a candidate', () => {
    assert.equal(candidateRejection(finding()), null);
});

test('the JS rule rejects everything the SQL rule leaves out', () => {
    const cases = [
        [{ verdict: 'PARTIALLY SUPPORTED' }, 'not_not_supported'],
        [{ reason_type: 'omission' }, 'not_a_contradiction'],
        [{ quote_status: 'partial' }, 'quote_not_verified'],
        [{ quote_status: 'not-found' }, 'quote_not_verified'],
        [{ source_truncated: '1' }, 'source_truncated'],
        [{ is_collective: '1' }, 'group_finding'],
        [{ lead_demoted: '1' }, 'lead_demoted'],
        [{ check_kind: 'lead_body' }, 'not_a_citation_check'],
        [{ is_blp: '1' }, 'blp'],
        [{ source_quote: '' }, 'missing_text'],
        [{ claim_text: 'As of December 2024, the company operates six locations.' }, 'time_varying'],
    ];
    for (const [over, reason] of cases) assert.equal(candidateRejection(finding(over)), reason, JSON.stringify(over));
});

test('the SQL rule binds every value and filters on the same columns', () => {
    const { sql, params } = buildCandidateQuery({ wiki: 'enwiki', limit: 10 });
    for (const column of ['check_kind', 'verdict', 'reason_type', 'quote_status', 'source_truncated', 'is_collective', 'lead_demoted']) {
        assert.match(sql, new RegExp(`\\b${column}\\b`), column);
    }
    assert.deepEqual(params, ['enwiki', 'NOT SUPPORTED', 'contradiction', ...CARD_QUOTE_STATUSES, 10]);
    assert.doesNotMatch(sql, /enwiki/);
    assert.throws(() => buildCandidateQuery({}), /requires a wiki/);
});

test('ToolsDB rows (numbers, Buffers) and CSV rows (strings) normalize the same way', () => {
    const fromDb = normalizeFinding({
        ...base, page_id: 42, revision_id: 1329482180, source_truncated: 0, is_collective: 0, lead_demoted: 0,
        verdict: Buffer.from('NOT SUPPORTED'), reason_type: Buffer.from('contradiction'), quote_status: Buffer.from('exact'),
        is_blp: undefined,
    });
    const fromCsv = finding({ is_blp: '' });
    assert.deepEqual(fromDb, fromCsv);
    assert.equal(fromCsv.isBlp, null, 'an empty is_blp is unknown, not false');
});

test('moving figures are recognized; ordinary dated facts are not', () => {
    assert.equal(isTimeVarying('As of the 2025 season, his record stands at 6–5.'), true);
    assert.equal(isTimeVarying('The company currently employs 400 people.'), true);
    assert.equal(isTimeVarying('The bridge opened in 1998.'), false);
    assert.equal(isTimeVarying('The company was founded as Ofcom.'), false);
});

test('card ids are stable, short, and ignore the provider and prompt version', () => {
    const a = cardIdFor(finding());
    assert.match(a, /^[0-9a-f]{12}$/);
    assert.equal(cardIdFor(finding({ provider: 'other', prompt_version: 'v9' })), a);
    assert.notEqual(cardIdFor(finding({ claim_text: 'Something else entirely.' })), a);
});
