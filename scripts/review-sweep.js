#!/usr/bin/env node
// A second look at a run-sweep.js findings CSV, beyond the post-run checks:
// where the verdicts come from, what is behind SOURCE UNAVAILABLE and
// source_too_large, which hosts draw unusually many flags, and — given the
// previous run's findings — how many verdicts the new run changed.
//
// Written for the ruwiki rerun after the 2026-11-05 charset fix, to run on
// Toolforge next to the data (the CSV is too big to move around), and to
// produce a small sample CSV of rows worth reading by hand.
//
// Usage:
//   node scripts/review-sweep.js ru-rerun-snapshot.csv
//   node scripts/review-sweep.js ru-rerun-snapshot.csv --old ru-pre-charset.tsv.gz --out ru-review
//
// --old takes the old findings as `mariadb -B` output (tab-separated, with a
// header row; .gz is read transparently), e.g.
//   mariadb ... -B -e "SELECT page_id, page_title, claim_text, source_url,
//     verdict, reason_type, rationale, model FROM citation_findings_ruwiki_pre_charset"
// Rows are matched on page_id + claim text + source URL, so a claim edited
// since the old run, or a re-pointed citation, simply doesn't match.
//
// Writes <out>.md (the report, also printed) and <out>-sample.csv (a few
// hundred rows in labelled categories; claim and rationale cut to 600 chars
// so it stays small enough to share).

import { parseArgs } from 'node:util';
import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { streamCsvRows } from '../service/csv-stream.js';
import { hostOf } from '../service/host-pool.js';
import { scriptShare } from '../service/sweep-checks.js';
import { VERDICT_LIST } from '../core/verdicts.js';

const FLAGGED = new Set(['NOT SUPPORTED', 'PARTIALLY SUPPORTED']);
const CUT = 600;

// Seeded so a sample can be reproduced (same PRNG as service/sweep-checks.js).
export function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Reservoir: a uniform random k of everything offered, O(k) memory.
export function reservoir(k, random) {
    const kept = [];
    let seen = 0;
    return {
        offer(item) {
            seen++;
            if (kept.length < k) kept.push(item);
            else {
                const j = Math.floor(random() * seen);
                if (j < k) kept[j] = item;
            }
        },
        get items() { return kept; },
        get seen() { return seen; },
    };
}

export function normClaim(text) {
    return (text ?? '').replace(/\s+/g, ' ').trim();
}

export function matchKey(pageId, claim, url) {
    return `${pageId}\u0001${normClaim(claim)}\u0001${(url ?? '').trim()}`;
}

// `mariadb -B` escapes \t \n \\ and NUL in field values.
export function unescapeMariadb(field) {
    if (field === 'NULL') return null;
    return field.replace(/\\(.)/g, (_, c) => ({ t: '\t', n: '\n', r: '\r', 0: '\0', '\\': '\\' }[c] ?? c));
}

export async function readOldFindings(path) {
    let stream = createReadStream(path);
    if (path.endsWith('.gz')) stream = stream.pipe(createGunzip());
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    const byKey = new Map();
    let header = null;
    for await (const line of lines) {
        const fields = line.split('\t').map(unescapeMariadb);
        if (!header) { header = fields; continue; }
        const row = Object.fromEntries(header.map((h, i) => [h, fields[i]]));
        byKey.set(matchKey(row.page_id, row.claim_text, row.source_url), row);
    }
    return byKey;
}

const bump = (obj, key, n = 1) => { obj[key || '(blank)'] = (obj[key || '(blank)'] || 0) + n; };
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : '—');
const top = (obj, k = 10) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, k);
const cut = s => ((s ?? '').length > CUT ? `${s.slice(0, CUT)}…` : (s ?? ''));

/**
 * Streams the findings CSV once. `old` is the Map from readOldFindings(), or
 * null. Returns { summary, sample }.
 */
