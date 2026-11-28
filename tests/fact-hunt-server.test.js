import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { createApp } from '../fact-hunt/server.js';
import { createDeck } from '../fact-hunt/lib/cards.js';
import { createStore } from '../fact-hunt/lib/store.js';
import { tokenize } from '../fact-hunt/lib/tokens.js';

const claim = 'Combat Zone Wrestling (CZW) is an American independent professional wrestling promotion founded in 1999 by John Zandig.';
const quote = 'CZW was born in a simpler time, way back in 1998, by John Zandig in Philadelphia';
const CARD = {
    id: '27c9765dd902', wiki: 'enwiki', host: 'en.wikipedia.org', pageId: 1, pageTitle: 'Combat Zone Wrestling',
    section: { index: 0, title: null },
    claim: { text: claim, span: { start: claim.indexOf('1999'), end: claim.indexOf('1999') + 4 } },
    quote: { text: quote, span: { start: quote.indexOf('1998'), end: quote.indexOf('1998') + 4 } },
    findText: 'founded in 1999', sourceUrl: 'https://lastwordonsports.com/czw/', sourceLabel: 'lastwordonsports.com',
    topics: ['film-tv'], monthlyViews: 5000,
};
const OTHER = { ...CARD, id: '74de5a9f24f8', pageTitle: 'Other article', topics: ['places'], monthlyViews: 10 };
const tokenOf = word => tokenize(claim).findIndex(t => claim.slice(t.start, t.end) === word);

