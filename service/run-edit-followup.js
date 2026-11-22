#!/usr/bin/env node
// Measures whether checks lead to edits, from article histories rather than
// edit summaries. See service/edit-followup.js for the method.
//
// Input is an export of Neon's verification_logs (EXPORT_SQL in
// edit-followup.js), as CSV, JSON (an array of rows) or NDJSON. For each run
// (article + checked revision) it fetches the revisions in the following
// hours from the MediaWiki Action API, works out which checked citations a
// human edit changed, and writes three files:
//
//   <out>.md              the report: flagged vs Supported change rates per window
//   <out>.json            the same numbers, machine-readable
//   <out>-citations.csv   one row per checked citation, for auditing cases
//
// Usage:
//   node service/run-edit-followup.js checks.csv
//   node service/run-edit-followup.js checks.csv --exclude-editor Alaexis --cache-dir .followup-cache
//
// Outbound network: the wiki's Action API only. One request per run (more
// for a busy article), plus one per 50 new usernames to look up bot flags.
// Sequential, with --delay-ms between requests.

import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
    readFile as fsReadFile, writeFile as fsWriteFile, mkdir as fsMkdir,
} from 'node:fs/promises';

import { streamCsvRows } from './csv-stream.js';
import { DEFAULT_USER_AGENT } from './wikipedia-pageids.js';
import {
    DEFAULT_WINDOWS_HOURS, EXPORT_SQL, analyzeRun, citationsToCsv, groupRuns,
    parseTimestamp, renderMarkdown, summarize,
} from './edit-followup.js';

export const HELP_TEXT = `usage: node service/run-edit-followup.js <checks.csv|.json|.ndjson> [options]

For each check logged to Neon, reads the article's history in the hours after
it and reports how often flagged citations were changed by a human edit,
against Supported citations from the same runs.

Export the input from Neon with this query (psql: wrap it in
\\copy (...) TO 'checks.csv' CSV HEADER):

${EXPORT_SQL}

Options:
  --wiki <host>            Wiki to analyze (default: en.wikipedia.org).
  --windows <h,h,...>      Windows in hours (default: ${DEFAULT_WINDOWS_HOURS.join(',')}).
  --since <date>           Only checks at or after this time (ISO 8601).
  --until <date>           Only checks before this time.
  --exclude-editor <name>  Drop runs in which this editor edited the article
                           after the check (repeatable). Use it to take your
                           own use out of the numbers.
  --max-runs <n>           Analyze at most n runs (the earliest first).
  --max-revisions <n>      Revisions to read per run before giving up on a
                           busy article (default: 200).
  --all-namespaces         Include checks run on drafts, sandboxes and other
                           non-article pages (default: articles only).
  --cache-dir <dir>        Keep fetched revisions here; a re-run with other
                           windows or filters then makes no requests.
  --out <prefix>           Output path prefix (default: edit-followup-<date>).
  --delay-ms <n>           Pause between API requests (default: 200).
  --user-agent <ua>        User-Agent for API requests.
  --help, -h               Show this help and exit.

Exit codes: 0 done, 1 the API failed for every run, 2 bad arguments or I/O error.
`;

const HOUR_MS = 60 * 60 * 1000;
const RETRY_DELAYS_MS = [2000, 4000, 8000, 16000, 32000];

export function parseCliArgs(argv) {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
            wiki: { type: 'string', default: 'en.wikipedia.org' },
            windows: { type: 'string' },
            since: { type: 'string' },
            until: { type: 'string' },
            'exclude-editor': { type: 'string', multiple: true, default: [] },
            'max-runs': { type: 'string' },
            'max-revisions': { type: 'string', default: '200' },
            'all-namespaces': { type: 'boolean', default: false },
            'cache-dir': { type: 'string' },
            out: { type: 'string' },
            'delay-ms': { type: 'string', default: '200' },
            'user-agent': { type: 'string', default: DEFAULT_USER_AGENT },
            help: { type: 'boolean', short: 'h', default: false },
        },
    });
    if (values.help) return { help: true };
    if (positionals.length !== 1) throw new UsageError('expected exactly one input file');

    const windowsHours = values.windows
        ? values.windows.split(',').map(s => Number(s.trim()))
        : [...DEFAULT_WINDOWS_HOURS];
    if (!windowsHours.length || windowsHours.some(h => !Number.isFinite(h) || h <= 0)) {
        throw new UsageError(`--windows must be positive numbers of hours, got "${values.windows}"`);
    }
    windowsHours.sort((a, b) => a - b);

    const timeOption = name => {
        if (values[name] === undefined) return null;
        const ms = parseTimestamp(values[name]);
        if (ms === null) throw new UsageError(`--${name} is not a date: "${values[name]}"`);
        return ms;
    };
    const intOption = (name, value) => {
        if (value === undefined) return null;
        const n = Number(value);
        if (!Number.isInteger(n) || n < 0) throw new UsageError(`--${name} must be a non-negative integer`);
        return n;
    };

    return {
        help: false,
        input: positionals[0],
        wiki: values.wiki,
        windowsHours,
        sinceMs: timeOption('since'),
        untilMs: timeOption('until'),
        excludedEditors: values['exclude-editor'],
        maxRuns: intOption('max-runs', values['max-runs']),
        maxRevisions: intOption('max-revisions', values['max-revisions']),
        allNamespaces: values['all-namespaces'],
        cacheDir: values['cache-dir'] ?? null,
        out: values.out ?? `edit-followup-${new Date().toISOString().slice(0, 10)}`,
        delayMs: intOption('delay-ms', values['delay-ms']),
        userAgent: values['user-agent'],
    };
}

