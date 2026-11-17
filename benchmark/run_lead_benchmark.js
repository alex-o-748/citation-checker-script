#!/usr/bin/env node
/**
 * Runs the lead check (core/lead-check.js) over dataset_lead.json for one or
 * more providers from run_benchmark.js's PROVIDERS table, and records one row
 * per lead sentence.
 *
 * Usage:
 *   node run_lead_benchmark.js --providers=hf-gpt-oss-20b[,liftwing-qwen3.8-27b] \
 *       [--dataset dataset_lead.json] [--results results_lead.json] [--labeled-only] [--resume]
 *
 * Score with analyze_lead.js.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';
import { PROVIDERS, callProvider, registerAdHocHfProvider } from './run_benchmark.js';
import { runLeadCheck, leadChunkSize, LEAD_PROMPT_VERSION } from '../core/lead-check.js';
import { LEAD_LABELS } from './lead_dataset.js';
import { loadRows, writeWithMetadata, todayIso } from './io.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// callProvider() parses a verdict and swallows errors, both right for the
// citation benchmark and wrong here: the lead check parses its own array, and
// needs a thrown error to split a chunk that ran out of output budget.
export function leadCaller(provider, call = callProvider) {
    return async (systemPrompt, userContent) => {
        const r = await call(provider, systemPrompt, userContent);
        if (r.error) throw new Error(r.error);
        return { text: r.raw_response ?? '', usage: r.usage ?? null };
    };
}

// The lead-check row for one sentence's result.
export function resultRow({ provider, model, articleId, result, bodyTruncated }) {
    return {
        provider, model, article_id: articleId, sentence_index: result.index,
        verdict: result.verdict, reason_type: result.reasonType, outcome: result.outcome,
        support_score: result.supportScore, quote_status: result.quoteStatus, section: result.section,
        comments: result.comments, error: result.error, body_truncated: bodyTruncated,
        prompt_version: LEAD_PROMPT_VERSION,
    };
}

async function main() {
    const { values } = parseArgs({
        args: process.argv.slice(2),
        options: {
            providers: { type: 'string' },
            dataset: { type: 'string', default: path.join(__dirname, 'dataset_lead.json') },
            results: { type: 'string', default: path.join(__dirname, 'results_lead.json') },
            'labeled-only': { type: 'boolean', default: false },
            resume: { type: 'boolean', default: false },
        },
        strict: false,
    });
    if (!values.providers) {
        console.error('usage: run_lead_benchmark.js --providers=<id>[,<id>...] [--dataset path] [--results path] [--labeled-only] [--resume]');
        return 2;
    }
    const providers = values.providers.split(',').map(p => (p.startsWith('hf:') ? registerAdHocHfProvider(p) : p));
    for (const p of providers) if (!PROVIDERS[p]) { console.error(`unknown provider: ${p}`); return 2; }

    const dataset = loadRows(values.dataset);
    const rows = values.resume && fs.existsSync(values.results) ? loadRows(values.results) : [];
    const done = new Set(rows.map(r => `${r.provider}|${r.article_id}`));
    const save = () => writeWithMetadata(values.results, {
        run: todayIso(), lead_prompt_version: LEAD_PROMPT_VERSION, dataset: path.basename(values.dataset), providers,
    }, rows);

    for (const provider of providers) {
        const config = PROVIDERS[provider];
        for (const entry of dataset) {
            if (done.has(`${provider}|${entry.id}`)) continue;
            const only = values['labeled-only']
                ? entry.sentences.filter(s => LEAD_LABELS.includes(s.label)).map(s => s.index)
                : undefined;
            if (only && only.length === 0) continue;
            const run = await runLeadCheck({ sentences: entry.sentences, body: entry.body, articleTitle: entry.title, only }, {
                callModel: leadCaller(provider),
                chunkSize: leadChunkSize(config.type),
                retry: { maxRetries: 1 },
                onChunkError: error => (console.error(`  ${provider} ${entry.title}: ${error.message}`), 'error'),
            });
            for (const result of run.results) {
                rows.push(resultRow({ provider, model: config.model, articleId: entry.id, result, bodyTruncated: run.bodyTruncated }));
            }
            console.error(`${provider} ${entry.title}: ${run.results.length} sentence(s), ${run.calls} call(s)`);
            save();
        }
    }
    save();
    return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().then(code => process.exit(code));
}
