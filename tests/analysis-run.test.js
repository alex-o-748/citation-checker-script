import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { createApiClient, listRevisions, revisionTexts, baselineRevision } from '../analysis/lib/mwapi.js';
import { buildRevisionsQuery, buildBaselineQuery, rowToMeta, toMwTimestamp } from '../analysis/lib/replicas.js';
import { loadSuggestions, groupForVerdict } from '../analysis/lib/batches.js';
import { wilson, summarize, sampleChanged, revisionFlags, toCsv } from '../analysis/lib/report.js';
import { analyzePage, parseCli } from '../analysis/run-edit-impact.js';
import { rowsToCsv } from '../service/csv-report.js';

function fakeResponse(status, body, headers = {}) {
    return { ok: status >= 200 && status < 300, status, json: async () => body, headers: { get: k => headers[k.toLowerCase()] ?? null } };
}

test('the API client waits between requests, sends a User-Agent and maxlag, and backs off on 429', async () => {
    let clock = 0;
    const sleeps = [];
    const calls = [];
    const responses = [fakeResponse(429, null, { 'retry-after': '7' }), fakeResponse(200, { query: {} }), fakeResponse(200, { query: {} })];
    const client = createApiClient({
        minIntervalMs: 1000,
        now: () => clock,
        sleepFn: async ms => { sleeps.push(ms); clock += ms; },
        fetchImpl: async (url, init) => { calls.push({ url, ua: init.headers['User-Agent'] }); return responses.shift(); },
    });
    await client.call({ action: 'query' });
    await client.call({ action: 'query' });
    assert.equal(calls.length, 3);
    assert.match(calls[0].url, /maxlag=5/);
    assert.match(calls[0].ua, /github\.com\/alex-o-748\/citation-checker-script/);
    assert.ok(sleeps.includes(7000), 'honours Retry-After');
    assert.ok(sleeps.filter(ms => ms === 1000).length >= 1, 'spaces requests');
});

test('the API client retries a maxlag error rather than returning it', async () => {
    const responses = [fakeResponse(200, { error: { code: 'maxlag', info: 'lagged' } }), fakeResponse(200, { ok: 1 })];
    const client = createApiClient({ minIntervalMs: 0, sleepFn: async () => {}, fetchImpl: async () => responses.shift() });
    assert.deepEqual(await client.call({}), { ok: 1 });
});

test('listRevisions follows continuation and keeps the window half-open', async () => {
    const pages = [
        { continue: { rvcontinue: 'x' }, query: { pages: [{ pageid: 5, revisions: [{ revid: 1, parentid: 0, timestamp: '2026-11-05T01:00:00Z', user: 'A', userid: 3, tags: ['editsuggestion-seen'] }] }] } },
        { query: { pages: [{ pageid: 5, revisions: [{ revid: 2, parentid: 1, timestamp: '2026-11-13T00:00:00Z', user: '~2026-1', userid: 9, temp: true, tags: [] }] }] } },
    ];
    const seen = [];
    const client = createApiClient({ minIntervalMs: 0, sleepFn: async () => {}, fetchImpl: async url => { seen.push(url); return fakeResponse(200, pages.shift()); } });
    const revs = await listRevisions(client, 5, { from: '2026-11-05T00:33:00Z', until: '2026-11-13T00:00:00Z' });
    assert.deepEqual(revs.map(r => r.rev_id), [1]);
    assert.match(seen[1], /rvcontinue=x/);
});

test('revisionTexts batches ids and marks missing ones null', async () => {
    const client = createApiClient({
        minIntervalMs: 0, sleepFn: async () => {},
        fetchImpl: async () => fakeResponse(200, { query: { pages: [{ pageid: 1, revisions: [{ revid: 10, slots: { main: { content: 'x' } } }] }] } }),
    });
    const texts = await revisionTexts(client, [10, 11]);
    assert.equal(texts.get(10), 'x');
    assert.equal(texts.get(11), null);
});

test('baselineRevision asks for the newest revision at or before the time', async () => {
    let url;
    const client = createApiClient({
        minIntervalMs: 0, sleepFn: async () => {},
        fetchImpl: async u => { url = u; return fakeResponse(200, { query: { pages: [{ pageid: 1, revisions: [{ revid: 9, timestamp: '2026-11-04T00:00:00Z', slots: { main: { content: 'T' } } }] }] } }); },
    });
    const b = await baselineRevision(client, 1, '2026-11-05T00:32:59Z');
    assert.equal(b.meta.rev_id, 9);
    assert.equal(b.text, 'T');
    assert.match(url, /rvdir=older/);
    assert.match(url, /rvstart=2026-11-05T00%3A32%3A59Z/);
});