export class UsageError extends Error {}

/** Reads the export: CSV (with header), a JSON array, or NDJSON. */
export async function readChecks(path, { readFile = fsReadFile, streamRows = streamCsvRows } = {}) {
    if (/\.json$/i.test(path)) {
        const data = JSON.parse(await readFile(path, 'utf8'));
        if (!Array.isArray(data)) throw new Error(`${path}: expected a JSON array of rows`);
        return data;
    }
    if (/\.ndjson$/i.test(path)) {
        return (await readFile(path, 'utf8')).split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
    }
    const rows = [];
    await streamRows(path, { onRow: row => rows.push(row) });
    return rows;
}

// --- The Action API ---------------------------------------------------------------

/**
 * GETs one Action API URL, retrying 429, 5xx and maxlag with backoff.
 * Returns the parsed JSON body; throws once retries run out.
 */
export async function apiGet(url, { fetchImpl = fetch, userAgent = DEFAULT_USER_AGENT, sleep = defaultSleep } = {}) {
    let lastError = null;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
        if (attempt > 0) await sleep(lastError?.retryAfterMs ?? RETRY_DELAYS_MS[attempt - 1]);
        let response;
        try {
            response = await fetchImpl(url, { headers: { 'User-Agent': userAgent, 'Api-User-Agent': userAgent } });
        } catch (err) {
            lastError = err;
            continue;
        }
        if (response.status === 429 || response.status >= 500) {
            const retryAfter = Number(response.headers?.get?.('retry-after'));
            lastError = Object.assign(new Error(`HTTP ${response.status}`), {
                retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 120) * 1000 : null,
            });
            continue;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
        const body = await response.json();
        if (body?.error?.code === 'maxlag') {
            lastError = new Error('maxlag');
            continue;
        }
        if (body?.error) throw new Error(`API error ${body.error.code}: ${body.error.info}`);
        return body;
    }
    throw new Error(`gave up after ${RETRY_DELAYS_MS.length + 1} attempts: ${lastError?.message ?? 'unknown error'}`);
}

function defaultSleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Which page each checked revision belongs to, as a Map of revid ->
 * `{ pageId, ns, title }`. Looked up by revision rather than by title
 * because Neon's article_title drops the namespace ("Foo/sandbox" for
 * "User:Foo/sandbox"), and a title stops pointing at the page once it is
 * moved or turned into a redirect. A revision of a deleted page is absent.
 */
export async function resolveRevisionPages(host, revids, { delayMs = 0, ...api } = {}) {
    const result = new Map();
    const unique = [...new Set(revids)];
    const sleep = api.sleep ?? defaultSleep;
    for (let i = 0; i < unique.length; i += 50) {
        const batch = unique.slice(i, i + 50);
        const params = new URLSearchParams({
            action: 'query', format: 'json', formatversion: '2',
            revids: batch.join('|'), prop: 'revisions', rvprop: 'ids', maxlag: '5',
        });
        const body = await apiGet(`https://${host}/w/api.php?${params.toString()}`, api);
        for (const page of body?.query?.pages ?? []) {
            if (page.missing || !page.pageid) continue;
            for (const r of page.revisions ?? []) {
                result.set(r.revid, { pageId: page.pageid, ns: page.ns, title: page.title });
            }
        }
        if (delayMs) await sleep(delayMs);
    }
    return result;
}

