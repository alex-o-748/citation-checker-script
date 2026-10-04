#!/usr/bin/env node
// Live progress view of a run-sweep.js findings CSV.
//   node scripts/monitor-csv.js ru-batch2-findings.csv [--total 100] [--every 10]
// Re-reads the file every --every seconds (default 10) and prints articles done,
// rows, verdict counts, ERROR/retries_exhausted, and rows/min. Ctrl-C to stop.
// The CSV has quoted multi-line cells, so it is parsed properly, not by line.

import { readFileSync, existsSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? Number(args[i + 1]) : d; };
const file = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!file) { console.error('usage: monitor-csv.js <findings.csv> [--total N] [--every SEC]'); process.exit(2); }
const total = flag('--total', 0);
const everyMs = flag('--every', 10) * 1000;

function parseCsv(text) {
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (q) {
            if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
            else cell += c;
        } else if (c === '"') q = true;
        else if (c === ',') { row.push(cell); cell = ''; }
        else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
        else if (c !== '\r') cell += c;
    }
    // a trailing partial row (file mid-write) is dropped, not counted
    return rows;
}

const t0 = Date.now();
let baseRows = null;
function tick() {
    if (!existsSync(file)) { console.log(`waiting for ${file}...`); return; }
    const rows = parseCsv(readFileSync(file, 'utf8'));
    if (rows.length < 2) { console.log('header only, no findings yet'); return; }
    const h = rows[0], idx = n => h.indexOf(n);
    const data = rows.slice(1).filter(r => r.length === h.length);
    const count = (col) => {
        const m = {}; for (const r of data) { const v = r[idx(col)] || '(blank)'; m[v] = (m[v] || 0) + 1; }
        return m;
    };
    if (!data.length) { console.log('no complete rows yet'); return; }
    if (baseRows === null) baseRows = data.length;
    const articles = new Set(data.map(r => r[idx('page_title')])).size;
    const verdicts = count('verdict');
    const retries = data.filter(r => r[idx('reason_type')] === 'retries_exhausted').length;
    const mins = Math.max((Date.now() - t0) / 60000, 1 / 60);
    const fmt = o => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join('  ');
    console.log([
        `[${new Date().toISOString().slice(11, 19)}] articles ${articles}${total ? '/' + total : ''}  rows ${data.length}`,
        `  verdicts: ${fmt(verdicts)}`,
        `  fetch:    ${fmt(count('fetch_status'))}`,
        `  retries_exhausted: ${retries}   rate: ${((data.length - baseRows) / mins).toFixed(1)} rows/min since monitor start`,
    ].join('\n'));
    const last = data[data.length - 1];
    console.log(`  last: ${last[idx('page_title')]} #${last[idx('citation_number')]} -> ${last[idx('verdict')]}\n`);
}
tick();
setInterval(tick, everyMs);
