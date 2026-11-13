// Reads the batch files listed in analysis/batches.json and turns their rows
// into the suggestions this analysis follows.
//
// Two groups, from the same files and the same pages:
//   flagged    NOT SUPPORTED / PARTIALLY SUPPORTED — what Suggestion Mode
//              shows as llmSourceVerification
//   supported  SUPPORTED — never shown; the control for ordinary article churn
// Everything else (SOURCE UNAVAILABLE, SKIPPED, ERROR) is neither shown nor a
// clean control, and is left out.

import { createReadStream, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createGunzip } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCsvParser } from '../../service/csv-stream.js';

export const MANIFEST_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'batches.json');

export const FLAGGED_VERDICTS = new Set(['NOT SUPPORTED', 'PARTIALLY SUPPORTED']);
export const CONTROL_VERDICTS = new Set(['SUPPORTED']);

export function groupForVerdict(verdict) {
    if (FLAGGED_VERDICTS.has(verdict)) return 'flagged';
    if (CONTROL_VERDICTS.has(verdict)) return 'supported';
    return null;
}

export async function loadManifest(path = MANIFEST_PATH) {
    return JSON.parse(await readFile(path, 'utf8'));
}

/** The file for a batch in `dir`: the CSV itself, or its .gz from the data/batches branch. */
export function batchFilePath(dir, batch) {
    for (const name of [batch.file, `${batch.file}.gz`]) {
        const path = join(dir, name);
        if (existsSync(path)) return path;
    }
    return null;
}

async function streamRows(path, onRow) {
    let header = null;
    const parser = createCsvParser(fields => {
        if (!header) { header = fields.map((f, i) => (i === 0 ? f.replace(/^﻿/, '') : f)); return; }
        if (fields.length === 1 && fields[0] === '') return;
        if (fields.length !== header.length) throw new Error(`${path}: a row has ${fields.length} fields, the header ${header.length}`);
        const row = {};
        header.forEach((name, i) => { row[name] = fields[i]; });
        onRow(row);
    });
    let stream = createReadStream(path);
    if (path.endsWith('.gz')) stream = stream.pipe(createGunzip());
    stream.setEncoding('utf8');
    for await (const chunk of stream) parser.write(chunk);
    if (parser.end().unterminated) throw new Error(`${path}: ends inside a quoted field (truncated file?)`);
}

/**
 * Loads every suggestion for `wiki` from the manifest's batches found in
 * `dir`. `titles`, when given, keeps only those pages (the validation runs).
 * Returns { suggestions, batches, missing } — `missing` lists manifest batches
 * whose file isn't in `dir`, which the caller reports rather than ignores.
 */
export async function loadSuggestions({ dir, wiki, titles = null, manifest }) {
    const wanted = titles ? new Set(titles) : null;
    const suggestions = [];
    const batches = [];
    const missing = [];
    for (const batch of manifest.batches.filter(b => b.wiki === wiki)) {
        const path = batchFilePath(dir, batch);
        if (!path) { missing.push(batch.batch_id); continue; }
        batches.push(batch);
        await streamRows(path, row => {
            const group = groupForVerdict(row.verdict);
            if (!group) return;
            if (wanted && !wanted.has(row.page_title)) return;
            suggestions.push({
                wiki,
                batch_id: batch.batch_id,
                live_from: batch.live_from,
                live_until: batch.live_until,
                group,
                check_id: row.check_id,
                page_id: Number(row.page_id),
                page_title: row.page_title,
                checked_revision_id: Number(row.revision_id),
                citation_number: row.citation_number,
                ref_name: row.ref_name,
                is_collective: row.is_collective === '1',
                group_id: row.group_id,
                verdict: row.verdict,
                reason_type: row.reason_type,
                rationale: row.rationale,
                claim_text: row.claim_text,
                source_url: row.source_url,
            });
        });
    }
    return { suggestions, batches, missing };
}
