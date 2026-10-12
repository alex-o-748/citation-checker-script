#!/usr/bin/env node
/**
 * Context probes: synthetic rows that test whether a model keeps article
 * context in its place (docs/design-plans/2026-10-12-claim-context.md).
 *
 * Giving the model the text around a claim can go wrong in two directions,
 * and an accuracy number can hide both at once, since they cancel:
 *
 *   leakage      The model counts the context as evidence. Probe: a row whose
 *                claim the source does NOT fully support, with the claim
 *                itself planted as the last sentence of the context. A model
 *                that flips to SUPPORTED read the context as support. This is
 *                the dangerous direction: it hides a real failure.
 *   scope creep  The model verifies the context too. Probe: a SUPPORTED row
 *                with an unrelated claim (another row's, which this source
 *                says nothing about) planted in the context. A model that
 *                flips to a flag checked something it was told not to.
 *
 * A flip is measured against the same model's verdict on the same row with
 * ordinary context, so the probe isolates the planted sentence.
 *
 *   node context_probes.js build   --dataset dataset_wice.json --out dataset_wice_probes.json [--per-type 60]
 *   node context_probes.js analyze --probes results_wice_probes.json --base results_wice_ctx.json
 *
 * Run the probe dataset with the same --context as the base run, e.g.
 *   node run_benchmark.js --dataset dataset_wice_probes.json --results results_wice_probes.json \
 *       --context title,section,preceding,citation --providers=hf-gpt-oss-20b
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { loadRows, loadMetadata } from './io.js';
import { precedingTextFromContainer } from './claim_context.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PROBE_TYPES = ['leak', 'creep'];

// A probe stands in for its original row only if the original is benchmarkable.
function usable(row) {
    return row.extraction_status === 'complete' && !row.needs_manual_review && !row.excluded_reason;
}

function isSupported(label) {
    return String(label || '').trim().toLowerCase() === 'supported';
}

// Stable order independent of dataset order, so the same --per-type sample is
// drawn every time and a later dataset edit doesn't reshuffle every probe.
function stableKey(id) {
    return createHash('sha256').update(String(id)).digest('hex');
}

function sample(rows, n) {
    return [...rows].sort((a, b) => stableKey(a.id).localeCompare(stableKey(b.id))).slice(0, n);
}

function withPlanted(preceding, planted) {
    const p = String(planted).trim().replace(/\s+/g, ' ');
    const sentence = /[.!?…]["'”’)]?$/.test(p) ? p : `${p}.`;
    return preceding ? `${preceding} ${sentence}` : sentence;
}

/**
 * Builds probe rows from a dataset. Each keeps its original's claim, source
 * and ground truth, and carries an explicit claim_context.precedingText that
 * contextForEntry() uses in place of the derived one.
 */
export function buildProbes(rows, { perType = 60 } = {}) {
    const pool = rows.filter(usable);

    // Leakage needs a claim the source doesn't fully support, so the planted
    // copy is the only thing that could make it SUPPORTED.
    const leakBase = sample(pool.filter(r => !isSupported(r.ground_truth)), perType);

    // Scope creep plants another row's claim. Taking it from a different
    // article keeps it unrelated to this source, so a flag can only mean the
    // model checked the context.
    const creepBase = sample(pool.filter(r => isSupported(r.ground_truth)), perType);
    const donors = sample(pool, pool.length);

    const probes = [];
    for (const row of leakBase) {
        const preceding = precedingTextFromContainer(row.claim_text, row.claim_container);
        probes.push(probeRow(row, 'leak', withPlanted(preceding, row.claim_text)));
    }
    creepBase.forEach((row, i) => {
        const preceding = precedingTextFromContainer(row.claim_text, row.claim_container);
        let donor = null;
        for (let j = 0; j < donors.length && !donor; j++) {
            const d = donors[(i * 7 + j) % donors.length];
            if (d.id !== row.id && d.article_title !== row.article_title && d.claim_text.length >= 40) donor = d;
        }
        if (donor) probes.push(probeRow(row, 'creep', withPlanted(preceding, donor.claim_text), donor.id));
    });
    return probes;
}

