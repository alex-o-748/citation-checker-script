#!/usr/bin/env node
// Runnable integration test for stages 4-5 of the batch pipeline: verify and
// store. Feeds benchmark/dataset.json's stored claim/source pairs through
// service/verifier.js and service/finding-builder.js, and — unless --dry-run — writes
// the results into the real ToolsDB citation_findings table via
// service/findings-store.js.
//
// This is the replay path docs/design-plans/
// 2026-08-22-batch-verification-and-persistence.md calls "the highest-value
// step in the whole sequence": it exercises the full verify -> assemble ->
// store chain against real claims, real sources, and a real model, with zero
// outbound requests to third-party publisher sites — the dataset's
// source_text was fetched once when the dataset was built, so this run
// touches only the model API and (for page-id resolution) the Wikipedia
// Action API, neither of which is behind the WMCS egress question stage 3's
// live source fetch is gated on.
//
// Two things this script needs that only run with real network access, so
// there is no way to smoke-test it from this environment — see that design
// doc's §11 for the full runbook:
//   1. A provider API key (any environment reachable, e.g. your laptop).
//   2. For a real (non---dry-run) write, ToolsDB access, which only exists
//      from inside Wikimedia Cloud infrastructure — the Toolforge bastion.
//
// Usage:
//   node service/run-replay.js --dry-run --limit 5                 # liftwing, no key needed
//   node service/run-replay.js --limit 20                          # writes to ToolsDB
//   node service/run-replay.js --dry-run --limit 5 --provider claude
//   node service/run-replay.js --help

