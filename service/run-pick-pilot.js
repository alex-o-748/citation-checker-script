#!/usr/bin/env node
// Runnable entry point: builds the 100-article pilot mix described in
// service/pilot-selection.js's header — most-edited articles, biased toward
// current events (recency + edit burst, with the {{current}} tag as a bonus)
// and toward {{failed verification}}, biased against articles whose sources
// the sweep can't fetch — and writes a --titles-file for service/run-sweep.js.
//
// Two stages, matching service/pilot-selection.js's split:
//   1. Wiki Replicas: top-edited base population (with a burst count), then
//      creation dates and tag membership for exactly those page ids. Cheap —
//      three bounded queries, none of them enumerating a whole population.
//   2. Wikipedia REST + citation extraction, walking stage 1's ranking in
//      order and stopping as soon as --max articles have survived the
//      offline-source filter. That early stop is what keeps this affordable:
//      checking the whole shortlist costs roughly twice the fetches for a
//      ranking that differs only in the margins (--scan-all disables it).
//
// MEMORY. Each article's Parsoid HTML can be several MB and every one of them
// is parsed into a DOM. JSDOM.fragment() (not new JSDOM(), see CLAUDE.md)
// keeps that flat rather than leaking a Window per article, but peak usage is
// still one large document at a time, and a Toolforge *bastion* shell is a
// shared login host with a tight cgroup limit — a run of a few hundred
// articles there gets OOMKilled. Run it as a job with its own allocation:
//
//   toolforge jobs run pick-pilot --command "node service/run-pick-pilot.js \
//       --out service/article-lists/pilot-100.txt --json-out pilot-100-scores.json" \
//       --image node18 --mem 2Gi --wait
//
// Usage (bastion is fine for a small --max/--shortlist-size; use a job otherwise):
//   node service/run-pick-pilot.js --out service/article-lists/pilot-100.txt
//   node service/run-pick-pilot.js --max 100 --base-pool 1500 --shortlist-size 400 \
//       --out pilot-100.txt --json-out pilot-100-scores.json
//
// Then run the sweep against the result:
//   node service/run-sweep.js --titles-file service/article-lists/pilot-100.txt \
//       --live-source-fetch --max 100 --out pilot-100-findings.csv

import { JSDOM } from 'jsdom';
import { parseArgs } from 'node:util';
import { writeFile as fsWriteFile } from 'node:fs/promises';

