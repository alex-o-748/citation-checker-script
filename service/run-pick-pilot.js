#!/usr/bin/env node
// Runnable entry point: builds the 100-article pilot mix described in
// service/pilot-selection.js's header — most-edited articles, biased toward
// {{current}} and {{failed verification}} tags, biased against sources the
// sweep can't fetch — and writes a --titles-file for service/run-sweep.js.
//
// Two stages, matching service/pilot-selection.js's split:
//   1. Wiki Replicas: top-edited base population + the two tag membership
//      sets. Cheap — three bounded queries.
//   2. Wikipedia REST + citation extraction, but only for the shortlist that
//      stage 1 already ranked well: this is the expensive part (one fetch
//      per candidate), so it never runs against the whole base population.
//
// Usage (on a Toolforge bastion, or any host with real Wikipedia egress —
// see run-sweep.js's --live-source-fetch comment for why that's not every
// environment):
//   node service/run-pick-pilot.js --out service/article-lists/pilot-100.txt
//   node service/run-pick-pilot.js --max 100 --base-pool 1500 --shortlist-size 300 \
//       --out pilot-100.txt --json-out pilot-100-scores.json
//
// Then run the sweep against the result:
//   node service/run-sweep.js --titles-file service/article-lists/pilot-100.txt \
//       --live-source-fetch --max 100 --out pilot-100-findings.csv

import { JSDOM } from 'jsdom';
import { parseArgs } from 'node:util';
import { writeFile as fsWriteFile } from 'node:fs/promises';

import { openReplicaConnection, makeQueryFn } from './replicas.js';
import { selectCandidates, selectTopEdited } from './article-picker.js';
import { collectCitations } from '../core/citations.js';
import { fetchArticleHtml } from '../core/wikipedia.js';
import {
    mergeSignals,
    shortlist,
    finalizeRanking,
    computeOfflineRatio,
    DEFAULT_WEIGHTS,
    DEFAULT_OFFLINE_RATIO_CEILING,
} from './pilot-selection.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function parseCliArgs(argv) {
    const { values } = parseArgs({
        args: argv.slice(2),
        options: {
            wiki:                { type: 'string', default: 'enwiki' },
            'edit-window-days':  { type: 'string', default: '14' },
            'base-pool':         { type: 'string', default: '1000' },
            'shortlist-size':    { type: 'string', default: '300' },
            max:                 { type: 'string', default: '100' },
            'offline-ratio-max': { type: 'string', default: String(DEFAULT_OFFLINE_RATIO_CEILING) },
            out:                 { type: 'string', default: 'pilot-100.txt' },
            'json-out':          { type: 'string' },
            help:                { type: 'boolean', short: 'h', default: false },
        },
        strict: true,
    });

    return {
        help: values.help,
        wiki: values.wiki,
        editWindowDays: Number(values['edit-window-days']),
        basePool: Number(values['base-pool']),
        shortlistSize: Number(values['shortlist-size']),
        max: Number(values.max),
        offlineRatioMax: Number(values['offline-ratio-max']),
        out: values.out,
        jsonOut: values['json-out'],
    };
}

export const HELP_TEXT = `usage: node service/run-pick-pilot.js [options]

Builds a --titles-file for service/run-sweep.js: the most-edited articles in
a recent window, biased toward {{current}} and {{failed verification}}, and
away from articles whose citations are mostly unfetchable. See
service/pilot-selection.js for the scoring, and service/article-picker.js's
'current-event' criterion and selectTopEdited() for the underlying queries.

Options:
  --wiki <db>               Wiki database name (default: enwiki)
  --edit-window-days <n>    Edit-count window in days (default: 14)
  --base-pool <n>           Top-edited articles to pull before scoring (default: 1000)
  --shortlist-size <n>      How many of those to fetch + extract citations for
                             in stage 2 (default: 300) — the expensive step, so
                             kept well below --base-pool
  --max <n>                 Final pilot size (default: 100)
  --offline-ratio-max <f>   Exclude articles whose citations are unfetchable
                             above this fraction, 0..1 (default: ${DEFAULT_OFFLINE_RATIO_CEILING})
  --out <path>              Titles-file output path (default: pilot-100.txt)
  --json-out <path>         Also write the full per-article score breakdown as JSON
  --help, -h                Show this help and exit.
`;

function validate(opts, stderr) {
    const checks = [
        ['editWindowDays', opts.editWindowDays > 0],
        ['basePool', Number.isInteger(opts.basePool) && opts.basePool >= 1 && opts.basePool <= 5000],
        ['shortlistSize', Number.isInteger(opts.shortlistSize) && opts.shortlistSize >= 1],
        ['max', Number.isInteger(opts.max) && opts.max >= 1],
        ['offlineRatioMax', opts.offlineRatioMax >= 0 && opts.offlineRatioMax <= 1],
    ];
    for (const [name, ok] of checks) {
        if (!ok) {
            stderr.write(`pick-pilot: invalid --${name.replace(/[A-Z]/g, m => '-' + m.toLowerCase())} (got: ${opts[name]})\n`);
            return false;
        }
    }
    return true;
}

