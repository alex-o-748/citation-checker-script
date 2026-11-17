#!/usr/bin/env node
/**
 * Backfills `citation_text` onto an existing dataset.json: for each row, the
 * footnote of its `[N]` marker at the row's pinned revision (the `oldid` in
 * `article_url`), as core/urls.js's extractReferenceText() reads it.
 *
 * One-off, for datasets extracted before extract_dataset.js recorded the
 * field (PROMPT_VERSION v3 sends it to the model; see
 * docs/design-plans/2026-11-08-fixable-causes-of-disputed-verdicts.md §1).
 * Re-extracting would re-fetch every source, which live sites make
 * unreproducible; this reads only Wikipedia, and touches no other field.
 *
 * Usage:
 *   node add_citation_text.js [--dataset dataset.json] [--force] [--dry-run]
 *
 * Rows that already carry `citation_text` are skipped unless --force. A row
 * whose footnote can't be found gets `citation_text: null`, and is counted.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { JSDOM } from 'jsdom';
import { extractCitationTextForCitation, extractCitationTextForRef } from './extract_dataset.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Wikimedia's policy asks automated clients for a descriptive User-Agent.
const USER_AGENT = 'citation-checker-benchmark/1.0 (add_citation_text.js; https://github.com/alex-o-748/citation-checker-script)';
const DELAY_MS = 1000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function fetchArticleDocument(articleUrl, { fetchImpl = fetch, retries = 3 } = {}) {
    for (let attempt = 1; ; attempt++) {
        const response = await fetchImpl(articleUrl, { headers: { 'User-Agent': USER_AGENT } });
        if (response.ok) return JSDOM.fragment(await response.text());
        if (attempt >= retries || (response.status !== 429 && response.status < 500)) {
            throw new Error(`HTTP ${response.status} for ${articleUrl}`);
        }
        await sleep(DELAY_MS * 2 ** attempt);
    }
}

// "human-annotation:… evergreen#67 cite_ref-Schirru_2022_15-1 check_id=…"
export function citeRefFromProvenance(provenance) {
    const match = /(?:^|\s)(cite_ref-\S+)/.exec(provenance || '');
    return match ? match[1] : null;
}

/**
 * Adds citation_text to each row in place. `loadDocument(articleUrl)` returns
 * a parsed article (cached per URL here); injectable for tests.
 * @returns {Promise<{filled: number, missing: number, skipped: number, failedArticles: string[]}>}
 */
export async function addCitationText(rows, { loadDocument, force = false, log = () => {} } = {}) {
    const byArticle = new Map();
    let skipped = 0;
    for (const row of rows) {
        if (!force && typeof row.citation_text === 'string') { skipped++; continue; }
        if (!byArticle.has(row.article_url)) byArticle.set(row.article_url, []);
        byArticle.get(row.article_url).push(row);
    }

    let filled = 0, missing = 0;
    const failedArticles = [];
    for (const [articleUrl, articleRows] of byArticle) {
        let doc;
        try {
            doc = await loadDocument(articleUrl);
        } catch (error) {
            log(`  ${articleUrl}: ${error.message}`);
            failedArticles.push(articleUrl);
            continue;
        }
        for (const row of articleRows) {
            // A row that records its marker's cite_ref id (v4's provenance)
            // is looked up by it: its citation number may be approximate.
            const citeRef = citeRefFromProvenance(row.provenance);
            const text = citeRef
                ? extractCitationTextForRef(doc, citeRef)
                : extractCitationTextForCitation(doc, row.citation_number, row.occurrence || 1);
            row.citation_text = text;
            if (text) filled++; else missing++;
        }
    }
    return { filled, missing, skipped, failedArticles };
}

async function main() {
    const args = process.argv.slice(2);
    const flag = name => args.includes(name);
    const value = name => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
    const datasetPath = path.resolve(__dirname, value('--dataset') || 'dataset.json');

    const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));
    const rows = Array.isArray(dataset) ? dataset : dataset.rows;

    let first = true;
    const loadDocument = async url => {
        if (!first) await sleep(DELAY_MS);
        first = false;
        process.stdout.write('.');
        return fetchArticleDocument(url);
    };
    const summary = await addCitationText(rows, { loadDocument, force: flag('--force'), log: m => console.log(`\n${m}`) });
    console.log(`\nfilled ${summary.filled}, no footnote found ${summary.missing}, already present ${summary.skipped}, articles failed ${summary.failedArticles.length}`);

    if (flag('--dry-run')) return;
    fs.writeFileSync(datasetPath, `${JSON.stringify(dataset, null, 2)}\n`);
    console.log(`wrote ${datasetPath}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().catch(error => { console.error(error); process.exit(1); });
}
