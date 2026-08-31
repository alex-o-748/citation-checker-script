// Stage 6 (partial): turns computed findings (service/finding-builder.js's
// assembleFinding() / assembleGroupFinding() output) into a shareable CSV —
// the "I run a script and I get a CSV I can share" deliverable docs/design-plans/
// 2026-08-24-csv-deliverable-and-component-names.md (G2) proposes in place of
// a read API nobody has a contract for yet (stage 6 as the parent design doc,
// 2026-08-07-batch-source-checks-for-edit-suggestions.md, originally
// specified it — gated on open question 3, whether the Suggestions surface
// resolves claim text to a wikitext location itself).
//
// Two layers, same split as service/findings-store.js: rowsToCsv() is pure
// string building, testable without a filesystem; writeCsvReport() is the
// thin file-write wrapper.
//
// Every finding is included, not just ones that flagged a problem — a row
// where no model ran (no URL, fetch failed) is still a citation someone
// looked at, and dropping it would overstate coverage to exactly the
// audience most likely to be misled by that (G2's "include the rows where no
// model ran"). ToolsDB's own claim_hash/source_url_hash columns are never
// exposed directly — they mean nothing to a reader on their own. check_id
// (below) is a different thing: a reader-facing identifier so a specific row
// can be referenced in conversation ("row a1b2c3..."), derived from the same
// identity fields ToolsDB's own uniq_finding key uses, not the raw hashes
// themselves.

import { createHash } from 'node:crypto';
import { writeFile as fsWriteFile } from 'node:fs/promises';
import { claimHash, sourceUrlHash } from '../core/anchor.js';

// service/article-picker.js queries a Wiki Replicas database name ('enwiki',
// 'frwiki', ...), not a domain. Only enwiki exists in practice today (per
// CLAUDE.md's "per-wiki scope" — the prompt's few-shot examples are tuned on
// English Wikipedia), so this heuristic is deliberately simple rather than a
// real wiki-to-domain table; revisit if a second wiki is ever added.
function wikiDomain(wiki) {
    if (!wiki) return 'en.wikipedia.org';
    return wiki.endsWith('wiki') ? `${wiki.slice(0, -4)}.wikipedia.org` : `${wiki}.wikipedia.org`;
}

// A reviewer reading a row needs to click through to the claim in the
// revision it was actually judged against — this is the difference between a
// CSV and a *shareable* CSV.
function permalink(finding) {
    if (!finding.pageId || !finding.revisionId) return '';
    return `https://${wikiDomain(finding.wiki)}/w/index.php?curid=${finding.pageId}&oldid=${finding.revisionId}`;
}

// Deterministic per-finding reference id, for pointing at one specific row
// in conversation ("check a1b2c3d4e5f6") — not present anywhere else in the
// system today (unlike main.js's logVerification()'s check_id, a Neon-side
// id from the live userscript's entirely separate logging path, unrelated to
// this batch pipeline). Reuses ToolsDB's own uniq_finding identity —
// (wiki, page_id, claim_hash, source_url_hash, provider, prompt_version) —
// computed independently here from fields already on the finding object,
// not by exposing findings-store.js's stored hashes. Deterministic on
// purpose: the same claim, source, provider, and prompt version always
// produce the same id, with or without --store, so a citation re-verified in
// a later run (unchanged) is still recognizably "the same row" — something a
// fresh ToolsDB auto-increment id could never give a CSV-only run.
//
// Truncated to 12 hex chars (48 bits) — short enough to read aloud or paste
// into a sentence; collision risk at the scale one sweep's CSV holds
// (thousands of rows, not billions) is negligible.
function checkId(finding) {
    const composite = createHash('sha256')
        .update(String(finding.wiki ?? ''))
        .update('\0')
        .update(String(finding.pageId ?? ''))
        .update('\0')
        .update(claimHash(finding.claimText))
        .update('\0')
        .update(sourceUrlHash(finding.sourceUrl))
        .update('\0')
        .update(String(finding.provider ?? ''))
        .update('\0')
        .update(String(finding.promptVersion ?? ''))
        .digest('hex');
    return composite.slice(0, 12);
}

// [csv header, finding -> cell value]. Order is the column order in the
// file. Kept as a flat list (rather than Object.entries on some template)
// so the header and the extraction logic can't drift apart.
const COLUMNS = [
    ['check_id', f => checkId(f)],
    ['page_title', f => f.pageTitle],
    ['page_id', f => f.pageId],
    ['revision_id', f => f.revisionId],
    ['permalink', f => permalink(f)],
    ['citation_number', f => f.citationNumber],
    ['ref_name', f => f.refName],
    ['is_collective', f => (f.isCollective ? 1 : 0)],
    ['group_id', f => f.groupId],
    ['claim_text', f => f.claimText],
    ['source_url', f => f.sourceUrl],
    ['verdict', f => f.verdict],
    ['support_score', f => f.supportScore],
    ['reason_type', f => f.reasonType],
    ['rationale', f => f.rationale],
    ['source_quote', f => f.sourceQuote],
    ['quote_status', f => f.quoteStatus],
    ['fetch_status', f => f.fetchStatus],
    ['source_truncated', f => (f.sourceTruncated ? 1 : 0)],
    ['provider', f => f.provider],
    ['model', f => f.model],
    ['prompt_version', f => f.promptVersion],
    ['tokens_in', f => f.tokensIn],
    ['tokens_out', f => f.tokensOut],
    ['published', f => (f.published ? 1 : 0)],
];

// RFC4180-style escaping: quote a cell that contains a comma, quote, or
// newline, doubling any internal quote. claim_text / rationale / source_quote
// are arbitrary web and model prose — exactly the kind of text CLAUDE.md
// warns is never safe to write raw into a structured format.
function csvCell(value) {
    if (value === null || value === undefined) return '';
    const s = String(value);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function findingToCsvRow(finding) {
    return COLUMNS.map(([, get]) => get(finding));
}

export function rowsToCsv(findings) {
    const header = COLUMNS.map(([name]) => name);
    const lines = [header, ...findings.map(findingToCsvRow)];
    return lines.map(row => row.map(csvCell).join(',')).join('\n') + '\n';
}

// Excel (and some other spreadsheet tools) has no way to detect a CSV's
// encoding other than a byte-order mark, and defaults to the system's legacy
// codepage (Windows-1252/ANSI) without one — every byte of UTF-8 non-ASCII
// text then gets shown as mojibake (Cyrillic, Greek, accented Latin, all of
// it) despite the file on disk being perfectly valid UTF-8. The BOM is inert
// for every other consumer this CSV has (rowsToCsv's own tests, `cat`, Node's
// own CSV/JSON tooling all either strip it or ignore it), so there is no
// downside to always including it — this file is the "share it with someone"
// deliverable, and that someone is likely opening it in a spreadsheet app.
const CSV_BOM = '﻿';

/**
 * Writes findings to a CSV file. `writeFile` is injected, matching the
 * pattern in service/replicas.js and service/toolsdb.js, so this is
 * testable without touching disk.
 */
export async function writeCsvReport(findings, path, { writeFile = fsWriteFile } = {}) {
    await writeFile(path, CSV_BOM + rowsToCsv(findings), 'utf8');
}
