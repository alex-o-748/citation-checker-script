import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { parseCliArgs, HELP_TEXT, runPickPilot } from '../service/run-pick-pilot.js';
import { NS_MAIN, NS_TEMPLATE } from '../service/article-picker.js';

test('parseCliArgs applies documented defaults', () => {
    const opts = parseCliArgs(['node', 'pick-pilot.js']);
    assert.equal(opts.wiki, 'enwiki');
    assert.equal(opts.editWindowDays, 30);
    assert.equal(opts.burstWindowDays, 3);
    assert.equal(opts.historyDays, 180);
    assert.equal(opts.historyBucketDays, 30);
    assert.equal(opts.minActiveBuckets, 3);
    assert.equal(opts.maxIdleDays, 21);
    assert.equal(opts.allowEventTitles, false);
    assert.equal(opts.basePool, 2000);
    assert.equal(opts.shortlistSize, 300);
    assert.equal(opts.max, 100);
    assert.equal(opts.offlineRatioMax, 0.6);
    assert.equal(opts.tableRatioMax, 0.5);
    assert.equal(opts.flaggedShare, 0.4);
    assert.equal(opts.scanAll, false);
    assert.equal(opts.out, 'pilot-100.txt');
    assert.equal(opts.jsonOut, undefined);
});

test('parseCliArgs applies overrides', () => {
    const opts = parseCliArgs([
        'node', 'pick-pilot.js', '--wiki', 'frwiki', '--edit-window-days', '7',
        '--burst-window-days', '2', '--history-days', '365', '--history-bucket-days', '7',
        '--min-active-buckets', '10', '--max-idle-days', '45', '--allow-event-titles',
        '--base-pool', '500', '--shortlist-size', '50',
        '--max', '20', '--offline-ratio-max', '0.4', '--table-ratio-max', '0.3',
        '--flagged-share', '0.25', '--scan-all',
        '--out', 'out.txt', '--json-out', 'out.json',
    ]);
    assert.equal(opts.editWindowDays, 7);
    assert.equal(opts.burstWindowDays, 2);
    assert.equal(opts.historyDays, 365);
    assert.equal(opts.historyBucketDays, 7);
    assert.equal(opts.minActiveBuckets, 10);
    assert.equal(opts.maxIdleDays, 45);
    assert.equal(opts.allowEventTitles, true);
    assert.equal(opts.max, 20);
    assert.equal(opts.offlineRatioMax, 0.4);
    assert.equal(opts.tableRatioMax, 0.3);
    assert.equal(opts.flaggedShare, 0.25);
    assert.equal(opts.scanAll, true);
    assert.equal(opts.jsonOut, 'out.json');
});

test('HELP_TEXT documents every flag and the Toolforge-job memory caveat', () => {
    for (const flag of ['--wiki', '--edit-window-days', '--burst-window-days',
        '--history-days', '--history-bucket-days', '--min-active-buckets',
        '--max-idle-days', '--allow-event-titles', '--base-pool',
        '--shortlist-size', '--max', '--offline-ratio-max', '--table-ratio-max',
        '--flagged-share', '--scan-all',
        '--out', '--json-out']) {
        assert.ok(HELP_TEXT.includes(flag), `HELP_TEXT missing ${flag}`);
    }
    assert.match(HELP_TEXT, /toolforge jobs run/);
});

// --- runPickPilot integration, with fakes for every external boundary ---

const link = url => `<a rel="nofollow" class="external text" href="${url}">source</a>`;

function article(prose, footnotes) {
    const body = prose.replace(/@@(\S+?)@@/g, (_, id) =>
        `<sup id="cite_ref-${id}" class="reference"><a href="./Test#cite_note-${id}">[${id}]</a></sup>`
    );
    const list = Object.entries(footnotes)
        .map(([id, html]) => `<li id="cite_note-${id}">${html}</li>`)
        .join('');
    return `<!DOCTYPE html><body>${body}<ol class="references">${list}</ol></body>`;
}

// Two solo citations, both carrying a fetchable URL. Claim text is the
// (paragraph-scope, default) span before each marker, which must clear
// core/citations.js's 10-char MIN_CLAIM_LENGTH or the citation is dropped
// entirely — hence full sentences rather than "C1.".
const onlineHeavyHtml = article(
    '<p>The festival opened on schedule this year.@@1@@ Attendance doubled from last year.@@2@@</p>',
    { 1: link('https://a.example/1'), 2: link('https://b.example/2') }
);

