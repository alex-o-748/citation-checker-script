#!/usr/bin/env node
// Measures how many checks were run against a source that reached the model
// as undecodable text.
//
// Why this exists: our fetchers (the Cloudflare Worker and tf-source-fetcher)
// decode every page as UTF-8. A page in another encoding — Windows-1251 and
// KOI8-R are common on older Russian sites, and Wayback's raw `id_` snapshots
// drop the charset header even when the live site sent one — comes back as a
// wall of U+FFFD replacement characters, with a 200 and "content retrieved".
// The model then sees no text at all and answers either SOURCE UNAVAILABLE
// (correct) or NOT SUPPORTED / omission (a confident wrong verdict, which is
// what a ruwiki editor reported on 2026-11-05 for Еврейские беженцы [62]).
//
// Neither ToolsDB nor the Neon verification log stores source text, so the
// only way to count affected checks is to re-fetch each distinct source URL
// through the same code path and look. This does that, once per URL, at most
// one request per host at a time (service/host-pool.js), and joins the result
// back onto the rows.
//
// Input: one or more CSVs with a source URL column and a verdict column — a
// run-sweep.js findings CSV as-is, or an export of ToolsDB's citation_findings
// or the Neon verification log.
//
// Caveat: a re-fetch today is not the fetch at check time. A site that has
// since moved to UTF-8, or died, is classified by what it serves now.
//
// Usage:
//   node service/run-encoding-audit.js findings.csv [more.csv ...] --out audit
//   node service/run-encoding-audit.js neon.csv --url-column source_url --verdict-column verdict --fetcher worker

import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { streamCsvRows } from './csv-stream.js';
import { createHostGate, hostOf, runHostPool, DEFAULT_FETCH_CONCURRENCY } from './host-pool.js';
import { fetchSourceContent } from '../core/worker.js';

export const FETCHERS = Object.freeze({
    worker: 'https://publicai-proxy.alaexis.workers.dev', // userscript, CLI
    toolforge: 'https://source-fetcher.toolforge.org',    // batch pipeline
});

// A page that failed to decode is overwhelmingly U+FFFD (72% and 82% on the
// two reported sources), while a clean page has none or a stray handful from
// a single bad byte. The thresholds sit far from both.
export const GARBLED_MIN_SHARE = 0.05;
export const GARBLED_MIN_COUNT = 50;

// The other way a decode goes wrong: UTF-8 bytes read as Latin-1/Windows-1252
// turn every Cyrillic letter into a two-character pair starting Ð or Ñ
// ("Ð•Ð²Ñ€ÐµÐ¸"). Not seen yet, but it is the same bug with the opposite
// mistake, and it would pass a U+FFFD count untouched.
const MOJIBAKE_PAIR = /[ÐÑ][\u0080-¿]/g;

/**
 * Scores a fetched text for decode damage.
 * @returns {{ length, replacement, mojibake, share, garbled: boolean }}
 */
export function encodingDamage(text) {
    const s = typeof text === 'string' ? text : '';
    let replacement = 0;
    for (const ch of s) if (ch === '�') replacement++;
    const mojibake = (s.match(MOJIBAKE_PAIR) || []).length * 2;
    const damaged = Math.max(replacement, mojibake);
    const share = s.length ? damaged / s.length : 0;
    return {
        length: s.length,
        replacement,
        mojibake,
        share,
        garbled: damaged >= GARBLED_MIN_COUNT && share >= GARBLED_MIN_SHARE,
    };
}

/** 'garbled' | 'clean' | 'fetch_failed' for one fetch result. */
export function classifyFetch(result) {
    if (!result || !result.content) return { status: 'fetch_failed', damage: encodingDamage('') };
    const damage = encodingDamage(result.content);
    return { status: damage.garbled ? 'garbled' : 'clean', damage };
}

const increment = (obj, key, n = 1) => { obj[key] = (obj[key] || 0) + n; };

/**
 * Joins per-URL classifications back onto rows and tallies.
 * @param rows   [{ url, verdict }]
 * @param byUrl  Map url -> { status, damage, error }
 */
export function summarize(rows, byUrl) {
    const summary = {
        rows: rows.length,
        rows_without_url: 0,
        distinct_urls: byUrl.size,
        urls_by_status: {},
        rows_by_status: {},
        garbled_rows_by_verdict: {},
        garbled_hosts: {},
    };
    for (const { status } of byUrl.values()) increment(summary.urls_by_status, status);
    for (const row of rows) {
        if (!row.url) { summary.rows_without_url++; continue; }
        const result = byUrl.get(row.url);
        const status = result ? result.status : 'not_fetched';
        increment(summary.rows_by_status, status);
        if (status === 'garbled') {
            increment(summary.garbled_rows_by_verdict, row.verdict || '(none)');
            increment(summary.garbled_hosts, hostOf(row.url));
        }
    }
    return summary;
}

