import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tokenize, tapMatches } from '../inaccuracies/lib/tokens.js';
import { createStore, fixGate, applyEvent, createState, DISMISS_AFTER } from '../inaccuracies/lib/store.js';
import { TOPICS, publicCard, reveal, judgeTap, nextCard, topicCounts } from '../inaccuracies/lib/cards.js';
import { fixSummary, editUrl, talkUrl, talkNote, sourceLink, checkSentence, revertedRevisions, SUMMARY_LIMIT } from '../inaccuracies/lib/wiki.js';
import { fixShareText, metaTags, pageMeta, shareTargets } from '../inaccuracies/lib/share.js';
import { wrapRuns, contextRuns, fixSvg, puzzleSvg } from '../inaccuracies/lib/og.js';
import { TOPIC_GROUPS } from '../service/cards/wiki.js';

const claim = 'Combat Zone Wrestling (CZW) is an American independent professional wrestling promotion founded in 1999 by John Zandig.';
const quote = 'CZW was born in a simpler time, way back in 1998, by John Zandig in Philadelphia';
const CARD = {
    id: '27c9765dd902', wiki: 'enwiki', host: 'en.wikipedia.org', pageTitle: 'Combat Zone Wrestling',
    section: { index: 0, title: null },
    claim: { text: claim, span: { start: claim.indexOf('1999'), end: claim.indexOf('1999') + 4 } },
    quote: { text: quote, span: { start: quote.indexOf('1998'), end: quote.indexOf('1998') + 4 } },
    findText: 'founded in 1999', sourceUrl: 'https://lastwordonsports.com/prowrestling/2022/06/28/combat-zone-wrestling/',
    sourceLabel: 'lastwordonsports.com', topics: ['film-tv'], monthlyViews: 5000,
};
const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// ---- tokens ----

test('words are tap targets; numbers, dates and abbreviations stay whole', () => {
    const words = s => tokenize(s).map(t => s.slice(t.start, t.end));
    assert.deepEqual(words('Founded in 1999 by John Zandig.'), ['Founded', 'in', '1999', 'by', 'John', 'Zandig']);
    assert.deepEqual(words('186,842 residents; record 6–5; the U.S. team; 500M+ downloads; don’t'), ['186,842', 'residents', 'record', '6–5', 'the', 'U.S.', 'team', '500M', 'downloads', 'don’t']);
    assert.deepEqual(words('(CZW) “quoted”'), ['CZW', 'quoted']);
});

test('a tap counts on the flagged words or one word either side, not further', () => {
    const tokens = tokenize(claim);
    const index = word => tokens.findIndex(t => claim.slice(t.start, t.end) === word);
    assert.equal(tapMatches(tokens, index('1999'), CARD.claim.span), true);
    assert.equal(tapMatches(tokens, index('in'), CARD.claim.span), true);
    assert.equal(tapMatches(tokens, index('by'), CARD.claim.span), true);
    assert.equal(tapMatches(tokens, index('founded'), CARD.claim.span), false);
    assert.equal(tapMatches(tokens, index('Zandig'), CARD.claim.span), false);
    assert.equal(tapMatches(tokens, -1, CARD.claim.span), false);
    assert.equal(tapMatches(tokens, 999, CARD.claim.span), false);
    assert.equal(judgeTap(CARD, index('1999')), true);
});

test('a multi-word span matches anywhere inside it', () => {
    const c = 'In April 1984, the LTTE formally joined a common militant front.';
    const span = { start: 3, end: 13 };
    const tokens = tokenize(c);
    const at = w => tokens.findIndex(t => c.slice(t.start, t.end) === w);
    assert.equal(tapMatches(tokens, at('April'), span), true);
    assert.equal(tapMatches(tokens, at('1984'), span), true);
    assert.equal(tapMatches(tokens, at('LTTE'), span), false);
});

// ---- store and the stop rule ----

test('answers, holds, fixes and reverts update the card state', () => {
    let clock = Date.parse('2026-11-23T10:00:00Z');
    const store = createStore({ now: () => new Date(clock) });
    store.record({ t: 'answer', card: 'a', session: 's1', kind: 'caught' });
    assert.equal(store.card('a').caught, 1);
    assert.ok(store.answered('s1').has('a'));

    store.record({ t: 'hold', card: 'a', session: 's1', action: 'fix' });
    assert.equal(store.heldByOther('a', 's2'), true);
    assert.equal(store.heldByOther('a', 's1'), false);
    clock += 21 * 60 * 1000;
    assert.equal(store.heldByOther('a', 's2'), false, 'a hold lasts 20 minutes');

    store.record({ t: 'fixed', card: 'a', session: 's1', revisionId: 5, snapshot: { id: 'a' } });
    assert.equal(store.card('a').status, 'fixed');
    store.record({ t: 'fixed', card: 'a', session: 's2', revisionId: 6 });
    assert.equal(store.state.counts.fixed, 1, 'a card is fixed once');
    store.record({ t: 'reverted', card: 'a', revisionId: 5 });
    assert.equal(store.card('a').status, 'disputed');
    assert.equal(store.state.fixes[0].reverted, true);
});

