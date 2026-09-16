#!/usr/bin/env node
// Runnable entry point: builds the pilot article mix described in
// service/pilot-selection.js's header — articles likely to still be edited
// when the batch reaches an editor (editing spread across months, by several
// people, without a recent spike), biased toward {{failed verification}} and
// against articles whose sources the sweep can't fetch — and writes a
// --titles-file for service/run-sweep.js.
//
// Not "articles being edited right now": that ranking filled the first batch
// with tournament finals and other one-shot events, which are finished by the
// time a batch ships. See service/pilot-selection.js's header and
// docs/design-plans/2026-09-16-selecting-for-future-activity.md.
//
// Two stages, matching service/pilot-selection.js's split:
//   1. Wiki Replicas: top-edited base population (with a burst count), then
//      creation dates, tag membership and the bucketed activity profile for
//      exactly those page ids. Cheap — four bounded queries, none of them
//      enumerating a whole population.
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
import { readFile as fsReadFile, writeFile as fsWriteFile } from 'node:fs/promises';

import { openReplicaConnection, makeQueryFn } from './replicas.js';
import { parseTitlesFile } from './run-sweep.js';
import {
    selectTopEdited,
    selectTagMembership,
    selectCreationDates,
    selectActivityProfiles,
    selectCategoryMembership,
    activityBuckets,
    currentEventTemplatesForWiki,
    failedVerificationTemplatesForWiki,
    livingPeopleCategoryForWiki,
} from './article-picker.js';
import { collectCitations } from '../core/citations.js';
import { fetchArticleHtml, hostForWiki } from '../core/wikipedia.js';
import {
    mergeSignals,
    shortlist,
    finalizeRanking,
    activityRejection,
    contentRejection,
    computeOfflineRatio,
    computeTableRatio,
    splitFlaggedPool,
    quotaFor,
    tierOf,
    DEFAULT_FLAGGED_QUOTA_SHARE,
    DEFAULT_BLP_QUOTA_SHARE,
    DEFAULT_MIN_ACTIVE_BUCKETS,
    DEFAULT_MAX_IDLE_DAYS,
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
            'edit-window-days':  { type: 'string', default: '30' },
            'burst-window-days': { type: 'string', default: '3' },
            'history-days':      { type: 'string', default: '180' },
            'history-bucket-days': { type: 'string', default: '30' },
            'min-active-buckets': { type: 'string', default: String(DEFAULT_MIN_ACTIVE_BUCKETS) },
            'max-idle-days':     { type: 'string', default: String(DEFAULT_MAX_IDLE_DAYS) },
            'allow-event-titles': { type: 'boolean', default: false },
            'base-pool':         { type: 'string', default: '2000' },
            'shortlist-size':    { type: 'string', default: '300' },
            max:                 { type: 'string', default: '100' },
            'offline-ratio-max': { type: 'string', default: String(DEFAULT_OFFLINE_RATIO_CEILING) },
            'table-ratio-max':   { type: 'string', default: String(DEFAULT_TABLE_RATIO_CEILING) },
            'flagged-share':     { type: 'string', default: String(DEFAULT_FLAGGED_QUOTA_SHARE) },
            'blp-share':         { type: 'string', default: String(DEFAULT_BLP_QUOTA_SHARE) },
            'exclude-titles-file': { type: 'string' },
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
        historyDays: Number(values['history-days']),
        historyBucketDays: Number(values['history-bucket-days']),
        minActiveBuckets: Number(values['min-active-buckets']),
        maxIdleDays: Number(values['max-idle-days']),
        allowEventTitles: values['allow-event-titles'],
        basePool: Number(values['base-pool']),
        shortlistSize: Number(values['shortlist-size']),
        max: Number(values.max),
        offlineRatioMax: Number(values['offline-ratio-max']),
        tableRatioMax: Number(values['table-ratio-max']),
        flaggedShare: Number(values['flagged-share']),
        blpShare: Number(values['blp-share']),
        excludeTitlesFile: values['exclude-titles-file'],
        scanAll: values['scan-all'],
        out: values.out,
        jsonOut: values['json-out'],
    };
}

