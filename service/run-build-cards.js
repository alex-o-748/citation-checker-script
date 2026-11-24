#!/usr/bin/env node
// Builds the Fact Hunt app's cards from stored findings.
//
//   node service/run-build-cards.js --findings-csv batch.csv [--findings-csv more.csv] --out cards.json
//   node service/run-build-cards.js --from-toolsdb --wiki enwiki --out cards.json
//
// Meant to run daily: each run re-reads the current revision of every
// candidate's article, so a card whose sentence was fixed, or whose article
// was protected, drops out. Model calls are cached in the output file
// (`decisions`), so a finding is sent to the model once per prompt version,
// not once a day. See docs/design-plans/2026-11-23-fact-hunt-app.md.

import { readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { hostForWiki } from '../core/wikipedia.js';
import { callProviderAPI } from '../core/providers.js';
import { PROVIDER_MODELS, PROVIDER_ENV_VARS } from './provider-config.js';
import { isAuthOrBillingError } from './verifier.js';
import { streamCsvRows } from './csv-stream.js';
import { buildCandidateQuery, normalizeFinding, candidateRejection, cardIdFor, findingHashes } from './cards/selection.js';
import { checkConflict, CONFLICT_PROMPT_VERSION } from './cards/conflict.js';
import { locateInWikitext } from './cards/find-text.js';
import {
    fetchPageStates, fetchTopicLabels, topicsFromLabels, fetchMonthlyViews,
    quoteInWikiLanguage, sourceLabelFor, lastFullMonth,
} from './cards/wiki.js';

export const CARDS_FILE_VERSION = 1;

function tally(counts, reason) {
    counts[reason] = (counts[reason] || 0) + 1;
}

/**
 * The whole build, with every outside call injected. Returns the cards file's
 * contents. `existing` is the previous cards file (or null): its decisions
 * and per-page topics are reused, and its views are reused within the same
 * month.
 */
export async function buildCards({
    findings,
    wiki,
    callModel,
    provider = null,
    model = null,
    existing = null,
    fetchImpl = fetch,
    now = new Date(),
    log = () => {},
}) {
    const dropped = {};
    const decisions = {};
    const previousDecisions = existing?.decisions || {};
    const previousPages = existing?.pages || {};
    const month = lastFullMonth(now).start;

    // 1. Rules that need only the finding itself.
    const candidates = new Map();
    for (const raw of findings) {
        const f = { ...raw, wiki: raw.wiki || wiki };
        if (f.wiki !== wiki) { tally(dropped, 'other_wiki'); continue; }
        const rejection = candidateRejection(f);
        if (rejection) { tally(dropped, rejection); continue; }
        const id = cardIdFor(f);
        // The same citation checked twice (two batches, two prompt versions)
        // is one card; keep the newest revision's finding.
        const prior = candidates.get(id);
        if (prior && (prior.f.revisionId ?? 0) >= (f.revisionId ?? 0)) { tally(dropped, 'duplicate'); continue; }
        if (prior) tally(dropped, 'duplicate');
        candidates.set(id, { id, f });
    }
    log(`cards: ${candidates.size} candidate findings after the text rules`);

    // 2. The articles as they are now.
    const titles = [...new Set([...candidates.values()].map(c => c.f.pageTitle))];
    const states = await fetchPageStates(titles, { wiki, fetchImpl });

    const cards = [];
    const pages = {};
    for (const { id, f } of candidates.values()) {
        const state = states.get(f.pageTitle);
        if (!state || state.missing) { tally(dropped, 'page_missing'); continue; }
        if (state.protection) { tally(dropped, 'protected'); continue; }
        if (state.pendingChanges) { tally(dropped, 'pending_changes'); continue; }
        if (state.isBlp === true) { tally(dropped, 'blp'); continue; }
        if (state.isBlp === null && f.isBlp !== false) { tally(dropped, 'blp_unknown'); continue; }
        if (!state.wikitext) { tally(dropped, 'no_wikitext'); continue; }
        if (!quoteInWikiLanguage(f.sourceQuote, { wiki })) { tally(dropped, 'source_language'); continue; }

        // 3. The conflict check, cached per card and prompt version.
        let decision = previousDecisions[id];
        const sameInputs = decision
            && decision.promptVersion === CONFLICT_PROMPT_VERSION
            && decision.claim === f.claimText
            && decision.quote === f.sourceQuote;
        if (!sameInputs) {
            const sourceLabel = sourceLabelFor(f.sourceUrl);
            let result;
            try {
                result = await checkConflict(
                    { articleTitle: state.title, claim: f.claimText, quote: f.sourceQuote, sourceLabel },
                    { callModel },
                );
            } catch (error) {
                if (isAuthOrBillingError(error)) throw error;
                log(`cards: conflict check failed for ${state.title} (${id}): ${error.message}`);
                tally(dropped, 'conflict_call_failed');
                continue; // not cached: tried again on the next build
            }
            if (!result.ok) {
                // A malformed answer is cached like any other: the same prompt
                // on the same text is likely to fail the same way.
                decision = { promptVersion: CONFLICT_PROMPT_VERSION, claim: f.claimText, quote: f.sourceQuote, keep: false, error: result.error, provider, model };
            } else {
                decision = {
                    promptVersion: CONFLICT_PROMPT_VERSION,
                    claim: f.claimText,
                    quote: f.sourceQuote,
                    keep: result.keep,
                    claimSpan: result.claimSpan,
                    quoteSpan: result.quoteSpan,
                    reason: result.reason,
                    provider,
                    model,
                };
            }
        }
        decisions[id] = decision;
        if (decision.error) { tally(dropped, `conflict_${decision.error}`); continue; }
        if (!decision.keep) { tally(dropped, 'both_can_be_true'); continue; }

        // 4. Is the sentence still there, and what to tell people to search for.
        const located = locateInWikitext(state.wikitext, f.claimText, decision.claimSpan);
        if (!located) { tally(dropped, 'sentence_not_found'); continue; }

        // 5. Topics and readers, once per page per build (topics are reused
        // from the last build; readers within the same month).
        const pageKey = String(state.pageId);
        if (!pages[pageKey]) {
            const before = previousPages[pageKey];
            let labels = before?.labels ?? null;
            if (!labels) {
                try {
                    labels = await fetchTopicLabels(state.title, { wiki, fetchImpl });
                } catch (error) {
                    log(`cards: topics failed for ${state.title}: ${error.message}`);
                    labels = null;
                }
            }
            let views = before?.viewsMonth === month ? before.views : undefined;
            if (views === undefined) {
                try {
                    views = await fetchMonthlyViews(state.title, { wiki, fetchImpl, now });
                } catch (error) {
                    log(`cards: pageviews failed for ${state.title}: ${error.message}`);
                    views = null;
                }
            }
            pages[pageKey] = { title: state.title, labels, views, viewsMonth: views == null ? null : month };
        }
        const page = pages[pageKey];
        if (page.labels === null) { tally(dropped, 'topics_unavailable'); continue; }
        const { topics, excluded } = topicsFromLabels(page.labels);
        if (excluded) { tally(dropped, 'excluded_topic'); continue; }

        cards.push({
            id,
            wiki,
            host: hostForWiki(wiki),
            pageId: state.pageId,
            pageTitle: state.title,
            revisionId: state.revisionId,
            section: located.section,
            claim: { text: f.claimText, span: { start: decision.claimSpan.start, end: decision.claimSpan.end } },
            quote: { text: f.sourceQuote, span: { start: decision.quoteSpan.start, end: decision.quoteSpan.end } },
            findText: located.findText,
            sourceUrl: f.sourceUrl,
            sourceLabel: sourceLabelFor(f.sourceUrl),
            topics,
            monthlyViews: page.views,
            reason: decision.reason,
            finding: { ...findingHashes(f), provider: f.provider, promptVersion: f.promptVersion, revisionId: f.revisionId },
        });
    }

    cards.sort((a, b) => (b.monthlyViews ?? -1) - (a.monthlyViews ?? -1) || a.id.localeCompare(b.id));
    return {
        version: CARDS_FILE_VERSION,
        generatedAt: now.toISOString(),
        wiki,
        conflictPromptVersion: CONFLICT_PROMPT_VERSION,
        provider,
        model,
        counts: { findings: findings.length, candidates: candidates.size, cards: cards.length },
        dropped,
        cards,
        decisions,
        pages,
    };
}

export function parseArgs(argv) {
    const opts = { findingsCsv: [], fromToolsDb: false, wiki: 'enwiki', provider: 'liftwing', model: null, out: 'cards.json', existing: null, limit: null };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const next = () => {
            const value = argv[++i];
            if (value === undefined) throw new Error(`${arg} needs a value`);
            return value;
        };
        if (arg === '--findings-csv') opts.findingsCsv.push(next());
        else if (arg === '--from-toolsdb') opts.fromToolsDb = true;
        else if (arg === '--wiki') opts.wiki = next();
        else if (arg === '--provider') opts.provider = next();
        else if (arg === '--model') opts.model = next();
        else if (arg === '--out') opts.out = next();
        else if (arg === '--existing') opts.existing = next();
        else if (arg === '--limit') opts.limit = Number(next());
        else if (arg === '--help' || arg === '-h') opts.help = true;
        else throw new Error(`Unknown argument: ${arg}`);
    }
    if (!opts.help && !opts.fromToolsDb && opts.findingsCsv.length === 0) {
        throw new Error('Pass --findings-csv <path> (repeatable) or --from-toolsdb');
    }
    if (!(opts.provider in PROVIDER_MODELS)) throw new Error(`Unknown provider: ${opts.provider}`);
    return opts;
}

