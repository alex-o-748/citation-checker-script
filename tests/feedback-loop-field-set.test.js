import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    FIELD_DATASET_VERSION,
    buildFieldRow,
    isOwnerDecided,
    mergeFieldRows,
    summarizeFieldRows,
    loadFieldSet,
    writeFieldSet,
    sha256,
} from '../feedback-loop/field-set.js';
import { normalizeCase } from '../feedback-loop/cases.js';
import { md, safeUrl, renderTriageReport } from '../feedback-loop/report.js';

function makeCase(overrides = {}) {
    return normalizeCase({
        check_id: 'aaaa0001',
        rating: -1,
        corrected_verdict: 'SUPPORTED',
        last_feedback_at: '2026-11-01T10:00:02+00:00',
        rating_gap_s: 2,
        rater_checks_on_article: 12,
        kind: 'source',
        article_url: 'https://en.wikipedia.org/wiki/Drought',
        article_title: 'Drought',
        revision_id: 1369727979,
        citation_number: '13',
        source_url: 'https://example.org/report',
        model: 'openai/gpt-oss-20b',
        verdict: 'NOT SUPPORTED',
        reason_type: 'omission',
        claim_text: 'Droughts could become more frequent.',
        llm_comments: 'The source does not mention it.',
        ...overrides,
    });
}

const ADJUDICATION = {
    version: 'adj-v1',
    blind: {
        verdict: 'SUPPORTED', reasonType: null,
        evidenceQuote: 'RAW MODEL QUOTE', quoteStatus: 'exact', verifiedQuote: 'droughts could become more frequent',
        explanation: 'Says so.',
    },
    attribution: { cause: 'missed_evidence', explanation: 'Missed it.' },
    sourceDrift: false,
    usage: { input: 10, output: 1, calls: 2 },
};
const AGREED = { groundTruth: 'Supported', suggestedBy: 'editor', labelStatus: 'agreed', reasons: [], excludedReason: null };
const NEEDS_OWNER = { groundTruth: 'Supported', suggestedBy: 'adjudicator', labelStatus: 'needs_owner', reasons: ['the editor rejected the verdict without giving one'], excludedReason: null };

function row(c, label = AGREED) {
    return buildFieldRow(c, {
        sourceText: 'Report text: droughts could become more frequent.',
        sourceTruncated: false,
        fetchedAt: '2026-11-15T02:00:00Z',
        adjudication: ADJUDICATION,
        label,
        hints: ['uncheckable_omission'],
        triagedAt: '2026-11-15T02:01:00Z',
    });
}

test('a field row has dataset.json\'s schema and the case history', () => {
    const r = row(makeCase());
    for (const key of ['id', 'article_url', 'claim_text', 'source_url', 'source_text', 'source_truncated', 'ground_truth', 'dataset_version', 'extraction_status', 'needs_manual_review', 'excluded_reason']) {
        assert.ok(Object.hasOwn(r, key), `missing ${key}`);
    }
    assert.equal(r.id, 'field_aaaa0001');
    assert.equal(r.dataset_version, FIELD_DATASET_VERSION);
    assert.equal(r.ground_truth, 'Supported');
    assert.equal(r.needs_manual_review, false);
    assert.equal(r.provenance.source_sha256, sha256('Report text: droughts could become more frequent.'));
    assert.equal(r.field.tool.verdict, 'NOT SUPPORTED');
    assert.equal(r.field.feedback.quick_rating, true);
    assert.equal(r.field.feedback.heavy_session, true);
    assert.equal(r.field.label.proposed_ground_truth, 'Supported');
});

test('only agreed rows pass the benchmark\'s own filter', () => {
    const rows = [row(makeCase({ check_id: 'agreed01' })), row(makeCase({ check_id: 'owner001' }), NEEDS_OWNER)];
    // The filter run_benchmark.js applies before scoring.
    const scored = rows.filter(e => e.extraction_status === 'complete' && !e.needs_manual_review);
    assert.deepEqual(scored.map(e => e.id), ['field_agreed01']);
});

test('isOwnerDecided recognizes each edit the review instructions describe', () => {
    const agreed = row(makeCase());
    const waiting = row(makeCase(), NEEDS_OWNER);
    assert.equal(isOwnerDecided(agreed), false);
    assert.equal(isOwnerDecided(waiting), false);
    assert.equal(isOwnerDecided({ ...waiting, needs_manual_review: false }), true, 'accepted a suggestion');
    assert.equal(isOwnerDecided({ ...agreed, ground_truth: 'Partially supported' }), true, 'relabelled');
    assert.equal(isOwnerDecided({ ...agreed, field: { ...agreed.field, label: { ...agreed.field.label, status: 'owner' } } }), true);
    assert.equal(isOwnerDecided({ id: 'row_2', ground_truth: 'Supported' }), true, 'not a triage row: hands off');
});

test('mergeFieldRows adds new rows and leaves existing ones alone without retriage', () => {
    const old = row(makeCase({ check_id: 'old00001', last_feedback_at: '2026-10-01T00:00:00Z' }));
    const changed = row(makeCase({ check_id: 'old00001', last_feedback_at: '2026-10-01T00:00:00Z' }), NEEDS_OWNER);
    const fresh = row(makeCase({ check_id: 'new00001', last_feedback_at: '2026-11-10T00:00:00Z' }));
    const { rows, added, replaced } = mergeFieldRows([old], [changed, fresh]);
    assert.deepEqual(added, ['new00001']);
    assert.deepEqual(replaced, []);
    assert.equal(rows.find(r => r.field.check_id === 'old00001').field.label.status, 'agreed');
    assert.deepEqual(rows.map(r => r.field.check_id), ['old00001', 'new00001'], 'oldest feedback first');
});