test('two sessions saying "they match" retire a card; one doesn\'t', () => {
    const state = createState();
    applyEvent(state, { t: 'answer', card: 'b', session: 's1', kind: 'same' });
    applyEvent(state, { t: 'answer', card: 'b', session: 's1', kind: 'same' });
    assert.equal(state.cards.get('b').status, 'open', 'the same person twice is one answer');
    applyEvent(state, { t: 'answer', card: 'b', session: 's2', kind: 'confirm_no' });
    assert.equal(DISMISS_AFTER, 2);
    assert.equal(state.cards.get('b').status, 'dismissed');
});

test('the stop rule: more than 10 reverted in a block of 50 switches Fix off, and only the owner turns it back on', () => {
    const fixes = n => Array.from({ length: n }, (_, i) => ({ card: `c${i}`, reverted: false }));
    const ten = fixes(50).map((f, i) => ({ ...f, reverted: i < 10 }));
    assert.equal(fixGate(ten).enabled, true, 'exactly 1 in 5 is allowed');
    const eleven = fixes(30).map((f, i) => ({ ...f, reverted: i < 11 }));
    const gate = fixGate(eleven);
    assert.equal(gate.enabled, false, 'an incomplete block that is already over the limit stops it');
    assert.match(gate.reason, /11 of fixes 1–30/);
    const later = [...fixes(50), ...fixes(20).map((f, i) => ({ ...f, reverted: i < 11 }))];
    assert.equal(fixGate(later).enabled, false, 'every block is judged on its own');
    assert.equal(fixGate(eleven, { override: 'on' }).enabled, true);
    assert.equal(fixGate([], { override: 'off' }).enabled, false);
});

test('the event log replays from a file, skipping a torn last line', async () => {
    const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'inacc-'));
    const file = join(dir, 'events.jsonl');
    const first = createStore({ file });
    first.record({ t: 'answer', card: 'a', session: 's1', kind: 'caught' });
    first.record({ t: 'fixed', card: 'a', session: 's1', revisionId: 9 });
    writeFileSync(file, readFileSync(file, 'utf8') + '{"t":"answer","ca');
    const second = createStore({ file });
    assert.equal(second.card('a').status, 'fixed');
    assert.equal(second.state.counts.caught, 1);
    const line = JSON.parse(readFileSync(file, 'utf8').split('\n')[0]);
    assert.deepEqual(Object.keys(line).sort(), ['at', 'card', 'kind', 'session', 't'], 'nothing but the event is stored');
});

// ---- cards ----

test('the app topics match the builder topics', () => {
    assert.deepEqual(TOPICS.map(t => [t.id, t.label]), TOPIC_GROUPS.map(g => [g.id, g.label]));
});

test('the card sent before an answer carries no span, and its source link does not point at the answer', () => {
    const pub = publicCard(CARD);
    const text = JSON.stringify(pub);
    assert.doesNotMatch(text, /"span"/);
    assert.doesNotMatch(text, /claimSpan|quoteSpan|findText/);
    assert.ok(pub.claim.tokens.length > 5);
    // The whole quote, from its first four words to its last four.
    assert.equal(pub.sourceLink, `${CARD.sourceUrl}#:~:text=CZW%20was%20born%20in,John%20Zandig%20in%20Philadelphia`);
});

test('reveal gives the spans and both ways to act', () => {
    const r = reveal(CARD, { projectPage: 'User:Example/Inaccuracies' });
    assert.equal(r.from, '1999');
    assert.equal(r.to, '1998');
    assert.equal(r.fix.findText, 'founded in 1999');
    assert.match(r.fix.editUrl, /^https:\/\/en\.wikipedia\.org\/w\/index\.php\?title=Combat\+Zone\+Wrestling&action=edit&section=0&summary=/);
    assert.match(r.ask.talkUrl, /title=Talk%3ACombat\+Zone\+Wrestling&action=edit&section=new&preloadtitle=/);
});

test('nextCard picks among the most-read available cards in the topic', () => {
    const cards = [
        { id: 'a', topics: ['sports'], monthlyViews: 10 },
        { id: 'b', topics: ['sports'], monthlyViews: 1000 },
        { id: 'c', topics: ['music'], monthlyViews: 5000 },
        { id: 'd', topics: ['sports'], monthlyViews: null },
    ];
    const all = () => true;
    assert.equal(nextCard(cards, { topic: 'sports', isAvailable: all, random: () => 0 }).id, 'b');
    assert.equal(nextCard(cards, { topic: 'sports', isAvailable: c => c.id !== 'b', random: () => 0 }).id, 'a');
    assert.equal(nextCard(cards, { topic: 'any', isAvailable: all, random: () => 0, pool: 1 }).id, 'c');
    assert.equal(nextCard(cards, { topic: 'food', isAvailable: all }), null);
    assert.deepEqual(topicCounts(cards, c => c.id !== 'a').sports, 2);
});

