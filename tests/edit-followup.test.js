import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    analyzeRun, citationState, citationsToCsv, compareStates, findUrlOccurrences, groupRuns,
    parseTimestamp, renderMarkdown, summarize, urlForms, verdictClass,
} from '../service/edit-followup.js';
import {
    apiGet, buildRevisionsUrl, fetchRevisions, lookUpBots, parseCliArgs, resolveRevisionPages, runFollowup, UsageError,
} from '../service/run-edit-followup.js';

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse('2026-10-01T12:00:00Z');

// --- verdicts and timestamps --------------------------------------------------

test('verdictClass: flagged, supported, unavailable, and nothing else', () => {
    assert.equal(verdictClass('NOT SUPPORTED'), 'flagged');
    assert.equal(verdictClass('partially supported'), 'flagged');
    assert.equal(verdictClass('SUPPORTED'), 'supported');
    assert.equal(verdictClass('SOURCE UNAVAILABLE'), 'unavailable');
    assert.equal(verdictClass('PARSE_ERROR'), null);
    assert.equal(verdictClass('SKIPPED'), null);
    assert.equal(verdictClass(''), null);
});

test('parseTimestamp: ISO and Postgres text forms agree', () => {
    assert.equal(parseTimestamp('2026-10-01T12:00:00.000Z'), T0);
    assert.equal(parseTimestamp('2026-10-01 12:00:00+00'), T0);
    assert.equal(parseTimestamp('2026-10-01 14:00:00.000+02:00'), T0);
    assert.equal(parseTimestamp('not a date'), null);
    assert.equal(parseTimestamp(''), null);
});

// --- grouping -----------------------------------------------------------------

const row = (overrides = {}) => ({
    ts: '2026-10-01T12:00:00.000Z',
    article_url: 'https://en.wikipedia.org/wiki/Foo',
    article_title: 'Foo',
    revision_id: '100',
    kind: 'source',
    citation_number: '1',
    source_url: 'https://example.com/a',
    verdict: 'NOT SUPPORTED',
    ...overrides,
});

test('groupRuns: one run per article and revision, latest check of a citation wins', () => {
    const { runs, skipped } = groupRuns([
        row(),
        row({ ts: '2026-10-01T12:05:00.000Z', verdict: 'SUPPORTED' }),
        row({ citation_number: '2', source_url: 'https://example.com/b', verdict: 'SUPPORTED' }),
        row({ revision_id: '101' }),
        row({ article_url: 'https://ru.wikipedia.org/wiki/Foo' }),
        row({ kind: 'group', source_url: '' }),
        row({ source_url: '' }),
        row({ verdict: 'PARSE_ERROR' }),
        row({ revision_id: '' }),
    ]);
    assert.equal(runs.length, 2);
    const run = runs.find(r => r.revisionId === 100);
    assert.equal(run.citations.length, 2);
    assert.equal(run.citations.find(c => c.citationNumber === '1').verdictClass, 'supported');
    assert.equal(run.firstCheckMs, T0);
    assert.equal(run.lastCheckMs, T0 + 5 * 60000);
    assert.deepEqual(skipped, {
        other_wiki: 1, group: 1, no_source_url: 1, unscored_verdict: 1, bad_row: 1, out_of_range: 0,
    });
});

test('groupRuns: since/until filter on check time', () => {
    const { runs, skipped } = groupRuns([row(), row({ ts: '2026-09-01T00:00:00Z', revision_id: '5' })], {
        sinceMs: Date.parse('2026-09-15T00:00:00Z'),
    });
    assert.equal(runs.length, 1);
    assert.equal(skipped.out_of_range, 1);
});

// --- finding URLs ---------------------------------------------------------------

test('urlForms: scheme dropped, trailing slash and percent-encoding normalized', () => {
    assert.deepEqual(urlForms('https://example.com/a/'), ['//example.com/a']);
    assert.ok(urlForms('https://example.com/caf%C3%A9').includes('//example.com/café'));
    assert.ok(urlForms('https://example.com/a?x=1&y=2').includes('//example.com/a?x=1&amp;y=2'));
    assert.deepEqual(urlForms('http://a.b'), [], 'too short to match safely');
});