test('replica queries bind every value and use the actor/comment views', () => {
    const { sql, params } = buildRevisionsQuery([1, 2], { from: '2026-11-05T00:33:00Z', until: '2026-11-13T00:00:00Z' });
    assert.match(sql, /actor_revision/);
    assert.match(sql, /comment_revision/);
    assert.match(sql, /change_tag_def/);
    assert.deepEqual(params, [1, 2, '20261105003300', '20261113000000']);
    assert.doesNotMatch(sql, /rev_sha1/, 'dropped from the replicas');
    assert.equal(buildBaselineQuery([3], '2026-11-05T00:32:59Z').params.at(-1), '20261105003259');
    assert.equal(toMwTimestamp('2026-11-05T00:33:00Z'), '20261105003300');
    const meta = rowToMeta({ rev_id: 7, rev_page: 3, rev_parent_id: 6, rev_timestamp: Buffer.from('20261106120000'), rev_len: 10,
        rev_minor_edit: 0, rev_deleted: 0, actor_name: Buffer.from('Bot'), actor_user: 4,
        comment_text: 'c', tags: Buffer.from('mw-reverted|visualeditor'), is_bot: 1 });
    assert.equal(meta.timestamp, '2026-11-06T12:00:00Z');
    assert.deepEqual(meta.tags, ['mw-reverted', 'visualeditor']);
    assert.equal(meta.is_bot, true);
});

test('loadSuggestions reads gzipped batch files and keeps flagged and supported rows only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'batches-'));
    const csv = rowsToCsv([
        { pageTitle: 'P', pageId: 1, revisionId: 5, verdict: 'NOT SUPPORTED', claimText: 'claim, with "quotes"\nand a newline', checkId: 'a' },
        { pageTitle: 'P', pageId: 1, revisionId: 5, verdict: 'SUPPORTED', claimText: 'b', checkId: 'b' },
        { pageTitle: 'P', pageId: 1, revisionId: 5, verdict: 'SOURCE UNAVAILABLE', claimText: 'c', checkId: 'c' },
    ]);
    writeFileSync(join(dir, 'x.csv.gz'), gzipSync(csv));
    const manifest = { batches: [
        { batch_id: 'x', wiki: 'enwiki', file: 'x.csv', live_from: '2026-11-05T00:33:00Z', live_until: null },
        { batch_id: 'y', wiki: 'enwiki', file: 'y.csv', live_from: '2026-11-05T00:33:00Z', live_until: null },
    ] };
    const { suggestions, missing } = await loadSuggestions({ dir, wiki: 'enwiki', manifest });
    assert.deepEqual(suggestions.map(s => [s.check_id, s.group]), [['a', 'flagged'], ['b', 'supported']]);
    assert.equal(suggestions[0].claim_text, 'claim, with "quotes"\nand a newline');
    assert.deepEqual(missing, ['y']);
    assert.equal(groupForVerdict('PARTIALLY SUPPORTED'), 'flagged');
});

test('wilson brackets the rate and handles zero', () => {
    const [lo, hi] = wilson(5, 50);
    assert.ok(lo < 0.1 && hi > 0.1);
    assert.deepEqual(wilson(0, 0), [null, null]);
    assert.equal(wilson(0, 10)[0], 0);
});

test('summarize splits changes by the tag on the changing edit and keeps the groups apart', () => {
    const row = (group, changed, extra = {}) => ({ group, located: 1, changed: changed ? 1 : 0, revisions_after: 1, first_change_kinds: changed ? 'sentence_edited' : '', ...extra });
    const s = summarize({
        wiki: 'enwiki', window: {}, pagesWithSuggestions: 1,
        revisions: [{ page_id: 1, page_title: 'P', seen: 1, used: 0 }],
        suggestions: [
            row('flagged', true, { first_change_seen: 1 }), row('flagged', true), row('flagged', false), { group: 'flagged', located: 0 },
            row('supported', true, { first_change_is_bot: 1 }), row('supported', false),
        ],
    });
    assert.equal(s.groups.flagged.changed.k, 2);
    assert.equal(s.groups.flagged.changed.n, 3);
    assert.equal(s.groups.flagged.not_located, 1);
    assert.equal(s.groups.flagged.changed_by_seen_tagged_edit.k, 1);
    assert.equal(s.groups.flagged.changed_by_other_edit.k, 1);
    assert.equal(s.groups.supported.changed_by_human_unreverted_edit.k, 0);
    assert.equal(s.revisions_tagged_seen, 1);
});

