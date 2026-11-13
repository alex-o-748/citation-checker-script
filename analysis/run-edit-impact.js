#!/usr/bin/env node
// Did editors act on Source Verification suggestions without pressing the
// button? Measured from page histories. Method and limits: analysis/README.md.
//
// Usage (Toolforge, all of enwiki — metadata from the Wiki Replicas, text from the API):
//   node analysis/run-edit-impact.js --wiki enwiki --batches ~/batch-export --source replicas --out ~/edit-impact
// A handful of pages, from anywhere with API access:
//   node analysis/run-edit-impact.js --wiki enwiki --batches ./batches --source api \
//       --titles "Beef clod|OpenAI" --out ./edit-impact
//
// Output, in <out>/<wiki>/:
//   suggestions.csv  one row per flagged or supported claim
//   revisions.csv    every revision after go-live on those pages
//   summary.md/.json the per-wiki summary
//   sample.md/.csv   ~30 random flagged claims that changed, for a person to judge
//   pages.md         with --titles only: every revision and changed claim, page by page
//   pages.jsonl      per-page results as they complete; a re-run resumes from it
//   run.json         the parameters, so a resume can't silently mix windows

import { parseArgs } from 'node:util';
import { mkdir, readFile, writeFile, appendFile, rm } from 'node:fs/promises';
import { existsSync, createReadStream, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadManifest, loadSuggestions } from './lib/batches.js';
import {
    createApiClient, listRevisions, baselineRevision, revisionTexts, botUsers, pageIdsForTitles, DEFAULT_USER_AGENT,
} from './lib/mwapi.js';
import { listRevisionsReplicas, baselineIdsReplicas } from './lib/replicas.js';
import { makeTarget, prepareRevision, trackSuggestion } from './lib/track.js';
import {
    suggestionRecord, revisionRecord, summarize, summaryMarkdown, sampleChanged, sampleMarkdown, pagesMarkdown, toCsv, csvLine,
    SUGGESTION_COLUMNS, REVISION_COLUMNS, SAMPLE_COLUMNS,
} from './lib/report.js';

export const HELP = `usage: node analysis/run-edit-impact.js --wiki <db> --batches <dir> [options]

  --wiki <db>          enwiki or ruwiki (must appear in analysis/batches.json)
  --batches <dir>      folder holding the batch files (.csv or .csv.gz, as on the
                       data/batches branch)
  --source <name>      replicas (Toolforge; revision metadata from the Wiki
                       Replicas) or api (default; everything from api.php)
  --titles <a|b|…>     only these pages. Titles with no suggestion are still
                       listed in revisions.csv (and reported), for validation
  --until <iso>        end of the window (default: now, fixed at the first run)
  --delay-ms <n>       minimum gap between API requests (default 1000)
  --contact <text>     appended to the User-Agent, e.g. a wiki username
  --sample <n>         size of the review sample (default 30)
  --seed <n>           sample seed (default 1)
  --out <dir>          output folder (default ./edit-impact)
  --fresh              discard a previous run's pages.jsonl instead of resuming
`;

export function parseCli(argv) {
    const { values } = parseArgs({
        args: argv.slice(2),
        options: {
            wiki: { type: 'string' }, batches: { type: 'string' }, source: { type: 'string', default: 'api' },
            titles: { type: 'string' }, until: { type: 'string' }, 'delay-ms': { type: 'string', default: '1000' },
            contact: { type: 'string' }, sample: { type: 'string', default: '30' }, seed: { type: 'string', default: '1' },
            out: { type: 'string', default: 'edit-impact' }, fresh: { type: 'boolean', default: false },
            help: { type: 'boolean', short: 'h', default: false },
        },
        strict: true,
    });
    return {
        help: values.help,
        wiki: values.wiki,
        batches: values.batches,
        source: values.source,
        titles: values.titles ? values.titles.split('|').map(t => t.trim()).filter(Boolean) : null,
        until: values.until ?? null,
        delayMs: Number(values['delay-ms']),
        contact: values.contact ?? null,
        sample: Number(values.sample),
        seed: Number(values.seed),
        out: values.out,
        fresh: values.fresh,
    };
}

const secondsBefore = (iso, s) => new Date(Date.parse(iso) - s * 1000).toISOString().replace('.000Z', 'Z');

/**
 * One page: baseline text, later revisions with text, every suggestion
 * tracked across them. `source` hides where metadata and text come from.
 */