function csvCell(value) {
    if (value === null || value === undefined) return '';
    const s = String(value);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function urlReportCsv(byUrl, rowCounts) {
    const lines = ['source_url,status,rows,length,replacement_chars,mojibake_chars,damaged_share,fetch_error'];
    for (const [url, r] of byUrl) {
        lines.push([url, r.status, rowCounts.get(url) || 0, r.damage.length, r.damage.replacement,
            r.damage.mojibake, r.damage.share.toFixed(3), r.error || ''].map(csvCell).join(','));
    }
    return lines.join('\n') + '\n';
}

export const HELP_TEXT = `usage: node service/run-encoding-audit.js <rows.csv> [more.csv ...] [options]

Re-fetches every distinct source URL in the given CSVs and reports how many
come back garbled by a charset decoding failure, and which verdicts those rows
received. Writes <out>.json (summary) and <out>-urls.csv (one line per URL).

Options:
  --url-column <name>      Column holding the source URL (default: source_url)
  --verdict-column <name>  Column holding the verdict (default: verdict)
  --fetcher <name>         worker (userscript's proxy) or toolforge (batch's
                           tf-source-fetcher). Default: toolforge.
  --concurrency <n>        Fetches at once, never two per host (default: ${DEFAULT_FETCH_CONCURRENCY})
  --limit <n>              Fetch at most n distinct URLs (for a trial run)
  --out <prefix>           Output prefix (default: encoding-audit)
  --help, -h               Show this help and exit.
`;

async function main(argv) {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
            'url-column': { type: 'string', default: 'source_url' },
            'verdict-column': { type: 'string', default: 'verdict' },
            fetcher: { type: 'string', default: 'toolforge' },
            concurrency: { type: 'string', default: String(DEFAULT_FETCH_CONCURRENCY) },
            limit: { type: 'string' },
            out: { type: 'string', default: 'encoding-audit' },
            help: { type: 'boolean', short: 'h' },
        },
    });
    if (values.help || positionals.length === 0) {
        process.stdout.write(HELP_TEXT);
        return values.help ? 0 : 2;
    }
    const workerBase = FETCHERS[values.fetcher];
    if (!workerBase) {
        process.stderr.write(`unknown --fetcher ${values.fetcher}; use worker or toolforge\n`);
        return 2;
    }

    const rows = [];
    for (const path of positionals) {
        const { header } = await streamCsvRows(path, {
            onRow: row => rows.push({ url: (row[values['url-column']] || '').trim(), verdict: row[values['verdict-column']] || '' }),
        });
        if (!header.includes(values['url-column'])) {
            process.stderr.write(`${path}: no column "${values['url-column']}" (have: ${header.join(', ')})\n`);
            return 2;
        }
    }

    const rowCounts = new Map();
    for (const { url } of rows) if (url) rowCounts.set(url, (rowCounts.get(url) || 0) + 1);
    let urls = [...rowCounts.keys()];
    if (values.limit) urls = urls.slice(0, Number(values.limit));
    process.stderr.write(`${rows.length} rows, ${rowCounts.size} distinct URLs; fetching ${urls.length} via ${workerBase}\n`);

    const byUrl = new Map();
    const hostGate = createHostGate();
    let done = 0;
    await runHostPool(urls, async url => {
        let result;
        try {
            result = await fetchSourceContent(url, null, { workerBase, hostGate });
        } catch (e) {
            result = { content: null, error: e.message };
        }
        const { status, damage } = classifyFetch(result);
        byUrl.set(url, { status, damage, error: result.content ? '' : result.error || '' });
        if (++done % 25 === 0) process.stderr.write(`  ${done}/${urls.length}\n`);
    }, { concurrency: Number(values.concurrency), keyOf: hostOf });

    const summary = summarize(rows, byUrl);
    await writeFile(`${values.out}.json`, JSON.stringify({ fetcher: workerBase, ...summary }, null, 2) + '\n');
    await writeFile(`${values.out}-urls.csv`, urlReportCsv(byUrl, rowCounts));
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main(process.argv.slice(2)).then(code => { process.exitCode = code; }, e => {
        process.stderr.write(`${e.stack || e}\n`);
        process.exitCode = 1;
    });
}