// Five solo citations, only one with a URL — offlineRatio = 0.8, a bare
// {{cite book}}-style footnote for the rest (no <a href="http...">).
const offlineHeavyHtml = article(
    '<p>The museum was founded in 1920 by local donors.@@1@@ '
        + 'It expanded twice during the following decades.@@2@@ '
        + 'A new wing opened after extensive renovations.@@3@@ '
        + 'The collection grew substantially over time.@@4@@ '
        + 'Recent acquisitions added several notable pieces.@@5@@</p>',
    {
        1: link('https://a.example/1'),
        2: '<span>Some Book Title, p. 5. Publisher, 2020.</span>',
        3: '<span>Another Book, p. 12.</span>',
        4: '<span>A Journal Article, vol. 3.</span>',
        5: '<span>Yet Another Print Source.</span>',
    }
);

// A results page: every citation sits in a table, and every one of them has a
// perfectly fetchable URL. This is the shape that dominated the first real run
// — six 2026 US Open draw pages plus a dozen other results tables. Selecting
// for durability removes the one-off draws at the source, but a *recurring*
// records table is durable and still worthless to verify, so the table filter
// is what has to catch it.
const tableHtml = `<!DOCTYPE html><body><table class="wikitable"><tbody>
<tr><td>Alcaraz def. Sinner 6-4, 7-5, 6-2 in the final match.<sup id="cite_ref-b1" class="reference"><a href="./Test#cite_note-b1">[1]</a></sup></td></tr>
<tr><td>Swiatek def. Gauff 7-6, 6-3 in the semifinal round.<sup id="cite_ref-b2" class="reference"><a href="./Test#cite_note-b2">[2]</a></sup></td></tr>
</tbody></table><ol class="references">
<li id="cite_note-b1">${link('https://draws.example/1')}</li>
<li id="cite_note-b2">${link('https://draws.example/2')}</li>
</ol></body>`;

const NOW = new Date('2026-09-09T00:00:00Z');
const daysAgo = n => new Date(NOW.getTime() - n * 86400000);
const mwTs = date => date.toISOString().replace(/[-:T]/g, '').slice(0, 14);

// pageId 1: brand new and bursty, edited in one month only — a breaking story.
//           Far more edits than the articles that should beat it.
// pageId 2: ancient, evenly edited across every month — the page the mix
//           should now rank first.
// pageId 3: ancient, {{failed verification}}, evenly edited, modest volume.
// pageId 4: ancient, persistent, huge edit count, but mostly offline sourcing.
// pageId 5: a finished tournament — an event title AND a one-month history.
// pageId 6: persistent and web-sourced, but every citation is in a table.
const topEditedRows = [
    { pageId: 5, pageTitle: '2026_Open_Mens_singles', revisionId: 55, editCount: 300, recentEditCount: 295 },
    { pageId: 4, pageTitle: 'Print_Heavy', revisionId: 44, editCount: 900, recentEditCount: 200 },
    { pageId: 2, pageTitle: 'Perennial_Page', revisionId: 22, editCount: 400, recentEditCount: 86 },
    { pageId: 6, pageTitle: 'League_Records_Table', revisionId: 66, editCount: 200, recentEditCount: 20 },
    { pageId: 1, pageTitle: 'Breaking_Story', revisionId: 11, editCount: 600, recentEditCount: 580 },
    { pageId: 3, pageTitle: 'Disputed_Claim', revisionId: 33, editCount: 40, recentEditCount: 9 },
];

const creationRows = [
    { pageId: 1, createdAt: Buffer.from(mwTs(daysAgo(4))) },
    { pageId: 2, createdAt: Buffer.from(mwTs(daysAgo(4000))) },
    { pageId: 3, createdAt: Buffer.from(mwTs(daysAgo(4000))) },
    { pageId: 4, createdAt: Buffer.from(mwTs(daysAgo(4000))) },
    { pageId: 5, createdAt: Buffer.from(mwTs(daysAgo(2))) },
    { pageId: 6, createdAt: Buffer.from(mwTs(daysAgo(3000))) },
];

// Six 30-day buckets, newest first. The distinction the whole rewrite turns
// on lives here: pages 1 and 5 have all their edits in bucket 0.
const profileRow = (pageId, bucketCounts, distinctEditors, idleDays) => ({
    pageId,
    historyEditCount: bucketCounts.reduce((a, b) => a + b, 0),
    distinctEditors,
    lastEditAt: Buffer.from(mwTs(daysAgo(idleDays))),
    ...Object.fromEntries(bucketCounts.map((n, i) => [`bucket${i}`, n])),
});