export const HELP_TEXT = `usage: node service/run-pick-pilot.js [options]

Builds a --titles-file for service/run-sweep.js: active articles that look
likely to STILL be edited when the batch reaches an editor — editing spread
across months, by several people, without a recent spike — biased toward
{{failed verification}}, and away from one-shot event pages and articles whose
citations are mostly unfetchable. See service/pilot-selection.js for the
scoring, and docs/design-plans/2026-09-16-selecting-for-future-activity.md for
why "edited a lot lately" was the wrong target.

Options:
  --wiki <db>               Wiki database name (default: enwiki)
  --edit-window-days <n>    Edit-count window in days (default: 30)
  --burst-window-days <n>   Short window whose share of those edits marks an
                             article as a spike — a finished event rather than
                             a page with a standing constituency. Penalized,
                             and subtracted from the volume term (default: 3)
  --history-days <n>        How far back to measure the editing pattern
                             (default: 180). Measured per candidate, so this
                             is a bounded index range per page, not a second
                             scan of the revision table.
  --history-bucket-days <n> Bucket size within that window (default: 30). The
                             number of buckets an article was edited in — not
                             its edit count — is the persistence signal.
  --min-active-buckets <n>  Reject an article edited in fewer than this many
                             buckets (default: ${DEFAULT_MIN_ACTIVE_BUCKETS} of 6, at the defaults
                             above). This is the filter that excludes one-shot
                             events; an article with no history in the window
                             at all is rejected too, never waved through.
  --max-idle-days <n>       Reject an article whose last edit is older than
                             this (default: ${DEFAULT_MAX_IDLE_DAYS})
  --allow-event-titles      Keep articles whose titles name an occasion rather
                             than a subject ("2026 US Open", "2025-26 X
                             season", "Athletics at the 2026 Olympics"). These
                             are excluded by default: a forthcoming event is
                             edited steadily right up until it happens, so
                             persistence alone does not catch it.
  --base-pool <n>           Top-edited articles to pull before scoring (default: 2000)
  --shortlist-size <n>      Upper bound on stage-2 candidates — the fetch +
                             citation-extraction step (default: 300). The run
                             normally stops well before this, once --max
                             articles have survived the offline filter.
  --max <n>                 Final pilot size (default: 100)
  --offline-ratio-max <f>   Exclude articles whose citations are unfetchable
                             above this fraction, 0..1 (default: ${DEFAULT_OFFLINE_RATIO_CEILING})
  --table-ratio-max <f>     Exclude articles with more than this fraction of
                             their citations inside a <table>, 0..1
                             (default: ${DEFAULT_TABLE_RATIO_CEILING}). Recurring results pages,
                             episode lists and medal tables are worthless to
                             verify: the claim behind a bracket citation is a
                             score line, not an assertion.
  --exclude-titles-file <path>
                             Skip any base-pool article whose title appears in
                             this file (same one-title-per-line format
                             --titles-file uses elsewhere) — a prior pilot's
                             titles file, so a second batch covers new ground
                             instead of re-picking the first batch's articles.
  --flagged-share <f>       Share of the pilot reserved for articles carrying
                             {{failed verification}}, 0..1 (default: ${DEFAULT_FLAGGED_QUOTA_SHARE}).
                             A floor, not a partition: those articles still
                             compete for the remaining slots on score, and an
                             unfillable reserve leaves its slots to the general
                             ranking. Without it the much larger untagged
                             population crowds them out entirely.
  --blp-share <f>           Share reserved for biographies of living people
                             (Category:Living people), 0..1 (default: ${DEFAULT_BLP_QUOTA_SHARE}).
                             A floor on the same terms as --flagged-share, and
                             a modest one: high-activity BLPs already score
                             well here, so this only insures a few are present.
                             0 disables it, as does a wiki with no confirmed
                             category name (enwiki is the only one so far).
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
        ['history-days', opts.historyDays > 0],
        ['history-bucket-days', opts.historyBucketDays > 0 && opts.historyBucketDays <= opts.historyDays],
        ['min-active-buckets', Number.isInteger(opts.minActiveBuckets) && opts.minActiveBuckets >= 0
            && opts.minActiveBuckets <= Math.ceil(opts.historyDays / opts.historyBucketDays)],
        ['max-idle-days', opts.maxIdleDays > 0],
        ['base-pool', Number.isInteger(opts.basePool) && opts.basePool >= 1 && opts.basePool <= 5000],
        ['shortlist-size', Number.isInteger(opts.shortlistSize) && opts.shortlistSize >= 1],
        ['max', Number.isInteger(opts.max) && opts.max >= 1],
        ['offline-ratio-max', opts.offlineRatioMax >= 0 && opts.offlineRatioMax <= 1],
        ['table-ratio-max', opts.tableRatioMax >= 0 && opts.tableRatioMax <= 1],
        ['flagged-share', opts.flaggedShare >= 0 && opts.flaggedShare <= 1],
        ['blp-share', opts.blpShare >= 0 && opts.blpShare <= 1],
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
        `# history-days=${opts.historyDays} history-bucket-days=${opts.historyBucketDays} `
            + `min-active-buckets=${opts.minActiveBuckets} max-idle-days=${opts.maxIdleDays} `
            + `allow-event-titles=${opts.allowEventTitles}`,
        `# base-pool=${opts.basePool} shortlist-size=${opts.shortlistSize} `
            + `offline-ratio-max=${opts.offlineRatioMax} table-ratio-max=${opts.tableRatioMax} `
            + `flagged-share=${opts.flaggedShare} blp-share=${opts.blpShare}`,
        '# Selected for articles likely to still be edited when this batch reaches an editor:',
        '# editing spread across months, by several people, without a recent spike. Biased toward',
        '# {{failed verification}}; biased against one-shot event pages, articles whose citations',
        '# are mostly unfetchable, and pages whose citations sit in results tables.',
        '# See service/pilot-selection.js.',
        '#',
        '# node service/run-sweep.js --titles-file <this file> --live-source-fetch \\',
        `#     --max ${ranked.length} --out pilot-findings.csv`,
        '',
    ].join('\n') + ranked.map(c => c.title).join('\n') + '\n';
}

