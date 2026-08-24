#!/usr/bin/env node
// Runnable entry point joining all five built stages of the batch pipeline —
// select, extract, fetch, verify, assemble — into the one command docs/design-plans/
// 2026-08-24-csv-deliverable-and-component-names.md describes: "I run a
// script and I get a CSV at the end that I can share." That doc's G1 (this
// runner) + G5 (the funnel below) + the CSV half of G2
// (service/csv-report.js).
//
// No runner joined these stages before this file: service/run-extract.js
// stops at stage 3 and prints a citations/URLs/fetched/failed funnel;
// service/run-replay.js does stages 4-5 but reads benchmark/dataset.json
// instead of stage 3's output. See that analysis doc's "The seam that has
// never been crossed" for the fuller story.
//
// Adjacent-citation groups are handled here, unlike run-replay.js (whose
// replay corpus has none to exercise): every citation, solo or grouped, gets
// its own per-source verifyCitation() call, and each group additionally gets
// one verifyGroup() collective call — mirroring main.js's
// verifyAllCitations(), and matching what core/groups.js's header describes.
// A group's collective finding and its members' per-source findings are all
// written; core/groups.js's mergeReportUnits() decides which one an editor
// should see, and nothing downstream of this runner applies that yet.
//
// Source fetching defaults to the stub — the same one service/run-extract.js
// uses. Real sources are opt-in only (--live-source-fetch). With the stub,
// every finding is SOURCE UNAVAILABLE — the CSV proves the pipeline wiring,
// not sourcing accuracy, until it's turned on.
//
// --live-source-fetch itself needs no permission for a small, attended run —
// the design doc's G3 settles this: it is only unattended, production-volume
// fetching *from Toolforge* that waits on WMCS. What a run of this flag
// actually requires is a host with open egress to en.wikipedia.org,
// TOOLFORGE_SOURCE_FETCHER_BASE below, and the chosen model provider — not
// every environment has that (a sandboxed Claude Code session's own proxy,
// for one, may not allow-list those hosts; check before assuming a run just
// hung).
//
// The CSV is the default deliverable; a ToolsDB write is opt-in (--store),
// inverting service/run-replay.js's default. Its bastion is unreachable from
// almost everywhere, so gating the shareable artifact on bastion access
// would make it unnecessarily hard to produce the thing someone actually
// asked for.
//
// Usage:
//   node service/run-sweep.js --max 5 --out findings.csv
//   node service/run-sweep.js --max 50 --live-source-fetch --out findings.csv
//   node service/run-sweep.js --max 5 --out findings.csv --store   # also ToolsDB
//   node service/run-sweep.js --help

import { JSDOM } from 'jsdom';
import { parseArgs } from 'node:util';

import { openReplicaConnection, makeQueryFn } from './replicas.js';
import { selectCandidates, CRITERIA } from './article-picker.js';
import { runBatch, ARTICLE_OUTCOMES } from './claim-extractor.js';
import { fetchArticleHtml } from '../core/wikipedia.js';
import { fetchSourceContent } from '../core/worker.js';
import { verifyCitation, verifyGroup, makeModelCaller, ProviderAuthError } from './verifier.js';
import { assembleFinding, assembleGroupFinding } from './finding-builder.js';
import { upsertFinding } from './findings-store.js';
import { openToolsDbConnection } from './toolsdb.js';
import { writeCsvReport } from './csv-report.js';
import { PROMPT_VERSION } from '../core/prompts.js';
import { PROVIDER_MODELS, PROVIDER_ENV_VARS } from './provider-config.js';

// Same contract as service/run-extract.js's — see that file's comment.
const TOOLFORGE_SOURCE_FETCHER_BASE = 'https://source-fetcher.toolforge.org';

