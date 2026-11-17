#!/usr/bin/env node
// Nightly triage of editor feedback: rated checks in, field-set rows out.
//
// A row whose label the rule agrees on (adjudicate.js proposeLabel) is
// accepted as it lands; everything else is written but held out of scoring
// until the owner decides it. Nobody approves the run: oversight is the
// weekly digest (digest.js), which spot-checks accepted labels at random and
// lists the held ones. If spot-checks keep finding wrong labels, agreed rows
// are held too until they stop (autoAcceptState).
//
//   node feedback-loop/run-triage.js --cases cases.json [options]
//
//   --cases FILE        JSON array from feedback-loop/sql/cases.sql (required)
//   --field FILE        field set to read and extend (default benchmark/dataset_field.json)
//   --report FILE       write the run's report (Markdown) here
//   --limit N           cases to triage this run, disputed first (default 40)
//   --concurrency N     cases in flight at once (default 2)
//   --model ID          adjudicator model (default $ADJUDICATOR_MODEL or claude-opus-5-5)
//   --effort LEVEL      output_config.effort for the adjudicator (default: API default)
//   --retriage          re-read cases already in the field set (owner decisions are kept)
//   --dry-run           fetch and tag only: no model calls, field set untouched
//   --worker-base URL   source-fetch proxy (default core/worker.js's)
//   --date YYYY-MM-DD   report date (default today, UTC)
//
// Needs ANTHROPIC_API_KEY unless --dry-run. Exit codes: 0 done; 1 bad
// arguments or input; 2 halted on a model auth/billing error (401/402/403).
// What was triaged before the halt is still written: a spent budget should
// cost the rest of the run, not the part already paid for.

import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { fetchSourceContent } from '../core/worker.js';
import { extractSourceText } from '../core/prompts.js';
import { callClaudeAPI } from '../core/providers.js';
import { normalizeCase, selectForTriage } from './cases.js';
import { tagCauses } from './causes.js';
import { adjudicateCase, proposeLabel, ADJUDICATOR_VERSION, LABEL_STATUSES } from './adjudicate.js';
import { buildFieldRow, mergeFieldRows, summarizeFieldRows, loadFieldSet, writeFieldSet } from './field-set.js';
import { autoAcceptState } from './digest.js';
import { renderTriageReport } from './report.js';

export const DEFAULT_MODEL = 'claude-opus-5-5';
export const DEFAULT_LIMIT = 40;

// fetchSourceContent frames the body ("Source URL: …\nTruncated: true\n\nSource
// Content:\n…"); the field set stores the body and the flag separately, as
// dataset.json does.
export function unframeSource(content) {
    const marker = content.indexOf('Source Content:');
    const header = marker === -1 ? '' : content.slice(0, marker);
    return { sourceText: extractSourceText(content), sourceTruncated: /^Truncated: true$/m.test(header) };
}

export class HaltError extends Error {}

const AUTH_FAILURE = /\((401|402|403)\)/;
const TRANSIENT = /\((429|500|502|503|504|529)\)|^fetch failed$|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i;

/**
 * Wraps a model call: transient failures (including Anthropic's 529
 * "overloaded", which core/retry.js does not retry) get a few attempts with
 * backoff; an auth or billing failure halts the whole run.
 */