// One line per rejection reason, e.g. "event-title: 214, low-persistence: 96".
// The commitment made on the 2026-09-14 volunteer call was to show how a batch
// was generated before it ships; this is the shareable form of it.
function countReasons(reasons) {
    const tally = reasons.reduce((acc, r) => {
        acc[r] = (acc[r] || 0) + 1;
        return acc;
    }, {});
    const entries = Object.entries(tally).sort((a, b) => b[1] - a[1]);
    return entries.length ? entries.map(([r, n]) => `${r}: ${n}`).join(', ') : 'none';
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
    fetchArticle,
    parseHtml = html => JSDOM.fragment(html),
    writeFile = fsWriteFile,
    readExcludeTitlesFile = path => fsReadFile(path, 'utf8'),
    now = () => new Date(),
} = {}) {
    if (!validate(opts, stderr)) return 2;

    // See core/wikipedia.js's hostForWiki() comment: defaulted here (not in
    // the destructuring above) so --wiki actually reaches the REST fetch
    // rather than always hitting en.wikipedia.org.
    const fetchArticleFn = fetchArticle
        ?? (params => fetchArticleHtml(params, { host: hostForWiki(opts.wiki) }));

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

        let excludeTitles = null;
        if (opts.excludeTitlesFile) {
            const text = await readExcludeTitlesFile(opts.excludeTitlesFile);
            excludeTitles = new Set(parseTitlesFile(text));
        }

        const topEditedAll = await selectTopEdited(query, {
            sinceDate, burstSinceDate, limit: opts.basePool,
        });
        if (topEditedAll.length === 0) {
            stderr.write('pick-pilot: no articles edited in the window — nothing to select\n');
            return 1;
        }

        const topEdited = excludeTitles
            ? topEditedAll.filter(c => !excludeTitles.has(c.title))
            : topEditedAll;
        if (excludeTitles) {
            stderr.write(
                `pick-pilot: --exclude-titles-file dropped ${topEditedAll.length - topEdited.length} of `
                + `${topEditedAll.length} base-pool article(s) already in ${opts.excludeTitlesFile}\n`
            );
            if (topEdited.length === 0) {
                stderr.write('pick-pilot: nothing left to select after --exclude-titles-file\n');
                return 1;
            }
        }

        const pageIds = topEdited.map(c => c.pageId);
        const buckets = activityBuckets({
            now: runAt, historyDays: opts.historyDays, bucketDays: opts.historyBucketDays,
        });
        // Null for any wiki whose Living-people category name hasn't been
        // confirmed by an editor there — the quota then reserves nothing,
        // which the run says out loud rather than silently filling.
        const blpCategory = livingPeopleCategoryForWiki(opts.wiki);

        const [currentTagIds, failedVerificationIds, creationDates, activityProfiles, blpIds] = await Promise.all([
            selectTagMembership(query, { templates: currentEventTemplatesForWiki(opts.wiki), pageIds }),
            selectTagMembership(query, { templates: failedVerificationTemplatesForWiki(opts.wiki), pageIds }),
            selectCreationDates(query, { pageIds }),
            selectActivityProfiles(query, { pageIds, buckets }),
            blpCategory ? selectCategoryMembership(query, { category: blpCategory, pageIds }) : new Set(),
        ]);
        if (!blpCategory && opts.blpShare > 0) {
            stderr.write(
                `pick-pilot: no Living-people category recorded for ${opts.wiki} — `
                + '--blp-share reserves nothing on this wiki\n'
            );
        }

        const merged = mergeSignals(topEdited, {
            currentTagIds,
            failedVerificationIds,
            blpIds,
            creationDates,
            activityProfiles,
            burstBaseline: opts.burstWindowDays / opts.editWindowDays,
            now: runAt,
        });

        // The activity filter runs before the shortlist, not after: rejecting
        // an event page here costs one map lookup, rejecting it in stage 2
        // costs an article fetch and a DOM parse.
        const activityFilter = {
            minActiveBuckets: opts.minActiveBuckets,
            maxIdleDays: opts.maxIdleDays,
            allowEventTitles: opts.allowEventTitles,
        };
        const rejected = [];
        const eligible = merged.filter(candidate => {
            const reason = activityRejection(candidate, activityFilter);
            if (reason) rejected.push(reason);
            return !reason;
        });

        const durableCount = eligible.filter(c => tierOf(c).startsWith('durable')).length;
        stderr.write(
            `pick-pilot: base pool ${merged.length} article(s) — dropped ${rejected.length} on the `
            + `activity filter (${countReasons(rejected)}); ${eligible.length} eligible, of which `
            + `${durableCount} read as durably edited and `
            + `${eligible.filter(c => c.failedVerification).length} carry {{failed verification}} `
            + `and ${eligible.filter(c => c.isBlp).length} BLP(s) `
            + `(${currentTagIds.size} of the pool carried a current-event tag)\n`
        );
        if (eligible.length === 0) {
            stderr.write('pick-pilot: no article in the base pool survived the activity filter\n');
            return 1;
        }

        const short = shortlist(eligible, {
            size: opts.shortlistSize, weights: DEFAULT_WEIGHTS, thresholds: DEFAULT_THRESHOLDS,
        });
        // Flagged articles are the scarcer population and score lower on
        // average (they are rarely also breaking news), so they are checked
        // first: otherwise the fetch budget is spent on current-events
        // candidates and the quota has nothing left to fill itself from.
        // Fetch order has no bearing on any article's score.
        const flaggedQuota = quotaFor(opts.max, opts.flaggedShare);
        const blpQuota = quotaFor(opts.max, opts.blpShare);
        const { flagged, rest } = splitFlaggedPool(short);
        // BLPs get a pass of their own for the same reason flagged articles
        // do — a reserved slot cannot be filled by an article the run never
        // fetched. The passes overlap (an article can be both, or be reached
        // again by the general pass), so checkPool() skips anything already
        // checked rather than paying for a second fetch.
        const blps = rest.filter(c => c.isBlp);
        stderr.write(
            `pick-pilot: checking citations until ${opts.max} survive `
            + `(${flaggedQuota} slot(s) reserved for {{failed verification}}, `
            + `${blpQuota} for BLPs; ${flagged.length} flagged and ${blps.length} BLP(s) `
            + `in the shortlist of ${short.length})...\n`
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
        const contentRejections = [];
        const checkedIds = new Set();
        let flaggedSurvivors = 0;
        let blpSurvivors = 0;
        let survivors = 0;
        let fetchFailures = 0;

        // `stopAt` is how many survivors this pass needs before it hands over
        // to the next; the shortlist is already in priority order within each
        // pool, so everything below a satisfied target is a worse candidate.
        const checkPool = async (pool, stopAt, countsToward) => {
            for (const candidate of pool) {
                if (!opts.scanAll && countsToward() >= stopAt) return;
                if (checkedIds.has(candidate.pageId)) continue;
                checkedIds.add(candidate.pageId);
                const { html } = await fetchArticleFn({
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
                const reason = contentRejection(candidate, contentFilter);
                if (reason) {
                    contentRejections.push(reason);
                } else {
                    survivors++;
                    if (candidate.failedVerification) flaggedSurvivors++;
                    if (candidate.isBlp) blpSurvivors++;
                }
            }
        };

        try {
            await checkPool(flagged, flaggedQuota, () => flaggedSurvivors);
            await checkPool(blps, blpQuota, () => blpSurvivors);
            await checkPool(rest, opts.max, () => survivors);
        } finally {
            console.log = realLog;
        }
        stderr.write(
            `pick-pilot: fetched ${checked.length} article(s), ${fetchFailures} failed, `
            + `${survivors} passed the content filter (${flaggedSurvivors} flagged, ${blpSurvivors} BLP); `
            + `dropped ${contentRejections.length} (${countReasons(contentRejections)})\n`
        );

        ranked = finalizeRanking(checked, {
            limit: opts.max,
            flaggedQuota,
            blpQuota,
            offlineRatioCeiling: opts.offlineRatioMax,
            tableRatioCeiling: opts.tableRatioMax,
            ...activityFilter,
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
