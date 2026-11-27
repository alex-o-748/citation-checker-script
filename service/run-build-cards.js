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

import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { hostForWiki, langCodeForWiki } from '../core/wikipedia.js';
import { callProviderAPI, groupMaxTokens } from '../core/providers.js';
import { runKnowledgeCheck, KNOWLEDGE_OUTCOMES, KNOWLEDGE_PROMPT_VERSION } from '../core/knowledge-check.js';
import { generateUncitedSystemPrompt, withUncitedCommentLanguage, uncitedChunkSize } from '../core/uncited-check.js';
import { paragraphAt, openingParagraph } from './cards/knowledge.js';
import { PROVIDER_MODELS, PROVIDER_ENV_VARS } from './provider-config.js';
import { isAuthOrBillingError } from './verifier.js';
import { withRetry } from '../core/retry.js';
import { streamCsvRows } from './csv-stream.js';
import { buildCandidateQuery, normalizeFinding, candidateRejection, cardIdFor, findingHashes } from './cards/selection.js';
import { checkConflict, CONFLICT_PROMPT_VERSION } from './cards/conflict.js';
import { locateInWikitext } from './cards/find-text.js';
import {
    fetchPageStates, fetchTopicLabels, topicsFromLabels, fetchMonthlyViews,
    quoteInWikiLanguage, sourceLabelFor, lastFullMonth, PAGE_BATCH_SIZE,
} from './cards/wiki.js';

export const CARDS_FILE_VERSION = 1;

function tally(counts, reason) {
    counts[reason] = (counts[reason] || 0) + 1;
}

// A model call that still fails after its retries is skipped (and tried again
// on the next build). This many in a row means the model service is down, not
// that one finding is odd: the build stops calling it, keeps what it has, and
// says so, rather than spending hours on a queue of failures.
export const MAX_CONSECUTIVE_MODEL_FAILURES = 10;

// Progress is handed to onCheckpoint after this many new model decisions, so
// a build that dies (out of memory, a killed job) loses at most this many.
export const CHECKPOINT_EVERY = 25;