test('findUrlOccurrences: matches http/https and a trailing slash, not a longer URL', () => {
    const text = 'x http://example.com/a y https://example.com/a/ z https://example.com/a/b '
        + 'w https://example.com/a?page=2 v |url=https://example.com/a}}';
    const at = findUrlOccurrences(text, 'https://example.com/a');
    assert.equal(at.length, 3);
});

test('findUrlOccurrences: the original URL inside an archive URL still counts', () => {
    const text = '<ref>{{cite web |url=https://web.archive.org/web/2020/https://example.com/a |title=T}}</ref>';
    assert.equal(findUrlOccurrences(text, 'https://example.com/a').length, 1);
});

// --- citation state ---------------------------------------------------------------

const ref = url => `<ref>{{cite web |url=${url} |title=T}}</ref>`;

test('citationState: counts refs, tags right after the ref, and the claim before it', () => {
    const text = `Para one. The sky is green.${ref('https://example.com/a')}{{failed verification|date=October 2026}} More.\n`
        + `Grass is blue.<ref name="x">{{cite web |url=https://example.com/a}}</ref> End.`;
    const state = citationState(text, 'https://example.com/a');
    assert.equal(state.count, 2);
    assert.equal(state.tagged, 1);
    assert.deepEqual(state.claims, ['The sky is green.', 'Grass is blue.'], 'the sentence the ref ends');
});

test('citationState: a tag after a cluster of refs belongs to every ref in it; a later tag does not', () => {
    const cluster = `Claim.${ref('https://example.com/a')}${ref('https://example.com/b')} {{fv}}`;
    assert.equal(citationState(cluster, 'https://example.com/a').tagged, 1);
    const later = `Claim.${ref('https://example.com/a')} Another sentence. {{fv}}`;
    assert.equal(citationState(later, 'https://example.com/a').tagged, 0);
    const redirect = `Claim.${ref('https://example.com/a')}{{Better_source_needed}}`;
    assert.equal(citationState(redirect, 'https://example.com/a').tagged, 1);
});

test('citationState: a tag added after the previous ref is not a change to the next claim', () => {
    const before = `A.${ref('https://example.com/a')} B is true.${ref('https://example.com/b')}`;
    const after = `A.${ref('https://example.com/a')}{{failed verification|date=Nov 2026}} B is true.${ref('https://example.com/b')}`;
    const change = compareStates(citationState(before, 'https://example.com/b'), citationState(after, 'https://example.com/b'));
    assert.equal(change.any, false);
});

test('citationState: removing a neighbouring ref does not change the next claim', () => {
    // Bounding the claim at the previous ref made every removal of a flagged
    // source also read as a reworded claim on the citation after it.
    const before = `Intro.\nThe sky is green.${ref('https://example.com/a')} Water is wet.${ref('https://example.com/b')}\n`;
    const after = `Intro.\nThe sky is green. Water is wet.${ref('https://example.com/b')}\n`;
    const url = 'https://example.com/b';
    assert.deepEqual(citationState(before, url).claims, ['Water is wet.']);
    assert.equal(compareStates(citationState(before, url), citationState(after, url)).any, false);
});

test('citationState: text written in front of a ref that had no claim is not a reworded claim', () => {
    const before = `Intro.\n${ref('https://example.com/a')}\n`;
    const after = `Intro.\nEngine failure.${ref('https://example.com/a')}\n`;
    assert.deepEqual(citationState(before, 'https://example.com/a').claims, [null]);
    const change = compareStates(citationState(before, 'https://example.com/a'), citationState(after, 'https://example.com/a'));
    assert.equal(change.any, false);
});

test('citationState: a URL outside any ref has no claim, and <references> is not a ref', () => {
    const text = '== Further reading ==\n* https://example.com/a\n<references>\n</references>';
    const state = citationState(text, 'https://example.com/a');
    assert.equal(state.count, 1);
    assert.deepEqual(state.claims, [null]);
});

test('compareStates: removed, tagged, claim', () => {
    const base = { count: 2, tagged: 0, claims: ['a', 'b'] };
    assert.deepEqual(compareStates(base, { count: 1, tagged: 0, claims: ['a'] }),
        { removed: true, tagged: false, claim: false, strong: true, any: true });
    assert.equal(compareStates(base, { count: 2, tagged: 1, claims: ['a', 'b'] }).strong, true);
    const claim = compareStates(base, { count: 2, tagged: 0, claims: ['a', 'b changed'] });
    assert.equal(claim.strong, false);
    assert.equal(claim.any, true);
    assert.equal(compareStates(base, { count: 3, tagged: 0, claims: ['a', 'b', 'c'] }).any, false,
        'adding another use of the source is not a fix');
});