async function readCsvFindings(paths, wiki) {
    const findings = [];
    for (const path of paths) {
        await streamCsvRows(path, { onRow: row => findings.push(normalizeFinding(row, { wiki })) });
    }
    return findings;
}

async function readToolsDbFindings(wiki, limit) {
    const { openToolsDbConnection } = await import('./toolsdb.js');
    const connection = await openToolsDbConnection();
    try {
        const { sql, params } = buildCandidateQuery({ wiki, limit });
        const [rows] = await connection.execute(sql, params);
        return rows.map(row => normalizeFinding(row, { wiki }));
    } finally {
        await connection.end();
    }
}

const HELP = `Builds Fact Hunt cards from stored findings.

  --findings-csv <path>  A batch findings CSV (repeatable)
  --from-toolsdb         Read findings from ToolsDB instead (on Toolforge)
  --wiki <db>            Wiki database name (default enwiki)
  --provider <id>        Model for the conflict check (default liftwing)
  --model <id>           Override the provider's default model
  --out <path>           Cards file to write (default cards.json)
  --existing <path>      Previous cards file to reuse decisions from (default: --out, if it exists)
  --limit <n>            Read at most n findings from ToolsDB`;

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) { console.log(HELP); return; }

    const model = opts.model || PROVIDER_MODELS[opts.provider];
    const keyVar = PROVIDER_ENV_VARS[opts.provider];
    const apiKey = keyVar ? process.env[keyVar] : undefined;
    if (keyVar && !apiKey) throw new Error(`${opts.provider} needs ${keyVar} set`);
    const callModel = ({ systemPrompt, userContent }) =>
        callProviderAPI(opts.provider, { apiKey, model, systemPrompt, userContent, temperature: 0 });

    const existingPath = opts.existing || (existsSync(opts.out) ? opts.out : null);
    const existing = existingPath ? JSON.parse(await readFile(existingPath, 'utf8')) : null;

    const findings = opts.fromToolsDb
        ? await readToolsDbFindings(opts.wiki, opts.limit)
        : await readCsvFindings(opts.findingsCsv, opts.wiki);
    console.error(`cards: read ${findings.length} findings`);

    const result = await buildCards({
        findings, wiki: opts.wiki, callModel, provider: opts.provider, model, existing,
        log: message => console.error(message),
    });

    // Write-then-rename, so the app never reads a half-written file.
    const tmp = `${opts.out}.tmp`;
    await writeFile(tmp, JSON.stringify(result, null, 2) + '\n');
    await rename(tmp, opts.out);

    console.error(`cards: wrote ${result.cards.length} cards to ${opts.out}`);
    const reasons = Object.entries(result.dropped).sort((a, b) => b[1] - a[1]);
    for (const [reason, count] of reasons) console.error(`  dropped ${String(count).padStart(5)}  ${reason}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(`cards: ${error.message}`);
        process.exit(1);
    });
}