export function parseCliArgs(argv) {
    const { values } = parseArgs({
        args: argv.slice(2),
        options: {
            criterion:           { type: 'string', default: 'failed-verification' },
            wiki:                { type: 'string', default: 'enwiki' },
            max:                 { type: 'string', default: '5' },
            provider:            { type: 'string', default: 'liftwing' },
            model:               { type: 'string' },
            'delay-ms':          { type: 'string', default: '1000' },
            'live-source-fetch': { type: 'boolean', default: false },
            store:               { type: 'boolean', default: false },
            out:                 { type: 'string', default: 'findings.csv' },
            help:                { type: 'boolean', short: 'h', default: false },
        },
        strict: true,
    });

    return {
        help: values.help,
        criterion: values.criterion,
        wiki: values.wiki,
        max: Number(values.max),
        provider: values.provider,
        model: values.model || PROVIDER_MODELS[values.provider],
        delayMs: Number(values['delay-ms']),
        liveSourceFetch: values['live-source-fetch'],
        store: values.store,
        out: values.out,
    };
}

export const HELP_TEXT = `usage: node service/run-sweep.js [options]

Selects candidate articles, extracts and fetches their citations, verifies
each claim against its source, and writes a CSV — the full pipeline in one
command. Source fetching (stage 3) is stubbed by default; every finding will
be SOURCE UNAVAILABLE until you opt in.

Options:
  --criterion <name>   Selection criterion. One of: ${Object.keys(CRITERIA).join(', ')}
                        (default: failed-verification)
  --wiki <db>           Wiki database name, e.g. enwiki, frwiki (default: enwiki)
  --max <n>             Maximum articles to process (default: 5)
  --provider <name>     One of: ${Object.keys(PROVIDER_MODELS).join(', ')} (default: liftwing)
  --model <id>          Override the provider's default model
  --delay-ms <n>        Delay after each model call, ms (default: 1000)
  --live-source-fetch   Fetch real sources via tf-source-fetcher instead of the
                         stub. A small, attended run needs no permission (see
                         the design doc's G3) — just a host with open egress
                         to en.wikipedia.org and tf-source-fetcher, which not
                         every environment has. Unattended, production-volume
                         fetching from Toolforge is the part still waiting
                         on WMCS.
  --store               Also upsert every finding into ToolsDB. Requires a
                         Toolforge bastion; the CSV is written either way.
  --out <path>          CSV output path (default: findings.csv)
  --help, -h            Show this help and exit.

A halt on an auth/billing error (401/402/403) from the model stops the run
immediately, exit code 3 — see ProviderAuthError in service/verifier.js. The
CSV (and, with --store, ToolsDB) still gets every finding computed before
the halt; nothing already written is rolled back.
`;

// Stage 3 stand-in, identical to service/run-extract.js's stubFetchSource.
// Every citation with a URL resolves to unavailableReason "fetch_failed"
// carrying this message — accurate (it genuinely was not fetched), not a
// disguised real failure.
export async function stubFetchSource() {
    return {
        content: null,
        status: null,
        error: 'source fetching not wired up — pass --live-source-fetch to fetch via tf-source-fetcher',
    };
}