async function start({ wikitext = 'promotion founded in 1999 by [[John Zandig]]', tags = [] } = {}) {
    const wiki = { wikitext, tags, calls: 0 };
    const fetchImpl = async url => {
        wiki.calls++;
        const params = new URL(url).searchParams;
        if (params.get('revids')) {
            return { ok: true, status: 200, json: async () => ({ query: { pages: [{ revisions: params.get('revids').split('|').map(r => ({ revid: Number(r), tags: wiki.tags })) }] } }) };
        }
        return { ok: true, status: 200, json: async () => ({ query: { pages: [{ pageid: 1, revisions: [{ revid: 500, timestamp: '2026-11-23T10:00:00Z', slots: { main: { content: wiki.wikitext } } }] }] } }) };
    };
    let clock = Date.parse('2026-11-23T10:00:00Z');
    const now = () => new Date(clock);
    const store = createStore({ now });
    const app = createApp({
        deck: createDeck({ cards: [CARD, OTHER] }), store, fetchImpl, now, random: () => 0,
        baseUrl: 'https://fact-hunt.example', projectPage: 'User:Example/Fact Hunt',
        readPublic: async name => {
            if (name === 'index.html') return Buffer.from('<head><!--META--></head><body></body>');
            throw new Error('no file');
        },
    });
    const server = createServer(app.handle);
    await new Promise(resolve => server.listen(0, resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (path, { method = 'GET', body, session = 'session-one' } = {}) => {
        const res = await fetch(base + path, {
            method,
            headers: { ...(session ? { 'X-Session': session } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
            body: body ? JSON.stringify(body) : undefined,
        });
        const type = res.headers.get('content-type') || '';
        return { status: res.status, body: type.includes('json') ? await res.json() : await res.text(), type };
    };
    return { call, app, store, wiki, advance: ms => { clock += ms; }, close: () => new Promise(r => server.close(r)) };
}

test('the whole flow: topics, a card, a tap, a hold, a fix detected, a fix page', async t => {
    const s = await start();
    t.after(s.close);

    const topics = await s.call('/api/topics');
    assert.equal(topics.body.topics.find(x => x.id === 'film-tv').open, 1);
    assert.equal(topics.body.any, 2);
    assert.equal(topics.body.fixed, 0);

    const next = await s.call('/api/next?topic=film-tv');
    assert.equal(next.body.card.id, CARD.id);
    assert.equal(next.body.left, 1);
    assert.equal(next.body.card.claim.span, undefined, 'no answer before an answer');

    const miss = await s.call('/api/answer', { method: 'POST', body: { card: CARD.id, kind: 'tap', token: tokenOf('Zandig') } });
    assert.equal(miss.body.result, 'miss');
    assert.equal(miss.body.from, '1999');

    const caught = await s.call('/api/answer', { method: 'POST', body: { card: CARD.id, kind: 'confirm', value: true } });
    assert.equal(caught.body.result, 'caught');
    assert.equal(caught.body.fixEnabled, true);
    assert.match(caught.body.fix.summary, /#facthunt/);

    // Someone else can't take the card while it's held.
    assert.equal((await s.call('/api/hold', { method: 'POST', body: { card: CARD.id, action: 'fix' } })).status, 200);
    assert.equal((await s.call('/api/hold', { method: 'POST', body: { card: CARD.id, action: 'fix' }, session: 'session-two' })).status, 409);
    const theirs = await s.call('/api/next?topic=film-tv', { session: 'session-two' });
    assert.equal(theirs.body.card, null, 'a held card isn\'t dealt to anyone else');

    // Not fixed yet; then the sentence changes.
    assert.deepEqual((await s.call('/api/check', { method: 'POST', body: { card: CARD.id } })).body, { fixed: false });
    assert.equal((await s.call('/api/check', { method: 'POST', body: { card: CARD.id } })).status, 429, 'checks are rate-limited per card');
    s.wiki.wikitext = 'promotion founded in 1998 by [[John Zandig]]';
    s.advance(5000);
    assert.deepEqual((await s.call('/api/check', { method: 'POST', body: { card: CARD.id } })).body, { fixed: true, revisionId: 500 });

    const after = await s.call('/api/topics');
    assert.equal(after.body.fixed, 1);
    assert.equal(after.body.latest.pageTitle, 'Combat Zone Wrestling');
    assert.equal(after.body.topics.find(x => x.id === 'film-tv').open, 0);

    const fixPage = await s.call(`/f/${CARD.id}`);
    assert.match(fixPage.body, /<title>Fixed: Combat Zone Wrestling<\/title>/);
    assert.match(fixPage.body, /og:image" content="https:\/\/fact-hunt\.example\/og\/f\/27c9765dd902\.png"/);
    const fixData = await s.call(`/api/card/${CARD.id}`);
    assert.equal(fixData.body.status, 'fixed');
    assert.equal(fixData.body.fixed.to, '1998');
});

test('a new visitor gets a fixed card as a warm-up, and warm-up answers count for nothing', async t => {
    const s = await start();
    t.after(s.close);
    s.store.record({ t: 'fixed', card: OTHER.id, session: 'x', revisionId: 1, snapshot: OTHER });
    const warm = await s.call('/api/next?topic=any', { session: 'new-visitor' });
    assert.equal(warm.body.card.warmUp, true);
    assert.equal(warm.body.card.id, OTHER.id);
    const answer = await s.call('/api/answer', { method: 'POST', body: { card: OTHER.id, kind: 'tap', token: tokenOf('1999') }, session: 'new-visitor' });
    assert.equal(answer.body.warmUp, true);
    assert.equal(answer.body.fixEnabled, false);
    assert.equal(s.store.state.counts.caught, 0);
    const real = await s.call('/api/next?topic=any&warmup=no', { session: 'new-visitor' });
    assert.equal(real.body.card.id, CARD.id);
    assert.equal(real.body.card.warmUp, false);
});

test('reverted fixes are found, and the stop rule then refuses new fix holds', async t => {
    const s = await start({ tags: ['mw-reverted'] });
    t.after(s.close);
    for (let i = 0; i < 11; i++) {
        s.store.record({ t: 'fixed', card: `fake${i}`, session: 'x', revisionId: 100 + i, snapshot: { host: 'en.wikipedia.org' } });
    }
    assert.equal(await s.app.checkReverts(), 11);
    assert.equal(s.app.gate().enabled, false);
    const caught = await s.call('/api/answer', { method: 'POST', body: { card: CARD.id, kind: 'tap', token: tokenOf('1999') } });
    assert.equal(caught.body.fixEnabled, false);
    assert.equal((await s.call('/api/hold', { method: 'POST', body: { card: CARD.id, action: 'fix' } })).status, 403);
    assert.equal((await s.call('/api/hold', { method: 'POST', body: { card: CARD.id, action: 'ask' } })).status, 200, 'asking the editors stays on');
});

test('requests without a valid session, unknown cards and bad input are refused', async t => {
    const s = await start();
    t.after(s.close);
    assert.equal((await s.call('/api/next', { session: null })).status, 400);
    assert.equal((await s.call('/api/next', { session: 'bad session!' })).status, 400);
    assert.equal((await s.call('/api/next?topic=nope')).status, 400);
    assert.equal((await s.call('/api/answer', { method: 'POST', body: { card: '000000000000', kind: 'tap', token: 1 } })).status, 404);
    assert.equal((await s.call('/api/answer', { method: 'POST', body: { card: CARD.id, kind: 'guess' } })).status, 400);
    assert.equal((await s.call('/api/shared', { method: 'POST', body: { card: 'x', kind: 'fix' } })).status, 400);
    assert.equal((await s.call('/../server.js')).status, 404);
    assert.equal((await s.call('/f/000000000000')).status, 200, 'an unknown fix link falls back to the home page');
});

test('a puzzle link is a page with its own title and preview; the answer is not in it', async t => {
    const s = await start();
    t.after(s.close);
    const page = await s.call(`/c/${CARD.id}`);
    assert.match(page.body, /<title>This Wikipedia sentence disagrees with its own source\. Can you spot where\?<\/title>/);
    assert.match(page.body, /og:image" content="https:\/\/fact-hunt\.example\/og\/c\/27c9765dd902\.png"/);
    assert.doesNotMatch(page.body, /1998/);
    const png = await s.call(`/og/c/${CARD.id}.png`);
    assert.ok(png.status === 200 || png.status === 404, 'a PNG when resvg is installed, else a 404');
    if (png.status === 200) assert.equal(png.type, 'image/png');
});

test('following a link to the article or the source is recorded, with whether the card was answered yet', async t => {
    const s = await start();
    t.after(s.close);
    const events = [];
    const record = s.store.record;
    s.store.record = e => { if (e.t === 'opened') events.push(e); return record(e); };
    const opened = body => s.call('/api/opened', { method: 'POST', body });
    assert.equal((await opened({ card: CARD.id, target: 'article' })).status, 200);
    await s.call('/api/answer', { method: 'POST', body: { card: CARD.id, kind: 'tap', token: tokenOf('1999') } });
    assert.equal((await opened({ card: CARD.id, target: 'source' })).status, 200);
    assert.deepEqual(events.map(e => [e.target, e.answered, e.session]), [['article', false, 'session-one'], ['source', true, 'session-one']]);
    assert.deepEqual(s.store.card(CARD.id).opened, { article: 1, source: 1 });
    assert.equal(s.store.state.counts.openedArticle, 1);
    assert.equal(s.store.state.counts.openedSource, 1);
    assert.equal((await opened({ card: CARD.id, target: 'talk' })).status, 400);
    assert.equal((await opened({ card: 'x', target: 'article' })).status, 400);
    assert.equal((await opened({ card: '000000000000', target: 'article' })).status, 404);
    assert.equal(events.length, 2, 'refused requests record nothing');
});