export async function analyzePage({ wiki, pageId, pageTitle, suggestions, window, source }) {
    const baseline = await source.baseline(pageId, secondsBefore(window.from, 1));
    const metas = await source.revisions(pageId, window);
    if (!baseline || baseline.text === null) {
        return {
            page_id: pageId,
            page_title: pageTitle,
            error: baseline ? 'baseline text unavailable' : 'page or baseline revision not found',
            revisions: metas.map(m => revisionRecord(m, { wiki, pageTitle })),
            suggestions: suggestions.map(s => suggestionRecord(s, { located: null, first: null, end: null, skipped: 0 },
                { baselineRevId: baseline?.meta?.rev_id ?? '', revisions: metas, wiki })),
        };
    }

    // One fetch per distinct text: a revert restores an earlier sha1 exactly.
    const bySha = new Map();
    const toFetch = [];
    for (const m of metas) {
        if (m.text_hidden) continue;
        if (m.sha1 && bySha.has(m.sha1)) continue;
        if (m.sha1) bySha.set(m.sha1, m.rev_id);
        toFetch.push(m.rev_id);
    }
    const sizes = new Map(metas.map(m => [m.rev_id, m.size ?? 0]));
    const texts = toFetch.length ? await source.texts(toFetch, sizes) : new Map();
    const prepared = new Map();
    const revFor = m => {
        if (m.text_hidden) return null;
        const id = m.sha1 && bySha.has(m.sha1) ? bySha.get(m.sha1) : m.rev_id;
        if (!prepared.has(id)) {
            const text = texts.get(id);
            prepared.set(id, text === null || text === undefined ? null : prepareRevision(text, wiki));
        }
        return prepared.get(id);
    };
    const baseRev = prepareRevision(baseline.text, wiki);
    const sequence = metas.map(meta => ({ meta, rev: revFor(meta) }));

    const firstChanges = new Map();
    const suggestionRows = suggestions.map(s => {
        const result = trackSuggestion(makeTarget(s), baseRev, sequence);
        if (result.first) {
            const counts = firstChanges.get(result.first.meta.rev_id) ?? { flagged: 0, supported: 0 };
            counts[s.group]++;
            firstChanges.set(result.first.meta.rev_id, counts);
        }
        return suggestionRecord(s, result, { baselineRevId: baseline.meta.rev_id, revisions: metas, wiki });
    });
    return {
        page_id: pageId,
        page_title: pageTitle,
        baseline_revision_id: baseline.meta.rev_id,
        revisions: metas.map(m => revisionRecord(m, { wiki, pageTitle, firstChanges: firstChanges.get(m.rev_id) })),
        suggestions: suggestionRows,
    };
}

function apiSource(client, log) {
    const botCache = new Map();
    return {
        async baseline(pageId, at) { return baselineRevision(client, pageId, at); },
        async revisions(pageId, window) {
            const metas = await listRevisions(client, pageId, window);
            const unknown = [...new Set(metas.filter(m => m.user && !m.anon && !m.temp).map(m => m.user))]
                .filter(u => !botCache.has(u));
            if (unknown.length) {
                const bots = await botUsers(client, unknown);
                for (const u of unknown) botCache.set(u, bots.has(u));
            }
            for (const m of metas) m.is_bot = Boolean(m.user && botCache.get(m.user));
            return metas;
        },
        async texts(ids, sizes) { return revisionTexts(client, ids, { sizes }); },
        log,
    };
}

async function replicasSource(client, pageIds, window, log) {
    const { openReplicaConnection, makeQueryFn } = await import('../service/replicas.js');
    const connection = await openReplicaConnection({ wikiDb: window.wiki });
    try {
        const query = makeQueryFn(connection);
        log(`replicas: revision metadata for ${pageIds.length} pages`);
        const byPage = await listRevisionsReplicas(query, pageIds, window);
        const baselines = await baselineIdsReplicas(query, pageIds, secondsBefore(window.from, 1));
        return {
            async baseline(pageId) {
                const id = baselines.get(pageId);
                if (!id) return null;
                const texts = await revisionTexts(client, [id]);
                return { meta: { rev_id: id }, text: texts.get(id) ?? null };
            },
            async revisions(pageId) { return byPage.get(pageId) ?? []; },
            async texts(ids, sizes) { return revisionTexts(client, ids, { sizes }); },
        };
    } finally {
        await connection.end();
    }
}

