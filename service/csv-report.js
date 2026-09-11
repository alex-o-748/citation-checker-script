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

import { appendFile as fsAppendFile, writeFile as fsWriteFile } from 'node:fs/promises';
import { hostForWiki } from '../core/wikipedia.js';

// A reviewer reading a row needs to click through to the claim in the
// revision it was actually judged against — this is the difference between a
// CSV and a *shareable* CSV.
function permalink(finding) {
    if (!finding.pageId || !finding.revisionId) return '';
    return `https://${hostForWiki(finding.wiki)}/w/index.php?curid=${finding.pageId}&oldid=${finding.revisionId}`;
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

export function csvHeaderLine() {
    return COLUMNS.map(([name]) => name).map(csvCell).join(',') + '\n';
}

export function findingToCsvLine(finding) {
    return findingToCsvRow(finding).map(csvCell).join(',') + '\n';
}

// Built from the same two functions the incremental writer uses, so a batch
// write and an appended write cannot produce different files.
export function rowsToCsv(findings) {
    return csvHeaderLine() + findings.map(findingToCsvLine).join('');
}

/**
 * Writes findings to a CSV file in one go. `writeFile` is injected, matching
 * the pattern in service/replicas.js and service/toolsdb.js, so this is
 * testable without touching disk.
 */
export async function writeCsvReport(findings, path, { writeFile = fsWriteFile } = {}) {
    await writeFile(path, rowsToCsv(findings), 'utf8');
}

/**
 * Appends one finding to an existing CSV.
 *
 * A sweep over a hundred articles runs for the better part of a day, and a
 * process killed at hour fifteen must not lose what it computed — the same
 * failure describeHalt() in service/run-sweep.js already guards against for
 * in-process errors, which a SIGKILL walks straight past.
 */
export async function appendFinding(path, finding, { appendFile = fsAppendFile } = {}) {
    await appendFile(path, findingToCsvLine(finding), 'utf8');
}

/**
 * The page titles already present in a CSV this module wrote — what --resume
 * skips over.
 *
 * Records can span physical lines: claim_text, rationale and source_quote are
 * arbitrary prose, and csvCell() quotes rather than strips an embedded
 * newline. So this tracks quoting instead of splitting on '\n', which would
 * read the second line of a claim as a fresh record and take a fragment of
 * prose for an article title.
 */
export function csvPageTitles(text) {
    const titles = new Set();
    let field = '';
    let inQuotes = false;
    let atFirstField = true;
    let recordIndex = 0;

    const endRecord = () => {
        // A single-column record ends without ever seeing a comma, so the
        // title is still sitting in `field`; a normal row already banked it.
        if (atFirstField && recordIndex > 0 && field) titles.add(field);
        recordIndex++;
        atFirstField = true;
        field = '';
    };

    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (inQuotes) {
            if (char !== '"') field += char;
            else if (text[i + 1] === '"') { field += '"'; i++; }
            else inQuotes = false;
            continue;
        }
        if (char === '"') inQuotes = true;
        else if (char === ',') {
            // recordIndex 0 is the header row, whose first cell is the
            // literal column name rather than a title.
            if (atFirstField && recordIndex > 0 && field) titles.add(field);
            atFirstField = false;
            field = '';
        } else if (char === '\n') endRecord();
        else if (char === '\r') {
            if (text[i + 1] === '\n') i++;
            endRecord();
        } else field += char;
    }
    endRecord();

    return titles;
}
