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
// model ran"). The internal identity hashes (claim_hash, source_url_hash)
// are dropped — they mean nothing to a reader and exist only to dedupe rows
// in ToolsDB.

import { writeFile as fsWriteFile } from 'node:fs/promises';

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

// [csv header, finding -> cell value]. Order is the column order in the
// file. Kept as a flat list (rather than Object.entries on some template)
// so the header and the extraction logic can't drift apart.
const COLUMNS = [
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
    ['confidence', f => f.confidence],
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

/**
 * Writes findings to a CSV file. `writeFile` is injected, matching the
 * pattern in service/replicas.js and service/toolsdb.js, so this is
 * testable without touching disk.
 */
export async function writeCsvReport(findings, path, { writeFile = fsWriteFile } = {}) {
    await writeFile(path, rowsToCsv(findings), 'utf8');
}