export function resilientModel(call, { attempts = 4, baseDelayMs = 2000, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
    return async req => {
        for (let attempt = 1; ; attempt++) {
            try {
                return await call(req);
            } catch (error) {
                const message = error?.message ?? String(error);
                if (AUTH_FAILURE.test(message)) throw new HaltError(message);
                if (attempt >= attempts || !TRANSIENT.test(message)) throw error;
                await sleep(baseDelayMs * 2 ** (attempt - 1));
            }
        }
    };
}

/** An agreed label, held for the owner while auto-accepting is paused. */
export function holdIfPaused(label, state) {
    if (!state?.paused || label.labelStatus !== LABEL_STATUSES.AGREED) return label;
    return {
        ...label,
        held: true,
        reasons: [...label.reasons, `held: auto-accept is paused (${state.wrong} of the last ${state.checked} spot-checks were wrong)`],
    };
}

async function triageOne(c, { fetchSource, callModel, dryRun, model, now, autoAccept }) {
    const fetched = await fetchSource(c.check.sourceUrl);
    if (!fetched?.content) {
        return { failure: { case: c, stage: 'fetch', error: fetched?.error || 'no content' } };
    }
    const { sourceText, sourceTruncated } = unframeSource(fetched.content);
    const hints = tagCauses(c.check);
    if (dryRun) return { result: { case: c, adjudication: null, label: null, hints, sourceLength: sourceText.length } };

    let adjudication;
    try {
        adjudication = await adjudicateCase(c, { sourceText, sourceTruncated, hints, callModel, model });
    } catch (error) {
        if (error instanceof HaltError) throw error;
        return { failure: { case: c, stage: 'adjudication', error: error?.message ?? String(error) } };
    }
    const label = holdIfPaused(proposeLabel(c, adjudication), autoAccept);
    const row = buildFieldRow(c, {
        sourceText, sourceTruncated,
        fetchedAt: now(), adjudication, label, hints, triagedAt: now(),
    });
    return { result: { case: c, adjudication, label, hints, row } };
}

/**
 * The whole run, with every outside dependency injected so it can be tested
 * without a network: fetchSource(url) -> {content, error}, and callModel as
 * adjudicateCase() expects it.
 */
export async function runTriage({
    caseRows,
    fieldRows = [],
    fetchSource,
    callModel = null,
    limit = DEFAULT_LIMIT,
    concurrency = 2,
    retriage = false,
    dryRun = false,
    model = null,
    date,
    now = () => new Date().toISOString(),
}) {
    if (!dryRun && !callModel) throw new TypeError('runTriage needs callModel unless dryRun');
    const cases = caseRows.map(normalizeCase);
    const triagedIds = fieldRows.map(r => r.field?.check_id).filter(Boolean);
    const { toTriage, deferred, skipped } = selectForTriage(cases, triagedIds, { limit, retriage });
    const autoAccept = autoAcceptState(fieldRows);

    const results = [];
    const failures = [];
    let halted = null;
    const queue = [...toTriage];
    const worker = async () => {
        while (queue.length && !halted) {
            const c = queue.shift();
            try {
                const out = await triageOne(c, { fetchSource, callModel, dryRun, model, now, autoAccept });
                if (out.result) results.push(out.result);
                if (out.failure) failures.push(out.failure);
            } catch (error) {
                if (error instanceof HaltError) halted = error.message;
                else failures.push({ case: c, stage: 'triage', error: error?.message ?? String(error) });
            }
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
    // Unstarted cases after a halt are deferred, not lost.
    const notReached = halted ? queue.splice(0) : [];

    // Completion order depends on timing; reports should not.
    const order = new Map(toTriage.map((c, i) => [c.checkId, i]));
    results.sort((a, b) => order.get(a.case.checkId) - order.get(b.case.checkId));

    const merged = dryRun
        ? { rows: fieldRows, added: [], replaced: [], keptOwner: [] }
        : mergeFieldRows(fieldRows, results.map(r => r.row), { retriage });
    const usage = results.reduce((u, r) => ({
        input: u.input + (r.adjudication?.usage?.input ?? 0),
        output: u.output + (r.adjudication?.usage?.output ?? 0),
        calls: u.calls + (r.adjudication?.usage?.calls ?? 0),
    }), { input: 0, output: 0, calls: 0 });
    const run = {
        date, results, failures, skipped,
        deferred: [...deferred, ...notReached],
        fieldSummary: summarizeFieldRows(merged.rows),
        model, usage, dryRun, autoAccept,
    };
    const accepted = results.filter(r => r.row && !r.row.needs_manual_review).length;
    return {
        ...run,
        halted,
        merged,
        accepted,
        held: results.filter(r => r.row?.needs_manual_review).length,
        changed: merged.added.length + merged.replaced.length > 0,
        report: renderTriageReport(run),
    };
}

function readCases(file) {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error(`${file}: expected a JSON array (feedback-loop/sql/cases.sql output)`);
    return parsed;
}

function setGithubOutputs(values) {
    if (!process.env.GITHUB_OUTPUT) return;
    fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(values).map(([k, v]) => `${k}=${v}\n`).join(''));
}

async function main() {
    const { values } = parseArgs({
        options: {
            cases: { type: 'string' },
            field: { type: 'string', default: 'benchmark/dataset_field.json' },
            report: { type: 'string' },
            limit: { type: 'string', default: String(DEFAULT_LIMIT) },
            concurrency: { type: 'string', default: '2' },
            model: { type: 'string', default: process.env.ADJUDICATOR_MODEL || DEFAULT_MODEL },
            effort: { type: 'string' },
            retriage: { type: 'boolean', default: false },
            'dry-run': { type: 'boolean', default: false },
            'worker-base': { type: 'string' },
            date: { type: 'string', default: new Date().toISOString().slice(0, 10) },
        },
    });
    if (!values.cases) {
        console.error('Usage: node feedback-loop/run-triage.js --cases cases.json [--limit N] [--report FILE] [--dry-run] …');
        process.exit(1);
    }
    const dryRun = values['dry-run'];
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!dryRun && !apiKey) {
        console.error('ANTHROPIC_API_KEY is not set (use --dry-run to fetch and tag without a model).');
        process.exit(1);
    }

    const caseRows = readCases(values.cases);
    const { rows: fieldRows, metadata } = loadFieldSet(values.field);
    const workerOpts = values['worker-base'] ? { workerBase: values['worker-base'] } : {};
    const callModel = dryRun ? null : resilientModel(({ systemPrompt, userContent }) => callClaudeAPI({
        apiKey, model: values.model, systemPrompt, userContent, maxTokens: 16000, effort: values.effort,
    }));

    const out = await runTriage({
        caseRows, fieldRows,
        fetchSource: url => fetchSourceContent(url, null, workerOpts),
        callModel,
        limit: Number(values.limit),
        concurrency: Number(values.concurrency),
        retriage: values.retriage,
        dryRun,
        model: dryRun ? null : values.model,
        date: values.date,
    });

    if (out.changed) {
        writeFieldSet(values.field, out.merged.rows, { ...metadata, adjudicator_version: ADJUDICATOR_VERSION });
    }
    if (values.report) fs.writeFileSync(values.report, out.report);

    const summary = {
        cases: caseRows.length,
        triaged: out.results.length,
        accepted: out.accepted,
        held: out.held,
        failures: out.failures.length,
        skipped: out.skipped.length,
        deferred: out.deferred.length,
        added: out.merged.added.length,
        replaced: out.merged.replaced.length,
        changed: out.changed,
        auto_accept_paused: out.autoAccept.paused,
        halted: out.halted,
        usage: out.usage,
    };
    console.log(JSON.stringify(summary, null, 2));
    setGithubOutputs({ changed: out.changed, added: out.merged.added.length, accepted: out.accepted, held: out.held });
    if (out.halted) {
        console.error(`Halted on a model auth/billing error: ${out.halted}`);
        process.exit(2);
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(error?.stack || error);
        process.exit(1);
    });
}