/** Calls `fn` for each page result in pages.jsonl, one line at a time. */
async function eachJsonl(path, fn) {
    if (!existsSync(path)) return;
    const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of lines) if (line) fn(JSON.parse(line));
}

async function write(stream, text) {
    if (!stream.write(text)) await once(stream, 'drain');
}

// What summarize() reads from each row. The full rows go straight to the CSVs;
// holding ~60,000 of them, with their prose, is what made a 512 MB Toolforge
// job run out of memory.
const SUMMARY_SUGGESTION_FIELDS = ['group', 'located', 'changed', 'revisions_after', 'first_change_kinds', 'first_change_is_bot',
    'first_change_reverted', 'first_change_seen', 'first_change_used', 'changed_at_end', 'check_id'];
const SUMMARY_REVISION_FIELDS = ['page_id', 'page_title', 'is_bot', 'seen', 'used', 'mw_reverted', 'visualeditor'];
const pick = (row, fields) => Object.fromEntries(fields.map(f => [f, row[f]]));

export async function main(argv = process.argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
    const opts = parseCli(argv);
    if (opts.help) { stdout.write(HELP); return 0; }
    if (!opts.wiki || !opts.batches) { stderr.write(HELP); return 2; }
    if (!['api', 'replicas'].includes(opts.source)) { stderr.write(`--source must be api or replicas\n`); return 2; }
    const log = msg => stderr.write(`${msg}\n`);

    const manifest = await loadManifest();
    const { suggestions, batches, missing } = await loadSuggestions({ dir: opts.batches, wiki: opts.wiki, titles: opts.titles, manifest });
    if (missing.length) log(`warning: no file in ${opts.batches} for batch(es): ${missing.join(', ')} — they are left out`);
    if (!batches.length) { log(`no ${opts.wiki} batch files found in ${opts.batches}`); return 1; }

    const outDir = join(opts.out, opts.wiki);
    await mkdir(outDir, { recursive: true });
    const jsonlPath = join(outDir, 'pages.jsonl');
    const runPath = join(outDir, 'run.json');
    if (opts.fresh) { await rm(jsonlPath, { force: true }); await rm(runPath, { force: true }); }

    const from = batches.map(b => b.live_from).sort()[0];
    const untilCandidates = [opts.until, ...batches.map(b => b.live_until)].filter(Boolean).sort();
    let run = {
        wiki: opts.wiki, from, until: untilCandidates[0] ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        batches: batches.map(b => b.batch_id), titles: opts.titles, source: opts.source,
    };
    if (existsSync(runPath)) {
        const previous = JSON.parse(await readFile(runPath, 'utf8'));
        const same = ['wiki', 'from', 'batches', 'titles'].every(k => JSON.stringify(previous[k]) === JSON.stringify(run[k]))
            && (!opts.until || previous.until === run.until);
        if (!same) { log(`${runPath} is from a different run; pass --fresh to start over`); return 2; }
        run = { ...run, until: previous.until };
        log(`resuming the run started for window ${run.from} → ${run.until}`);
    }
    await writeFile(runPath, `${JSON.stringify(run, null, 2)}\n`);
    const window = { wiki: opts.wiki, from: run.from, until: run.until };

    const userAgent = opts.contact ? `${DEFAULT_USER_AGENT} ${opts.contact}` : DEFAULT_USER_AGENT;
    const client = createApiClient({ wiki: opts.wiki, userAgent, minIntervalMs: opts.delayMs, log });

    // Pages with suggestions, plus requested titles that have none.
    const pages = new Map();
    for (const s of suggestions) {
        if (!pages.has(s.page_id)) pages.set(s.page_id, { title: s.page_title, suggestions: [] });
        pages.get(s.page_id).suggestions.push(s);
    }
    const unbatched = opts.titles ? opts.titles.filter(t => ![...pages.values()].some(p => p.title === t)) : [];
    if (unbatched.length) {
        log(`not in any ${opts.wiki} batch (no Source Verification suggestion): ${unbatched.join('; ')}`);
        const ids = await pageIdsForTitles(client, unbatched);
        for (const [title, id] of ids) if (!pages.has(id)) pages.set(id, { title, suggestions: [] });
    }

    const done = new Set();
    await eachJsonl(jsonlPath, p => done.add(p.page_id));
    const pageIds = [...pages.keys()];
    const source = opts.source === 'replicas'
        ? await replicasSource(client, pageIds.filter(id => !done.has(id)), window, log)
        : apiSource(client, log);

    let n = done.size;
    for (const pageId of pageIds) {
        if (done.has(pageId)) continue;
        const page = pages.get(pageId);
        const result = await analyzePage({ wiki: opts.wiki, pageId, pageTitle: page.title, suggestions: page.suggestions, window, source });
        await appendFile(jsonlPath, `${JSON.stringify(result)}\n`);
        n++;
        log(`[${n}/${pageIds.length}] ${page.title}: ${result.revisions.length} revisions, ${result.suggestions.length} claims`
            + `${result.error ? ` (${result.error})` : ''} — ${client.requests} API requests so far`);
    }

    // Output: stream pages.jsonl once, writing the CSVs as it goes and keeping
    // only what the summary, the sample and (for --titles) pages.md need.
    const suggestionsCsv = createWriteStream(join(outDir, 'suggestions.csv'));
    const revisionsCsv = createWriteStream(join(outDir, 'revisions.csv'));
    await write(suggestionsCsv, toCsv(SUGGESTION_COLUMNS, []));
    await write(revisionsCsv, toCsv(REVISION_COLUMNS, []));
    const slimSuggestions = [];
    const slimRevisions = [];
    const changedFlagged = [];
    const pageErrors = [];
    const fullResults = [];
    let suggestionCount = 0;
    let revisionCount = 0;
    const lines = createInterface({ input: createReadStream(jsonlPath, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of lines) {
        if (!line) continue;
        const result = JSON.parse(line);
        const measured = Boolean(pages.get(Number(result.page_id))?.suggestions.length);
        for (const row of result.suggestions) {
            await write(suggestionsCsv, csvLine(SUGGESTION_COLUMNS, row));
            slimSuggestions.push(pick(row, SUMMARY_SUGGESTION_FIELDS));
            if (row.group === 'flagged' && Number(row.changed) === 1) changedFlagged.push(row);
        }
        for (const row of result.revisions) {
            await write(revisionsCsv, csvLine(REVISION_COLUMNS, row));
            if (measured) slimRevisions.push(pick(row, SUMMARY_REVISION_FIELDS));
        }
        suggestionCount += result.suggestions.length;
        revisionCount += result.revisions.length;
        if (result.error) pageErrors.push({ page_title: result.page_title, error: result.error });
        if (opts.titles) fullResults.push(result);
    }
    suggestionsCsv.end();
    revisionsCsv.end();
    await Promise.all([once(suggestionsCsv, 'finish'), once(revisionsCsv, 'finish')]);

    const summary = summarize({
        wiki: opts.wiki, window, suggestions: slimSuggestions,
        revisions: slimRevisions,
        pagesWithSuggestions: [...pages.values()].filter(p => p.suggestions.length).length,
    });
    summary.unbatched_titles = unbatched;
    summary.page_errors = pageErrors;
    let md = summaryMarkdown(summary);
    if (unbatched.length) md += `\nRequested but carrying no Source Verification suggestion (revisions listed, nothing to measure): ${unbatched.join('; ')}.\n`;
    if (summary.page_errors.length) md += `\nPages that could not be measured: ${summary.page_errors.map(e => `${e.page_title} (${e.error})`).join('; ')}.\n`;
    await writeFile(join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    await writeFile(join(outDir, 'summary.md'), md);

    const sample = sampleChanged(changedFlagged, { size: opts.sample, seed: opts.seed });
    await writeFile(join(outDir, 'sample.md'), sampleMarkdown(opts.wiki, sample, { seed: opts.seed, poolSize: changedFlagged.length }));
    await writeFile(join(outDir, 'sample.csv'), toCsv(SAMPLE_COLUMNS, sample.map(r => ({ ...r, addressed_flag: '', reviewer_notes: '' }))));

    stdout.write(md);
    if (opts.titles) {
        const pagesMd = pagesMarkdown(opts.wiki, fullResults);
        await writeFile(join(outDir, 'pages.md'), pagesMd);
        stdout.write(`\n${pagesMd}`);
    }
    log(`wrote ${outDir}/ (${suggestionCount} claims, ${revisionCount} revisions, ${client.requests} API requests)`);
    return 0;
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
    process.exitCode = await main();
}
