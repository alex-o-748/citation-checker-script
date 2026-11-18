#!/usr/bin/env node
// Re-verifies already-flagged findings with a second (stronger) model before
// they are delivered, and records both verdicts side by side.
//
// Why: the November 2026 ruwiki rerun's delivery tier (NOT SUPPORTED /
// contradiction with a quote verified in the source) was hand-checked on a
// random 50 (benchmark/contradiction-spotcheck-2026-11.csv): 25 genuine,
// 4 borderline, 21 wrong. The wrong ones were the first model misjudging, not
// the pipeline failing: the same thing under another name, a publication
// date or time zone read as the event date, a snapshot from another moment.
// A second reading by a stronger model, with the source in front of it,
// filters those before an editor sees them.
//
// It is a full re-verification (fetch the source, judge the claim), not a
// look at the first model's quote: several of the wrong verdicts needed
// context the quote alone does not carry.
//
// Input: any findings CSV with claim_text and source_url (a delivery file, or
// the labelled spot-check). source_url holding several URLs, one per line, is
// a collective group row and is re-verified as a group, as the sweep did.
// Output: the input columns plus recheck_* columns, one row per input row,
// appended as each finishes (so a killed run keeps what it did; --resume
// skips rows already in the output).
//
// With a `label` column (genuine / wrong / borderline), it also scores the
// recheck against the hand labels: how many wrong flags it removes and how
// many genuine ones it keeps.
//
// Usage:
//   node service/run-recheck.js benchmark/contradiction-spotcheck-2026-11.csv \
//     --provider huggingface --model deepseek-ai/DeepSeek-V3.2-Exp \
//     --worker-base https://llm-router.toolforge.org --wiki ruwiki --out recheck.csv