const activityProfileRows = [
    profileRow(1, [600, 0, 0, 0, 0, 0], 45, 1),
    profileRow(2, [86, 140, 150, 160, 180, 184], 25, 1),
    profileRow(3, [9, 30, 35, 36, 35, 35], 8, 2),
    profileRow(4, [200, 260, 240, 300, 250, 250], 40, 1),
    profileRow(5, [295, 5, 0, 0, 0, 0], 30, 1),
    profileRow(6, [20, 40, 45, 50, 40, 45], 15, 1),
];

function fakeConnection({ onQuery } = {}) {
    return {
        execute: async (sql, params) => {
            onQuery?.(sql, params);
            if (/AS historyEditCount/.test(sql)) return [activityProfileRows];
            if (/GROUP BY p\.page_id/.test(sql)) return [topEditedRows];
            if (/MIN\(rev_timestamp\)/.test(sql)) return [creationRows];
            // Tag membership: [NS_TEMPLATE, ...templates, NS_MAIN, ...pageIds]
            assert.equal(params[0], NS_TEMPLATE);
            const templates = params.slice(1, params.indexOf(NS_MAIN, 1));
            if (templates.includes('Failed_verification')) return [[{ pageId: 3 }]];
            return [[]]; // no {{current}} tags at all — the real enwiki case
        },
        end: async () => {},
    };
}

function htmlForTitle(title) {
    if (title === 'Print Heavy') return offlineHeavyHtml;
    if (title === '2026 Open Mens singles' || title === 'League Records Table') return tableHtml;
    return onlineHeavyHtml;
}

const baseIo = (overrides = {}) => ({
    stdout: { write() {} },
    stderr: { write() {} },
    connectReplicas: async () => fakeConnection(),
    fetchArticle: async ({ title }) => ({ html: htmlForTitle(title), status: 200, error: null }),
    parseHtml: html => JSDOM.fragment(html),
    writeFile: async () => {},
    now: () => NOW,
    ...overrides,
});

const baseOpts = (overrides = {}) => ({
    wiki: 'enwiki', editWindowDays: 30, burstWindowDays: 3,
    historyDays: 180, historyBucketDays: 30, minActiveBuckets: 3, maxIdleDays: 21,
    allowEventTitles: false, basePool: 1000,
    shortlistSize: 10, max: 10, offlineRatioMax: 0.6, tableRatioMax: 0.5,
    flaggedShare: 0.4, scanAll: false,
    out: 'pilot.txt', jsonOut: undefined,
    ...overrides,
});

// The headline behaviour change of 2026-09-16, as an end-to-end assertion:
// the breaking story has 15x the edits of the article that now wins, and it
// does not appear at all.
test('a steadily edited page outranks a far busier breaking story, which is dropped outright', async () => {
    let written;
    const code = await runPickPilot(baseOpts(), baseIo({
        writeFile: async (path, content) => { written = content; },
    }));

    assert.equal(code, 0);
    const titles = written.split('\n').filter(l => l && !l.startsWith('#'));
    assert.ok(!titles.includes('Breaking Story'),
        '600 edits in one month is a finished story, not a page with a future');
    assert.ok(!titles.includes('Print Heavy'), 'offline-heavy article dropped entirely');
    assert.deepEqual(titles, ['Perennial Page', 'Disputed Claim']);
});

// An event title is rejected before a fetch is ever spent on it — persistence
// alone would not catch a *forthcoming* event, which is edited steadily right
// up until it happens.
test('an event-titled article is dropped at stage 1, without being fetched', async () => {
    const fetched = [];
    const code = await runPickPilot(baseOpts({ scanAll: true }), baseIo({
        fetchArticle: async ({ title }) => {
            fetched.push(title);
            return { html: htmlForTitle(title), status: 200, error: null };
        },
    }));

    assert.equal(code, 0);
    assert.ok(!fetched.includes('2026 Open Mens singles'));
    assert.ok(!fetched.includes('Breaking Story'));
});

