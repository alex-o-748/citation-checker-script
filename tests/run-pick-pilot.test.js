import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { parseCliArgs, HELP_TEXT, runPickPilot } from '../service/run-pick-pilot.js';
import { NS_MAIN, NS_TEMPLATE } from '../service/article-picker.js';

test('parseCliArgs applies documented defaults', () => {
    const opts = parseCliArgs(['node', 'pick-pilot.js']);
    assert.equal(opts.wiki, 'enwiki');
    assert.equal(opts.editWindowDays, 14);
    assert.equal(opts.burstWindowDays, 3);
    assert.equal(opts.basePool, 1000);
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
        '--burst-window-days', '2', '--base-pool', '500', '--shortlist-size', '50',
        '--max', '20', '--offline-ratio-max', '0.4', '--table-ratio-max', '0.3',
        '--flagged-share', '0.25', '--scan-all',
        '--out', 'out.txt', '--json-out', 'out.json',
    ]);
    assert.equal(opts.editWindowDays, 7);
    assert.equal(opts.burstWindowDays, 2);
    assert.equal(opts.max, 20);
    assert.equal(opts.offlineRatioMax, 0.4);
    assert.equal(opts.tableRatioMax, 0.3);
    assert.equal(opts.flaggedShare, 0.25);
    assert.equal(opts.scanAll, true);
    assert.equal(opts.jsonOut, 'out.json');
});