function probeRow(row, type, precedingText, donorId = null) {
    return {
        ...row,
        id: `${row.id}__${type}`,
        probe_of: row.id,
        probe_type: type,
        probe_donor: donorId,
        claim_context: { precedingText },
    };
}

function isFlag(verdict) {
    const v = String(verdict || '').trim().toLowerCase();
    return v === 'not supported' || v === 'partially supported';
}

/**
 * Flip rates per provider. A probe counts only when the base run gave its
 * original row a usable verdict in the direction the probe tests: a leak
 * probe needs the base verdict to have been a flag (else there is nothing to
 * flip to SUPPORTED), a creep probe needs it to have been SUPPORTED.
 */
export function summarizeProbes(probeResults, baseResults) {
    const base = new Map(baseResults.filter(r => !r.error).map(r => [`${r.entry_id}|${r.provider}`, r]));
    const out = {};
    for (const r of probeResults) {
        if (r.error) continue;
        const m = /^(.*)__(leak|creep)$/.exec(r.entry_id);
        if (!m) continue;
        const [, origId, type] = m;
        const b = base.get(`${origId}|${r.provider}`);
        const p = (out[r.provider] ||= {
            leak: { eligible: 0, flipped: 0, examples: [] },
            creep: { eligible: 0, flipped: 0, examples: [] },
        });
        if (!b) continue;
        const bucket = p[type];
        if (type === 'leak' && isFlag(b.predicted_verdict)) {
            bucket.eligible++;
            if (isSupported(r.predicted_verdict)) {
                bucket.flipped++;
                bucket.examples.push(origId);
            }
        } else if (type === 'creep' && isSupported(b.predicted_verdict)) {
            bucket.eligible++;
            if (isFlag(r.predicted_verdict)) {
                bucket.flipped++;
                bucket.examples.push(origId);
            }
        }
    }
    for (const p of Object.values(out)) {
        for (const t of PROBE_TYPES) p[t].rate = p[t].eligible ? p[t].flipped / p[t].eligible : null;
    }
    return out;
}

function flag(argv, name, fallback) {
    const i = argv.indexOf(name);
    return i !== -1 ? argv[i + 1] : fallback;
}

function main() {
    const [cmd, ...argv] = process.argv.slice(2);
    if (cmd === 'build') {
        const datasetPath = path.resolve(__dirname, flag(argv, '--dataset', 'dataset_wice.json'));
        const outPath = path.resolve(__dirname, flag(argv, '--out', 'dataset_wice_probes.json'));
        const perType = parseInt(flag(argv, '--per-type', '60'), 10);
        const probes = buildProbes(loadRows(datasetPath), { perType });
        const metadata = {
            ...loadMetadata(datasetPath),
            probes_built_at: new Date().toISOString(),
            probes_from: path.basename(datasetPath),
            probes_per_type: perType,
        };
        fs.writeFileSync(outPath, JSON.stringify({ metadata, rows: probes }, null, 2));
        const counts = PROBE_TYPES.map(t => `${t}: ${probes.filter(p => p.probe_type === t).length}`).join(', ');
        console.log(`Wrote ${probes.length} probe rows to ${path.basename(outPath)} (${counts})`);
    } else if (cmd === 'analyze') {
        const probes = loadRows(path.resolve(__dirname, flag(argv, '--probes', 'results_wice_probes.json')));
        const base = loadRows(path.resolve(__dirname, flag(argv, '--base', 'results_wice_ctx.json')));
        const summary = summarizeProbes(probes, base);
        for (const [provider, s] of Object.entries(summary)) {
            console.log(`${provider}`);
            for (const t of PROBE_TYPES) {
                const pct = s[t].rate == null ? 'n/a' : `${(s[t].rate * 100).toFixed(1)}%`;
                console.log(`  ${t.padEnd(6)} ${s[t].flipped}/${s[t].eligible} flipped (${pct})`);
            }
        }
    } else {
        console.error('Usage: node context_probes.js build|analyze [options]');
        process.exit(1);
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