// --- one run ----------------------------------------------------------------------

const article = ({ a = true, aTag = '', b = true, claimA = 'The sky is green.' } = {}) =>
    `Intro.\n${claimA}${a ? ref('https://example.com/a') : ''}${aTag} Water is wet.${b ? ref('https://example.com/b') : ''}\n`;

const runFixture = () => groupRuns([
    row({ citation_number: '1', source_url: 'https://example.com/a', verdict: 'NOT SUPPORTED' }),
    row({ citation_number: '2', source_url: 'https://example.com/b', verdict: 'SUPPORTED' }),
    row({ citation_number: '3', source_url: 'https://example.com/missing', verdict: 'NOT SUPPORTED' }),
]).runs[0];

const rev = (revid, minutesAfter, user, text) => ({ revid, timestampMs: T0 + minutesAfter * 60000, user, text });

test('analyzeRun: the first human edit that changed a citation, in minutes after its check', () => {
    const run = runFixture();
    const revisions = [
        rev(100, -60, 'Someone', article()),
        rev(101, 10, 'Editor', article({ claimA: 'The sky is blue.' })),
        rev(102, 30, 'Editor', article({ claimA: 'The sky is blue.', aTag: '{{fv}}' })),
    ];
    const { status, citations, editsByWindow } = analyzeRun(run, revisions, { windowsHours: [1, 24] });
    assert.equal(status, 'ok');
    assert.deepEqual(editsByWindow, { 1: true, 24: true });
    const a = citations.find(c => c.citationNumber === '1');
    assert.equal(a.matched, true);
    assert.equal(a.any.kind, 'claim');
    assert.equal(a.any.minutes, 10);
    assert.equal(a.strong.kind, 'tagged');
    assert.equal(a.strong.revid, 102);
    const b = citations.find(c => c.citationNumber === '2');
    assert.equal(b.strong, null);
    assert.equal(b.any, null);
    assert.equal(citations.find(c => c.citationNumber === '3').matched, false);
});

test('analyzeRun: bot edits and edits before the check are recorded but do not count', () => {
    const run = runFixture();
    const before = analyzeRun(run, [rev(100, -60, 'X', article()), rev(101, -5, 'Editor', article({ a: false }))]);
    assert.equal(before.citations[0].strong.beforeCheck, true);
    const bot = analyzeRun(run, [rev(100, -60, 'X', article()), rev(101, 5, 'IABot', article({ a: false }))],
        { isBot: user => user === 'IABot' });
    assert.equal(bot.citations[0].strong.byBot, true);
    assert.equal(bot.editsByWindow[1], false, 'a bot edit is not a human edit after the run');
    const summary = summarize([before, bot], { windowsHours: [1] });
    assert.equal(summary.classes.flagged.windows[1].strong, 0);
    assert.equal(summary.classes.flagged.byBot, 1);
    assert.equal(summary.classes.flagged.beforeCheck, 1);
});

test('analyzeRun: edits past the longest window are ignored', () => {
    const run = runFixture();
    const result = analyzeRun(run, [rev(100, -60, 'X', article()), rev(101, 49 * 60, 'Editor', article({ a: false }))],
        { windowsHours: [1, 48] });
    assert.equal(result.citations[0].strong, null);
});

test('analyzeRun: statuses for a wrong base revision, hidden text, and an excluded editor', () => {
    const run = runFixture();
    assert.equal(analyzeRun(run, []).status, 'no_revisions');
    assert.equal(analyzeRun(run, [rev(99, -60, 'X', article())]).status, 'base_mismatch');
    assert.equal(analyzeRun(run, [rev(100, -60, 'X', null)]).status, 'base_hidden');
    const revisions = [rev(100, -60, 'X', article()), rev(101, 5, 'Alaexis', article({ a: false }))];
    assert.equal(analyzeRun(run, revisions, { excludedEditors: ['alaexis'] }).status, 'excluded_editor');
    assert.equal(analyzeRun(run, revisions, { excludedEditors: ['Someone else'] }).status, 'ok');
});

// --- summary ------------------------------------------------------------------------