test('HELP_TEXT documents every flag and the Toolforge-job memory caveat', () => {
    for (const flag of ['--wiki', '--edit-window-days', '--burst-window-days', '--base-pool',
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

// A tournament draw: every citation sits in a results table, and every one of
// them has a perfectly fetchable URL. This is the shape that dominated the
// first real run — six 2026 US Open draw pages plus a dozen other results
// tables — and that the offline filter alone cannot catch.
const bracketHtml = `<!DOCTYPE html><body><table class="wikitable"><tbody>
<tr><td>Alcaraz def. Sinner 6-4, 7-5, 6-2 in the final match.<sup id="cite_ref-b1" class="reference"><a href="./Test#cite_note-b1">[1]</a></sup></td></tr>
<tr><td>Swiatek def. Gauff 7-6, 6-3 in the semifinal round.<sup id="cite_ref-b2" class="reference"><a href="./Test#cite_note-b2">[2]</a></sup></td></tr>
</tbody></table><ol class="references">
<li id="cite_note-b1">${link('https://draws.example/1')}</li>
<li id="cite_note-b2">${link('https://draws.example/2')}</li>
</ol></body>`;

const NOW = new Date('2026-09-09T00:00:00Z');
const daysAgo = n => new Date(NOW.getTime() - n * 86400000);
const mwTs = date => date.toISOString().replace(/[-:T]/g, '').slice(0, 14);

// pageId 1: brand new and bursty — a breaking story, no tag anywhere.
// pageId 2: ancient and evenly edited, but far more edits — the perennial
//           page the mix should NOT read as a current event.
// pageId 3: ancient, {{failed verification}}, evenly edited.
// pageId 4: ancient, huge edit count, but mostly offline sourcing.
const topEditedRows = [
    { pageId: 5, pageTitle: '2026_Open_Mens_singles', revisionId: 55, editCount: 300, recentEditCount: 295 },
    { pageId: 4, pageTitle: 'Print_Heavy', revisionId: 44, editCount: 900, recentEditCount: 200 },
    { pageId: 2, pageTitle: 'Perennial_Page', revisionId: 22, editCount: 400, recentEditCount: 86 },
    { pageId: 1, pageTitle: 'Breaking_Story', revisionId: 11, editCount: 60, recentEditCount: 58 },
    { pageId: 3, pageTitle: 'Disputed_Claim', revisionId: 33, editCount: 40, recentEditCount: 9 },
];

const creationRows = [
    { pageId: 1, createdAt: Buffer.from(mwTs(daysAgo(4))) },
    { pageId: 2, createdAt: Buffer.from(mwTs(daysAgo(4000))) },
    { pageId: 3, createdAt: Buffer.from(mwTs(daysAgo(4000))) },
    { pageId: 4, createdAt: Buffer.from(mwTs(daysAgo(4000))) },
    { pageId: 5, createdAt: Buffer.from(mwTs(daysAgo(2))) },
];

function fakeConnection({ onQuery } = {}) {
    return {
        execute: async (sql, params) => {
            onQuery?.(sql, params);
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
    if (title === '2026 Open Mens singles') return bracketHtml;
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
    wiki: 'enwiki', editWindowDays: 14, burstWindowDays: 3, basePool: 1000,
    shortlistSize: 10, max: 10, offlineRatioMax: 0.6, tableRatioMax: 0.5,
    flaggedShare: 0.4, scanAll: false,
    out: 'pilot.txt', jsonOut: undefined,
    ...overrides,
});

test('an untagged breaking story outranks a much busier perennial page', async () => {
    let written;
    const code = await runPickPilot(baseOpts(), baseIo({
        writeFile: async (path, content) => { written = content; },
    }));

    assert.equal(code, 0);
    const titles = written.split('\n').filter(l => l && !l.startsWith('#'));
    assert.equal(titles[0], 'Breaking Story',
        'recency + burst must beat a 6x higher edit count with no {{current}} tag anywhere');
    assert.ok(!titles.includes('Print Heavy'), 'offline-heavy article dropped entirely');
    assert.deepEqual(titles, ['Breaking Story', 'Perennial Page', 'Disputed Claim']);
});

// The regression the first real run exposed: a draw page is newly created,
// almost entirely bursty and fully web-sourced, so every signal ranks it top
// and the offline filter waves it through.
test('a tournament draw is dropped despite topping every current-events signal', async () => {
    let written;
    const code = await runPickPilot(baseOpts({ scanAll: true }), baseIo({
        writeFile: async (path, content) => { written = content; },
    }));

    assert.equal(code, 0);
    const titles = written.split('\n').filter(l => l && !l.startsWith('#'));
    assert.ok(!titles.includes('2026 Open Mens singles'),
        'table-heavy article excluded — its claims are score lines, not assertions');
    assert.equal(titles[0], 'Breaking Story');
});

test('raising --table-ratio-max lets the draw page back in', async () => {
    let written;
    await runPickPilot(baseOpts({ scanAll: true, tableRatioMax: 1 }), baseIo({
        writeFile: async (path, content) => { written = content; },
    }));
    const titles = written.split('\n').filter(l => l && !l.startsWith('#'));
    assert.ok(titles.includes('2026 Open Mens singles'));
});

test('the mix is reported by tier, and a burstless old page is not called a current event', async () => {
    const files = {};
    const code = await runPickPilot(baseOpts({ jsonOut: 'pilot.json' }), baseIo({
        writeFile: async (path, content) => { files[path] = content; },
    }));

    assert.equal(code, 0);
    const parsed = JSON.parse(files['pilot.json']);
    const byTitle = Object.fromEntries(parsed.map(c => [c.title, c]));
    assert.equal(byTitle['Breaking Story'].tier, 'current');
    assert.equal(byTitle['Perennial Page'].tier, 'baseline');
    assert.equal(byTitle['Disputed Claim'].tier, 'flagged');
    assert.equal(byTitle['Breaking Story'].currentTag, false, 'no tag was involved');
    assert.ok(byTitle['Breaking Story'].ageDays < 5);
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
    assert.deepEqual(fetched, ['2026 Open Mens singles', 'Breaking Story'],
        'a rejected article does not count toward the stop, so the run keeps going '
        + 'until it has a real survivor — then stops');
});

test('--scan-all fetches the whole shortlist instead of stopping early', async () => {
    const fetched = [];
    await runPickPilot(baseOpts({ max: 1, scanAll: true }), baseIo({
        fetchArticle: async ({ title }) => {
            fetched.push(title);
            return { html: htmlForTitle(title), status: 200, error: null };
        },
    }));

    assert.equal(fetched.length, 5);
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
        fetchArticle: async ({ title }) => (title === 'Breaking Story'
            ? { html: null, status: 404, error: 'gone' }
            : { html: htmlForTitle(title), status: 200, error: null }),
        writeFile: async (path, content) => { written = content; },
    }));

    assert.equal(code, 0);
    const titles = written.split('\n').filter(l => l && !l.startsWith('#'));
    assert.ok(!titles.includes('Breaking Story'));
    assert.ok(titles.includes('Perennial Page'));
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
