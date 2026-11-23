import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    buildPageStateUrl, fetchPageStates, editProtection, pendingChanges,
    topicsFromLabels, fetchTopicLabels, lastFullMonth, buildPageviewsUrl, fetchMonthlyViews,
    quoteInWikiLanguage, sourceLabelFor, USER_AGENT,
} from '../service/cards/wiki.js';

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('the page-state query asks for wikitext, protection, pending changes and the living-people category', () => {
    const url = new URL(buildPageStateUrl(['A', 'B'], { wiki: 'enwiki' }));
    assert.equal(url.host, 'en.wikipedia.org');
    const p = url.searchParams;
    assert.equal(p.get('titles'), 'A|B');
    assert.equal(p.get('prop'), 'info|revisions|categories|flagged');
    assert.equal(p.get('inprop'), 'protection');
    assert.equal(p.get('rvslots'), 'main');
    assert.equal(p.get('clcategories'), 'Category:Living_people');
    assert.equal(p.get('redirects'), '1');
    assert.equal(new URL(buildPageStateUrl(['A'], { wiki: 'ruwiki' })).searchParams.get('clcategories'), null);
});

test('any edit protection level counts; move protection does not', () => {
    assert.equal(editProtection({ protection: [{ type: 'move', level: 'sysop' }] }), null);
    assert.equal(editProtection({ protection: [{ type: 'edit', level: 'autoconfirmed' }] }), 'autoconfirmed');
    assert.equal(editProtection({ protection: [{ type: 'edit', level: 'extendedconfirmed' }] }), 'extendedconfirmed');
    assert.equal(pendingChanges({ flagged: { stable_revid: 1, level: 0 } }), null);
    assert.equal(pendingChanges({ flagged: { stable_revid: 1, protection_level: 'autoconfirmed' } }), 'autoconfirmed');
});

// Shaped like a formatversion=2 response: one plain page, one protected,
// one under pending changes, one BLP, one redirect, one missing.
const RESPONSE = {
    query: {
        normalized: [{ from: 'plain_page', to: 'Plain page' }],
        redirects: [{ from: 'Old name', to: 'New name' }],
        pages: [
            { pageid: 1, title: 'Plain page', protection: [], revisions: [{ revid: 11, slots: { main: { content: 'text one' } } }] },
            { pageid: 2, title: 'Protected', protection: [{ type: 'edit', level: 'autoconfirmed', expiry: 'infinity' }], revisions: [{ revid: 22, slots: { main: { content: 'x' } } }] },
            { pageid: 3, title: 'Pending', protection: [], flagged: { stable_revid: 3, protection_level: 'autoconfirmed' }, revisions: [{ revid: 33, slots: { main: { content: 'x' } } }] },
            { pageid: 4, title: 'A person', protection: [], categories: [{ ns: 14, title: 'Category:Living people' }], revisions: [{ revid: 44, slots: { main: { content: 'x' } } }] },
            { pageid: 5, title: 'New name', protection: [], revisions: [{ revid: 55, slots: { main: { content: 'renamed' } } }] },
            { title: 'Gone', missing: true },
        ],
    },
};

test('fetchPageStates reads each page and keys it by the title asked for', async () => {
    let headers;
    const states = await fetchPageStates(['plain_page', 'Protected', 'Pending', 'A person', 'Old name', 'Gone'], {
        wiki: 'enwiki',
        fetchImpl: async (url, init) => { headers = init.headers; return json(RESPONSE); },
    });
    assert.equal(headers['User-Agent'], USER_AGENT);
    assert.match(USER_AGENT, /github\.com/, 'the Wikimedia UA policy wants contact details');
    assert.deepEqual(states.get('plain_page'), {
        missing: false, pageId: 1, title: 'Plain page', revisionId: 11, wikitext: 'text one',
        protection: null, pendingChanges: null, isBlp: false,
    });
    assert.equal(states.get('Protected').protection, 'autoconfirmed');
    assert.equal(states.get('Pending').pendingChanges, 'autoconfirmed');
    assert.equal(states.get('A person').isBlp, true);
    assert.equal(states.get('Old name').title, 'New name');
    assert.equal(states.get('Old name').wikitext, 'renamed');
    assert.equal(states.get('Gone').missing, true);
});

