import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { parseCliArgs, HELP_TEXT, runPickPilot } from '../service/run-pick-pilot.js';
import { NS_MAIN, NS_TEMPLATE } from '../service/article-picker.js';

test('parseCliArgs applies documented defaults', () => {
    const opts = parseCliArgs(['node', 'pick-pilot.js']);
    assert.equal(opts.wiki, 'enwiki');
    assert.equal(opts.editWindowDays, 14);
    assert.equal(opts.basePool, 1000);
    assert.equal(opts.shortlistSize, 300);
    assert.equal(opts.max, 100);
    assert.equal(opts.offlineRatioMax, 0.6);
    assert.equal(opts.out, 'pilot-100.txt');
    assert.equal(opts.jsonOut, undefined);
});

test('parseCliArgs applies overrides', () => {
    const opts = parseCliArgs([
        'node', 'pick-pilot.js', '--wiki', 'frwiki', '--edit-window-days', '7',
        '--base-pool', '500', '--shortlist-size', '50', '--max', '20',
        '--offline-ratio-max', '0.4', '--out', 'out.txt', '--json-out', 'out.json',
    ]);
    assert.equal(opts.wiki, 'frwiki');
    assert.equal(opts.editWindowDays, 7);
    assert.equal(opts.basePool, 500);
    assert.equal(opts.shortlistSize, 50);
    assert.equal(opts.max, 20);
    assert.equal(opts.offlineRatioMax, 0.4);
    assert.equal(opts.out, 'out.txt');
    assert.equal(opts.jsonOut, 'out.json');
});

test('HELP_TEXT documents every flag', () => {
    for (const flag of ['--wiki', '--edit-window-days', '--base-pool', '--shortlist-size',
        '--max', '--offline-ratio-max', '--out', '--json-out']) {
        assert.ok(HELP_TEXT.includes(flag), `HELP_TEXT missing ${flag}`);
    }
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

const rows = {
    // pageId=1: baseline, high edit count, no tags, fully online.
    popular: { pageId: 1, pageTitle: 'Popular_Now', revisionId: 11, editCount: 500 },
    // pageId=2: {{current}}, moderate edit count, fully online.
    current: { pageId: 2, pageTitle: 'Breaking_Story', revisionId: 22, editCount: 50 },
    // pageId=3: {{failed verification}}, low edit count, fully online.
    flagged: { pageId: 3, pageTitle: 'Disputed_Claim', revisionId: 33, editCount: 10 },
    // pageId=4: no tags, huge edit count (would rank first on stage 1 alone),
    // but mostly offline sourcing — must be excluded by finalizeRanking.
    offline: { pageId: 4, pageTitle: 'Print_Heavy', revisionId: 44, editCount: 1000 },
};

function fakeConnection() {
    return {
        execute: async (sql, params) => {
            if (/GROUP BY p\.page_id/.test(sql)) {
                return [[rows.popular, rows.current, rows.flagged, rows.offline]];
            }
            // buildCandidateQuery params: [NS_TEMPLATE, template, NS_MAIN, NS_MAIN, afterPageId, limit]
            assert.equal(params[0], NS_TEMPLATE);
            assert.equal(params[2], NS_MAIN);
            const template = params[1];
            if (template === 'Current') return [[rows.current]];
            if (template === 'Failed_verification') return [[rows.flagged]];
            return [[]];
        },
        end: async () => {},
    };
}

function htmlForTitle(title) {
    if (title === 'Print Heavy') return offlineHeavyHtml;
    return onlineHeavyHtml;
}

const baseIo = (overrides = {}) => ({
    stdout: { write() {} },
    stderr: { write() {} },
    connectReplicas: async () => fakeConnection(),
    fetchArticle: async ({ title }) => ({ html: htmlForTitle(title), status: 200, error: null }),
    parseHtml: html => JSDOM.fragment(html),
    now: () => new Date('2026-09-09T00:00:00Z'),
    ...overrides,
});

const baseOpts = (overrides = {}) => ({
    wiki: 'enwiki', editWindowDays: 14, basePool: 1000, shortlistSize: 10,
    max: 10, offlineRatioMax: 0.6, out: 'pilot.txt', jsonOut: undefined,
    ...overrides,
});

test('runPickPilot excludes the offline-heavy article and ranks the rest by score', async () => {
    let written;
    const code = await runPickPilot(baseOpts(), baseIo({
        writeFile: async (path, content) => { written = { ...written, [path]: content }; },
    }));

    assert.equal(code, 0);
    const body = written['pilot.txt'];
    assert.ok(body, 'titles file was written');

    const titles = body.split('\n').filter(l => l && !l.startsWith('#'));
    assert.deepEqual(titles, ['Breaking Story', 'Popular Now', 'Disputed Claim'],
        'current-event boost outranks a much higher edit count; offline-heavy article dropped entirely');
});

test('runPickPilot writes the header documenting provenance and the follow-up sweep command', async () => {
    let written;
    const code = await runPickPilot(baseOpts(), baseIo({
        writeFile: async (path, content) => { written = content; },
    }));
    assert.equal(code, 0);
    assert.match(written, /^# Pilot mix:/);
    assert.match(written, /run-sweep\.js --titles-file/);
});

test('runPickPilot writes --json-out with the full score/tier breakdown when requested', async () => {
    const files = {};
    const code = await runPickPilot(baseOpts({ jsonOut: 'pilot.json' }), baseIo({
        writeFile: async (path, content) => { files[path] = content; },
    }));
    assert.equal(code, 0);
    const parsed = JSON.parse(files['pilot.json']);
    assert.equal(parsed.length, 3);
    assert.deepEqual(parsed.map(c => c.tier), ['current', 'baseline', 'flagged']);
});

test('runPickPilot rejects an out-of-range --offline-ratio-max before touching the network', async () => {
    let touched = false;
    const code = await runPickPilot(
        baseOpts({ offlineRatioMax: 1.5 }),
        baseIo({ connectReplicas: async () => { touched = true; return fakeConnection(); } })
    );
    assert.equal(code, 2);
    assert.equal(touched, false);
});

test('runPickPilot surfaces a Wiki Replicas connection failure as exit code 1', async () => {
    const code = await runPickPilot(baseOpts(), baseIo({
        connectReplicas: async () => { throw new Error('ECONNREFUSED'); },
    }));
    assert.equal(code, 1);
});
