import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseEvents, parseWhen, tally, formatTally } from '../fact-hunt/lib/tally.js';
import { parseArgs } from '../fact-hunt/tally.js';

const A = 'aaaaaaaa1';
const B = 'bbbbbbbb2';
const C1 = '111111111111';
const C2 = '222222222222';
const at = minute => `2026-12-01T10:${String(minute).padStart(2, '0')}:00.000Z`;

const LOG = [
    { at: at(0), t: 'opened', card: C1, session: A, target: 'article', answered: false },
    { at: at(1), t: 'answer', card: C1, session: A, kind: 'caught' },
    { at: at(2), t: 'opened', card: C1, session: A, target: 'article', answered: true },
    { at: at(3), t: 'hold', card: C1, session: A, action: 'fix' },
    { at: at(4), t: 'fixed', card: C1, session: A, revisionId: 9 },
    { at: at(5), t: 'shared', card: C1, session: A, kind: 'fix', platform: 'bluesky' },
    { at: at(6), t: 'answer', card: C2, session: B, kind: 'miss' },
    { at: at(7), t: 'answer', card: C2, session: B, kind: 'confirm_no' },
    { at: at(8), t: 'opened', card: C2, session: B, target: 'source', answered: true },
    { at: at(9), t: 'answer', card: C1, session: B, kind: 'skip' },
    { at: at(10), t: 'reverted', card: C1, revisionId: 9 },
].map(e => JSON.stringify(e)).join('\n') + '\n{"torn';

test('parseEvents skips blank and torn lines', () => {
    assert.equal(parseEvents(LOG).length, 11);
    assert.deepEqual(parseEvents('\n\n'), []);
});

test('the funnel counts each session once, however often it acted', () => {
    const t = tally(parseEvents(LOG));
    assert.equal(t.sessions, 2);
    assert.deepEqual(t.funnel, { answered: 2, caught: 1, startedFix: 1, fixed: 1, startedAsk: 0, asked: 0, shared: 1, openedArticle: 1, openedSource: 1 });
    assert.deepEqual(t.answers, { caught: 1, miss: 1, confirm_no: 1, skip: 1 });
    assert.deepEqual(t.cardsPerSession, { median: 1.5, max: 2 }, 'skips are not cards answered');
    assert.equal(t.fixed, 1);
    assert.equal(t.reverted, 1);
    assert.deepEqual(t.shares, { byKind: { fix: 1 }, byPlatform: { bluesky: 1 } });
});

test('links followed are split by before and after answering, and cards ranked by them', () => {
    const t = tally(parseEvents(LOG));
    assert.deepEqual(t.opened, { article: { before: 1, after: 1 }, source: { before: 0, after: 1 } });
    assert.deepEqual(t.topOpenedCards.map(c => [c.card, c.openedArticle, c.openedSource]), [[C1, 2, 0], [C2, 0, 1]]);
});

test('a window keeps only events inside it', () => {
    const t = tally(parseEvents(LOG), { since: Date.parse(at(6)), until: Date.parse(at(9)) });
    assert.equal(t.events, 3);
    assert.equal(t.sessions, 1);
    assert.equal(t.fixed, 0);
});

test('parseWhen reads spans back from now and ISO dates, and refuses anything else', () => {
    const now = Date.parse('2026-12-08T00:00:00Z');
    assert.equal(parseWhen('7d', now), Date.parse('2026-12-01T00:00:00Z'));
    assert.equal(parseWhen('2h', now), now - 7200000);
    assert.equal(parseWhen('2026-12-01', now), Date.parse('2026-12-01'));
    assert.equal(parseWhen(null), null);
    assert.throws(() => parseWhen('last week'));
});

test('the text report names cards by title when it has them', () => {
    const text = formatTally(tally(parseEvents(LOG)), { titles: new Map([[C1, 'Combat Zone Wrestling']]) });
    assert.match(text, /answered a card\s+2/);
    assert.match(text, /caught one\s+1\s+50%/);
    assert.match(text, /Combat Zone Wrestling\s+article 2, source 0/);
    assert.match(text, /222222222222/);
    assert.match(formatTally(tally([])), /no events/);
});

test('parseArgs takes a path and options, and refuses unknown ones', () => {
    assert.deepEqual(parseArgs(['log.jsonl', '--since', '7d', '--top', '5', '--json']),
        { file: 'log.jsonl', since: '7d', until: null, cards: null, top: 5, json: true });
    assert.throws(() => parseArgs(['--sinse', '7d']));
    assert.throws(() => parseArgs(['--since']));
});