test('retriage replaces undecided rows and never an owner\'s decision', () => {
    const undecided = row(makeCase({ check_id: 'undec001' }), NEEDS_OWNER);
    const decided = { ...row(makeCase({ check_id: 'decid001' }), NEEDS_OWNER), ground_truth: 'Not supported', needs_manual_review: false };
    const newer = [row(makeCase({ check_id: 'undec001' })), row(makeCase({ check_id: 'decid001' }))];
    const { rows, replaced, keptOwner } = mergeFieldRows([undecided, decided], newer, { retriage: true });
    assert.deepEqual(replaced, ['undec001']);
    assert.deepEqual(keptOwner, ['decid001']);
    assert.equal(rows.find(r => r.field.check_id === 'decid001').ground_truth, 'Not supported');
});

test('summarizeFieldRows and a write/load round trip', () => {
    const rows = [
        row(makeCase({ check_id: 'agreed01' })),
        row(makeCase({ check_id: 'owner001' }), NEEDS_OWNER),
        row(makeCase({ check_id: 'excl0001' }), { ...NEEDS_OWNER, excludedReason: 'retrieved text is not the cited source (independent reading)' }),
    ];
    assert.deepEqual(summarizeFieldRows(rows), { rows: 3, scoreable: 1, agreed: 1, owner_decided: 0, needs_owner: 2, excluded: 1 });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'field-set-'));
    const file = path.join(dir, 'dataset_field.json');
    assert.deepEqual(loadFieldSet(file), { rows: [], metadata: {} }, 'a missing file is an empty set');
    writeFieldSet(file, rows, { adjudicator_version: 'adj-v1' });
    const loaded = loadFieldSet(file);
    assert.equal(loaded.rows.length, 3);
    assert.equal(loaded.metadata.adjudicator_version, 'adj-v1');
    assert.equal(loaded.metadata.counts.scoreable, 1);
    fs.rmSync(dir, { recursive: true });
});

test('md neutralizes mentions, issue links and Markdown structure', () => {
    assert.equal(md('ping @alex-o-748 about #398'), 'ping @​alex-o-748 about #​398');
    assert.equal(md('a | b `c` <d>\n\ne'), 'a \\| b \\`c\\` \\<d\\> e');
    assert.equal(md('x'.repeat(20), 10), `${'x'.repeat(9)}…`);
});

test('safeUrl allows only http(s) and encodes characters that end a link', () => {
    assert.equal(safeUrl('javascript:alert(1)'), null);
    assert.equal(safeUrl('https://example.org/a (b)'), 'https://example.org/a%20%28b%29');
});

test('the report shows verified evidence, never the raw model quote', () => {
    const c = makeCase();
    const results = [
        { case: c, adjudication: ADJUDICATION, label: NEEDS_OWNER, hints: ['uncheckable_omission'] },
        { case: makeCase({ check_id: 'agreed01' }), adjudication: ADJUDICATION, label: AGREED, hints: [] },
    ];
    const report = renderTriageReport({
        date: '2026-11-15', results,
        failures: [{ case: makeCase({ check_id: 'fail0001' }), stage: 'fetch', error: 'HTTP 403' }],
        skipped: [{ case: makeCase({ check_id: 'grp00001' }), reason: 'group' }],
        deferred: [],
        fieldSummary: { rows: 2, scoreable: 1, needs_owner: 1, excluded: 0 },
        model: 'claude-test', usage: { input: 20, output: 2, calls: 4 },
    });
    assert.match(report, /^# Feedback triage — 2026-11-15/);
    assert.match(report, /\*\*2\*\* cases triaged: \*\*1\*\* accepted, \*\*1\*\* waiting for a decision/);
    assert.match(report, /## Waiting for a decision \(1\)/);
    assert.match(report, /Why it needs you:\*\* the editor rejected the verdict without giving one/);
    assert.match(report, /> droughts could become more frequent/);
    assert.ok(!report.includes('RAW MODEL QUOTE'));
    assert.match(report, /## Accepted \(1\)/);
    assert.match(report, /`missed_evidence` \| The source contains the passage that decides the verdict[^|]*\| \[cause 4\]\([^)]*#4-omissions-the-editor-cant-check\) \| 2 \|/);
    assert.match(report, /`fail0001` — fetch failed: HTTP 403/);
    assert.match(report, /Skipped, `group` \(1\): `grp00001`/);
    assert.match(report, /claude-test: 4 calls/);
});

test('a dry-run report groups by pattern hints instead of causes', () => {
    const report = renderTriageReport({
        date: '2026-11-15', dryRun: true,
        results: [{ case: makeCase(), adjudication: null, label: null, hints: ['uncheckable_omission'] }],
    });
    assert.match(report, /dry run: no model calls/);
    assert.match(report, /\| `uncheckable_omission` \| Omission with nothing for the editor to check \| 1 \|/);
});

test('an agreed label held while auto-accept is paused waits like any other', () => {
    const held = { ...AGREED, held: true, reasons: ['held: auto-accept is paused (2 of the last 10 spot-checks were wrong)'] };
    const r = row(makeCase(), held);
    assert.equal(r.needs_manual_review, true);
    assert.equal(r.field.label.status, 'agreed', 'still agreed by the rule, so a decision on it is a spot-check');
    assert.equal(r.field.label.held, true);
    const report = renderTriageReport({
        date: '2026-11-15',
        results: [{ case: makeCase(), adjudication: ADJUDICATION, label: held, hints: [] }],
        autoAccept: { paused: true, wrong: 2, checked: 10 },
    });
    assert.match(report, /\*\*0\*\* accepted, \*\*1\*\* waiting/);
    assert.match(report, /Auto-accept is paused/);
});