test('isBlp is unknown, not false, on a wiki without a known living-people category', async () => {
    const states = await fetchPageStates(['Plain page'], { wiki: 'ruwiki', fetchImpl: async () => json(RESPONSE) });
    assert.equal(states.get('Plain page').isBlp, null);
});

test('an HTTP error from the API halts the build rather than passing pages through unchecked', async () => {
    await assert.rejects(fetchPageStates(['A'], { wiki: 'enwiki', fetchImpl: async () => json({}, 429) }), /HTTP 429/);
});

test('topic labels map onto the app topics, and medicine excludes the card', () => {
    // The real labels Lift Wing gave Combat Zone Wrestling on 2026-11-23.
    const czw = topicsFromLabels(['Culture.Media.Television', 'Culture.Media.Entertainment', 'Culture.Media.Media*']);
    assert.deepEqual(czw, { topics: ['film-tv'], excluded: null });
    assert.deepEqual(topicsFromLabels(['Geography.Regions.Europe.Western Europe', 'Culture.Sports']).topics, ['sports', 'places']);
    assert.equal(topicsFromLabels(['STEM.Medicine & Health', 'STEM.Biology']).excluded, 'STEM.Medicine & Health');
    assert.deepEqual(topicsFromLabels(['Culture.Philosophy and religion']).topics, []);
});

test('fetchTopicLabels posts the title and keeps labels at or above the threshold', async () => {
    let body;
    const labels = await fetchTopicLabels('Combat Zone Wrestling', {
        wiki: 'enwiki',
        fetchImpl: async (url, init) => {
            body = JSON.parse(init.body);
            return json({ prediction: { results: [{ topic: 'Culture.Media.Television', score: 0.99 }, { topic: 'Culture.Sports', score: 0.31 }] } });
        },
    });
    assert.deepEqual(body, { page_title: 'Combat_Zone_Wrestling', lang: 'en', threshold: 0.5 });
    assert.deepEqual(labels, ['Culture.Media.Television']);
});

test('pageviews cover the last complete month, people only', async () => {
    assert.deepEqual(lastFullMonth(new Date('2026-11-23T10:00:00Z')), { start: '2026100100', end: '2026103100' });
    assert.deepEqual(lastFullMonth(new Date('2026-01-05T10:00:00Z')), { start: '2025120100', end: '2025123100' });
    const url = buildPageviewsUrl('Rax Roast Beef', { wiki: 'enwiki', now: new Date('2026-03-02T00:00:00Z') });
    assert.equal(url, 'https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/Rax_Roast_Beef/monthly/2026020100/2026022800');
    assert.equal(await fetchMonthlyViews('X', { wiki: 'enwiki', fetchImpl: async () => json({ items: [{ views: 1234 }] }) }), 1234);
    assert.equal(await fetchMonthlyViews('X', { wiki: 'enwiki', fetchImpl: async () => json({}, 404) }), null);
});

test('only English-language quotes make enwiki cards', () => {
    assert.equal(quoteInWikiLanguage('CZW was born in a simpler time, way back in 1998', { wiki: 'enwiki' }), true);
    assert.equal(quoteInWikiLanguage('Sala Penal ordena anular acciones penales contra Nasry Asfura', { wiki: 'enwiki' }), false);
    assert.equal(quoteInWikiLanguage('Один из активистов предъявил ультиматум', { wiki: 'enwiki' }), false);
    assert.equal(quoteInWikiLanguage('1B+ Downloads', { wiki: 'enwiki' }), true);
    assert.equal(quoteInWikiLanguage('Один из активистов', { wiki: 'ruwiki' }), true);
});

test('sources are labelled by host, and archive snapshots by the site they archived', () => {
    assert.equal(sourceLabelFor('https://www.lastwordonsports.com/prowrestling/x'), 'lastwordonsports.com');
    assert.equal(sourceLabelFor('https://web.archive.org/web/20110919182250/http://countrystudies.us/sri-lanka/72.htm'), 'countrystudies.us');
    assert.equal(sourceLabelFor('not a url'), null);
});
