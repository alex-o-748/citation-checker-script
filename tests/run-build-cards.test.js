import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildCards, parseArgs } from '../service/run-build-cards.js';
import { normalizeFinding } from '../service/cards/selection.js';

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

const finding = over => normalizeFinding({
    wiki: 'enwiki', page_id: '1', page_title: 'Combat Zone Wrestling', revision_id: '100',
    claim_text: 'Combat Zone Wrestling (CZW) is an American professional wrestling promotion founded in 1999 by John Zandig.',
    source_url: 'https://lastwordonsports.com/czw/',
    verdict: 'NOT SUPPORTED', reason_type: 'contradiction',
    source_quote: 'CZW was born in a simpler time, way back in 1998, by John Zandig in Philadelphia',
    quote_status: 'exact', source_truncated: '0', is_collective: '0', check_kind: 'citation', lead_demoted: '0',
    provider: 'liftwing', prompt_version: 'v4',
    ...over,
});

const PAGES = {
    'Combat Zone Wrestling': { pageid: 1, protection: [], content: "'''CZW''' is an American [[professional wrestling]] promotion founded in 1999 by [[John Zandig]].\n== History ==\nText." },
    'Protected page': { pageid: 2, protection: [{ type: 'edit', level: 'autoconfirmed' }], content: 'founded in 1999 by someone' },
    'Some person': { pageid: 3, protection: [], categories: [{ title: 'Category:Living people' }], content: 'born in 1999 in a town' },
    'A drug': { pageid: 4, protection: [], content: 'The drug was approved in 1999 by the agency.' },
    'A chain': { pageid: 5, protection: [], content: 'The chain has six stores in total.' },
};
const TOPICS = { 1: ['Culture.Media.Television'], 4: ['STEM.Medicine & Health'], 5: ['History and Society.Business and economics'] };

function fakeFetch(calls) {
    return async (url, init = {}) => {
        const u = String(url);
        if (u.includes('/w/api.php')) {
            calls.pages++;
            const titles = new URL(u).searchParams.get('titles').split('|');
            return json({
                query: {
                    pages: titles.map(t => {
                        const p = PAGES[t];
                        if (!p) return { title: t, missing: true };
                        return { pageid: p.pageid, title: t, protection: p.protection, categories: p.categories, revisions: [{ revid: 200 + p.pageid, slots: { main: { content: p.content } } }] };
                    }),
                },
            });
        }
        if (u.includes('outlink-topic-model')) {
            calls.topics++;
            const title = JSON.parse(init.body).page_title.replace(/_/g, ' ');
            const id = PAGES[title].pageid;
            return json({ prediction: { results: (TOPICS[id] || []).map(topic => ({ topic, score: 0.9 })) } });
        }
        if (u.includes('pageviews')) {
            calls.views++;
            return json({ items: [{ views: 4321 }] });
        }
        throw new Error(`unexpected fetch ${u}`);
    };
}

function fakeModel(calls) {
    return async ({ userContent }) => {
        calls.model++;
        if (userContent.includes('six stores')) {
            return { text: '{"claim_span":"six","quote_span":"five","both_can_be_true":true,"reason":"Store counts change."}' };
        }
        const claimSpan = userContent.includes('approved') ? 'approved in 1999' : '1999';
        return { text: JSON.stringify({ claim_span: claimSpan, quote_span: '1998', both_can_be_true: false, reason: 'Cannot both be right.' }) };
    };
}

const FINDINGS = [
    finding(),
    finding({ page_id: '2', page_title: 'Protected page', claim_text: 'It was founded in 1999 by someone.' }),
    finding({ page_id: '3', page_title: 'Some person', claim_text: 'She was born in 1999 in a town.' }),
    finding({ page_id: '4', page_title: 'A drug', claim_text: 'The drug was approved in 1999 by the agency.', source_quote: 'The drug was approved in 1998 by the agency after trials' }),
    finding({ page_id: '5', page_title: 'A chain', claim_text: 'The chain has six stores in total.', source_quote: 'There are only five stores left in the whole country' }),
    finding({ page_id: '6', page_title: 'Gone page', claim_text: 'It opened in 1999 to great acclaim.' }),
    finding({ reason_type: 'omission' }),
];