import { openReplicaConnection, makeQueryFn } from './replicas.js';
import {
    selectTopEdited,
    selectTagMembership,
    selectCreationDates,
    CURRENT_EVENT_TEMPLATES,
    resolveCriterion,
} from './article-picker.js';
import { collectCitations } from '../core/citations.js';
import { fetchArticleHtml } from '../core/wikipedia.js';
import {
    mergeSignals,
    shortlist,
    finalizeRanking,
    passesContentFilter,
    computeOfflineRatio,
    computeTableRatio,
    splitFlaggedPool,
    flaggedQuotaFor,
    tierOf,
    DEFAULT_FLAGGED_QUOTA_SHARE,
    DEFAULT_WEIGHTS,
    DEFAULT_THRESHOLDS,
    DEFAULT_OFFLINE_RATIO_CEILING,
    DEFAULT_TABLE_RATIO_CEILING,
} from './pilot-selection.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function parseCliArgs(argv) {
    const { values } = parseArgs({
        args: argv.slice(2),
        options: {
            wiki:                { type: 'string', default: 'enwiki' },
            'edit-window-days':  { type: 'string', default: '14' },
            'burst-window-days': { type: 'string', default: '3' },
            'base-pool':         { type: 'string', default: '1000' },
            'shortlist-size':    { type: 'string', default: '300' },
            max:                 { type: 'string', default: '100' },
            'offline-ratio-max': { type: 'string', default: String(DEFAULT_OFFLINE_RATIO_CEILING) },
            'table-ratio-max':   { type: 'string', default: String(DEFAULT_TABLE_RATIO_CEILING) },
            'flagged-share':     { type: 'string', default: String(DEFAULT_FLAGGED_QUOTA_SHARE) },
            'scan-all':          { type: 'boolean', default: false },
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
        burstWindowDays: Number(values['burst-window-days']),
        basePool: Number(values['base-pool']),
        shortlistSize: Number(values['shortlist-size']),
        max: Number(values.max),
        offlineRatioMax: Number(values['offline-ratio-max']),
        tableRatioMax: Number(values['table-ratio-max']),
        flaggedShare: Number(values['flagged-share']),
        scanAll: values['scan-all'],
        out: values.out,
        jsonOut: values['json-out'],
    };
}

export const HELP_TEXT = `usage: node service/run-pick-pilot.js [options]

Builds a --titles-file for service/run-sweep.js: the most-edited articles in
a recent window, biased toward current events (recently created, or edits
concentrated in a burst, or carrying {{current}}) and toward
{{failed verification}}, and away from articles whose citations are mostly
unfetchable. See service/pilot-selection.js for the scoring.

Options:
  --wiki <db>               Wiki database name (default: enwiki)
  --edit-window-days <n>    Edit-count window in days (default: 14)
  --burst-window-days <n>   Short window whose share of those edits marks an
                             article as a burst, i.e. breaking rather than
                             perennially busy (default: 3)
  --base-pool <n>           Top-edited articles to pull before scoring (default: 1000)
  --shortlist-size <n>      Upper bound on stage-2 candidates — the fetch +
                             citation-extraction step (default: 300). The run
                             normally stops well before this, once --max
                             articles have survived the offline filter.
  --max <n>                 Final pilot size (default: 100)
  --offline-ratio-max <f>   Exclude articles whose citations are unfetchable
                             above this fraction, 0..1 (default: ${DEFAULT_OFFLINE_RATIO_CEILING})
  --table-ratio-max <f>     Exclude articles with more than this fraction of
                             their citations inside a <table>, 0..1
                             (default: ${DEFAULT_TABLE_RATIO_CEILING}). Tournament draws, episode
                             lists and medal tables score at the very top of
                             the current-events ranking and are worthless to
                             verify: the claim behind a bracket citation is a
                             score line, not an assertion.
  --flagged-share <f>       Share of the pilot reserved for articles carrying
                             {{failed verification}}, 0..1 (default: ${DEFAULT_FLAGGED_QUOTA_SHARE}).
                             A floor, not a partition: those articles still
                             compete for the remaining slots on score, and an
                             unfillable reserve leaves its slots to the general
                             ranking. Without it the much larger current-events
                             population crowds them out entirely.
  --scan-all                Fetch the entire shortlist instead of stopping at
                             --max survivors. Ranks more exactly, costs roughly
                             twice the fetches.
  --out <path>              Titles-file output path (default: pilot-100.txt)
  --json-out <path>         Also write the full per-article score breakdown as JSON
  --help, -h                Show this help and exit.

On Toolforge, run this as a job rather than on a bastion shell — a few hundred
article fetches will exceed a bastion's memory limit:
  toolforge jobs run pick-pilot --image node18 --mem 2Gi --wait \\
      --command "node service/run-pick-pilot.js --out pilot-100.txt"
`;

function validate(opts, stderr) {
    const checks = [
        ['edit-window-days', opts.editWindowDays > 0],
        ['burst-window-days', opts.burstWindowDays > 0 && opts.burstWindowDays <= opts.editWindowDays],
        ['base-pool', Number.isInteger(opts.basePool) && opts.basePool >= 1 && opts.basePool <= 5000],
        ['shortlist-size', Number.isInteger(opts.shortlistSize) && opts.shortlistSize >= 1],
        ['max', Number.isInteger(opts.max) && opts.max >= 1],
        ['offline-ratio-max', opts.offlineRatioMax >= 0 && opts.offlineRatioMax <= 1],
        ['table-ratio-max', opts.tableRatioMax >= 0 && opts.tableRatioMax <= 1],
        ['flagged-share', opts.flaggedShare >= 0 && opts.flaggedShare <= 1],
    ];
    for (const [flag, ok] of checks) {
        if (!ok) {
            stderr.write(`pick-pilot: invalid --${flag}\n`);
            return false;
        }
    }
    return true;
}

// Same rendering as service/article-lists/nigerian-actors.txt's header —
// documented provenance and the command to run it, not just a bare list.
function renderTitlesFile(ranked, opts, generatedAt) {
    return [
        `# Pilot mix: ${ranked.length} article(s), generated ${generatedAt}`,
        `# wiki=${opts.wiki} edit-window-days=${opts.editWindowDays} burst-window-days=${opts.burstWindowDays}`,
        `# base-pool=${opts.basePool} shortlist-size=${opts.shortlistSize} `
            + `offline-ratio-max=${opts.offlineRatioMax} table-ratio-max=${opts.tableRatioMax} `
            + `flagged-share=${opts.flaggedShare}`,
        '# Biased toward current events (recently created, or edits concentrated in a burst, or',
        '# carrying {{current}}) and toward {{failed verification}}; biased against articles whose',
        '# citations are mostly unfetchable. See service/pilot-selection.js.',
        '#',
        '# node service/run-sweep.js --titles-file <this file> --live-source-fetch \\',
        `#     --max ${ranked.length} --out pilot-findings.csv`,
        '',
    ].join('\n') + ranked.map(c => c.title).join('\n') + '\n';
}

function countTiers(ranked) {
    return ranked.reduce((acc, c) => {
        acc[c.tier] = (acc[c.tier] || 0) + 1;
        return acc;
    }, {});
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
        const runAt = now();
        const sinceDate = new Date(runAt.getTime() - opts.editWindowDays * MS_PER_DAY);
        const burstSinceDate = new Date(runAt.getTime() - opts.burstWindowDays * MS_PER_DAY);

        const topEdited = await selectTopEdited(query, {
            sinceDate, burstSinceDate, limit: opts.basePool,
        });
        if (topEdited.length === 0) {
            stderr.write('pick-pilot: no articles edited in the window — nothing to select\n');
            return 1;
        }

        const pageIds = topEdited.map(c => c.pageId);
        const [currentTagIds, failedVerificationIds, creationDates] = await Promise.all([
            selectTagMembership(query, { templates: CURRENT_EVENT_TEMPLATES, pageIds }),
            selectTagMembership(query, {
                templates: [resolveCriterion('failed-verification').template], pageIds,
            }),
            selectCreationDates(query, { pageIds }),
        ]);

        const merged = mergeSignals(topEdited, {
            currentTagIds,
            failedVerificationIds,
            creationDates,
            burstBaseline: opts.burstWindowDays / opts.editWindowDays,
            now: runAt,
        });
        const currentCount = merged.filter(c => tierOf(c).startsWith('current')).length;
        stderr.write(
            `pick-pilot: base pool ${merged.length} article(s) — ${currentCount} read as current events `
            + `(${currentTagIds.size} by tag), ${failedVerificationIds.size} tagged {{failed verification}}\n`
        );

        const short = shortlist(merged, {
            size: opts.shortlistSize, weights: DEFAULT_WEIGHTS, thresholds: DEFAULT_THRESHOLDS,
        });
        // Flagged articles are the scarcer population and score lower on
        // average (they are rarely also breaking news), so they are checked
        // first: otherwise the fetch budget is spent on current-events
        // candidates and the quota has nothing left to fill itself from.
        // Fetch order has no bearing on any article's score.
        const flaggedQuota = flaggedQuotaFor(opts.max, opts.flaggedShare);
        const { flagged, rest } = splitFlaggedPool(short);
        stderr.write(
            `pick-pilot: checking citations until ${opts.max} survive `
            + `(${flaggedQuota} slot(s) reserved for {{failed verification}}; `
            + `${flagged.length} such article(s) in the shortlist of ${short.length})...\n`
        );

        // core/urls.js logs one console.log per citation it examines — fine
        // for a human watching one article in devtools, unusable noise across
        // hundreds of articles with nobody reading in real time. That module
        // is shared with the live userscript and the CLI, where the logging is
        // legitimate, so it stays as-is there; this suppresses only around the
        // extraction loop, matching service/run-extract.js.
        const realLog = console.log;
        console.log = () => {};

        const contentFilter = {
            offlineRatioCeiling: opts.offlineRatioMax,
            tableRatioCeiling: opts.tableRatioMax,
        };
        const checked = [];
        let flaggedSurvivors = 0;
        let survivors = 0;
        let fetchFailures = 0;

        // `stopAt` is how many survivors this pass needs before it hands over
        // to the next; the shortlist is already in priority order within each
        // pool, so everything below a satisfied target is a worse candidate.
        const checkPool = async (pool, stopAt, countsToward) => {
            for (const candidate of pool) {
                if (!opts.scanAll && countsToward() >= stopAt) return;
                const { html } = await fetchArticle({
                    title: candidate.title, revisionId: candidate.revisionId,
                });
                if (!html) {
                    fetchFailures++;
                    candidate.citationCount = 0;
                    candidate.offlineRatio = null;
                    candidate.tableRatio = null;
                } else {
                    const citations = collectCitations(parseHtml(html));
                    candidate.citationCount = citations.length;
                    candidate.offlineRatio = computeOfflineRatio(citations);
                    candidate.tableRatio = computeTableRatio(citations);
                }
                checked.push(candidate);
                if (passesContentFilter(candidate, contentFilter)) {
                    survivors++;
                    if (candidate.failedVerification) flaggedSurvivors++;
                }
            }
        };

        try {
            await checkPool(flagged, flaggedQuota, () => flaggedSurvivors);
            await checkPool(rest, opts.max, () => survivors);
        } finally {
            console.log = realLog;
        }
        stderr.write(
            `pick-pilot: fetched ${checked.length} article(s), ${fetchFailures} failed, `
            + `${survivors} passed the offline filter (${flaggedSurvivors} flagged)\n`
        );

        ranked = finalizeRanking(checked, {
            limit: opts.max,
            flaggedQuota,
            offlineRatioCeiling: opts.offlineRatioMax,
            tableRatioCeiling: opts.tableRatioMax,
            weights: DEFAULT_WEIGHTS,
            thresholds: DEFAULT_THRESHOLDS,
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

    stdout.write(
        `selected ${ranked.length} article(s) -> ${opts.out} `
        + `(${Object.entries(countTiers(ranked)).map(([t, n]) => `${t}: ${n}`).join(', ')})\n`
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