/**
 * The whole build, with every outside call injected. Returns the cards file's
 * contents. `existing` is the previous cards file (or a checkpoint, or null):
 * its decisions and per-page topics are reused, and its views are reused
 * within the same month.
 *
 * Articles are read PAGE_BATCH_SIZE at a time and their wikitext dropped once
 * their findings are done. The first version read every candidate article
 * before starting, and on a real ToolsDB run (hundreds of articles) that ran
 * the job out of memory after 90 minutes, with nothing saved.
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
    onCheckpoint = null,
    retry = {},
    pageBatchSize = PAGE_BATCH_SIZE,
    knowledgeCheck = false,
}) {
    const dropped = {};
    const decisions = {};
    const previousDecisions = existing?.decisions || {};
    // --knowledge-check results made by this builder, cached per card like
    // the conflict decisions (a stored finding's own result is used first).
    const knowledge = {};
    const previousKnowledge = existing?.knowledge || {};
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
    const byTitle = new Map();
    for (const c of candidates.values()) {
        if (!byTitle.has(c.f.pageTitle)) byTitle.set(c.f.pageTitle, []);
        byTitle.get(c.f.pageTitle).push(c);
    }
    const titles = [...byTitle.keys()];
    log(`cards: ${candidates.size} candidate findings in ${titles.length} articles after the text rules`);

    const cards = [];
    const pages = {};
    let newDecisions = 0;
    let consecutiveFailures = 0;
    let modelDown = null;

    const snapshot = () => ({
        decisions: { ...previousDecisions, ...decisions },
        pages: { ...previousPages, ...pages },
        ...(knowledgeCheck ? { knowledge: { ...previousKnowledge, ...knowledge } } : {}),
    });

    // The knowledge check's result for each ready card of one article, by
    // card id: the finding's stored result when it is current, else this
    // builder's cached one, else one call (or a few) for the rest, with the
    // paragraph context read from the wikitext. A card missing from the map
    // (the model is down, or its call failed) was not checked: it is not
    // dealt this build and is tried again on the next.
    async function knowledgeFor(state, ready) {
        const out = new Map();
        const todo = [];
        for (const r of ready) {
            const { id, f } = r;
            if (f.knowledgeCheck && f.knowledgeCheck !== KNOWLEDGE_OUTCOMES.ERROR
                && f.knowledgePromptVersion === KNOWLEDGE_PROMPT_VERSION) {
                out.set(id, { outcome: f.knowledgeCheck, confidence: f.knowledgeConfidence, promptVersion: f.knowledgePromptVersion });
                continue;
            }
            const cached = previousKnowledge[id];
            if (cached && cached.promptVersion === KNOWLEDGE_PROMPT_VERSION && cached.claim === f.claimText) {
                knowledge[id] = cached;
                out.set(id, cached);
                continue;
            }
            todo.push(r);
        }
        if (todo.length === 0 || modelDown) return out;
        const claims = todo.map(({ id, f, located }) => ({
            key: id,
            claimText: f.claimText,
            sectionTitle: located.section || null,
            paragraphText: paragraphAt(state.wikitext, located.offset) || null,
        }));
        const articleLangCode = langCodeForWiki(wiki);
        let run;
        try {
            run = await runKnowledgeCheck({ claims, articleTitle: state.title, opening: openingParagraph(state.wikitext) }, {
                callModel: (systemPrompt, userContent) => callModel({ systemPrompt, userContent, kind: 'knowledge' }),
                systemPrompt: withUncitedCommentLanguage(generateUncitedSystemPrompt(), { lang: articleLangCode, articleLangCode }),
                chunkSize: uncitedChunkSize(provider),
                retry: { maxRetries: 4, minBackoffMs: 2000, maxBackoffMs: 30000, ...retry },
                onChunkError: error => {
                    if (isAuthOrBillingError(error)) throw error;
                    log(`cards: knowledge check failed for ${state.title}: ${error.message}`);
                    return 'call_failed';
                },
            });
        } catch (error) {
            if (isAuthOrBillingError(error)) throw error;
            log(`cards: knowledge check failed for ${state.title}: ${error.message}`);
            return out;
        }
        let anyAnswered = false;
        for (const { id, f } of todo) {
            const result = run.results.get(id);
            if (!result || result.outcome === KNOWLEDGE_OUTCOMES.ERROR) continue; // not cached: tried again next build
            anyAnswered = true;
            const entry = { promptVersion: run.promptVersion, claim: f.claimText, outcome: result.outcome, confidence: result.confidence, provider, model };
            knowledge[id] = entry;
            out.set(id, entry);
        }
        if (anyAnswered) {
            consecutiveFailures = 0;
        } else {
            consecutiveFailures += 1;
            if (consecutiveFailures >= MAX_CONSECUTIVE_MODEL_FAILURES) {
                modelDown = 'knowledge check calls kept failing';
                log(`cards: ${consecutiveFailures} model calls in a row failed; no more model calls this build`);
            }
        }
        return out;
    }

    async function decide(id, f, state) {
        const cached = previousDecisions[id];
        if (cached
            && cached.promptVersion === CONFLICT_PROMPT_VERSION
            && cached.claim === f.claimText
            && cached.quote === f.sourceQuote) return cached;
        if (modelDown) return { skipped: 'model_unavailable' };
        let result;
        try {
            result = await withRetry(() => checkConflict(
                { articleTitle: state.title, claim: f.claimText, quote: f.sourceQuote, sourceLabel: sourceLabelFor(f.sourceUrl) },
                { callModel },
            ), { maxRetries: 4, minBackoffMs: 2000, maxBackoffMs: 30000, ...retry });
        } catch (error) {
            if (isAuthOrBillingError(error)) throw error;
            consecutiveFailures += 1;
            log(`cards: conflict check failed for ${state.title} (${id}): ${error.message}`);
            if (consecutiveFailures >= MAX_CONSECUTIVE_MODEL_FAILURES) {
                modelDown = error.message;
                log(`cards: ${consecutiveFailures} model calls in a row failed; no more model calls this build`);
            }
            return { skipped: 'conflict_call_failed' }; // not cached: tried again on the next build
        }
        consecutiveFailures = 0;
        // A malformed answer is cached like any other: the same prompt on the
        // same text is likely to fail the same way.
        const decision = result.ok
            ? { promptVersion: CONFLICT_PROMPT_VERSION, claim: f.claimText, quote: f.sourceQuote, keep: result.keep, claimSpan: result.claimSpan, quoteSpan: result.quoteSpan, reason: result.reason, provider, model }
            : { promptVersion: CONFLICT_PROMPT_VERSION, claim: f.claimText, quote: f.sourceQuote, keep: false, error: result.error, provider, model };
        newDecisions += 1;
        return decision;
    }

    async function pageInfo(state) {
        const pageKey = String(state.pageId);
        if (pages[pageKey]) return pages[pageKey];
        const before = previousPages[pageKey];
        let labels = before?.labels ?? null;
        if (!labels) {
            try {
                labels = await withRetry(() => fetchTopicLabels(state.title, { wiki, fetchImpl }), { maxRetries: 3, ...retry });
            } catch (error) {
                log(`cards: topics failed for ${state.title}: ${error.message}`);
                labels = null;
            }
        }
        let views = before?.viewsMonth === month ? before.views : undefined;
        if (views === undefined) {
            try {
                views = await withRetry(() => fetchMonthlyViews(state.title, { wiki, fetchImpl, now }), { maxRetries: 3, ...retry });
            } catch (error) {
                log(`cards: pageviews failed for ${state.title}: ${error.message}`);
                views = null;
            }
        }
        pages[pageKey] = { title: state.title, labels, views, viewsMonth: views == null ? null : month };
        return pages[pageKey];
    }

    // 2. The articles as they are now, a batch at a time.
    for (let i = 0; i < titles.length; i += pageBatchSize) {
        const batch = titles.slice(i, i + pageBatchSize);
        const states = await withRetry(() => fetchPageStates(batch, { wiki, fetchImpl, batchSize: pageBatchSize }), { maxRetries: 4, ...retry });

        for (const title of batch) {
            const state = states.get(title);
            // Cards that passed every other rule, held until the article's
            // knowledge check (when on) has run over all of them at once.
            const ready = [];
            for (const { id, f } of byTitle.get(title)) {
                if (!state || state.missing) { tally(dropped, 'page_missing'); continue; }
                if (state.protection) { tally(dropped, 'protected'); continue; }
                if (state.pendingChanges) { tally(dropped, 'pending_changes'); continue; }
                if (state.isBlp === true) { tally(dropped, 'blp'); continue; }
                if (state.isBlp === null && f.isBlp !== false) { tally(dropped, 'blp_unknown'); continue; }
                if (!state.wikitext) { tally(dropped, 'no_wikitext'); continue; }
                if (!quoteInWikiLanguage(f.sourceQuote, { wiki })) { tally(dropped, 'source_language'); continue; }

                // 3. The conflict check, cached per card and prompt version.
                const decision = await decide(id, f, state);
                if (decision.skipped) { tally(dropped, decision.skipped); continue; }
                decisions[id] = decision;
                if (onCheckpoint && newDecisions > 0 && newDecisions % CHECKPOINT_EVERY === 0) {
                    await onCheckpoint(snapshot());
                }
                if (decision.error) { tally(dropped, `conflict_${decision.error}`); continue; }
                if (!decision.keep) { tally(dropped, 'both_can_be_true'); continue; }

                // 4. Is the sentence still there, and what to tell people to search for.
                const located = locateInWikitext(state.wikitext, f.claimText, decision.claimSpan);
                if (!located) { tally(dropped, 'sentence_not_found'); continue; }

                // 5. Topics and readers, once per page per build (topics are
                // reused from the last build; readers within the same month).
                const page = await pageInfo(state);
                if (page.labels === null) { tally(dropped, 'topics_unavailable'); continue; }
                const { topics, excluded } = topicsFromLabels(page.labels);
                if (excluded) { tally(dropped, 'excluded_topic'); continue; }
                ready.push({ id, f, decision, located, page, topics });
            }

            // 6. --knowledge-check: deal only a card whose claim the model,
            // without the source, independently doubts. A not-doubted card is
            // not "probably true", only not dealt.
            const knowledgeResults = knowledgeCheck && ready.length ? await knowledgeFor(state, ready) : null;
            for (const { id, f, decision, located, page, topics } of ready) {
                let knowledgeResult = null;
                if (knowledgeCheck) {
                    knowledgeResult = knowledgeResults.get(id);
                    if (!knowledgeResult) { tally(dropped, 'knowledge_unchecked'); continue; }
                    if (knowledgeResult.outcome !== KNOWLEDGE_OUTCOMES.DOUBTED) { tally(dropped, 'not_doubted'); continue; }
                }
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
                    // Which knowledge check dealt the card. Its comment is
                    // never on a card: the fix comes only from the source.
                    ...(knowledgeResult ? { knowledge: { confidence: knowledgeResult.confidence ?? null, promptVersion: knowledgeResult.promptVersion } } : {}),
                });
            }
        }
        log(`cards: ${Math.min(i + pageBatchSize, titles.length)}/${titles.length} articles, ${cards.length} cards, ${newDecisions} new model decisions`);
    }

    cards.sort((a, b) => (b.monthlyViews ?? -1) - (a.monthlyViews ?? -1) || a.id.localeCompare(b.id));
    // Decisions for findings not seen this build are kept, so a finding that
    // drops out for a day (a protected article) doesn't cost a model call when
    // it comes back.
    const { decisions: allDecisions, pages: allPages, knowledge: allKnowledge } = snapshot();
    return {
        version: CARDS_FILE_VERSION,
        generatedAt: now.toISOString(),
        wiki,
        conflictPromptVersion: CONFLICT_PROMPT_VERSION,
        ...(knowledgeCheck ? { knowledgePromptVersion: KNOWLEDGE_PROMPT_VERSION } : {}),
        provider,
        model,
        complete: !modelDown,
        stoppedReason: modelDown,
        counts: { findings: findings.length, candidates: candidates.size, cards: cards.length },
        dropped,
        cards,
        decisions: allDecisions,
        pages: allPages,
        ...(knowledgeCheck ? { knowledge: allKnowledge } : {}),
    };
}

export function parseArgs(argv) {
    const opts = { findingsCsv: [], fromToolsDb: false, wiki: 'enwiki', provider: 'liftwing', model: null, out: 'cards.json', existing: null, limit: null, knowledgeCheck: false };
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
        else if (arg === '--knowledge-check') opts.knowledgeCheck = true;
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

async function readToolsDbFindings(wiki, limit, withKnowledge = false) {
    const { openToolsDbConnection } = await import('./toolsdb.js');
    const connection = await openToolsDbConnection();
    try {
        const { sql, params } = buildCandidateQuery({ wiki, limit, withKnowledge });
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
  --limit <n>            Read at most n findings from ToolsDB
  --knowledge-check      Deal only cards whose claim the model, without the
                         source, doubts (core/knowledge-check.js). Uses the
                         finding's stored result when current, else checks the
                         article itself. With --from-toolsdb it needs
                         service/migrations/007-knowledge-check.sql applied.`;

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) { console.log(HELP); return; }

    const model = opts.model || PROVIDER_MODELS[opts.provider];
    const keyVar = PROVIDER_ENV_VARS[opts.provider];
    const apiKey = keyVar ? process.env[keyVar] : undefined;
    if (keyVar && !apiKey) throw new Error(`${opts.provider} needs ${keyVar} set`);
    // The knowledge check weighs several claims per call, so it gets the
    // larger output budget the uncited check gets in the sweep.
    const callModel = ({ systemPrompt, userContent, kind }) =>
        callProviderAPI(opts.provider, {
            apiKey, model, systemPrompt, userContent, temperature: 0,
            ...(kind === 'knowledge' && groupMaxTokens(opts.provider) ? { maxTokens: groupMaxTokens(opts.provider) } : {}),
        });

    const existingPath = opts.existing || (existsSync(opts.out) ? opts.out : null);
    const existing = existingPath ? JSON.parse(await readFile(existingPath, 'utf8')) : null;
    // A build that died or stopped early left its model decisions here; they
    // are reused like the last cards file's, so a rerun picks up where it was.
    const checkpointPath = `${opts.out}.checkpoint.json`;
    const checkpoint = existsSync(checkpointPath) ? JSON.parse(await readFile(checkpointPath, 'utf8')) : null;
    const reuse = {
        decisions: { ...(existing?.decisions || {}), ...(checkpoint?.decisions || {}) },
        pages: { ...(existing?.pages || {}), ...(checkpoint?.pages || {}) },
        knowledge: { ...(existing?.knowledge || {}), ...(checkpoint?.knowledge || {}) },
    };
    if (checkpoint) console.error(`cards: resuming with ${Object.keys(checkpoint.decisions || {}).length} decisions from ${checkpointPath}`);

    const findings = opts.fromToolsDb
        ? await readToolsDbFindings(opts.wiki, opts.limit, opts.knowledgeCheck)
        : await readCsvFindings(opts.findingsCsv, opts.wiki);
    console.error(`cards: read ${findings.length} findings`);

    const writeAtomically = async (path, data) => {
        const tmp = `${path}.tmp`;
        await writeFile(tmp, JSON.stringify(data) + '\n');
        await rename(tmp, path);
    };

    const result = await buildCards({
        findings, wiki: opts.wiki, callModel, provider: opts.provider, model, existing: reuse,
        knowledgeCheck: opts.knowledgeCheck,
        log: message => console.error(message),
        onCheckpoint: data => writeAtomically(checkpointPath, data),
    });

    // Write-then-rename, so the app never reads a half-written file.
    await writeAtomically(opts.out, result);
    console.error(`cards: wrote ${result.cards.length} cards to ${opts.out}`);
    const reasons = Object.entries(result.dropped).sort((a, b) => b[1] - a[1]);
    for (const [reason, count] of reasons) console.error(`  dropped ${String(count).padStart(5)}  ${reason}`);

    if (!result.complete) {
        // The decisions so far are in the cards file too; keep the checkpoint
        // as well, so the next run resumes even if the cards file is replaced.
        await writeAtomically(checkpointPath, { decisions: result.decisions, pages: result.pages, knowledge: result.knowledge });
        console.error(`cards: stopped early, the model was unavailable (${result.stoppedReason}). Run again later to finish.`);
        process.exitCode = 3;
    } else if (existsSync(checkpointPath)) {
        await unlink(checkpointPath);
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(`cards: ${error.message}`);
        process.exit(1);
    });
}
