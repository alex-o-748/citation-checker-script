#!/usr/bin/env node
/**
 * WiCE -> dataset_wice.json converter.
 *
 * Downloads (and caches) the WiCE release from GitHub, converts the
 * claim-level corpus into `dataset.json`-shaped rows, and writes
 * `benchmark/dataset_wice.json`.
 *
 * The conversion itself — and every place WiCE's task differs from ours — lives
 * in `benchmark/wice.js`. This file is only fetch, write, and report.
 *
 * Usage:
 *   node convert_wice.js                        # dev + test (the eval splits)
 *   node convert_wice.js --splits dev,test,train
 *   node convert_wice.js --output dataset_wice.json
 *   node convert_wice.js --cache-dir .wice-cache
 *   node convert_wice.js --wice-dir ../wice     # use a local clone, no network
 *
 * Why dev + test by default: those splits were annotated by 5 workers each and
 * manually error-corrected by the authors (paper S2.1/S2.3); train got 3
 * workers and no correction pass. 707 rows is also a sane default benchmark
 * cost — `--splits train` adds 1,260 more when you want them.
 *
 * Run it, then benchmark against the separate file:
 *   node run_benchmark.js --dataset dataset_wice.json --results results_wice.json
 *   node analyze_results.js --dataset dataset_wice.json --results results_wice.json \
 *       --analysis analysis_wice.json
 *
 * See docs/wice-benchmark.md.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

import { convertWiceSplit, indexSubclaims, summarizeConverted } from './wice.js';
import { writeWithMetadata, todayIso } from './io.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const WICE_REPO = 'https://github.com/ryokamoi/wice';
const WICE_RAW = 'https://raw.githubusercontent.com/ryokamoi/wice/main';
const ALL_SPLITS = ['dev', 'test', 'train'];
const DEFAULT_SPLITS = ['dev', 'test'];

const args = process.argv.slice(2);
function flagValue(name, fallback = null) {
    const i = args.indexOf(name);
    return i !== -1 ? args[i + 1] : fallback;
}

const SPLITS = flagValue('--splits', DEFAULT_SPLITS.join(',')).split(',').map(s => s.trim()).filter(Boolean);
const OUTPUT_PATH = path.resolve(__dirname, flagValue('--output', 'dataset_wice.json'));
const CACHE_DIR = path.resolve(__dirname, flagValue('--cache-dir', '.wice-cache'));
const WICE_DIR = flagValue('--wice-dir');

// Relative paths inside the WiCE release, shared by the local and remote loaders.
const relPath = (level, split) => `data/entailment_retrieval/${level}/${split}.jsonl`;

function parseJsonl(text, label) {
    const rows = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
            rows.push(JSON.parse(line));
        } catch (err) {
            throw new Error(`${label}: malformed JSON on line ${i + 1}: ${err.message}`);
        }
    }
    return rows;
}

/**
 * Load one WiCE file, preferring a local clone, then the on-disk cache, then
 * the network. The cache means a re-run costs nothing and the conversion stays
 * reproducible if the upstream repo moves.
 */
async function loadWiceFile(level, split) {
    const rel = relPath(level, split);

    if (WICE_DIR) {
        const local = path.resolve(process.cwd(), WICE_DIR, rel);
        if (!fs.existsSync(local)) throw new Error(`Not found in --wice-dir: ${local}`);
        return parseJsonl(fs.readFileSync(local, 'utf-8'), rel);
    }

    const cached = path.join(CACHE_DIR, `${level}_${split}.jsonl`);
    if (fs.existsSync(cached)) {
        return parseJsonl(fs.readFileSync(cached, 'utf-8'), rel);
    }

    const url = `${WICE_RAW}/${rel}`;
    process.stdout.write(`  fetching ${level}/${split}.jsonl ... `);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
    const text = await res.text();
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cached, text);
    console.log(`${(text.length / 1e6).toFixed(1)} MB (cached)`);
    return parseJsonl(text, rel);
}

async function main() {
    const unknown = SPLITS.filter(s => !ALL_SPLITS.includes(s));
    if (unknown.length) {
        console.error(`Unknown split(s): ${unknown.join(', ')}. Valid: ${ALL_SPLITS.join(', ')}`);
        process.exit(1);
    }

    console.log(`Converting WiCE splits: ${SPLITS.join(', ')}`);
    console.log(WICE_DIR ? `Source: local clone at ${WICE_DIR}` : `Source: ${WICE_REPO} (cache: ${path.relative(__dirname, CACHE_DIR)})`);

    const rows = [];
    for (const split of SPLITS) {
        // The subclaim corpus is loaded purely to recover the labels the
        // annotators actually assigned, so a claim-level label that is an
        // artifact of WiCE's projection rule can be told apart from one that
        // isn't. See note 2 in benchmark/wice.js.
        const [claimRows, subclaimRows] = await Promise.all([
            loadWiceFile('claim', split),
            loadWiceFile('subclaim', split),
        ]);
        const subclaimIndex = indexSubclaims(subclaimRows);
        const converted = convertWiceSplit(claimRows, { split, subclaimIndex });

        const joined = converted.filter(r => r.wice_subclaim_count > 0).length;
        console.log(`  ${split}: ${converted.length} claims, ${subclaimRows.length} subclaims, ${joined}/${converted.length} joined`);
        rows.push(...converted);
    }

    const summary = summarizeConverted(rows);

    // dataset_wice.json is generated, not committed (7 MB, and unlike
    // dataset.json it is deterministically reproducible). This checksum is how
    // a later regenerate proves it got the same corpus — if upstream WiCE ever
    // changes, the digest moves and results_wice.json stops being attributable
    // to a known dataset. Expected value is recorded in docs/wice-benchmark.md.
    const checksum = crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');

    writeWithMetadata(OUTPUT_PATH, {
        extracted_at: todayIso(),
        version_filter: 'wice',
        source: 'WiCE (Kamoi et al., EMNLP 2023)',
        source_repo: WICE_REPO,
        source_level: 'claim',
        splits: SPLITS,
        license: 'Wikipedia text CC-BY-SA; cited-page text per Common Crawl ToU; WiCE annotations ODC-BY 1.0',
        notes: 'Claim-level labels are projected from subclaim annotations by WiCE; see wice_label_projection and docs/wice-benchmark.md.',
        checksum_sha256: checksum,
        summary,
    }, rows);

    console.log(`\nWrote ${rows.length} rows to ${path.relative(process.cwd(), OUTPUT_PATH)}`);
    console.log(`  ground truth: ${JSON.stringify(summary.by_ground_truth)}`);
    console.log(`  projection:   ${JSON.stringify(summary.by_projection)}`);
    console.log(`  truncated sources: ${summary.truncated}, flagged for review: ${summary.flagged_for_review}`);
    console.log(`  sha256: ${checksum}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().catch(err => {
        console.error(err.message);
        process.exit(1);
    });
}
