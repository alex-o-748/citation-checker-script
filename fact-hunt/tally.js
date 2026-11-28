#!/usr/bin/env node
// Prints what people did on Fact Hunt, from the event log.
//
//   node tally.js [events.jsonl] [--since 7d|2026-11-01] [--until <date>] [--cards cards.json] [--top 10] [--json]
//
// The log defaults to EVENTS_FILE, and the cards file (for article titles)
// to CARDS_FILE. Read-only.

import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseEvents, parseWhen, tally, formatTally } from './lib/tally.js';

export function parseArgs(argv) {
    const opts = { file: null, since: null, until: null, cards: null, top: 10, json: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--json') opts.json = true;
        else if (a === '--since' || a === '--until' || a === '--cards' || a === '--top') {
            const value = argv[++i];
            if (value == null) throw new Error(`${a} needs a value`);
            opts[a.slice(2)] = a === '--top' ? Number(value) : value;
        } else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
        else opts.file = a;
    }
    return opts;
}

function cardTitles(file) {
    const titles = new Map();
    if (!file || !existsSync(file)) return titles;
    try {
        const data = JSON.parse(readFileSync(file, 'utf8'));
        for (const c of data.cards || data) if (c?.id) titles.set(c.id, c.pageTitle);
    } catch { /* titles are a nicety; ids will do */ }
    return titles;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    let opts;
    try { opts = parseArgs(process.argv.slice(2)); } catch (error) { console.error(`tally: ${error.message}`); process.exit(2); }
    const file = opts.file || process.env.EVENTS_FILE;
    if (!file || !existsSync(file)) {
        console.error(`tally: no event log${file ? ` at ${file}` : ' (pass a path or set EVENTS_FILE)'}`);
        process.exit(2);
    }
    let since;
    let until;
    try { since = parseWhen(opts.since); until = parseWhen(opts.until); } catch (error) { console.error(`tally: ${error.message}`); process.exit(2); }
    const result = tally(parseEvents(readFileSync(file, 'utf8')), { since, until, top: opts.top });
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else console.log(formatTally(result, { titles: cardTitles(opts.cards || process.env.CARDS_FILE) }));
}