export function buildRevisionsUrl(host, { pageId, startRevid, endMs, continueParams = {} }) {
    const params = new URLSearchParams({
        action: 'query',
        format: 'json',
        formatversion: '2',
        prop: 'revisions',
        pageids: String(pageId),
        rvprop: 'ids|timestamp|user|content',
        rvslots: 'main',
        rvstartid: String(startRevid),
        rvdir: 'newer',
        rvend: new Date(endMs).toISOString().replace(/\.\d{3}Z$/, 'Z'),
        rvlimit: '50',
        maxlag: '5',
        ...continueParams,
    });
    return `https://${host}/w/api.php?${params.toString()}`;
}

/**
 * The checked revision and every revision after it up to `endMs`, oldest
 * first, as `[{ revid, timestampMs, user, text }]`. `text` is null for a
 * revision whose content is hidden. Returns `{ status, revisions, truncated }`
 * with status 'ok' or 'missing' (the page was deleted).
 */
export async function fetchRevisions({ host, pageId, startRevid, endMs, maxRevisions = 200, delayMs = 0, ...api }) {
    const revisions = [];
    let continueParams = {};
    let truncated = false;
    const sleep = api.sleep ?? defaultSleep;
    for (;;) {
        const body = await apiGet(buildRevisionsUrl(host, { pageId, startRevid, endMs, continueParams }), api);
        const page = body?.query?.pages?.[0];
        if (!page || page.missing || page.invalid) return { status: 'missing', revisions: [], truncated: false };
        for (const r of page.revisions ?? []) {
            const slot = r.slots?.main;
            revisions.push({
                revid: r.revid,
                timestampMs: Date.parse(r.timestamp),
                user: r.userhidden ? null : (r.user ?? null),
                text: !slot || slot.texthidden || slot.content === undefined ? null : slot.content,
            });
        }
        if (!body.continue) break;
        if (revisions.length >= maxRevisions) { truncated = true; break; }
        continueParams = { ...body.continue };
        if (delayMs) await sleep(delayMs);
    }
    return { status: 'ok', revisions, truncated };
}

/**
 * Which of `users` are in the wiki's bot group. Looks names up 50 at a time
 * and remembers them in `cache` (a Map of name -> boolean).
 */
export async function lookUpBots(host, users, cache, { delayMs = 0, ...api } = {}) {
    const unknown = [...new Set(users.filter(u => u && !cache.has(u)))];
    const sleep = api.sleep ?? defaultSleep;
    for (let i = 0; i < unknown.length; i += 50) {
        const batch = unknown.slice(i, i + 50);
        const params = new URLSearchParams({
            action: 'query', format: 'json', formatversion: '2',
            list: 'users', ususers: batch.join('|'), usprop: 'groups', maxlag: '5',
        });
        const body = await apiGet(`https://${host}/w/api.php?${params.toString()}`, api);
        for (const name of batch) cache.set(name, false);
        for (const u of body?.query?.users ?? []) {
            if (u.name) cache.set(u.name, Array.isArray(u.groups) && u.groups.includes('bot'));
        }
        if (delayMs) await sleep(delayMs);
    }
    return cache;
}

function cachePath(cacheDir, run, endMs) {
    const key = createHash('sha1').update(`${run.wiki}\u0000${run.title}\u0000${run.revisionId}\u0000${endMs}`).digest('hex');
    return `${cacheDir}/${key}.json`;
}

// --- The run ------------------------------------------------------------------------

