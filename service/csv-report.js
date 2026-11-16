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
import { createReadStream as fsCreateReadStream, createWriteStream as fsCreateWriteStream } from 'node:fs';
import { createCsvParser } from './csv-stream.js';
import { extname } from 'node:path';
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
    ['fetch_error', f => f.fetchError],
    ['source_truncated', f => (f.sourceTruncated ? 1 : 0)],
    ['provider', f => f.provider],
    ['model', f => f.model],
    ['prompt_version', f => f.promptVersion],
    ['tokens_in', f => f.tokensIn],
    ['tokens_out', f => f.tokensOut],
    ['published', f => (f.published ? 1 : 0)],
    // Severity pass (core/severity.js). is_blp is empty, not 0, on a wiki
    // with no confirmed living-people category — "can't tell" is not "no".
    ['is_blp', f => (f.isBlp === null || f.isBlp === undefined ? null : (f.isBlp ? 1 : 0))],
    ['section_title', f => f.sectionTitle],
    ['severity_tier', f => f.severityTier],
    ['severity_subclaims', f => (f.severitySubclaims ? JSON.stringify(f.severitySubclaims) : null)],
    ['severity_error', f => f.severityError],
    ['severity_prompt_version', f => f.severityPromptVersion],
    // Last, not first, despite being the row's identifier — csvPageTitles()
    // below reads the FIRST field of every record as the page title, which is
    // what --resume skips on. Moving check_id to column 1 would silently make
    // every resume treat an id as an article title and re-check the whole
    // batch. If this ever does belong at the front, teach csvPageTitles() to
    // locate page_title by header name first.
    ['check_id', f => f.checkId],
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

// Parses RFC4180 records, including quoted newlines. This deliberately lives
// beside csvCell(): the cleaner below is also intended for CSVs from previous
// runs, so it cannot rely on the in-memory finding objects of the current run.
export function parseCsv(text) {
    const records = [];
    let record = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (inQuotes) {
            if (char !== '"') field += char;
            else if (text[i + 1] === '"') { field += '"'; i++; }
            else inQuotes = false;
        } else if (char === '"' && field === '') inQuotes = true;
        else if (char === ',') { record.push(field); field = ''; }
        else if (char === '\n' || char === '\r') {
            if (char === '\r' && text[i + 1] === '\n') i++;
            record.push(field);
            records.push(record);
            record = [];
            field = '';
        } else field += char;
    }
    if (field !== '' || record.length) {
        record.push(field);
        records.push(record);
    }
    return records;
}

export function cleanCsvPath(path) {
    const extension = extname(path);
    return extension
        ? `${path.slice(0, -extension.length)}-clean${extension}`
        : `${path}-clean.csv`;
}

/**
 * Three independent rules, so none depends on what another removed:
 *
 * 1. A finding on a truncated source is kept only if it is SUPPORTED or NOT
 *    SUPPORTED / contradiction — verdicts resting on a passage the model
 *    actually saw, which text past the cutoff cannot undo. Everything else on
 *    a truncated source (omission above all: "not mentioned" may just mean
 *    "past the cutoff") is dropped.
 * 2. Once an adjacent-citation group has a collective finding, its individual
 *    findings are never shown — even when rule 1 or 3 dropped the collective
 *    itself. Falling back to the members there would surface one source's
 *    partial view of a claim several sources back.
 * 3. In a group where any source is SOURCE UNAVAILABLE, the group's verdict
 *    loses its PARTIALLY SUPPORTED and NOT SUPPORTED / omission findings:
 *    "not in the sources" may just mean "in the one nobody read". The group's
 *    verdict is its collective row when there is one, and otherwise its
 *    members' rows — core/groups.js's shouldSkipCollective() skips the
 *    collective when only one source is readable, so in the commonest
 *    incomplete group the members are all there is. Rule 2 already removes
 *    members once a collective exists, so this applies to every row in the
 *    group. It is the cleaner's half of what core/groups.js's
 *    hasUnreadSource() does for the severity pass.
 *
 * Group IDs are only meaningful within an article revision, so the key
 * includes page identity.
 */