export async function reviewSweep(csvPath, { old = null, seed = 1, perCategory = 25 } = {}) {
    const random = mulberry32(seed);
    const s = {
        rows: 0, articles: new Set(), verdicts: {}, models: {},
        modelRows: 0, fetched: 0,
        unavailable: { fetch_failed: 0, no_url: 0, model_on_fetched: 0, other: 0 },
        tooLarge: 0, tooLargeByArticle: {}, tooLargeByHost: {},
        rowsByHost: {}, flaggedByHost: {}, modelRowsByHost: {},
        quoteStatusFlagged: {},
        nonCyrillicRationales: 0, rationalesChecked: 0,
        old: old ? { matched: 0, transitions: {}, oldModels: {} } : null,
    };
    const categories = {
        'not-supported': reservoir(perCategory, random),
        'not-supported-wayback': reservoir(perCategory, random),
        'partially-supported': reservoir(perCategory, random),
        'unavailable-but-fetched': reservoir(perCategory, random),
        'supported': reservoir(Math.ceil(perCategory / 2), random),
        'english-rationale': reservoir(Math.ceil(perCategory / 2), random),
        ...(old ? {
            'was-not-supported-now-supported': reservoir(perCategory, random),
            'was-supported-now-not-supported': reservoir(perCategory, random),
        } : {}),
    };

    await streamCsvRows(csvPath, {
        onRow: row => {
            s.rows++;
            s.articles.add(row.page_title);
            const v = row.verdict;
            bump(s.verdicts, v);
            const host = row.source_url ? hostOf(row.source_url) : '(no url)';
            bump(s.rowsByHost, host);
            const modelRan = VERDICT_LIST.includes(v) && row.provider;
            if (row.fetch_status && /^2\d\d$/.test(row.fetch_status) && row.reason_type !== 'fetch_failed') s.fetched++;

            if (row.reason_type === 'source_too_large') {
                s.tooLarge++;
                bump(s.tooLargeByArticle, row.page_title);
                bump(s.tooLargeByHost, host);
            }

            let oldRow = null;
            if (old && row.page_id) {
                oldRow = old.get(matchKey(row.page_id, row.claim_text, row.source_url)) ?? null;
                if (oldRow) {
                    s.old.matched++;
                    bump(s.old.transitions, `${oldRow.verdict} → ${v}`);
                    bump(s.old.oldModels, oldRow.model);
                }
            }
            const item = { row, oldRow };

            if (v === 'SOURCE UNAVAILABLE') {
                if (row.reason_type === 'fetch_failed') s.unavailable.fetch_failed++;
                else if (row.reason_type === 'no_url' || !row.source_url) s.unavailable.no_url++;
                else if (modelRan) { s.unavailable.model_on_fetched++; categories['unavailable-but-fetched'].offer(item); }
                else s.unavailable.other++;
            }

            if (modelRan) {
                s.modelRows++;
                bump(s.models, row.model);
                bump(s.modelRowsByHost, host);
                if (FLAGGED.has(v)) {
                    bump(s.flaggedByHost, host);
                    bump(s.quoteStatusFlagged, row.quote_status);
                }
                if (v === 'NOT SUPPORTED') {
                    categories['not-supported'].offer(item);
                    if (host === 'web.archive.org') categories['not-supported-wayback'].offer(item);
                }
                if (v === 'PARTIALLY SUPPORTED') categories['partially-supported'].offer(item);
                if (v === 'SUPPORTED') categories.supported.offer(item);
                if (row.rationale) {
                    const { letters, share } = scriptShare(row.rationale, 'Cyrillic');
                    if (letters >= 20) {
                        s.rationalesChecked++;
                        if (share < 0.3) { s.nonCyrillicRationales++; categories['english-rationale'].offer(item); }
                    }
                }
            }
            if (oldRow) {
                if (oldRow.verdict === 'NOT SUPPORTED' && v === 'SUPPORTED') categories['was-not-supported-now-supported'].offer(item);
                if (oldRow.verdict === 'SUPPORTED' && v === 'NOT SUPPORTED') categories['was-supported-now-not-supported'].offer(item);
            }
        },
    });

    const sample = [];
    for (const [category, res] of Object.entries(categories)) {
        for (const { row, oldRow } of res.items) sample.push({ category, row, oldRow });
    }
    return { summary: s, sample };
}