function toIdSet(rows) {
    return new Set(rows.map(r => r.pageId));
}

// Same rendering as service/article-lists/nigerian-actors.txt's header —
// documented provenance and the command to run it, not just a bare list.
function renderTitlesFile(ranked, opts, generatedAt) {
    const header = [
        `# Pilot mix: top ${ranked.length} of up to ${opts.max} candidates, generated ${generatedAt}`,
        `# wiki=${opts.wiki} edit-window-days=${opts.editWindowDays} base-pool=${opts.basePool} `
            + `shortlist-size=${opts.shortlistSize} offline-ratio-max=${opts.offlineRatioMax}`,
        `# Biased toward {{current}} (current events) and {{failed verification}} (a disputed`,
        `# citation already flagged by an editor), biased against articles whose citations are`,
        `# mostly unfetchable. See service/pilot-selection.js and service/run-pick-pilot.js.`,
        `#`,
        `# node service/run-sweep.js --titles-file <this file> --live-source-fetch \\`,
        `#     --max ${ranked.length} --out pilot-findings.csv`,
        '',
    ].join('\n');
    return header + ranked.map(c => c.title).join('\n') + '\n';
}

export async function runPickPilot(opts, {
    stdout = process.stdout,
    stderr = process.stderr,
    connectReplicas = openReplicaConnection,
    fetchArticle = fetchArticleHtml,
    parseHtml = html => JSDOM.fragment(html),
    writeFile = fsWriteFile,
    now = () => new Date(),
} = {}) {
    if (!validate(opts, stderr)) return 2;

    let connection;
    try {
        connection = await connectReplicas({ wikiDb: opts.wiki });
    } catch (error) {
        stderr.write(`pick-pilot: could not connect to Wiki Replicas: ${error.message}\n`);
        return 1;
    }

    let ranked;
    try {
        const query = makeQueryFn(connection);
        const sinceDate = new Date(now().getTime() - opts.editWindowDays * MS_PER_DAY);

        const [currentEventRows, failedVerificationRows, topEdited] = await Promise.all([
            selectCandidates(query, { criterion: 'current-event', max: 5000 }),
            selectCandidates(query, { criterion: 'failed-verification', max: 5000 }),
            selectTopEdited(query, { sinceDate, limit: opts.basePool }),
        ]);
        stderr.write(
            `pick-pilot: base pool ${topEdited.length} article(s), `
            + `${currentEventRows.length} tagged {{current}}, `
            + `${failedVerificationRows.length} tagged {{failed verification}}\n`
        );

        const merged = mergeSignals(topEdited, {
            currentEventIds: toIdSet(currentEventRows),
            failedVerificationIds: toIdSet(failedVerificationRows),
        });
        const short = shortlist(merged, { size: opts.shortlistSize, weights: DEFAULT_WEIGHTS });
        stderr.write(`pick-pilot: fetching citations for ${short.length} shortlisted article(s)...\n`);

        let fetchFailures = 0;
        for (const candidate of short) {
            const { html } = await fetchArticle({ title: candidate.title, revisionId: candidate.revisionId });
            if (!html) {
                fetchFailures++;
                candidate.citationCount = 0;
                candidate.offlineRatio = null;
                continue;
            }
            const citations = collectCitations(parseHtml(html));
            candidate.citationCount = citations.length;
            candidate.offlineRatio = computeOfflineRatio(citations);
        }
        if (fetchFailures > 0) {
            stderr.write(`pick-pilot: ${fetchFailures} shortlisted article(s) failed to fetch and were dropped\n`);
        }

        ranked = finalizeRanking(short, {
            limit: opts.max,
            offlineRatioCeiling: opts.offlineRatioMax,
            weights: DEFAULT_WEIGHTS,
        });
    } catch (error) {
        stderr.write(`pick-pilot: ${error.message}\n`);
        return 1;
    } finally {
        await connection.end();
    }

    const generatedAt = now().toISOString();
    await writeFile(opts.out, renderTitlesFile(ranked, opts, generatedAt), 'utf8');
    if (opts.jsonOut) {
        await writeFile(opts.jsonOut, JSON.stringify(ranked, null, 2) + '\n', 'utf8');
    }

    const tierCounts = ranked.reduce((acc, c) => {
        acc[c.tier] = (acc[c.tier] || 0) + 1;
        return acc;
    }, {});
    stdout.write(
        `selected ${ranked.length} article(s) -> ${opts.out} `
        + `(${Object.entries(tierCounts).map(([t, n]) => `${t}: ${n}`).join(', ')})\n`
    );
    return 0;
}

export async function main(argv) {
    const opts = parseCliArgs(argv);
    if (opts.help) {
        process.stdout.write(HELP_TEXT);
        return 0;
    }
    return runPickPilot(opts);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main(process.argv).then(code => process.exit(code));
}