function liveFetchSource(url, pageNum) {
    return fetchSourceContent(url, pageNum, { workerBase: TOOLFORGE_SOURCE_FETCHER_BASE });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Splits one article's citations into solo citations and adjacent groups
// (groupSize > 1), grouped by groupId and sorted by groupIndex — the shape
// both verifyGroup() and assembleGroupFinding() expect.
export function splitCitations(citations) {
    const solos = [];
    const groupsById = new Map();
    for (const citation of citations) {
        if (citation.groupSize > 1) {
            if (!groupsById.has(citation.groupId)) groupsById.set(citation.groupId, []);
            groupsById.get(citation.groupId).push(citation);
        } else {
            solos.push(citation);
        }
    }
    const groups = [...groupsById.values()].map(
        members => members.slice().sort((a, b) => (a.groupIndex ?? 0) - (b.groupIndex ?? 0))
    );
    return { solos, groups };
}

// A "flag" is any verdict that would surface as a suggestion — matches the
// parent design doc's §1 "any-flag" definition (NOT SUPPORTED or PARTIALLY
// SUPPORTED). Kept as its own predicate so the funnel and any future
// publication filter read the same definition.
function isFlagged(verdict) {
    return verdict === 'NOT SUPPORTED' || verdict === 'PARTIALLY SUPPORTED';
}

export async function runSweep(opts, {
    stdout = process.stdout,
    stderr = process.stderr,
    env = process.env,
    connectReplicas = openReplicaConnection,
    connectToolsDb = openToolsDbConnection,
    fetchArticle = fetchArticleHtml,
    fetchSourceFn,
    makeModelCallerFn = makeModelCaller,
    writeCsvReportFn = writeCsvReport,
    parseHtml = html => new JSDOM(html).window.document,
    readFile,
} = {}) {
    if (!Number.isInteger(opts.max) || opts.max < 1) {
        stderr.write(`sweep: --max must be a positive integer (got: ${opts.max})\n`);
        return 2;
    }

    const envVar = PROVIDER_ENV_VARS[opts.provider];
    const apiKey = envVar ? env[envVar] : undefined;
    if (envVar && !apiKey) {
        stderr.write(`sweep: ${envVar} environment variable is required for provider "${opts.provider}"\n`);
        return 2;
    }

    let replicaConnection;
    try {
        replicaConnection = await connectReplicas({ wikiDb: opts.wiki });
    } catch (error) {
        stderr.write(`sweep: could not connect to Wiki Replicas: ${error.message}\n`);
        return 1;
    }

    let candidates;
    try {
        candidates = await selectCandidates(makeQueryFn(replicaConnection), {
            criterion: opts.criterion,
            max: opts.max,
        });
    } catch (error) {
        stderr.write(`sweep: ${error.message}\n`);
        return 1;
    } finally {
        await replicaConnection.end();
    }
    stderr.write(`sweep: selected ${candidates.length} article(s)\n`);

    let toolsDbConnection = null;
    let toolsDbQuery = null;
    if (opts.store) {
        try {
            toolsDbConnection = await connectToolsDb(readFile ? { readFile } : {});
            toolsDbQuery = makeQueryFn(toolsDbConnection);
        } catch (error) {
            stderr.write(`sweep: could not connect to ToolsDB: ${error.message}\n`);
            return 1;
        }
    }

    if (opts.liveSourceFetch) {
        stderr.write(
            `sweep: WARNING — --live-source-fetch is on, fetching real sources via ${TOOLFORGE_SOURCE_FETCHER_BASE}. ` +
            `Confirm WMCS has cleared unattended fetching before using this outside a manual, attended run.\n`
        );
    }
    const fetchSource = fetchSourceFn ?? (opts.liveSourceFetch ? liveFetchSource : stubFetchSource);
    const callModel = makeModelCallerFn({ provider: opts.provider, apiKey, model: opts.model });

    const findings = [];
    // citationsSeen -> withUrl -> fetched -> verified -> flagged -> published
    // is deliberately citation-denominated and monotonic (each stage's count
    // can only be <= the one before it), matching the parent design doc's §7
    // funnel. A group's collective check is a genuinely separate thing — one
    // extra model call per group, not one more citation — so it gets its own
    // counters below rather than being folded in, where it would let
    // "verified" or "flagged" exceed "seen" and stop meaning what a funnel
    // is supposed to mean.
    const funnel = {
        articles: 0, articlesFailed: 0,
        citationsSeen: 0, citationsWithUrl: 0, citationsFetched: 0,
        verified: 0, flagged: 0, published: 0,
        groupsChecked: 0, groupsSkipped: 0, groupsFlagged: 0,
    };
    const verdictCounts = {};

    const recordVerdict = verdict => {
        verdictCounts[verdict] = (verdictCounts[verdict] || 0) + 1;
        return isFlagged(verdict);
    };

    // Every finding this phase computes is published:false (the §1
    // publication threshold doesn't exist yet — see service/finding-builder.js).
    // Counted here anyway so the funnel prints a real 0 rather than omitting
    // the column, which is the whole point of measuring the funnel now.
    const record = async finding => {
        findings.push(finding);
        if (finding.published) funnel.published++;
        if (toolsDbQuery) await upsertFinding(toolsDbQuery, finding);
    };

    // core/urls.js logs one console.log per citation it examines — fine for
    // a human watching one article in devtools, noise for a batch sweep. See
    // service/run-extract.js's identical suppression for the fuller comment.
    const realLog = console.log;
    console.log = () => {};

    let haltCode = null;
    try {
        // One shared source cache across the whole sweep, not per article —
        // the same reason service/claim-extractor.js's own header gives:
        // "one source is often cited across many articles."
        outer:
        for await (const article of runBatch(candidates, { parseHtml, fetchArticle, fetchSource })) {
            funnel.articles++;
            if (article.outcome !== ARTICLE_OUTCOMES.OK) {
                funnel.articlesFailed++;
                continue;
            }

            const wikiCandidate = { wiki: opts.wiki, pageId: article.pageId, title: article.title, revisionId: article.revisionId };
            const { solos, groups } = splitCitations(article.citations);

            for (const citation of [...solos, ...groups.flat()]) {
                funnel.citationsSeen++;
                if (citation.url) funnel.citationsWithUrl++;
                if (citation.source?.content) funnel.citationsFetched++;

                let verification;
                try {
                    verification = await verifyCitation(citation.claimText, citation.source, { callModel });
                } catch (error) {
                    if (error instanceof ProviderAuthError) { haltCode = describeHalt(stderr, opts.provider, error, findings.length); break outer; }
                    throw error;
                }
                if (verification.usage) { funnel.verified++; await sleep(opts.delayMs); }
                if (recordVerdict(verification.verdict)) funnel.flagged++;

                await record(assembleFinding({
                    candidate: wikiCandidate, citation, verification,
                    provider: opts.provider, model: opts.model, promptVersion: PROMPT_VERSION,
                }));
            }

            for (const members of groups) {
                let verification;
                try {
                    verification = await verifyGroup(members, { callModel });
                } catch (error) {
                    if (error instanceof ProviderAuthError) { haltCode = describeHalt(stderr, opts.provider, error, findings.length); break outer; }
                    throw error;
                }
                funnel.groupsChecked++;
                if (verification.skipped) { funnel.groupsSkipped++; continue; }
                if (verification.usage) await sleep(opts.delayMs);
                if (recordVerdict(verification.verdict)) funnel.groupsFlagged++;

                await record(assembleGroupFinding({
                    candidate: wikiCandidate, members, verification,
                    provider: opts.provider, model: opts.model, promptVersion: PROMPT_VERSION,
                }));
            }
        }
    } finally {
        console.log = realLog;
        if (toolsDbConnection) await toolsDbConnection.end();
    }

    await writeCsvReportFn(findings, opts.out);
    stderr.write(
        `sweep: done. ${funnel.articles} article(s) (${funnel.articlesFailed} failed/no citations), ` +
        `${funnel.citationsSeen} citation(s) seen -> ${funnel.citationsWithUrl} had a URL -> ` +
        `${funnel.citationsFetched} fetched -> ${funnel.verified} verified -> ${funnel.flagged} flagged -> ` +
        `${funnel.published} published.\n` +
        `sweep: adjacent-citation groups: ${funnel.groupsChecked} checked, ${funnel.groupsSkipped} skipped ` +
        `(<=1 usable source), ${funnel.groupsFlagged} flagged.\n` +
        `sweep: verdicts: ${JSON.stringify(verdictCounts)}\n` +
        `sweep: wrote ${findings.length} finding(s) to ${opts.out}${toolsDbQuery ? ' and ToolsDB' : ''}.\n`
    );

    return haltCode ?? 0;
}

function describeHalt(stderr, provider, error, writtenSoFar) {
    stderr.write(
        `sweep: halting — ${provider} returned an auth/billing error (${error.status ?? '?'}): ${error.message}\n` +
        `sweep: ${writtenSoFar} finding(s) already computed are kept and will still be written to the CSV.\n`
    );
    return 3;
}

export async function main(argv, io = {}) {
    const opts = parseCliArgs(argv);
    if (opts.help) {
        (io.stdout ?? process.stdout).write(HELP_TEXT);
        return 0;
    }
    return runSweep(opts, io);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main(process.argv).then(code => process.exit(code));
}