test('summarize: rates per window and the flagged-minus-supported gap', () => {
    const run = runFixture();
    const fixed = analyzeRun(run, [rev(100, -60, 'X', article()), rev(101, 20, 'Editor', article({ a: false }))],
        { windowsHours: [1, 6] });
    const late = analyzeRun(run, [rev(100, -60, 'X', article()), rev(101, 120, 'Editor', article({ a: false, b: false }))],
        { windowsHours: [1, 6] });
    const summary = summarize([fixed, late, { status: 'page_missing', citations: [], editsByWindow: {} }],
        { windowsHours: [1, 6] });

    assert.equal(summary.runs.total, 3);
    assert.equal(summary.runs.analyzed, 2);
    assert.equal(summary.runs.byStatus.page_missing, 1);
    assert.equal(summary.classes.flagged.citations, 2);
    assert.equal(summary.classes.flagged.unmatched, 2);
    assert.equal(summary.classes.flagged.windows[1].strongRate, 0.5);
    assert.equal(summary.classes.flagged.windows[6].strongRate, 1);
    assert.equal(summary.classes.flagged.windows[6].removed, 2);
    assert.equal(summary.classes.supported.windows[1].strongRate, 0);
    assert.equal(summary.classes.supported.windows[6].strongRate, 0.5);
    assert.equal(summary.gap[1].strong, 0.5);
    assert.equal(summary.gap[6].strong, 0.5);
    assert.deepEqual(summary.editors, [{
        // Both fixtures' edits are revision 101: one edit, counted once.
        user: 'Editor', flaggedEdits: 1, flaggedCitationsChanged: 2, flaggedSourcesChanged: 2,
        supportedCitationsChanged: 1, runs: 2,
    }]);

    const markdown = renderMarkdown(summary, { skipped: { group: 4 }, notes: ['A note.'] });
    assert.match(markdown, /\| 1 h \| 50\.0% \(1\) \| 0\.0% \(0\) \| \+50\.0 pts/);
    assert.match(markdown, /page_missing: 1/);
    assert.match(markdown, /group: 4/);
    assert.match(markdown, /A note\./);
});

test('summarize: editors over a threshold, all of them with topEditors 0', () => {
    const run = runFixture();
    const byUser = (user, n) => Array.from({ length: n }, (_, i) =>
        analyzeRun(run, [rev(100, -60, 'X', article()), rev(200 + i, 20, user, article({ a: false }))]));
    const results = [...byUser('Many', 4), ...byUser('Few', 3), ...byUser('Other', 5)];
    const all = summarize(results, { windowsHours: [1], topEditors: 0, minEditorEdits: 4 });
    assert.deepEqual(all.editors.map(e => [e.user, e.flaggedEdits]), [['Other', 5], ['Many', 4]]);
    const top = summarize(results, { windowsHours: [1], topEditors: 1 });
    assert.deepEqual(top.editors.map(e => e.user), ['Other']);
    assert.match(renderMarkdown(all), /\| Many \| 4 \| 4 \| 4 \| 4 \| 0 \|/);
});

test('citationsToCsv: one row per citation, no usernames', () => {
    const run = runFixture();
    const result = analyzeRun(run, [rev(100, -60, 'X', article()), rev(101, 20, 'Editor', article({ a: false }))]);
    const csv = citationsToCsv([{ run, result }]);
    const lines = csv.trim().split('\n');
    assert.equal(lines.length, 4);
    assert.match(lines[1], /^Foo,100,1,NOT SUPPORTED,flagged,https:\/\/example\.com\/a,true,removed,20\.0,101,false,,$/);
    assert.ok(!csv.includes('Editor'));
});

// --- the API layer --------------------------------------------------------------------

const json = (body, status = 200, headers = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => headers[name.toLowerCase()] ?? null },
    json: async () => body,
});

test('apiGet: retries 429, 5xx and maxlag, honouring Retry-After', async () => {
    const responses = [
        json({}, 429, { 'retry-after': '3' }),
        json({}, 503),
        json({ error: { code: 'maxlag', info: 'lagged' } }),
        json({ ok: true }),
    ];
    const sleeps = [];
    const body = await apiGet('https://x/w/api.php', {
        fetchImpl: async () => responses.shift(),
        sleep: async ms => { sleeps.push(ms); },
    });
    assert.deepEqual(body, { ok: true });
    assert.deepEqual(sleeps, [3000, 4000, 8000]);
});

