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
//   node service/run-sweep.js --max 50 --live-llm-router --concurrency 16 --out findings.csv
//   node service/run-sweep.js --help
//
// --concurrency controls only the verify stage (model calls); fetching stays
// serial. See --concurrency's --help text and scripts/probe-concurrency.js
// for how to (re-)measure the ceiling for whatever backend you're calling.

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

// Opt-in override that routes the liftwing provider's call through the
// tf-llm-router Toolforge tool (https://github.com/alex-o-748/tf-llm-router)
// instead of the Cloudflare Worker CORS proxy makeModelCaller() otherwise
// defaults to (core/providers.js's callLiftwingAPI(), workerBase = the
// publicai-proxy worker). Without this flag "--provider liftwing" measures
// the worker's shared approved-bot-JWT path — the same one the live
// userscript uses — not the Toolforge-internal Lift Wing access the parent
// design doc (docs/design-plans/2026-08-07-batch-source-checks-for-edit-
// suggestions.md §5) is actually about; those can have very different rate
// limits, and conflating them was caught live (2026-08-24): a --delay-ms 0
// run against the worker's /liftwing path 429'd after 2 calls, which is
// evidence about the worker's shared JWT budget, not about what Lift Wing
// itself would tolerate from inside Toolforge. Mirrors cli/verify.js's
// TOOLFORGE_LLM_ROUTER_BASE override (there scoped to huggingface, since
// that predates this one); tf-llm-router's already-deployed /liftwing route
// is what makes this meaningful for liftwing specifically.
const TOOLFORGE_LLM_ROUTER_BASE = 'https://llm-router.toolforge.org';

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
            concurrency:         { type: 'string', default: '1' },
            'live-source-fetch': { type: 'boolean', default: false },
            'live-llm-router':   { type: 'boolean', default: false },
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
        concurrency: Number(values.concurrency),
        liveSourceFetch: values['live-source-fetch'],
        liveLlmRouter: values['live-llm-router'],
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
  --concurrency <n>     Model calls (verifyCitation/verifyGroup) to run at once
                         (default: 1, i.e. serial — matches every prior version
                         of this runner). --delay-ms still applies per worker,
                         so effective sustained rate is roughly
                         concurrency / delay-ms. Measured against tf-llm-router
                         on 2026-08-24: throughput scaled up through
                         concurrency=32 (~2.2 calls/s) then flattened/regressed
                         at 64 — that plateau is specific to whichever backend
                         you're calling and worth re-measuring
                         (scripts/probe-concurrency.js) before trusting a
                         number this comment will go stale on.
  --live-source-fetch   Fetch real sources via tf-source-fetcher instead of the
                         stub. A small, attended run needs no permission (see
                         the design doc's G3) — just a host with open egress
                         to en.wikipedia.org and tf-source-fetcher, which not
                         every environment has. Unattended, production-volume
                         fetching from Toolforge is the part still waiting
                         on WMCS.
  --live-llm-router     When --provider is liftwing, route the model call
                         through tf-llm-router
                         (https://github.com/alex-o-748/tf-llm-router)
                         instead of the Cloudflare Worker CORS proxy. The
                         worker's /liftwing path is a shared approved-bot-JWT
                         budget (the same one the live userscript uses);
                         tf-llm-router's is Lift Wing accessed directly from
                         inside Toolforge, per the design doc's §5 argument
                         for the migration. The two have not been shown to
                         share a rate limit — measure separately.
  --store               Also upsert every finding into ToolsDB. Requires a
                         Toolforge bastion; the CSV is written either way.
  --out <path>          CSV output path (default: findings.csv)
  --help, -h            Show this help and exit.

A halt on an auth/billing error (401/402/403) from the model stops the run
immediately, exit code 3 — see ProviderAuthError in service/verifier.js. Any
other unrecoverable model-call error (e.g. a 429 that exhausted retries)
halts the same way, exit code 4. Either way the CSV (and, with --store,
ToolsDB) still gets every finding computed before the halt; nothing already
written is rolled back.
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
    if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1) {
        stderr.write(`sweep: --concurrency must be a positive integer (got: ${opts.concurrency})\n`);
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

    const useLlmRouter = opts.liveLlmRouter && opts.provider === 'liftwing';
    if (opts.liveLlmRouter && opts.provider !== 'liftwing') {
        stderr.write(`sweep: --live-llm-router only affects --provider liftwing; ignoring for "${opts.provider}"\n`);
    }
    if (useLlmRouter) {
        stderr.write(`sweep: routing liftwing via ${TOOLFORGE_LLM_ROUTER_BASE}\n`);
    }
    const callModel = makeModelCallerFn({
        provider: opts.provider, apiKey, model: opts.model,
        ...(useLlmRouter ? { workerBase: TOOLFORGE_LLM_ROUTER_BASE } : {}),
    });

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

    // Producer/pool split: a single producer coroutine drives runBatch()
    // (fetch stays serial — out of scope here, see scripts/probe-concurrency.js
    // for the model-call-only concurrency this measures) and yields one task
    // per solo citation or per group; opts.concurrency worker coroutines pull
    // from that *same* async generator concurrently. Multiple concurrent
    // `for await` consumers over one shared async generator is a real,
    // verified pattern (each .next() call queues and resolves with the next
    // distinct value, in call order) — not a hand-rolled queue class, just
    // this file relying on that generator semantics.
    //
    // `halted` is checked by the producer between articles (so a fatal error
    // stops further fetching, not just further verifying — the property the
    // old fully-serial loop had for free) and by each worker before acting on
    // a pulled task (so tasks already queued up from an already-fetched
    // article are drained without dispatching new model calls, rather than
    // processed). Tasks already in flight when halted flips are allowed to
    // finish and record normally — halting stops new dispatch, not work
    // already committed to the network.
    let halted = false;
    let haltError = null;

    async function* generateTasks() {
        // Deliberately not `for await (const article of runBatch(...))`:
        // for-await-of fetches the *next* value before running the loop
        // body, so a halted check inside the body would let one extra
        // article's worth of fetching slip through after halting before it
        // took effect. Driving runBatch's iterator by hand puts the check
        // before each fetch instead of after.
        const articles = runBatch(candidates, { parseHtml, fetchArticle, fetchSource });
        while (true) {
            if (halted) return;
            const { value: article, done } = await articles.next();
            if (done) return;

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
                yield { kind: 'solo', wikiCandidate, citation };
            }
            for (const members of groups) {
                yield { kind: 'group', wikiCandidate, members };
            }
        }
    }

    async function worker(tasks) {
        for await (const task of tasks) {
            if (halted) continue; // drain without dispatching new model calls

            if (task.kind === 'solo') {
                let verification;
                try {
                    verification = await verifyCitation(task.citation.claimText, task.citation.source, { callModel });
                } catch (error) {
                    if (!halted) { halted = true; haltError = error; }
                    continue;
                }
                if (verification.usage) { funnel.verified++; await sleep(opts.delayMs); }
                if (recordVerdict(verification.verdict)) funnel.flagged++;

                await record(assembleFinding({
                    candidate: task.wikiCandidate, citation: task.citation, verification,
                    provider: opts.provider, model: opts.model, promptVersion: PROMPT_VERSION,
                }));
            } else {
                let verification;
                try {
                    verification = await verifyGroup(task.members, { callModel });
                } catch (error) {
                    if (!halted) { halted = true; haltError = error; }
                    continue;
                }
                funnel.groupsChecked++;
                if (verification.skipped) { funnel.groupsSkipped++; continue; }
                if (verification.usage) await sleep(opts.delayMs);
                if (recordVerdict(verification.verdict)) funnel.groupsFlagged++;

                await record(assembleGroupFinding({
                    candidate: task.wikiCandidate, members: task.members, verification,
                    provider: opts.provider, model: opts.model, promptVersion: PROMPT_VERSION,
                }));
            }
        }
    }

    try {
        // One shared source cache across the whole sweep, not per article —
        // the same reason service/claim-extractor.js's own header gives:
        // "one source is often cited across many articles."
        const tasks = generateTasks();
        await Promise.all(Array.from({ length: opts.concurrency }, () => worker(tasks)));
    } finally {
        console.log = realLog;
        if (toolsDbConnection) await toolsDbConnection.end();
    }

    // Computed after every worker has drained, not at the moment haltError
    // was set — other workers may have finished and recorded findings
    // concurrently between the failure and the pool actually stopping, so
    // findings.length here is the true final count, not a lower bound.
    const haltCode = haltError ? describeHalt(stderr, opts.provider, haltError, findings.length) : null;

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

// Halts on ANY error verifyCitation()/verifyGroup() throws, not just
// ProviderAuthError. A retry-exhausted 429/5xx (the case that matters at
// 1000-article scale) is just as unrecoverable *for this run* as an
// auth/billing error — core/retry.js already spent up to 5 attempts and a
// ~30s backoff before this surfaced, so it is not a one-off blip worth
// pressing on through. Previously only ProviderAuthError was caught here and
// everything else was rethrown uncaught, which meant a single mid-run 429
// (observed in practice: --delay-ms 0 against Lift Wing failed on the 3rd
// citation) crashed the process *before* the CSV write at the bottom of
// runSweep() ran, silently discarding every finding computed so far — the
// opposite of what the halt path is for.
function describeHalt(stderr, provider, error, writtenSoFar) {
    if (error instanceof ProviderAuthError) {
        stderr.write(
            `sweep: halting — ${provider} returned an auth/billing error (${error.status ?? '?'}): ${error.message}\n` +
            `sweep: ${writtenSoFar} finding(s) already computed are kept and will still be written to the CSV.\n`
        );
        return 3;
    }
    stderr.write(
        `sweep: halting — unrecoverable error calling ${provider}: ${error.message}\n` +
        `sweep: ${writtenSoFar} finding(s) already computed are kept and will still be written to the CSV.\n`
    );
    return 4;
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