test('--allow-event-titles lets the event page be considered again', async () => {
    const fetched = [];
    await runPickPilot(baseOpts({ scanAll: true, allowEventTitles: true }), baseIo({
        fetchArticle: async ({ title }) => {
            fetched.push(title);
            return { html: htmlForTitle(title), status: 200, error: null };
        },
    }));
    // Still not selected — its one-month history fails --min-active-buckets —
    // but the title is no longer what stops it.
    assert.ok(!fetched.includes('2026 Open Mens singles'),
        'the event page has a one-month history too, so persistence still rejects it');

    const bothOff = [];
    await runPickPilot(baseOpts({ scanAll: true, allowEventTitles: true, minActiveBuckets: 0 }), baseIo({
        fetchArticle: async ({ title }) => {
            bothOff.push(title);
            return { html: htmlForTitle(title), status: 200, error: null };
        },
    }));
    assert.ok(bothOff.includes('2026 Open Mens singles'), 'with both filters off it is back');
});

// Durability does not make an article worth verifying: a recurring records
// table is edited every month and its claims are still score lines.
test('a persistent results page is dropped by the table filter, not by the activity one', async () => {
    let written;
    const code = await runPickPilot(baseOpts({ scanAll: true }), baseIo({
        writeFile: async (path, content) => { written = content; },
    }));

    assert.equal(code, 0);
    const titles = written.split('\n').filter(l => l && !l.startsWith('#'));
    assert.ok(!titles.includes('League Records Table'));
});

test('raising --table-ratio-max lets the results page back in', async () => {
    let written;
    await runPickPilot(baseOpts({ scanAll: true, tableRatioMax: 1 }), baseIo({
        writeFile: async (path, content) => { written = content; },
    }));
    const titles = written.split('\n').filter(l => l && !l.startsWith('#'));
    assert.ok(titles.includes('League Records Table'));
});

test('the mix is reported by tier, and a durable page is labelled from its spread', async () => {
    const files = {};
    const code = await runPickPilot(baseOpts({ jsonOut: 'pilot.json' }), baseIo({
        writeFile: async (path, content) => { files[path] = content; },
    }));

    assert.equal(code, 0);
    const parsed = JSON.parse(files['pilot.json']);
    const byTitle = Object.fromEntries(parsed.map(c => [c.title, c]));
    assert.equal(byTitle['Perennial Page'].tier, 'durable');
    assert.equal(byTitle['Disputed Claim'].tier, 'durable+flagged');
    assert.equal(byTitle['Perennial Page'].activeBuckets, 6);
    assert.equal(byTitle['Perennial Page'].distinctEditors, 25);
    assert.equal(byTitle['Perennial Page'].sustainedEditCount, 314,
        'the volume term scores the floor, not the spike');
    assert.equal(byTitle['Disputed Claim'].eventShaped, false);
});

test('the run stops fetching once --max articles have survived the content filter', async () => {
    const fetched = [];
    const code = await runPickPilot(baseOpts({ max: 1 }), baseIo({
        fetchArticle: async ({ title }) => {
            fetched.push(title);
            return { html: htmlForTitle(title), status: 200, error: null };
        },
    }));

    assert.equal(code, 0);
    assert.deepEqual(fetched, ['Print Heavy', 'Perennial Page'],
        'a rejected article does not count toward the stop, so the run keeps going '
        + 'until it has a real survivor — then stops');
});

test('--scan-all fetches the whole eligible shortlist instead of stopping early', async () => {
    const fetched = [];
    await runPickPilot(baseOpts({ max: 1, scanAll: true }), baseIo({
        fetchArticle: async ({ title }) => {
            fetched.push(title);
            return { html: htmlForTitle(title), status: 200, error: null };
        },
    }));

    assert.equal(fetched.length, 4, 'six in the base pool, two rejected before any fetch');
});

test('the activity filter rejecting everything fails cleanly rather than writing an empty pilot', async () => {
    let wrote = false;
    // Every fixture's last edit is at least a day old, so this rejects all six.
    const code = await runPickPilot(baseOpts({ maxIdleDays: 0.5 }), baseIo({
        writeFile: async () => { wrote = true; },
    }));
    assert.equal(code, 1);
    assert.equal(wrote, false);
});

test('tag membership is asked about the base pool rather than pulled with a row cap', async () => {
    const membershipCalls = [];
    await runPickPilot(baseOpts(), baseIo({
        connectReplicas: async () => fakeConnection({
            onQuery: (sql, params) => {
                if (/tl_from IN/.test(sql)) membershipCalls.push(params);
            },
        }),
    }));

    assert.ok(membershipCalls.length >= 2, 'one membership query per tag set');
    for (const params of membershipCalls) {
        assert.ok(params.includes(1) && params.includes(4), 'every base-pool id is asked about');
    }
});