test('apiGet: gives up after the last retry, and does not retry a 4xx', async () => {
    await assert.rejects(apiGet('u', { fetchImpl: async () => json({}, 429), sleep: async () => {} }), /gave up/);
    let calls = 0;
    await assert.rejects(apiGet('u', { fetchImpl: async () => { calls++; return json({}, 404); }, sleep: async () => {} }), /HTTP 404/);
    assert.equal(calls, 1);
});

test('buildRevisionsUrl: by page id, from the checked revision forward, up to the window end', () => {
    const url = new URL(buildRevisionsUrl('en.wikipedia.org', { pageId: 42, startRevid: 100, endMs: T0 }));
    assert.equal(url.searchParams.get('pageids'), '42');
    assert.equal(url.searchParams.get('rvstartid'), '100');
    assert.equal(url.searchParams.get('rvdir'), 'newer');
    assert.equal(url.searchParams.get('rvend'), '2026-10-01T12:00:00Z');
    assert.equal(url.searchParams.get('titles'), null, 'a title stops pointing at the page once it is moved');
});

test('resolveRevisionPages: revision -> page, namespace and current title, 50 at a time', async () => {
    const urls = [];
    const fetchImpl = async url => {
        urls.push(url);
        const ids = new URL(url).searchParams.get('revids').split('|').map(Number);
        return json({ query: {
            badrevids: {},
            pages: ids.filter(id => id !== 7).map(id => ({
                pageid: id * 10, ns: id === 3 ? 118 : 0, title: id === 3 ? 'Draft:Three' : `Page ${id}`,
                revisions: [{ revid: id }],
            })),
        } });
    };
    const ids = Array.from({ length: 60 }, (_, i) => i + 1);
    const pages = await resolveRevisionPages('h', [...ids, 1], { fetchImpl, sleep: async () => {} });
    assert.equal(urls.length, 2);
    assert.deepEqual(pages.get(3), { pageId: 30, ns: 118, title: 'Draft:Three' });
    assert.equal(pages.get(7), undefined, 'a revision of a deleted page');
    assert.equal(pages.size, 59);
});

test('fetchRevisions: follows continuation, maps hidden content and users to null', async () => {
    const pages = [
        { continue: { rvcontinue: '2', continue: '||' }, query: { pages: [{ revisions: [
            { revid: 100, timestamp: '2026-10-01T11:00:00Z', user: 'A', slots: { main: { content: 'base' } } },
        ] }] } },
        { query: { pages: [{ revisions: [
            { revid: 101, timestamp: '2026-10-01T12:30:00Z', userhidden: true, slots: { main: { texthidden: true } } },
        ] }] } },
    ];
    const urls = [];
    const result = await fetchRevisions({
        host: 'en.wikipedia.org', pageId: 1, startRevid: 100, endMs: T0 + HOUR,
        fetchImpl: async url => { urls.push(url); return json(pages.shift()); }, sleep: async () => {},
    });
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.revisions.map(r => [r.revid, r.user, r.text]), [[100, 'A', 'base'], [101, null, null]]);
    assert.equal(new URL(urls[1]).searchParams.get('rvcontinue'), '2');
});

test('fetchRevisions: a missing page', async () => {
    const result = await fetchRevisions({
        host: 'h', pageId: 1, startRevid: 1, endMs: T0,
        fetchImpl: async () => json({ query: { pages: [{ title: 'Gone', missing: true }] } }),
    });
    assert.equal(result.status, 'missing');
});

test('lookUpBots: bot group membership, cached, IPs and unknown names are not bots', async () => {
    const cache = new Map();
    let calls = 0;
    const fetchImpl = async () => {
        calls++;
        return json({ query: { users: [
            { name: 'InternetArchiveBot', groups: ['*', 'user', 'bot'] },
            { name: 'Editor', groups: ['*', 'user'] },
            { name: '1.2.3.4', invalid: true },
        ] } });
    };
    await lookUpBots('h', ['InternetArchiveBot', 'Editor', '1.2.3.4', null], cache, { fetchImpl });
    await lookUpBots('h', ['Editor'], cache, { fetchImpl });
    assert.equal(calls, 1);
    assert.equal(cache.get('InternetArchiveBot'), true);
    assert.equal(cache.get('Editor'), false);
    assert.equal(cache.get('1.2.3.4'), false);
});