// ---- links into Wikipedia ----

test('the edit summary quotes the source in context, carries the hashtag, and fits in 500 characters', () => {
    const summary = fixSummary(CARD, { projectPage: 'User:Example/Inaccuracies' });
    assert.equal(summary, 'Corrected to match the cited source (lastwordonsports.com): "…time, way back in 1998, by John Zandig…" #inaccuracies ([[User:Example/Inaccuracies|what is this?]])');
    const long = { ...CARD, quote: { text: `${'word '.repeat(150)}1998 ${'more '.repeat(150)}`, span: { start: 750, end: 754 } } };
    assert.ok(fixSummary(long).length <= SUMMARY_LIMIT);
    assert.match(fixSummary(long), /1998/);
});

test('the talk note carries both texts and a signature', () => {
    const note = talkNote(CARD);
    assert.match(note, /The article says: "Combat Zone Wrestling/);
    assert.match(note, /says: "CZW was born/);
    assert.match(note, /~~~~$/);
    assert.match(decodeURIComponent(talkUrl(CARD).replace(/\+/g, ' ')), /preloadtitle=Possible inaccuracy: "1999"/);
});

test('a card with no known section opens the whole page', () => {
    assert.doesNotMatch(editUrl({ ...CARD, section: { index: null } }), /section=/);
});

test('checkSentence: the search text gone means the sentence changed', async () => {
    const page = content => json({ query: { pages: [{ pageid: 1, revisions: [{ revid: 77, timestamp: '2026-11-23T10:00:00Z', slots: { main: { content } } }] }] } });
    assert.deepEqual(await checkSentence(CARD, { fetchImpl: async () => page('promotion founded in 1999 by [[John Zandig]]') }),
        { changed: false, revisionId: 77, timestamp: '2026-11-23T10:00:00Z' });
    assert.equal((await checkSentence(CARD, { fetchImpl: async () => page('promotion founded in 1998 by [[John Zandig]]') })).changed, true);
    await assert.rejects(checkSentence(CARD, { fetchImpl: async () => json({}, 503) }), /503/);
});

test('revertedRevisions reads the mw-reverted tag', async () => {
    let asked;
    const reverted = await revertedRevisions('en.wikipedia.org', [1, 2], {
        fetchImpl: async url => {
            asked = new URL(url).searchParams;
            return json({ query: { pages: [{ revisions: [{ revid: 1, tags: ['mw-reverted', 'visualeditor'] }, { revid: 2, tags: [] }] }] } });
        },
    });
    assert.equal(asked.get('revids'), '1|2');
    assert.equal(asked.get('rvprop'), 'ids|tags');
    assert.deepEqual([...reverted], [1]);
});

// ---- share and previews ----

test('share text names the article and both values, and leaves room for a link on Bluesky', () => {
    assert.equal(fixShareText(CARD), "Wikipedia's article on Combat Zone Wrestling said 1999. Its own source said 1998. I fixed it. Find one yourself:");
    const long = { ...CARD, pageTitle: 'A'.repeat(300) };
    assert.ok(fixShareText(long).length <= 220);
    const targets = shareTargets('Hello', 'https://example.org/f/1');
    assert.equal(targets.bluesky, 'https://bsky.app/intent/compose?text=Hello%20https%3A%2F%2Fexample.org%2Ff%2F1');
});

test('meta tags escape card text', () => {
    const tags = metaTags({ ...pageMeta('puzzle', { card: { ...CARD, claim: { ...CARD.claim, text: 'A "quoted" <b>tag</b> & more' } } }), image: 'https://x/og.png' });
    assert.match(tags, /content="A &quot;quoted&quot; &lt;b&gt;tag&lt;\/b&gt; &amp; more"/);
    assert.match(tags, /summary_large_image/);
    assert.doesNotMatch(metaTags({ title: 't', description: 'd' }), /og:image/);
});

test('preview text wraps without losing the marked words, and escapes the card text', () => {
    const runs = contextRuns(claim, CARD.claim.span);
    assert.equal(runs.find(r => r.mark === 'flag').text, '1999');
    const lines = wrapRuns(runs, { maxChars: 42, maxLines: 2 });
    const flat = lines.map(l => l.map(r => r.text).join('')).join(' ');
    assert.match(flat, /founded in 1999 by John Zandig\./);
    assert.ok(lines.every(l => l.map(r => r.text).join('').length <= 43));
    const svg = puzzleSvg({ ...CARD, claim: { ...CARD.claim, text: 'Tom & Jerry <script>' } });
    assert.match(svg, /Tom &amp; Jerry &lt;script&gt;/);
    assert.match(fixSvg(CARD), /Wikipedia said/);
    assert.doesNotMatch(puzzleSvg(CARD), /1998/, 'a puzzle preview never shows the answer');
});
