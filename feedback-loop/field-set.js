// The field regression set: benchmark/dataset_field.json.
//
// Rows are never deleted. A check the owner drops is kept as a marker
// (excluded_reason: 'dropped by the owner'), because a missing check id looks
// untriaged and the next run would read it again.
//
// Rows are dataset.json's schema, so the benchmark takes the file as it is:
//
//   cd benchmark && node run_benchmark.js --dataset dataset_field.json --results results_field.json
//
// run_benchmark.js scores only rows that are `extraction_status: 'complete'`
// and not `needs_manual_review`, and analyze_results.js drops rows carrying an
// `excluded_reason` — so an unconfirmed or unusable row is held in the file
// without being scored, and confirming one is a single edit.
//
// Kept apart from dataset.json for the reason WiCE is (CLAUDE.md, "WiCE"):
// every row here was selected by someone reacting to a verdict, most of them
// disagreeing, so pooling it with the representative set would silently
// change what headline accuracy means.
//
// Each row also carries a `field` block: the check as the tool logged it, the
// editor's feedback, the pattern hints, the adjudication, and the label's
// provenance. Nothing in it identifies the rater.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { loadRows, loadMetadata, writeWithMetadata } from '../benchmark/io.js';
import { LABEL_STATUSES } from './adjudicate.js';

export const FIELD_DATASET_VERSION = 'field';

export function fieldRowId(checkId) {
    return `field_${checkId}`;
}

export function sha256(text) {
    return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

/**
 * One triaged case as a dataset row.
 *
 * @param {object} c - normalizeCase() output
 * @param {object} t
 * @param {string} t.sourceText - re-fetched source body
 * @param {boolean} t.sourceTruncated
 * @param {string} t.fetchedAt - ISO timestamp of the re-fetch
 * @param {object} t.adjudication - adjudicateCase() output
 * @param {object} t.label - proposeLabel() output
 * @param {string[]} t.hints - tagCauses(c.check)
 * @param {string} t.triagedAt - ISO timestamp
 */
export function buildFieldRow(c, { sourceText, sourceTruncated, fetchedAt, adjudication, label, hints, triagedAt }) {
    return {
        id: fieldRowId(c.checkId),
        article_url: c.check.articleUrl,
        article_title: c.check.articleTitle,
        citation_number: c.check.citationNumber,
        claim_text: c.check.claimText,
        claim_container: null,
        source_url: c.check.sourceUrl,
        source_text: sourceText,
        source_truncated: Boolean(sourceTruncated),
        ground_truth: label.groundTruth,
        dataset_version: FIELD_DATASET_VERSION,
        extraction_status: 'complete',
        // An agreed label is accepted as it lands, unless auto-accepting is
        // paused (feedback-loop/digest.js autoAcceptState), when it is held
        // for the owner like any other row.
        needs_manual_review: label.labelStatus !== LABEL_STATUSES.AGREED || Boolean(label.held),
        excluded_reason: label.excludedReason,
        provenance: {
            from: 'editor feedback on a logged check (Neon: feedback + verification_logs)',
            source_fetched_at: fetchedAt,
            source_sha256: sha256(sourceText),
        },
        field: {
            check_id: c.checkId,
            wiki: c.check.wiki,
            revision_id: c.check.revisionId,
            checked_at: c.check.checkedAt,
            tool: {
                provider: c.check.provider,
                model: c.check.model,
                verdict: c.check.verdict,
                reason_type: c.check.reasonType,
                support_score: c.check.supportScore,
                comments: c.check.comments,
                source_quote: c.check.sourceQuote,
                quote_status: c.check.quoteStatus,
            },
            feedback: {
                rating: c.rating,
                corrected_verdict: c.correctedVerdict,
                editor_verdict: c.editor.verdict,
                inconsistent: c.editor.inconsistent,
                feedback_at: c.feedbackAt,
                feedback_rows: c.feedbackRows,
                quick_rating: c.rater.quick,
                heavy_session: c.rater.heavySession,
                wiki_section: c.wikiSection,
            },
            hints,
            adjudication,
            label: {
                status: label.labelStatus,
                // What triage proposed. A ground_truth that no longer equals
                // this was edited by the owner, and is never overwritten.
                proposed_ground_truth: label.groundTruth,
                suggested_by: label.suggestedBy,
                reasons: label.reasons,
                held: Boolean(label.held),
            },
            triaged_at: triagedAt,
        },
    };
}

/**
 * Whether the owner has decided this row's label, by any of the edits the
 * review instructions describe: marking it `owner`, changing ground_truth, or
 * clearing needs_manual_review on a row triage had left for them.
 */
export function isOwnerDecided(row) {
    const label = row?.field?.label;
    if (!label) return true; // not a triage row at all: hands off
    if (label.status === LABEL_STATUSES.OWNER) return true;
    if (row.ground_truth !== label.proposed_ground_truth) return true;
    return label.status === LABEL_STATUSES.NEEDS_OWNER && row.needs_manual_review === false;
}

/**
 * Merges newly triaged rows into the existing set, keyed by check id.
 * New check ids are added. An existing row is replaced only with
 * `retriage`, and never when the owner has decided it.
 */
export function mergeFieldRows(existingRows, newRows, { retriage = false } = {}) {
    const byCheck = new Map(existingRows.map(r => [r.field?.check_id ?? r.id, r]));
    const added = [];
    const replaced = [];
    const keptOwner = [];
    for (const row of newRows) {
        const key = row.field.check_id;
        const old = byCheck.get(key);
        if (!old) {
            byCheck.set(key, row);
            added.push(key);
        } else if (!retriage) {
            // Not re-triaged: selection should have skipped it already.
        } else if (isOwnerDecided(old)) {
            keptOwner.push(key);
        } else {
            byCheck.set(key, row);
            replaced.push(key);
        }
    }
    // Oldest feedback first, so a nightly run appends at the end and the
    // diff a reviewer reads is mostly additions.
    const rows = [...byCheck.values()].sort((a, b) =>
        String(a.field?.feedback?.feedback_at ?? '').localeCompare(String(b.field?.feedback?.feedback_at ?? ''))
        || String(a.id).localeCompare(String(b.id)));
    return { rows, added, replaced, keptOwner };
}

export function summarizeFieldRows(rows) {
    const count = pred => rows.filter(pred).length;
    return {
        rows: rows.length,
        scoreable: count(r => r.extraction_status === 'complete' && !r.needs_manual_review && !r.excluded_reason),
        agreed: count(r => r.field?.label?.status === LABEL_STATUSES.AGREED && !r.needs_manual_review),
        owner_decided: count(r => isOwnerDecided(r)),
        needs_owner: count(r => r.needs_manual_review),
        excluded: count(r => r.excluded_reason),
    };
}

export function loadFieldSet(filePath) {
    if (!fs.existsSync(filePath)) return { rows: [], metadata: {} };
    return { rows: loadRows(filePath), metadata: loadMetadata(filePath) };
}

export function writeFieldSet(filePath, rows, metadata = {}) {
    writeWithMetadata(filePath, {
        name: 'Field regression set',
        description: 'Checks editors rated in the userscript, re-fetched and independently re-read. Selected by disagreement, so not representative: never pool with dataset.json. See feedback-loop/README.md.',
        ...metadata,
        updated_at: new Date().toISOString(),
        counts: summarizeFieldRows(rows),
    }, rows);
}
