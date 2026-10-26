#!/usr/bin/env node
/**
 * Builds the lead-check benchmark's dataset: for each article, its lead
 * sentences (unlabeled) and the body the lead check reads, stored so the set
 * stays reproducible after the articles change. Labels are added by hand —
 * see lead_dataset.js for what each one means.
 *
 * Usage:
 *   node extract_lead_dataset.js --titles-file <path> [--wiki enwiki] [--out dataset_lead.json]
 *   node extract_lead_dataset.js --html <saved Parsoid .html>... --wiki enwiki   (no fetching)
 *
 * Re-running keeps every label already in --out (matched by article and exact
 * sentence text), so an article can be re-extracted without losing work.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';
import { JSDOM } from 'jsdom';
import { fetchArticleHtml, hostForWiki, langCodeForWiki } from '../core/wikipedia.js';
import { sentencexSplitSentences } from '../service/sentences.js';
import { LEAD_PROMPT_VERSION } from '../core/lead-check.js';
import { leadDatasetEntry, carryOverLabels } from './lead_dataset.js';
import { loadRows, writeWithMetadata, todayIso } from './io.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Parsoid puts the revision in <html about=".../revision/<id>">; the title in <title>.
export function parsoidRevision(html) {
    const m = /about="[^"]*\/revision\/(\d+)"/.exec(html.slice(0, 4000));
    return m ? Number(m[1]) : null;
}
function parsoidTitle(html) {
    const m = /<title>([^<]*)<\/title>/.exec(html.slice(0, 4000));
    return m ? m[1].replace(/&amp;/g, '&') : null;
}

async function main() {
    const { values, positionals } = parseArgs({
        args: process.argv.slice(2),
        options: {
            'titles-file': { type: 'string' },
            html: { type: 'boolean', default: false },
            wiki: { type: 'string', default: 'enwiki' },
            out: { type: 'string', default: path.join(__dirname, 'dataset_lead.json') },
            'delay-ms': { type: 'string', default: '2000' },
        },
        allowPositionals: true,
    });
    const split = sentencexSplitSentences(langCodeForWiki(values.wiki));
    const sources = [];
    if (values.html) {
        for (const file of positionals) {
            const html = fs.readFileSync(file, 'utf8');
            sources.push({ title: parsoidTitle(html) ?? path.basename(file, '.html'), html });
        }
    } else if (values['titles-file']) {
        const titles = fs.readFileSync(values['titles-file'], 'utf8').split('\n')
            .map(l => l.trim()).filter(l => l && !l.startsWith('#'));
        for (const title of titles) {
            const { html, status, error } = await fetchArticleHtml({ title }, { host: hostForWiki(values.wiki) });
            if (!html) { console.error(`skipped ${title}: ${status ?? ''} ${error ?? ''}`); continue; }
            sources.push({ title, html });
            await new Promise(r => setTimeout(r, Number(values['delay-ms'])));
        }
    } else {
        console.error('usage: extract_lead_dataset.js --titles-file <path> | --html <file>... [--wiki enwiki] [--out path]');
        return 2;
    }

    const entries = [];
    for (const { title, html } of sources) {
        const entry = leadDatasetEntry({
            wiki: values.wiki, title, revisionId: parsoidRevision(html),
            root: JSDOM.fragment(html), splitSentences: split,
        });
        if (!entry.body.text || entry.sentences.length === 0) {
            console.error(`skipped ${title}: ${entry.body.text ? 'no lead prose' : 'no body (no headings)'}`);
            continue;
        }
        entries.push(entry);
    }

    const previous = fs.existsSync(values.out) ? loadRows(values.out) : [];
    const kept = carryOverLabels(entries, previous);
    const ids = new Set(entries.map(e => e.id));
    const merged = [...previous.filter(e => !ids.has(e.id)), ...entries];
    writeWithMetadata(values.out, {
        description: 'Lead sentences labeled against their article body (see benchmark/lead_dataset.js)',
        extracted: todayIso(),
        lead_prompt_version_at_extraction: LEAD_PROMPT_VERSION,
        articles: merged.length,
        sentences: merged.reduce((n, e) => n + e.sentences.length, 0),
    }, merged);
    console.error(`wrote ${entries.length} article(s) (${entries.reduce((n, e) => n + e.sentences.length, 0)} lead sentences) to ${values.out}; kept ${kept} existing label(s)`);
    return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().then(code => process.exit(code));
}