// --- the CLI ----------------------------------------------------------------------------

test('parseCliArgs: defaults, sorted windows, repeatable --exclude-editor, and errors', () => {
    const opts = parseCliArgs(['checks.csv', '--windows', '24,1', '--exclude-editor', 'A', '--exclude-editor', 'B',
        '--top-editors', '0', '--min-editor-edits', '4']);
    assert.equal(opts.topEditors, 0);
    assert.equal(opts.minEditorEdits, 4);
    assert.equal(opts.input, 'checks.csv');
    assert.deepEqual(opts.windowsHours, [1, 24]);
    assert.deepEqual(opts.excludedEditors, ['A', 'B']);
    assert.equal(opts.wiki, 'en.wikipedia.org');
    assert.deepEqual(parseCliArgs(['x.csv']).windowsHours, [1, 6, 24, 48]);
    assert.equal(parseCliArgs(['--help']).help, true);
    assert.throws(() => parseCliArgs([]), UsageError);
    assert.throws(() => parseCliArgs(['x', '--windows', '0']), UsageError);
    assert.throws(() => parseCliArgs(['x', '--since', 'soon']), UsageError);
});

test('runFollowup: end to end over a JSON export, with a cache and an open window', async () => {
    const rows = [
        row({ citation_number: '1', source_url: 'https://example.com/a', verdict: 'NOT SUPPORTED' }),
        row({ citation_number: '2', source_url: 'https://example.com/b', verdict: 'SUPPORTED' }),
        row({ revision_id: '200', article_title: 'Recent', ts: '2026-11-20T00:00:00Z' }),
        row({ revision_id: '300', article_title: 'Foo/sandbox' }),
        row({ revision_id: '400', article_title: 'Deleted' }),
    ];
    const files = new Map([['checks.json', JSON.stringify(rows)]]);
    const readFile = async path => {
        if (!files.has(path)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return files.get(path);
    };
    const writeFile = async (path, data) => { files.set(path, data); };
    let requests = 0;
    const fetchImpl = async url => {
        requests++;
        const params = new URL(url).searchParams;
        if (params.get('list') === 'users') return json({ query: { users: [{ name: 'Editor', groups: ['user'] }] } });
        if (params.get('revids')) {
            assert.equal(params.get('revids'), '100|300|400', 'the open-window run is not resolved');
            return json({ query: { pages: [
                { pageid: 1, ns: 0, title: 'Foo (moved)', revisions: [{ revid: 100 }] },
                { pageid: 3, ns: 2, title: 'User:X/Foo/sandbox', revisions: [{ revid: 300 }] },
            ] } });
        }
        assert.equal(params.get('pageids'), '1');
        return json({ query: { pages: [{ revisions: [
            { revid: 100, timestamp: '2026-10-01T11:00:00Z', user: 'Editor', slots: { main: { content: article() } } },
            { revid: 101, timestamp: '2026-10-01T12:20:00Z', user: 'Editor', slots: { main: { content: article({ a: false }) } } },
        ] }] } });
    };
    const options = {
        ...parseCliArgs(['checks.json', '--out', 'out/report', '--cache-dir', 'cache', '--delay-ms', '0']),
    };
    const deps = {
        fetchImpl, readFile, writeFile, mkdir: async () => {}, sleep: async () => {},
        now: () => Date.parse('2026-11-21T00:00:00Z'), log: () => {},
    };

    const first = await runFollowup(options, deps);
    assert.equal(requests, 3, 'one revision lookup, one history query, one user lookup');
    assert.equal(first.summary.runs.byStatus.window_open, 1);
    assert.equal(first.summary.runs.byStatus.not_an_article, 1);
    assert.equal(first.summary.runs.byStatus.page_missing, 1);
    assert.ok(files.get('out/report-citations.csv').includes('Foo (moved),100'), 'the current title, not Neon\'s');
    assert.equal(first.summary.classes.flagged.windows[1].strongRate, 1);
    assert.equal(first.summary.classes.supported.windows[1].strongRate, 0);
    assert.ok(files.has('out/report.md'));
    assert.ok(files.has('out/report.json'));
    assert.ok(files.get('out/report-citations.csv').includes('removed'));

    await runFollowup(options, deps);
    assert.equal(requests, 4, 'the second run only re-resolves revisions; the history comes from the cache');
});