export async function runFollowup(options, {
    fetchImpl = fetch,
    sleep = defaultSleep,
    now = () => Date.now(),
    readFile = fsReadFile,
    writeFile = fsWriteFile,
    mkdir = fsMkdir,
    log = message => process.stderr.write(`${message}\n`),
    streamRows = streamCsvRows,
} = {}) {
    const rows = await readChecks(options.input, { readFile, streamRows });
    const { runs: allRuns, skipped } = groupRuns(rows, {
        wiki: options.wiki, sinceMs: options.sinceMs, untilMs: options.untilMs,
    });
    const runs = options.maxRuns !== null && options.maxRuns !== undefined ? allRuns.slice(0, options.maxRuns) : allRuns;
    log(`${rows.length} rows -> ${allRuns.length} runs on ${options.wiki}; analyzing ${runs.length}`);

    if (options.cacheDir) await mkdir(options.cacheDir, { recursive: true });
    const api = { fetchImpl, userAgent: options.userAgent, sleep, delayMs: options.delayMs ?? 0 };
    const botCache = new Map();
    const maxWindowMs = Math.max(...options.windowsHours) * HOUR_MS;
    const results = [];
    let apiFailures = 0;
    let truncatedRuns = 0;
    const empty = status => ({ status, citations: [], editsByWindow: {} });

    const closed = runs.filter(run => run.lastCheckMs + maxWindowMs <= now());
    let pages;
    try {
        pages = await resolveRevisionPages(options.wiki, closed.map(r => r.revisionId), api);
    } catch (err) {
        log(`resolving checked revisions failed: ${err.message}`);
        throw err;
    }

    for (const [index, run] of runs.entries()) {
        const endMs = run.lastCheckMs + maxWindowMs;
        if (endMs > now()) {
            results.push({ run, result: empty('window_open') });
            continue;
        }
        const page = pages.get(run.revisionId);
        if (!page) {
            results.push({ run, result: empty('page_missing') });
            continue;
        }
        if (page.ns !== 0 && !options.allNamespaces) {
            results.push({ run, result: empty('not_an_article') });
            continue;
        }
        let fetched = null;
        const path = options.cacheDir ? cachePath(options.cacheDir, run, endMs) : null;
        if (path) {
            try { fetched = JSON.parse(await readFile(path, 'utf8')); } catch { fetched = null; }
        }
        if (!fetched) {
            try {
                fetched = await fetchRevisions({
                    host: options.wiki, pageId: page.pageId, startRevid: run.revisionId, endMs,
                    maxRevisions: options.maxRevisions ?? 200, ...api,
                });
                await lookUpBots(options.wiki, fetched.revisions.map(r => r.user), botCache, api);
                fetched.bots = fetched.revisions.map(r => r.user).filter(u => botCache.get(u));
                if (path) await writeFile(path, JSON.stringify(fetched));
            } catch (err) {
                apiFailures++;
                log(`  ${run.title} @${run.revisionId}: ${err.message}`);
                results.push({ run, result: empty('api_error') });
                continue;
            }
            if (api.delayMs) await sleep(api.delayMs);
        }
        if (fetched.truncated) truncatedRuns++;

        let result;
        if (fetched.status !== 'ok') {
            result = empty('page_missing');
        } else {
            const bots = new Set(fetched.bots ?? []);
            result = analyzeRun(run, fetched.revisions, {
                windowsHours: options.windowsHours,
                isBot: user => bots.has(user),
                excludedEditors: options.excludedEditors ?? [],
            });
        }
        // The page's current title, namespace included, rather than Neon's.
        results.push({ run: { ...run, title: page.title }, result });
        if ((index + 1) % 25 === 0) log(`  ${index + 1}/${runs.length} runs`);
    }

    const summary = summarize(results.map(r => r.result), { windowsHours: options.windowsHours });
    const notes = [];
    if (options.excludedEditors?.length) notes.push(`Runs where ${options.excludedEditors.join(', ')} edited after the check are excluded.`);
    if (truncatedRuns) notes.push(`${truncatedRuns} busy runs hit --max-revisions; their longest windows may be undercounted.`);
    if (summary.runs.byStatus.window_open) notes.push(`${summary.runs.byStatus.window_open} runs are too recent for the longest window and were skipped.`);
    notes.push('Edits made without changing the source URL, a tag, or the text right before the ref are not seen, so these are lower bounds.');
    notes.push('Neon stores no user, so who ran a check is unknown; the Supported baseline is what separates the tool\'s effect from ordinary editing.');

    const markdown = renderMarkdown(summary, { skipped, notes });
    await writeFile(`${options.out}.md`, markdown);
    await writeFile(`${options.out}.json`, JSON.stringify({ options: { ...options, userAgent: undefined }, skipped, notes, summary }, null, 2));
    await writeFile(`${options.out}-citations.csv`, citationsToCsv(results));

    const attempted = results.filter(r => r.result.status !== 'window_open').length;
    return { summary, markdown, apiFailures, allFailed: attempted > 0 && apiFailures === attempted };
}

async function main(argv) {
    let options;
    try {
        options = parseCliArgs(argv);
    } catch (err) {
        process.stderr.write(`${err.message}\n\n${HELP_TEXT}`);
        return 2;
    }
    if (options.help) {
        process.stdout.write(HELP_TEXT);
        return 0;
    }
    try {
        const { markdown, allFailed } = await runFollowup(options);
        process.stdout.write(`${markdown}\n`);
        process.stderr.write(`wrote ${options.out}.md, ${options.out}.json, ${options.out}-citations.csv\n`);
        return allFailed ? 1 : 0;
    } catch (err) {
        process.stderr.write(`${err.stack || err.message}\n`);
        return 2;
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
