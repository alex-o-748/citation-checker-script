#!/usr/bin/env node
// Runnable integration test for stages 4-5 of the batch pipeline: verify and
// store. Feeds benchmark/dataset.json's stored claim/source pairs through
// service/verify.js and service/assemble.js, and — unless --dry-run — writes
// the results into the real ToolsDB citation_findings table via
// service/findings.js.
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
//   node service/replay.js --dry-run --limit 5                 # liftwing, no key needed
//   node service/replay.js --limit 20                          # writes to ToolsDB
//   node service/replay.js --dry-run --limit 5 --provider claude
//   node service/replay.js --help

import { readFile as fsReadFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { resolvePageIds } from './wikipedia-pageids.js';
import { verifyCitation, makeModelCaller, ProviderAuthError } from './verify.js';
import { assembleFinding } from './assemble.js';
import { buildUpsertQuery, upsertFinding } from './findings.js';
import { openToolsDbConnection } from './toolsdb.js';
import { makeQueryFn } from './replicas.js';
import { PROMPT_VERSION } from '../core/prompts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATASET_PATH = join(__dirname, '..', 'benchmark', 'dataset.json');

// Sourced from main.js's this.providers config, which is the authoritative,
// complete provider list — NOT from cli/verify.js's KNOWN_PROVIDERS, which
// omits 'liftwing' with no stated reason and was wrongly treated as
// authoritative in an earlier version of this file. That omission mattered
// more here than it does in cli/verify.js: Lift Wing, called from inside
// Toolforge, is the specific thing docs/design-plans/
// 2026-08-07-batch-source-checks-for-edit-suggestions.md §5 calls "the
// strongest single argument for Toolforge hosting" — a replay runner for a
// Toolforge migration that can't select it is missing its own point. Keep in
// sync with main.js's this.providers by hand if either changes.
const PROVIDER_MODELS = {
    publicai:    'aisingapore/Qwen-SEA-LION-v4-32B-IT',
    huggingface: 'openai/gpt-oss-20b',
    liftwing:    'llm-qwen36-27b',
    claude:      'claude-sonnet-4-6',
    gemini:      'gemini-flash-latest',
    openai:      'gpt-4o',
};

const PROVIDER_ENV_VARS = {
    publicai:    null,
    huggingface: null,
    liftwing:    null, // proxied through the CORS worker; no client-side key
    claude:      'CLAUDE_API_KEY',
    gemini:      'GEMINI_API_KEY',
    openai:      'OPENAI_API_KEY',
};

export function parseCliArgs(argv) {
    const { values } = parseArgs({
        args: argv.slice(2),
        options: {
            dataset:        { type: 'string', default: DEFAULT_DATASET_PATH },
            wiki:           { type: 'string', default: 'enwiki' },
            // liftwing default, not publicai: this runner exists for the
            // Toolforge migration, and Lift Wing is the provider that
            // migration is about — see the comment on PROVIDER_MODELS above.
            provider:       { type: 'string', default: 'liftwing' },
            model:          { type: 'string' },
            limit:          { type: 'string' },
            'delay-ms':     { type: 'string', default: '1000' },
            'dry-run':      { type: 'boolean', default: false },
            help:           { type: 'boolean', short: 'h', default: false },
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
    };
}

export const HELP_TEXT = `usage: node service/replay.js [options]

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
  --help, -h         Show this help and exit.

A halt on an auth/billing error (401/402/403) from the model stops the run
immediately, exit code 3 — see ProviderAuthError in service/verify.js. Every
finding written before the halt is kept; nothing is rolled back.
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

// Reshapes one dataset row into the citation shape service/verify.js and
// service/assemble.js expect (the shape service/pipeline.js's processArticle
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

    const callModel = makeModelCallerFn({ provider: opts.provider, apiKey, model: opts.model });

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
                if (error instanceof ProviderAuthError) {
                    stderr.write(
                        `replay: halting — ${opts.provider} returned an auth/billing error ` +
                        `(${error.status ?? '?'}): ${error.message}\n` +
                        `replay: ${written} finding(s) already written are kept; nothing further will be processed.\n`
                    );
                    return 3;
                }
                throw error;
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