import { readFile as fsReadFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { resolvePageIds } from './wikipedia-pageids.js';
import { verifyCitation, makeModelCaller, ProviderAuthError } from './verifier.js';
import { assembleFinding } from './finding-builder.js';
import { buildUpsertQuery, upsertFinding } from './findings-store.js';
import { openToolsDbConnection } from './toolsdb.js';
import { makeQueryFn } from './replicas.js';
import { PROMPT_VERSION } from '../core/prompts.js';
import { PROVIDER_MODELS, PROVIDER_ENV_VARS } from './provider-config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATASET_PATH = join(__dirname, '..', 'benchmark', 'dataset.json');

// See the matching comment in service/run-sweep.js: without this, "--provider
// liftwing" measures the Cloudflare Worker's shared approved-bot-JWT budget
// (core/providers.js's callLiftwingAPI() default workerBase), not Lift Wing
// accessed directly from inside Toolforge via tf-llm-router — the path the
// parent design doc's §5 Toolforge-migration argument is actually about.
const TOOLFORGE_LLM_ROUTER_BASE = 'https://llm-router.toolforge.org';

export function parseCliArgs(argv) {
    const { values } = parseArgs({
        args: argv.slice(2),
        options: {
            dataset:          { type: 'string', default: DEFAULT_DATASET_PATH },
            wiki:             { type: 'string', default: 'enwiki' },
            // liftwing default, not publicai: this runner exists for the
            // Toolforge migration, and Lift Wing is the provider that
            // migration is about — see the comment in ./provider-config.js.
            provider:         { type: 'string', default: 'liftwing' },
            model:            { type: 'string' },
            limit:            { type: 'string' },
            'delay-ms':       { type: 'string', default: '1000' },
            'dry-run':        { type: 'boolean', default: false },
            'live-llm-router': { type: 'boolean', default: false },
            help:             { type: 'boolean', short: 'h', default: false },
        },
        strict: true,
    });

    return {
        help: values.help,
        dataset: values.dataset,
        wiki: values.wiki,
        provider: values.provider,
        model: values.model || PROVIDER_MODELS[values.provider],
        limit: values.limit ? Number(values.limit) : Infinity,
        delayMs: Number(values['delay-ms']),
        dryRun: values['dry-run'],
        liveLlmRouter: values['live-llm-router'],
    };
}

export const HELP_TEXT = `usage: node service/run-replay.js [options]

Runs benchmark/dataset.json's stored claim/source pairs through the batch
pipeline's verify and store stages, proving the chain end to end with zero
outbound requests to third-party publisher sites (source_text was already
fetched when the dataset was built).

Options:
  --dataset <path>   Dataset JSON file (default: benchmark/dataset.json)
  --wiki <db>        Wiki database name recorded on each finding (default: enwiki)
  --provider <name>  One of: ${Object.keys(PROVIDER_MODELS).join(', ')} (default: liftwing)
  --model <id>       Override the provider's default model
  --limit <n>        Only process the first n dataset rows (default: all)
  --delay-ms <n>     Delay between model calls, ms (default: 1000)
  --dry-run          Verify and assemble, but do not connect to ToolsDB or
                      write anything — prints each finding to stdout instead.
                      Runnable from anywhere with a provider API key; no
                      bastion or ~/replica.my.cnf needed.
  --live-llm-router  When --provider is liftwing, route the model call
                      through tf-llm-router
                      (https://github.com/alex-o-748/tf-llm-router) instead
                      of the Cloudflare Worker CORS proxy. See the comment on
                      TOOLFORGE_LLM_ROUTER_BASE in this file — the two paths
                      have different rate-limit behavior and should be
                      measured separately.
  --help, -h         Show this help and exit.

A halt on an auth/billing error (401/402/403) from the model stops the run
immediately, exit code 3 — see ProviderAuthError in service/verifier.js. Any
other unrecoverable model-call error (e.g. a 429 that exhausted retries)
halts the same way, exit code 4. Every finding written before the halt is
kept; nothing is rolled back.
`;

// Pulls the pinned revision id out of a dataset row's article_url
// (".../w/index.php?title=...&oldid=NNNN"). All 189 rows in the current
// dataset carry one; a row that somehow doesn't is skipped, not fatal.
export function extractOldid(articleUrl) {
    try {
        const oldid = new URL(articleUrl).searchParams.get('oldid');
        return oldid ? Number(oldid) : null;
    } catch {
        return null;
    }
}

// Reshapes one dataset row into the citation shape service/verifier.js and
// service/finding-builder.js expect (the shape service/claim-extractor.js's processArticle
// produces for a live-fetched citation). No groups: the replay corpus has
// none to reshape (see the design doc's §3, "Wrinkle 2").
export function toCitation(row) {
    const hasSource = Boolean(row.source_text);
    return {
        claimText: row.claim_text,
        citationNumber: row.citation_number ?? null,
        url: row.source_url ?? null,
        groupId: null,
        source: hasSource
            ? {
                content: `Source URL: ${row.source_url}\n\nSource Content:\n${row.source_text}`,
                status: 200,
                error: null,
            }
            : {
                content: null,
                status: null,
                error: row.source_url ? 'dataset row has no stored source_text' : null,
                unavailableReason: row.source_url ? 'fetch_failed' : 'no_url',
            },
    };
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export async function runReplay(opts, {
    stdout = process.stdout,
    stderr = process.stderr,
    env = process.env,
    readFile = fsReadFile,
    connectToolsDb = openToolsDbConnection,
    resolvePageIdsFn = resolvePageIds,
    makeModelCallerFn = makeModelCaller,
} = {}) {
    const envVar = PROVIDER_ENV_VARS[opts.provider];
    const apiKey = envVar ? env[envVar] : undefined;
    if (envVar && !apiKey) {
        stderr.write(`replay: ${envVar} environment variable is required for provider "${opts.provider}"\n`);
        return 2;
    }

    let dataset;
    try {
        dataset = JSON.parse(await readFile(opts.dataset, 'utf8'));
    } catch (error) {
        stderr.write(`replay: could not read dataset ${opts.dataset}: ${error.message}\n`);
        return 1;
    }

    const rows = dataset.rows.slice(0, opts.limit);
    stderr.write(`replay: ${rows.length} row(s) from ${opts.dataset}\n`);

    const titles = [...new Set(rows.map(r => r.article_title))];
    let pageIds;
    try {
        pageIds = await resolvePageIdsFn(titles);
    } catch (error) {
        stderr.write(`replay: could not resolve page IDs: ${error.message}\n`);
        return 1;
    }
    stderr.write(`replay: resolved ${pageIds.size}/${titles.length} article title(s) to page IDs\n`);

    let connection = null;
    let queryFn = null;
    if (!opts.dryRun) {
        try {
            connection = await connectToolsDb({ readFile });
            queryFn = makeQueryFn(connection);
        } catch (error) {
            stderr.write(`replay: could not connect to ToolsDB: ${error.message}\n`);
            return 1;
        }
    }

    const useLlmRouter = opts.liveLlmRouter && opts.provider === 'liftwing';
    if (opts.liveLlmRouter && opts.provider !== 'liftwing') {
        stderr.write(`replay: --live-llm-router only affects --provider liftwing; ignoring for "${opts.provider}"\n`);
    }
    if (useLlmRouter) {
        stderr.write(`replay: routing liftwing via ${TOOLFORGE_LLM_ROUTER_BASE}\n`);
    }
    const callModel = makeModelCallerFn({
        provider: opts.provider, apiKey, model: opts.model,
        ...(useLlmRouter ? { workerBase: TOOLFORGE_LLM_ROUTER_BASE } : {}),
    });

    let processed = 0, skippedNoPageId = 0, skippedNoRevision = 0, written = 0;
    const verdictCounts = {};

    try {
        for (const row of rows) {
            const revisionId = extractOldid(row.article_url);
            if (!revisionId) {
                skippedNoRevision++;
                stderr.write(`replay: skipping ${row.id} (no oldid in article_url)\n`);
                continue;
            }
            const pageId = pageIds.get(row.article_title);
            if (!pageId) {
                skippedNoPageId++;
                stderr.write(`replay: skipping ${row.id} (could not resolve page ID for "${row.article_title}")\n`);
                continue;
            }

            const citation = toCitation(row);

            let verification;
            try {
                verification = await verifyCitation(citation.claimText, citation.source, { callModel });
            } catch (error) {
                // Halts on ANY error, not just ProviderAuthError — see the
                // matching comment on run-sweep.js's describeHalt() for why a
                // retry-exhausted 429/5xx gets the same halt-and-preserve
                // treatment rather than crashing uncaught.
                if (error instanceof ProviderAuthError) {
                    stderr.write(
                        `replay: halting — ${opts.provider} returned an auth/billing error ` +
                        `(${error.status ?? '?'}): ${error.message}\n` +
                        `replay: ${written} finding(s) already written are kept; nothing further will be processed.\n`
                    );
                    return 3;
                }
                stderr.write(
                    `replay: halting — unrecoverable error calling ${opts.provider}: ${error.message}\n` +
                    `replay: ${written} finding(s) already written are kept; nothing further will be processed.\n`
                );
                return 4;
            }

            verdictCounts[verification.verdict] = (verdictCounts[verification.verdict] || 0) + 1;

            const finding = assembleFinding({
                candidate: { wiki: opts.wiki, pageId, title: row.article_title, revisionId },
                citation,
                verification,
                provider: opts.provider,
                model: opts.model,
                promptVersion: PROMPT_VERSION,
            });

            if (opts.dryRun) {
                stdout.write(JSON.stringify({ row: row.id, finding }) + '\n');
            } else {
                await upsertFinding(queryFn, finding);
                written++;
            }
            processed++;

            if (opts.delayMs > 0) await sleep(opts.delayMs);
        }
    } finally {
        if (connection) await connection.end();
    }

    stderr.write(
        `replay: done. ${processed} processed, ${skippedNoPageId} skipped (no page ID), ` +
        `${skippedNoRevision} skipped (no oldid), ${written} written to ToolsDB.\n` +
        `replay: verdicts: ${JSON.stringify(verdictCounts)}\n`
    );
    return 0;
}

export async function main(argv, io = {}) {
    const opts = parseCliArgs(argv);
    if (opts.help) {
        (io.stdout ?? process.stdout).write(HELP_TEXT);
        return 0;
    }
    return runReplay(opts, io);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main(process.argv).then(code => process.exit(code));
}
