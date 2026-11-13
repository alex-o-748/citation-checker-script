#!/usr/bin/env node
// Lists the edits that changed claims, one row per edit, with its edit
// summary — the quickest way to see what the "changed" count is made of.
//
//   node analysis/list-changes.js ~/edit-impact/enwiki            # flagged claims
//   node analysis/list-changes.js ~/edit-impact/enwiki --group supported
//
// Reads suggestions.csv and revisions.csv from a run-edit-impact.js output
// folder; prints Markdown and writes it to changes-<group>.md beside them.

import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { streamCsvRows } from '../service/csv-stream.js';

const esc = text => String(text ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const clip = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

export function changesMarkdown({ group, edits, totalClaims }) {
    const lines = [
        `# Edits that first changed a ${group} claim`,
        '',
        `${totalClaims} ${group} claims changed, by ${edits.length} edits. One row per edit, oldest first.`,
        'Marks: **bot** bot account · **rev** later reverted (`mw-reverted`) · **seen** / **used** Suggestion Mode tags (any suggestion type).',
        '',
        '| # | Page | When (UTC) | Editor | Marks | Edit summary | Claims changed | Diff |',
        '|---|---|---|---|---|---|---|---|',
    ];
    edits.forEach((e, i) => {
        const marks = [e.is_bot && 'bot', e.reverted && 'rev', e.seen && 'seen', e.used && 'used'].filter(Boolean).join(' ');
        const claims = e.claims.map(c => `[${c.citation_number}] ${esc(c.kinds).replace(/\\\|/g, " + ")}: “${esc(clip(c.claim_text, 70))}”`).join('<br>');
        lines.push(`| ${i + 1} | ${esc(e.page_title)} | ${e.timestamp.slice(0, 16).replace('T', ' ')} | ${esc(e.user || '(hidden)')}`
            + ` | ${marks} | ${esc(clip(e.comment || '(no summary)', 200))} | ${claims} | [diff](${e.diff}) |`);
    });
    return `${lines.join('\n')}\n`;
}

export async function collectChanges(dir, group, { stream = streamCsvRows } = {}) {
    const revisions = new Map();
    await stream(join(dir, 'revisions.csv'), { onRow: row => revisions.set(row.rev_id, row) });
    const byRev = new Map();
    let totalClaims = 0;
    await stream(join(dir, 'suggestions.csv'), {
        onRow: row => {
            if (row.group !== group || row.changed !== '1') return;
            totalClaims++;
            if (!byRev.has(row.first_change_rev_id)) byRev.set(row.first_change_rev_id, []);
            byRev.get(row.first_change_rev_id).push({
                citation_number: row.citation_number, kinds: row.first_change_kinds, claim_text: row.claim_text,
            });
        },
    });
    const edits = [...byRev].map(([revId, claims]) => {
        const r = revisions.get(revId) ?? {};
        return {
            rev_id: revId, claims, page_title: r.page_title ?? '?', timestamp: r.timestamp ?? '', user: r.user,
            comment: r.comment, diff: r.diff ?? '', is_bot: r.is_bot === '1', reverted: r.mw_reverted === '1',
            seen: r.seen === '1', used: r.used === '1',
        };
    }).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return { group, edits, totalClaims };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: { group: { type: 'string', default: 'flagged' } } });
    if (positionals.length !== 1) {
        process.stderr.write('usage: node analysis/list-changes.js <output folder, e.g. ~/edit-impact/enwiki> [--group flagged|supported]\n');
        process.exit(2);
    }
    const md = changesMarkdown(await collectChanges(positionals[0], values.group));
    const out = join(positionals[0], `changes-${values.group}.md`);
    await writeFile(out, md);
    process.stdout.write(md);
    process.stderr.write(`wrote ${out}\n`);
}