test('a fetch failure drops the article instead of aborting the run', async () => {
    let written;
    const code = await runPickPilot(baseOpts(), baseIo({
        fetchArticle: async ({ title }) => (title === 'Perennial Page'
            ? { html: null, status: 404, error: 'gone' }
            : { html: htmlForTitle(title), status: 200, error: null }),
        writeFile: async (path, content) => { written = content; },
    }));

    assert.equal(code, 0);
    const titles = written.split('\n').filter(l => l && !l.startsWith('#'));
    assert.ok(!titles.includes('Perennial Page'));
    assert.ok(titles.includes('Disputed Claim'));
});

test('runPickPilot rejects a burst window longer than the edit window before any I/O', async () => {
    let touched = false;
    const code = await runPickPilot(
        baseOpts({ burstWindowDays: 30, editWindowDays: 14 }),
        baseIo({ connectReplicas: async () => { touched = true; return fakeConnection(); } })
    );
    assert.equal(code, 2);
    assert.equal(touched, false);
});

test('runPickPilot rejects an out-of-range --offline-ratio-max before touching the network', async () => {
    const code = await runPickPilot(baseOpts({ offlineRatioMax: 1.5 }), baseIo());
    assert.equal(code, 2);
});

test('runPickPilot surfaces a Wiki Replicas connection failure as exit code 1', async () => {
    const code = await runPickPilot(baseOpts(), baseIo({
        connectReplicas: async () => { throw new Error('ECONNREFUSED'); },
    }));
    assert.equal(code, 1);
});

test('runPickPilot restores console.log after suppressing extraction noise', async () => {
    const original = console.log;
    await runPickPilot(baseOpts(), baseIo());
    assert.equal(console.log, original);
});

test('--wiki reaches the REST host when fetchArticle is not injected (the hostForWiki bug)', async () => {
    let seenUrl;
    const originalFetch = global.fetch;
    global.fetch = async url => {
        seenUrl = url;
        return { ok: false, status: 404 };
    };
    try {
        const code = await runPickPilot(baseOpts({ wiki: 'ruwiki' }), baseIo({ fetchArticle: undefined }));
        assert.equal(code, 0);
    } finally {
        global.fetch = originalFetch;
    }
    assert.match(seenUrl, /^https:\/\/ru\.wikipedia\.org\//);
});

// --- --exclude-titles-file: a second batch must cover new ground ---

test('--exclude-titles-file drops matching base-pool articles before scoring', async () => {
    let written;
    const code = await runPickPilot(baseOpts({ excludeTitlesFile: 'batch1.txt' }), baseIo({
        readExcludeTitlesFile: async path => {
            assert.equal(path, 'batch1.txt');
            return 'Breaking Story\n# a comment\nPerennial Page\n';
        },
        writeFile: async (path, content) => { written = content; },
    }));

    assert.equal(code, 0);
    const titles = written.split('\n').filter(l => l && !l.startsWith('#'));
    assert.ok(!titles.includes('Perennial Page'));
    assert.deepEqual(titles, ['Disputed Claim'], 'the one selectable article left');
});

test('without --exclude-titles-file, the exclude file is never read', async () => {
    let readAttempted = false;
    const code = await runPickPilot(baseOpts(), baseIo({
        readExcludeTitlesFile: async () => { readAttempted = true; return ''; },
    }));
    assert.equal(code, 0);
    assert.equal(readAttempted, false);
});

test('--exclude-titles-file that removes every candidate fails cleanly rather than writing an empty pilot', async () => {
    const code = await runPickPilot(baseOpts({ excludeTitlesFile: 'batch1.txt' }), baseIo({
        readExcludeTitlesFile: async () =>
            'Breaking Story\nPerennial Page\nDisputed Claim\nPrint Heavy\n'
            + '2026 Open Mens singles\nLeague Records Table\n',
    }));
    assert.equal(code, 1);
});

test('a missing --exclude-titles-file surfaces as an error rather than silently including everything', async () => {
    const code = await runPickPilot(baseOpts({ excludeTitlesFile: 'nope.txt' }), baseIo({
        readExcludeTitlesFile: async () => { throw new Error('ENOENT: no such file'); },
    }));
    assert.equal(code, 1);
});