import { parseArgs } from 'node:util';
import { appendFile, writeFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { iterateCsvRows } from './csv-stream.js';
import { verifyCitation, verifyGroup, makeModelCaller, ProviderAuthError } from './verifier.js';
import { fetchSourceContent } from '../core/worker.js';
import { langCodeForWiki } from '../core/wikipedia.js';
import { modelFor } from '../core/models.js';

export const SOURCE_FETCHER_BASE = 'https://source-fetcher.toolforge.org';
const COLUMN_SUFFIXES = [
    'row', 'provider', 'model', 'verdict', 'reason_type', 'rationale', 'source_quote', 'quote_status', 'kept', 'error',
];
// --prefix names a pass's columns, so passes can be chained (one model's kept
// file fed to the next) without the second pass's columns colliding with the
// first's: qwen_verdict, then glm_verdict.
export function recheckColumns(prefix = 'recheck') {
    return COLUMN_SUFFIXES.map(s => `${prefix}_${s}`);
}
export const RECHECK_COLUMNS = recheckColumns();

// A flag survives the recheck when the second model also says NOT SUPPORTED.
// Deliberately not "also contradiction": a stronger model that calls a
// genuine conflict an omission still says the citation fails.
export function keptByRecheck(result) {
    return result?.verdict === 'NOT SUPPORTED';
}

function csvCell(value) {
    if (value === null || value === undefined) return '';
    const s = String(value);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function sourceUrls(row) {
    return (row.source_url ?? '').split(/\r?\n/).map(u => u.trim()).filter(Boolean);
}

/**
 * Re-verifies one row. `fetchSource(url)` returns the core/worker.js shape;
 * results are cached by the caller across rows. Returns the verifier result
 * (verdict, reasonType, rationale, sourceQuote, quoteStatus) or
 * `{ verdict: 'ERROR', error }`.
 */
export async function recheckRow(row, { fetchSource, callModel, articleLangCode }) {
    const urls = sourceUrls(row);
    if (urls.length === 0) return { verdict: 'ERROR', error: 'no source_url' };
    const sources = await Promise.all(urls.map(async url => {
        const fetched = await fetchSource(url);
        return {
            content: fetched?.content ?? null,
            status: fetched?.status ?? null,
            error: fetched?.content ? null : (fetched?.error ?? 'fetch failed'),
            unavailableReason: fetched?.content ? null : 'fetch_failed',
        };
    }));
    if (urls.length === 1) {
        return verifyCitation(row.claim_text, sources[0], { callModel, articleLangCode });
    }
    const numbers = (row.citation_number ?? '').split(',').map(s => s.trim());
    const members = urls.map((url, i) => ({
        groupId: row.group_id || 'recheck', claimText: row.claim_text,
        citationNumber: numbers[i] ?? String(i + 1), url, pageNum: null, source: sources[i],
    }));
    const result = await verifyGroup(members, { callModel, articleLangCode });
    if (result.skipped) return { verdict: 'ERROR', error: 'group skipped: at most one source readable now' };
    return result;
}

/** Scores a recheck against hand labels: label -> { kept, removed }. */
export function scoreAgainstLabels(outcomes) {
    const table = {};
    for (const { label, kept, error } of outcomes) {
        if (!label) continue;
        const t = table[label] ??= { kept: 0, removed: 0, error: 0 };
        if (error) t.error++;
        else if (kept) t.kept++;
        else t.removed++;
    }
    return table;
}

export function renderScore(table) {
    const lines = ['', 'Against the hand labels:', '', '| Label | Kept | Removed | Error |', '|---|---|---|---|'];
    for (const label of ['genuine', 'borderline', 'wrong']) {
        const t = table[label];
        if (t) lines.push(`| ${label} | ${t.kept} | ${t.removed} | ${t.error} |`);
    }
    const g = table.genuine ?? { kept: 0, removed: 0 };
    const w = table.wrong ?? { kept: 0, removed: 0 };
    const kept = g.kept + w.kept + (table.borderline?.kept ?? 0);
    lines.push('', `Precision of what it keeps: ${g.kept} genuine of ${kept} kept`
        + `${kept ? ` (${Math.round((100 * g.kept) / kept)}%)` : ''}; `
        + `it removes ${w.removed} of ${w.kept + w.removed} wrong and ${g.removed} of ${g.kept + g.removed} genuine.`);
    return lines.join('\n') + '\n';
}

export function keptCsvPath(out) {
    return out.replace(/\.csv$/, '') + '-kept.csv';
}

// The rows that survived, from the whole output (a resumed run included):
// the file to deliver. Streams, like everything that reads a sweep's CSVs.
export async function writeKeptCsv(out, keptPath, prefix = 'recheck') {
    let header = null;
    let lines = [];
    let total = 0;
    for await (const { row } of iterateCsvRows(out)) {
        if (!row) continue;
        if (!header) { header = Object.keys(row); lines.push(header.map(csvCell).join(',')); }
        if (row[`${prefix}_kept`] !== '1') continue;
        total++;
        lines.push(header.map(h => csvCell(row[h])).join(','));
    }
    await writeFile(keptPath, lines.length ? lines.join('\n') + '\n' : '');
    return total;
}

async function countOutputRows(path) {
    try { await access(path); } catch { return 0; }
    let n = 0;
    for await (const { row } of iterateCsvRows(path)) if (row) n++;
    return n;
}

export async function runRecheck(rawOpts, {
    stderr = process.stderr,
    stdout = process.stdout,
    fetchOne = (url) => fetchSourceContent(url, null, { workerBase: rawOpts.fetcherBase }),
    callModel = makeModelCaller({ provider: rawOpts.provider, model: rawOpts.model, workerBase: rawOpts.workerBase, apiKey: rawOpts.apiKey }),
} = {}) {
    const opts = { prefix: 'recheck', ...rawOpts };
    const articleLangCode = langCodeForWiki(opts.wiki);
    const cache = new Map();
    const fetchSource = url => {
        if (!cache.has(url)) cache.set(url, fetchOne(url).catch(error => ({ content: null, error: error.message })));
        return cache.get(url);
    };

    const done = opts.resume ? await countOutputRows(opts.out) : 0;
    let header = null;
    const outcomes = [];
    let index = 0;
    let started = 0;
    const queue = [];
    let halted = null;

    const write = async (row, result) => {
        const kept = !result.error && keptByRecheck(result);
        const values = [...header.map(h => row[h]), row.__index, opts.provider, opts.model,
            result.verdict, result.reasonType, result.rationale, result.sourceQuote, result.quoteStatus,
            result.error ? '' : (kept ? 1 : 0), result.error ?? ''];
        await appendFile(opts.out, values.map(csvCell).join(',') + '\n');
        outcomes.push({ label: row.label, kept, error: Boolean(result.error) });
        if (outcomes.length % 25 === 0) stderr.write(`recheck: ${outcomes.length + done} rows done\n`);
    };

    const worker = async () => {
        while (queue.length && !halted) {
            const row = queue.shift();
            let result;
            try {
                result = await recheckRow(row, { fetchSource, callModel, articleLangCode });
            } catch (error) {
                if (error instanceof ProviderAuthError) { halted = error; return; }
                result = { verdict: 'ERROR', error: error.message };
            }
            await write(row, result);
        }
    };

    for await (const { row } of iterateCsvRows(opts.input)) {
        if (!row) continue;
        if (!header) {
            header = Object.keys(row);
            if (!header.includes('claim_text') || !header.includes('source_url')) {
                stderr.write('recheck: input needs claim_text and source_url columns\n');
                return 2;
            }
            const own = recheckColumns(opts.prefix);
            const clash = own.filter(c => header.includes(c));
            if (clash.length) {
                stderr.write(`recheck: input already has ${clash.join(', ')}; pass a different --prefix\n`);
                return 2;
            }
            if (!done) await writeFile(opts.out, [...header, ...own].map(csvCell).join(',') + '\n');
        }
        index++;
        if (index <= done) continue;
        if (opts.limit && started >= opts.limit) break;
        started++;
        queue.push({ ...row, __index: index });
    }
    if (!header) { stderr.write('recheck: input has no rows\n'); return 2; }

    stderr.write(`recheck: ${queue.length} row(s) with ${opts.provider} / ${opts.model}${done ? ` (${done} already done)` : ''}\n`);
    await Promise.all(Array.from({ length: opts.concurrency }, worker));
    if (halted) {
        stderr.write(`recheck: halting, the model refused: ${halted.message}\n`);
        return 3;
    }

    const kept = outcomes.filter(o => o.kept).length;
    const errors = outcomes.filter(o => o.error).length;
    const keptPath = keptCsvPath(opts.out);
    const keptTotal = await writeKeptCsv(opts.out, keptPath, opts.prefix);
    stdout.write(`recheck: ${outcomes.length} rechecked; ${kept} kept (second model also NOT SUPPORTED), `
        + `${outcomes.length - kept - errors} removed, ${errors} error(s). Wrote ${opts.out}\n`
        + `recheck: ${keptTotal} kept row(s) in total, the delivery file: ${keptPath}\n`);
    if (outcomes.some(o => o.label)) stdout.write(renderScore(scoreAgainstLabels(outcomes)));
    return 0;
}

export const HELP_TEXT = `usage: node service/run-recheck.js <findings.csv> --provider <p> [options]

Re-verifies each row's claim against its freshly fetched source with a second
model and writes the input plus <prefix>_* columns. <prefix>_kept is 1 when the
second model also says NOT SUPPORTED. With a label column, scores itself
against the labels.

Options:
  --provider <name>     Provider from core/models.js (e.g. huggingface, claude, liftwing)
  --model <id>          Model id (default: the provider's)
  --worker-base <url>   e.g. https://llm-router.toolforge.org for huggingface via the router
  --wiki <db>           Wiki the findings came from, for the rationale language (default: ruwiki)
  --out <path>          Output CSV (default: <input>-recheck.csv)
  --concurrency <n>     Rows at once (default: 4)
  --limit <n>           Recheck at most n rows
  --resume              Skip rows already in --out
  --fetcher-base <url>  Source fetcher (default: ${SOURCE_FETCHER_BASE})
  --prefix <name>       Column prefix for this pass (default: recheck). Use a
                        different one per pass when chaining: feeding one pass's
                        -kept.csv to another keeps only flags both models agree on.
`;

async function main(argv) {
    const { values, positionals } = parseArgs({
        args: argv, allowPositionals: true,
        options: {
            provider: { type: 'string' }, model: { type: 'string' }, 'worker-base': { type: 'string' },
            wiki: { type: 'string', default: 'ruwiki' }, out: { type: 'string' },
            concurrency: { type: 'string', default: '4' }, limit: { type: 'string' },
            resume: { type: 'boolean', default: false },
            'fetcher-base': { type: 'string', default: SOURCE_FETCHER_BASE },
            prefix: { type: 'string', default: 'recheck' },
            help: { type: 'boolean', short: 'h' },
        },
    });
    if (values.help || !positionals[0] || !values.provider) {
        process.stdout.write(HELP_TEXT);
        return values.help ? 0 : 2;
    }
    const opts = {
        input: positionals[0],
        provider: values.provider,
        model: values.model ?? modelFor(values.provider),
        workerBase: values['worker-base'],
        apiKey: process.env[{ claude: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY' }[values.provider]],
        wiki: values.wiki,
        out: values.out ?? positionals[0].replace(/\.csv$/, '') + '-recheck.csv',
        concurrency: Math.max(1, Number(values.concurrency)),
        limit: values.limit ? Number(values.limit) : null,
        resume: values.resume,
        fetcherBase: values['fetcher-base'],
        prefix: values.prefix,
    };
    return runRecheck(opts);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
        process.stderr.write(`${error.stack || error}\n`);
        process.exitCode = 1;
    });
}
