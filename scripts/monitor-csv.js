#!/usr/bin/env node
// Live progress view of a run-sweep.js findings CSV.
//   node scripts/monitor-csv.js ru-batch2-findings.csv [--total 100] [--every 10]
// Prints articles done, rows, verdict / fetch-status counts, ERROR reasons and
// rows/min every --every seconds (default 10). Ctrl-C to stop.
//
// Memory is O(one row), not O(file): the file is read incrementally from the
// last byte offset and fed through a streaming CSV parser that keeps only the
// five columns it needs. (The first version re-parsed the whole file into an
// array of arrays every tick and was OOM-killed in a Toolforge shell at ~12k
// rows.) The CSV has quoted multi-line cells, so it is parsed, not split.

import { openSync, readSync, closeSync, statSync, existsSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? Number(args[i + 1]) : d; };
const file = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!file) { console.error('usage: monitor-csv.js <findings.csv> [--total N] [--every SEC]'); process.exit(2); }
const total = flag('--total', 0);
const everyMs = flag('--every', 10) * 1000;

const WANTED = ['page_title', 'citation_number', 'verdict', 'fetch_status', 'reason_type'];

// ---- streaming parser state (survives across ticks and chunk boundaries) ----
let decoder, offset, header, wantedAt, col, cell, inQuote, pendingQuote, rowVals, state;
function reset() {
    decoder = new StringDecoder('utf8');
    offset = 0; header = null; wantedAt = null;
    col = 0; cell = ''; inQuote = false; pendingQuote = false; rowVals = {};
    state = { articles: new Set(), rows: 0, verdicts: {}, fetch: {}, errors: {}, last: null };
}
reset();

const bump = (o, k) => { k = k || '(blank)'; o[k] = (o[k] || 0) + 1; };

function endCell() {
    if (header === null) {
        (endCell.h ??= []).push(cell);
    } else if (wantedAt.has(col)) {
        rowVals[wantedAt.get(col)] = cell;
    }
    col++; cell = '';
}

function endRow() {
    if (header === null) {
        header = endCell.h; endCell.h = null;
        wantedAt = new Map(WANTED.map(n => [header.indexOf(n), n]).filter(([i]) => i >= 0));
        if (wantedAt.size) { /* keyed by column index */ }
    } else if (col === header.length) { // complete row only
        const v = rowVals;
        state.rows++;
        state.articles.add(v.page_title);
        bump(state.verdicts, v.verdict);
        bump(state.fetch, v.fetch_status);
        if (v.verdict === 'ERROR') bump(state.errors, v.reason_type);
        state.last = `${v.page_title} #${v.citation_number} -> ${v.verdict}`;
    }
    col = 0; cell = ''; rowVals = {};
}

function feed(text) {
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQuote) {
            if (pendingQuote) {
                pendingQuote = false;
                if (c === '"') { cell += '"'; continue; }
                inQuote = false; // the quote closed the cell; fall through to handle c
            } else if (c === '"') { pendingQuote = true; continue; }
            else { if (header === null || wantedAt.has(col)) cell += c; continue; }
        }
        if (c === '"') inQuote = true;
        else if (c === ',') endCell();
        else if (c === '\n') { endCell(); endRow(); }
        else if (c !== '\r' && (header === null || wantedAt.has(col))) cell += c;
    }
}

// wantedAt is a Map(index -> name); `.has(col)` above tests the index
const t0 = Date.now();
let baseRows = null;
const fmt = o => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join('  ');

function tick() {
    if (!existsSync(file)) { console.log(`waiting for ${file}...`); return; }
    const size = statSync(file).size;
    if (size < offset) reset(); // file was replaced/truncated: start over
    const fd = openSync(file, 'r');
    try {
        const buf = Buffer.allocUnsafe(1 << 20);
        let n;
        while ((n = readSync(fd, buf, 0, buf.length, offset)) > 0) {
            offset += n;
            feed(decoder.write(buf.subarray(0, n)));
        }
    } finally { closeSync(fd); }

    if (!state.rows) { console.log(header ? 'no complete rows yet' : 'waiting for header...'); return; }
    if (baseRows === null) baseRows = state.rows;
    const mins = Math.max((Date.now() - t0) / 60000, 1 / 60);
    console.log([
        `[${new Date().toISOString().slice(11, 19)}] articles ${state.articles.size}${total ? '/' + total : ''}  rows ${state.rows}`,
        `  verdicts: ${fmt(state.verdicts)}`,
        `  fetch:    ${fmt(state.fetch)}`,
        `  ERROR reasons: ${fmt(state.errors) || 'none'}   rate: ${((state.rows - baseRows) / mins).toFixed(1)} rows/min since monitor start`,
        `  last: ${state.last}`,
        `  heap: ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB\n`,
    ].join('\n'));
}
tick();
setInterval(tick, everyMs);