test('sampleChanged is reproducible and only draws changed flagged claims', () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ check_id: `c${i}`, group: i % 2 ? 'flagged' : 'supported', changed: i % 3 ? 1 : 0 }));
    const a = sampleChanged(rows, { size: 5, seed: 7 }).map(r => r.check_id);
    assert.deepEqual(a, sampleChanged(rows, { size: 5, seed: 7 }).map(r => r.check_id));
    assert.ok(a.every(id => { const r = rows.find(x => x.check_id === id); return r.group === 'flagged' && r.changed === 1; }));
});

test('revisionFlags reads the tags the brief names', () => {
    const f = revisionFlags({ tags: ['editsuggestion-seen', 'visualeditor-wikitext', 'mw-reverted'] });
    assert.deepEqual([f.seen, f.used, f.visualeditor, f.reverted], [true, false, true, true]);
    assert.equal(toCsv(['a'], [{ a: 'x,"y"' }]), 'a\n"x,""y"""\n');
});

test('analyzePage tracks flagged and supported claims through a page history and attributes first changes', async () => {
    const base = 'Intro.\n\n* Black Pearl – Pirates of the Caribbean, 2003<ref name=":1">{{cite web|url=https://maritimecyprus.com/x/}}</ref>\n'
        + '* Nautilus – Twenty Thousand Leagues Under the Sea, 1870<ref>{{cite web|url=https://example.org/n}}</ref>\n';
    const edited = base.replace('2003<ref name=":1">', '2003<ref name=":1">').replace('maritimecyprus.com/x/}}</ref>', 'maritimecyprus.com/x/}}</ref>{{failed verification|date=November 2026}}');
    const revisions = [
        { rev_id: 11, parent_id: 10, page_id: 1, timestamp: '2026-11-06T10:00:00Z', user: 'Ed', tags: ['editsuggestion-seen', 'visualeditor'], sha1: 's1', is_bot: false },
        { rev_id: 12, parent_id: 11, page_id: 1, timestamp: '2026-11-07T10:00:00Z', user: 'Bot', tags: [], sha1: 's1', is_bot: true },
    ];
    const fetched = [];
    const source = {
        async baseline() { return { meta: { rev_id: 10 }, text: base }; },
        async revisions() { return revisions; },
        async texts(ids) { fetched.push(...ids); return new Map(ids.map(id => [id, edited])); },
    };
    const suggestions = [
        { group: 'flagged', verdict: 'NOT SUPPORTED', check_id: 'f', page_id: 1, page_title: 'Ships', claim_text: 'Black Pearl – Pirates of the Caribbean, 2003', ref_name: ':1', source_url: 'https://maritimecyprus.com/x/' },
        { group: 'supported', verdict: 'SUPPORTED', check_id: 's', page_id: 1, page_title: 'Ships', claim_text: 'Nautilus – Twenty Thousand Leagues Under the Sea, 1870', ref_name: '', source_url: 'https://example.org/n' },
    ];
    const result = await analyzePage({ wiki: 'enwiki', pageId: 1, pageTitle: 'Ships', suggestions, window: { from: '2026-11-05T00:33:00Z', until: '2026-11-13T00:00:00Z' }, source });
    assert.deepEqual(fetched, [11], 'one fetch per distinct sha1');
    const [flagged, supported] = result.suggestions;
    assert.equal(flagged.changed, 1);
    assert.equal(flagged.first_change_kinds, 'flag_added');
    assert.equal(flagged.first_change_seen, 1);
    assert.equal(flagged.first_change_diff, 'https://en.wikipedia.org/w/index.php?diff=11&oldid=10');
    assert.equal(supported.changed, 0);
    assert.equal(result.revisions[0].first_changes_flagged, 1);
    assert.equal(result.revisions[1].is_bot, 1);
});