// The three rules below need two facts about the whole file (which groups
// have a collective row, which have an unreadable source) before any row can
// be judged, so they are applied in two passes: observe() every row, then
// keep() decides each one. Shared by cleanCsvText() (a string, for tests and
// small files) and writeCleanCsv() (streamed, for real sweeps).
export function createCleanRules(header) {
    const indexes = Object.fromEntries(header.map((name, index) => [name, index]));
    for (const name of ['source_truncated', 'is_collective', 'group_id', 'verdict', 'reason_type']) {
        if (indexes[name] === undefined) throw new Error(`CSV is missing required column: ${name}`);
    }
    const truthy = value => /^(?:1|true|yes)$/i.test(value.trim());
    const groupKey = row => [
        indexes.page_id === undefined ? '' : row[indexes.page_id],
        indexes.revision_id === undefined ? '' : row[indexes.revision_id],
        indexes.page_title === undefined ? '' : row[indexes.page_title],
        row[indexes.group_id],
    ].join('\u0000');
    const isCollective = row => truthy(row[indexes.is_collective] || '');
    const survivesTruncation = row => row[indexes.verdict] === 'SUPPORTED'
        || (row[indexes.verdict] === 'NOT SUPPORTED' && row[indexes.reason_type] === 'contradiction');
    // Narrower than !survivesTruncation(): only the verdicts unread text could
    // undo. An ERROR or SKIPPED row says nothing about the claim either way.
    const undoneByUnreadSource = row => row[indexes.verdict] === 'PARTIALLY SUPPORTED'
        || (row[indexes.verdict] === 'NOT SUPPORTED' && row[indexes.reason_type] !== 'contradiction');
    const collectiveGroups = new Set();
    const incompleteGroups = new Set();
    return {
        observe(row) {
            if (!row[indexes.group_id]) return;
            if (isCollective(row)) collectiveGroups.add(groupKey(row));
            if (row[indexes.verdict] === 'SOURCE UNAVAILABLE') incompleteGroups.add(groupKey(row));
        },
        keep(row) {
            if (truthy(row[indexes.source_truncated] || '') && !survivesTruncation(row)) return false;
            if (row[indexes.group_id] && !isCollective(row) && collectiveGroups.has(groupKey(row))) return false;
            if (row[indexes.group_id] && incompleteGroups.has(groupKey(row)) && undoneByUnreadSource(row)) return false;
            return true;
        },
    };
}

const csvLine = row => row.map(csvCell).join(',');

export function cleanCsvText(text) {
    const records = parseCsv(text);
    if (records.length === 0) throw new Error('CSV is empty');
    const [header, ...rows] = records;
    const rules = createCleanRules(header);
    for (const row of rows) rules.observe(row);
    return [header, ...rows.filter(row => rules.keep(row))].map(csvLine).join('\n') + '\n';
}

// Streams the file twice rather than loading it: a whole ruwiki sweep's CSV
// (113,680 rows, 2026-11) parsed into arrays outgrew the job's 2 GiB, and
// since this runs at the very end of run-sweep.js the process died after a
// multi-day run without writing the clean CSV or the post-run checks. Memory
// is now the two sets of group keys, whatever the file's size. Output is
// byte-identical to cleanCsvText() (tests/csv-report.test.js pins that).
export async function writeCleanCsv(inputPath, outputPath = cleanCsvPath(inputPath), {
    createReadStream = fsCreateReadStream,
    createWriteStream = fsCreateWriteStream,
} = {}) {
    // One pass over the file; onRow sees every record after the header.
    const pass = async (onHeader, onRow) => {
        let seenHeader = false;
        const parser = createCsvParser(fields => {
            if (!seenHeader) { seenHeader = true; onHeader(fields); return; }
            onRow(fields);
        });
        for await (const chunk of createReadStream(inputPath, { encoding: 'utf8' })) {
            parser.write(chunk);
            await afterChunk();
        }
        parser.end();
        await afterChunk();
        return seenHeader;
    };
    let afterChunk = async () => {};

    let rules = null;
    let header = null;
    if (!await pass(h => { header = h; rules = createCleanRules(h); }, row => rules.observe(row))) {
        throw new Error('CSV is empty');
    }

    const out = createWriteStream(outputPath, { encoding: 'utf8' });
    let pending = csvLine(header) + '\n';
    // Written once per input chunk, so memory is bounded by the chunk size.
    afterChunk = async () => {
        if (!pending) return;
        const ok = out.write(pending);
        pending = '';
        if (!ok) await new Promise(resolve => out.once('drain', resolve));
    };
    await pass(() => {}, row => { if (rules.keep(row)) pending += csvLine(row) + '\n'; });
    await new Promise((resolve, reject) => out.end(err => (err ? reject(err) : resolve())));
    return outputPath;
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