export function renderReport(s) {
    const L = [];
    L.push(`# Sweep review`, '');
    L.push(`${s.rows} rows, ${s.articles.size} articles; model ran on ${s.modelRows} rows (${Object.keys(s.models).join(', ') || 'none'}).`, '');
    L.push('## Verdicts', '', '| Verdict | Rows | Share |', '|---|---|---|');
    for (const [v, n] of top(s.verdicts, 20)) L.push(`| ${v} | ${n} | ${pct(n, s.rows)} |`);
    const flagged = (s.verdicts['NOT SUPPORTED'] || 0) + (s.verdicts['PARTIALLY SUPPORTED'] || 0);
    L.push('', `Flagged (NOT + PARTIALLY SUPPORTED): ${flagged} = ${pct(flagged, s.modelRows)} of rows the model judged.`, '');

    const u = s.unavailable;
    const uTotal = u.fetch_failed + u.no_url + u.model_on_fetched + u.other;
    L.push('## What is behind SOURCE UNAVAILABLE', '', '| Cause | Rows |', '|---|---|');
    L.push(`| No URL (book, print source) | ${u.no_url} |`);
    L.push(`| Fetch failed | ${u.fetch_failed} |`);
    L.push(`| **Model said unavailable about a source it was given** | ${u.model_on_fetched} |`);
    if (u.other) L.push(`| Other | ${u.other} |`);
    L.push(`| Total | ${uTotal} |`, '');

    L.push('## source_too_large', '');
    L.push(`${s.tooLarge} rows = ${pct(s.tooLarge, s.fetched + s.tooLarge)} of fetched sources (post-run checks warn above 15%; ~8% was normal on the October ruwiki runs).`, '');
    const byArticle = top(s.tooLargeByArticle, 5);
    const top5 = byArticle.reduce((a, [, n]) => a + n, 0);
    L.push(`Top 5 articles hold ${top5} of them (${pct(top5, s.tooLarge)}):`, '');
    for (const [k, n] of byArticle) L.push(`- ${k}: ${n}`);
    L.push('', 'Top hosts:', '');
    for (const [k, n] of top(s.tooLargeByHost, 8)) L.push(`- ${k}: ${n}`);
    L.push('');

    L.push('## Hosts with unusually many flags', '');
    L.push('Hosts with at least 10 judged rows, ranked by flag rate. A host flagged on nearly every citation is more often a fetch problem (paywall, bot wall, cookie page, wrong page) than a run of bad citations.', '');
    L.push('| Host | Judged | Flagged | Rate |', '|---|---|---|---|');
    const hostRates = Object.entries(s.modelRowsByHost)
        .filter(([, n]) => n >= 10)
        .map(([h, n]) => [h, n, s.flaggedByHost[h] || 0])
        .sort((a, b) => b[2] / b[1] - a[2] / a[1]);
    for (const [h, n, f] of hostRates.slice(0, 15)) L.push(`| ${h} | ${n} | ${f} | ${pct(f, n)} |`);
    L.push('');

    L.push('## Evidence on flagged rows', '', '| quote_status | Rows |', '|---|---|');
    for (const [k, n] of top(s.quoteStatusFlagged, 10)) L.push(`| ${k} | ${n} |`);
    L.push('', `Rationales not in Russian: ${s.nonCyrillicRationales} of ${s.rationalesChecked} checked (${pct(s.nonCyrillicRationales, s.rationalesChecked)}).`, '');

    if (s.old) {
        L.push('## Compared with the previous run', '');
        L.push(`${s.old.matched} rows matched an old finding on page + claim + source URL (${pct(s.old.matched, s.rows)} of new rows). Old models: ${top(s.old.oldModels, 5).map(([k, n]) => `${k} ${n}`).join(', ')}.`, '');
        const changed = Object.entries(s.old.transitions).filter(([k]) => { const [a, b] = k.split(' → '); return a !== b; });
        const same = s.old.matched - changed.reduce((a, [, n]) => a + n, 0);
        L.push(`Unchanged: ${same} (${pct(same, s.old.matched)}). Changed:`, '', '| Old → new | Rows |', '|---|---|');
        for (const [k, n] of changed.sort((a, b) => b[1] - a[1]).slice(0, 20)) L.push(`| ${k} | ${n} |`);
        L.push('');
    }
    return L.join('\n');
}

function csvCell(value) {
    if (value === null || value === undefined) return '';
    const str = String(value);
    return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

export function renderSample(sample) {
    const cols = ['category', 'page_title', 'permalink', 'citation_number', 'claim_text', 'source_url',
        'verdict', 'reason_type', 'rationale', 'source_quote', 'quote_status', 'fetch_status',
        'old_verdict', 'old_rationale'];
    const lines = [cols.join(',')];
    for (const { category, row, oldRow } of sample) {
        lines.push([category, row.page_title, row.permalink, row.citation_number, cut(row.claim_text),
            row.source_url, row.verdict, row.reason_type, cut(row.rationale), cut(row.source_quote),
            row.quote_status, row.fetch_status, oldRow?.verdict, cut(oldRow?.rationale)].map(csvCell).join(','));
    }
    return lines.join('\n') + '\n';
}

async function main(argv) {
    const { values, positionals } = parseArgs({
        args: argv, allowPositionals: true,
        options: {
            old: { type: 'string' },
            out: { type: 'string' },
            seed: { type: 'string', default: '1' },
            'per-category': { type: 'string', default: '25' },
        },
    });
    const csv = positionals[0];
    if (!csv) { process.stderr.write('usage: review-sweep.js <findings.csv> [--old old.tsv[.gz]] [--out prefix]\n'); return 2; }
    const out = values.out ?? csv.replace(/\.csv$/, '') + '-review2';
    const old = values.old ? await readOldFindings(values.old) : null;
    if (old) process.stderr.write(`old findings: ${old.size} rows\n`);
    const { summary, sample } = await reviewSweep(csv, { old, seed: Number(values.seed), perCategory: Number(values['per-category']) });
    const report = renderReport(summary);
    await writeFile(`${out}.md`, report + '\n');
    await writeFile(`${out}-sample.csv`, renderSample(sample));
    process.stdout.write(report + '\n');
    process.stderr.write(`wrote ${out}.md and ${out}-sample.csv (${sample.length} rows)\n`);
    return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main(process.argv.slice(2)).then(code => { process.exitCode = code; }, e => {
        process.stderr.write(`${e.stack || e}\n`);
        process.exitCode = 1;
    });
}