test('parseCli splits --titles on pipes', () => {
    const o = parseCli(['node', 'x', '--wiki', 'enwiki', '--batches', 'd', '--titles', 'Beef clod| OpenAI']);
    assert.deepEqual(o.titles, ['Beef clod', 'OpenAI']);
    assert.equal(o.source, 'api');
});

test('pagesMarkdown lists revisions, changed claims and pages without a suggestion', async () => {
    const { pagesMarkdown } = await import('../analysis/lib/report.js');
    const md = pagesMarkdown('enwiki', [
        { page_title: 'Beef clod', baseline_revision_id: 9, suggestions: [
            { group: 'flagged', verdict: 'NOT SUPPORTED', located: 1, changed: 1, citation_number: '6, 7', claim_text: 'bistro filet', first_change_kinds: 'sentence_edited', first_change_rev_id: 11, first_change_user: 'Dreamyshade', first_change_used: 1 },
        ], revisions: [{ rev_id: 11, diff: 'd', timestamp: 't', user: 'Dreamyshade', editor_type: 'registered', used: 1, first_changes_flagged: 1 }] },
        { page_title: 'Colette Kress', suggestions: [], revisions: [] },
    ]);
    assert.match(md, /Dreamyshade \(used\)/);
    assert.match(md, /Colette Kress\n\nNo Source Verification suggestion/);
    assert.match(md, /\| 1\/0 \|/);
});

test('the API client logs a timed-out request before retrying, and caps a long Retry-After', async () => {
    const logs = [];
    const sleeps = [];
    const responses = [
        () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; },
        () => fakeResponse(429, null, { 'retry-after': '3600' }),
        () => fakeResponse(200, { ok: 1 }),
    ];
    const client = createApiClient({ minIntervalMs: 0, maxWaitMs: 300000, sleepFn: async ms => { sleeps.push(ms); }, log: m => logs.push(m), fetchImpl: async () => responses.shift()() });
    assert.deepEqual(await client.call({}), { ok: 1 });
    assert.match(logs[0], /no response in 60s; retry 1\/6/);
    assert.ok(sleeps.includes(300000) && !sleeps.includes(3600000));
});

test('revisionTexts splits a request by total size', async () => {
    const asked = [];
    const client = createApiClient({ minIntervalMs: 0, sleepFn: async () => {}, fetchImpl: async url => { asked.push(new URL(url).searchParams.get('revids')); return fakeResponse(200, { query: { pages: [] } }); } });
    await revisionTexts(client, [1, 2, 3], { maxBytes: 1000, sizes: new Map([[1, 600], [2, 600], [3, 100]]) });
    assert.deepEqual(asked, ['1', '2|3']);
});

test('list-changes groups changed claims by the edit that changed them, without breaking the table', async () => {
    const { collectChanges, changesMarkdown } = await import('../analysis/list-changes.js');
    const files = {
        'revisions.csv': [{ rev_id: '11', page_title: 'Dubin', timestamp: '2026-11-05T08:29:18Z', user: 'Ed', comment: 'Add citation | fix', diff: 'd', is_bot: '0', mw_reverted: '0', seen: '1', used: '1' }],
        'suggestions.csv': [
            { group: 'flagged', changed: '1', first_change_rev_id: '11', first_change_kinds: 'footnote_added|flag_removed', citation_number: '1', claim_text: 'claim one' },
            { group: 'flagged', changed: '1', first_change_rev_id: '11', first_change_kinds: 'sentence_edited', citation_number: '2', claim_text: 'claim two' },
            { group: 'supported', changed: '1', first_change_rev_id: '11', first_change_kinds: 'sentence_edited', citation_number: '3', claim_text: 'x' },
        ],
    };
    const stream = async (path, { onRow }) => { for (const row of files[path.split('/').pop()]) onRow(row); };
    const result = await collectChanges('dir', 'flagged', { stream });
    assert.equal(result.totalClaims, 2);
    assert.equal(result.edits.length, 1);
    const md = changesMarkdown(result);
    const row = md.split('\n').find(l => l.startsWith('| 1 |'));
    assert.equal(row.split(/(?<!\\)\|/).length - 2, 8, 'eight cells');
    assert.match(row, /footnote_added \+ flag_removed/);
    assert.match(row, /Add citation \\\| fix/);
});