test('buildCards keeps the real contradiction and says why it dropped each of the others', async () => {
    const calls = { pages: 0, topics: 0, views: 0, model: 0 };
    const out = await buildCards({
        findings: FINDINGS, wiki: 'enwiki', callModel: fakeModel(calls), provider: 'liftwing', model: 'm',
        fetchImpl: fakeFetch(calls), now: new Date('2026-11-23T00:00:00Z'),
    });
    assert.equal(out.cards.length, 1);
    const [card] = out.cards;
    assert.equal(card.pageTitle, 'Combat Zone Wrestling');
    assert.equal(card.claim.text.slice(card.claim.span.start, card.claim.span.end), '1999');
    assert.equal(card.quote.text.slice(card.quote.span.start, card.quote.span.end), '1998');
    assert.equal(card.findText, 'founded in 1999');
    assert.deepEqual(card.section, { index: 0, title: null });
    assert.deepEqual(card.topics, ['film-tv']);
    assert.equal(card.monthlyViews, 4321);
    assert.equal(card.sourceLabel, 'lastwordonsports.com');
    assert.equal(card.revisionId, 201, 'the revision the sentence was found in, not the finding\'s');
    assert.equal(card.finding.revisionId, 100);

    assert.deepEqual(out.dropped, {
        not_a_contradiction: 1, protected: 1, blp: 1, excluded_topic: 1, both_can_be_true: 1, page_missing: 1,
    });
    // Protected, BLP and missing pages never reach the model.
    assert.equal(calls.model, 3);
});

test('a rebuild reuses cached decisions and topics, and calls the model only for changed findings', async () => {
    const calls = { pages: 0, topics: 0, views: 0, model: 0 };
    const now = new Date('2026-11-23T00:00:00Z');
    const first = await buildCards({ findings: FINDINGS, wiki: 'enwiki', callModel: fakeModel(calls), fetchImpl: fakeFetch(calls), now });
    const second = { pages: 0, topics: 0, views: 0, model: 0 };
    const again = await buildCards({ findings: FINDINGS, wiki: 'enwiki', callModel: fakeModel(second), fetchImpl: fakeFetch(second), now, existing: first });
    assert.equal(second.model, 0);
    assert.equal(second.topics, 0);
    assert.equal(second.views, 0, 'views are reused within the same month');
    assert.ok(second.pages > 0, 'the articles are always re-read: that is the freshness check');
    assert.deepEqual(again.cards, first.cards);

    const nextMonth = { pages: 0, topics: 0, views: 0, model: 0 };
    await buildCards({ findings: FINDINGS, wiki: 'enwiki', callModel: fakeModel(nextMonth), fetchImpl: fakeFetch(nextMonth), now: new Date('2026-12-02T00:00:00Z'), existing: first });
    assert.ok(nextMonth.views > 0);
});

test('a fixed sentence drops its card on the next build', async () => {
    const calls = { pages: 0, topics: 0, views: 0, model: 0 };
    const original = PAGES['Combat Zone Wrestling'].content;
    PAGES['Combat Zone Wrestling'].content = original.replace('founded in 1999', 'founded in 1998');
    try {
        const out = await buildCards({ findings: [finding()], wiki: 'enwiki', callModel: fakeModel(calls), fetchImpl: fakeFetch(calls) });
        assert.equal(out.cards.length, 0);
        assert.deepEqual(out.dropped, { sentence_not_found: 1 });
    } finally {
        PAGES['Combat Zone Wrestling'].content = original;
    }
});

test('a failed model call skips the finding without caching it; an auth error halts the build', async () => {
    const calls = { pages: 0, topics: 0, views: 0, model: 0 };
    const flaky = await buildCards({
        findings: [finding()], wiki: 'enwiki', fetchImpl: fakeFetch(calls),
        callModel: async () => { throw new Error('Lift Wing API request failed (500): oops'); },
    });
    assert.deepEqual(flaky.dropped, { conflict_call_failed: 1 });
    assert.deepEqual(flaky.decisions, {});

    await assert.rejects(buildCards({
        findings: [finding()], wiki: 'enwiki', fetchImpl: fakeFetch(calls),
        callModel: async () => { throw new Error('API request failed (401): bad key'); },
    }), /401/);
});

test('parseArgs needs an input and a known provider', () => {
    assert.throws(() => parseArgs([]), /--findings-csv/);
    assert.throws(() => parseArgs(['--from-toolsdb', '--provider', 'nope']), /Unknown provider/);
    const opts = parseArgs(['--findings-csv', 'a.csv', '--findings-csv', 'b.csv', '--out', 'c.json']);
    assert.deepEqual(opts.findingsCsv, ['a.csv', 'b.csv']);
    assert.equal(opts.out, 'c.json');
    assert.equal(opts.wiki, 'enwiki');
});
