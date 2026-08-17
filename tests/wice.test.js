import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    mapWiceLabel,
    extractSourceMeta,
    buildSourceText,
    flattenSupportingSentences,
    indexSubclaims,
    projectionFor,
    convertWiceRow,
    convertWiceSplit,
    summarizeConverted,
    WICE_LABELS,
    DEFAULT_MAX_SOURCE_CHARS,
} from '../benchmark/wice.js';

// A WiCE claim-level row, trimmed to the fields the converter reads. Shape
// mirrors data/entailment_retrieval/claim/dev.jsonl.
const WICE_ROW = {
    label: 'partially_supported',
    supporting_sentences: [[1, 3], [3, 4]],
    claim: 'The bridge opened in 2002 and cost $40 million.',
    evidence: [
        '(meta data) TITLE: Morrison Bridge - City Tribune',
        '(meta data) PUBLISHER: City Tribune',
        'Skip to content',
        'The bridge was finally opened to traffic in August 2002.',
        'Funding shortages delayed the project repeatedly.',
    ],
    meta: {
        id: 'dev01234',
        claim_title: 'Morrison Bridge',
        claim_section: 'History.',
        claim_context: 'Planning began in 1988. Ground was broken in 1994.',
    },
};

const SUBCLAIM_ROWS = [
    { label: 'supported', claim: 'The bridge opened in 2002.', meta: { id: 'dev01234-0' } },
    { label: 'not_supported', claim: 'The bridge cost $40 million.', meta: { id: 'dev01234-1' } },
    { label: 'supported', claim: 'Something else.', meta: { id: 'dev09999-0' } },
];

// --- mapWiceLabel ---

test('mapWiceLabel maps every WiCE label to our ground-truth vocabulary', () => {
    assert.equal(mapWiceLabel('supported'), 'Supported');
    assert.equal(mapWiceLabel('partially_supported'), 'Partially supported');
    assert.equal(mapWiceLabel('not_supported'), 'Not supported');
});

test('mapWiceLabel covers the full declared WiCE label list', () => {
    // Guards against WICE_LABELS growing without the mapping following.
    for (const label of WICE_LABELS) {
        assert.doesNotThrow(() => mapWiceLabel(label), `no mapping for ${label}`);
    }
});

test('mapWiceLabel throws on an unrecognized label rather than guessing', () => {
    assert.throws(() => mapWiceLabel('neutral'), /Unrecognized WiCE label/);
    assert.throws(() => mapWiceLabel(undefined), /Unrecognized WiCE label/);
});

// --- source text assembly ---

test('buildSourceText strips the (meta data) marker but keeps the content', () => {
    const { text } = buildSourceText(WICE_ROW.evidence);
    assert.ok(!text.includes('(meta data)'), 'marker should be gone');
    assert.ok(text.startsWith('TITLE: Morrison Bridge - City Tribune'));
    assert.ok(text.includes('PUBLISHER: City Tribune'));
});

test('buildSourceText joins sentences with single spaces, like the CORS proxy', () => {
    const { text } = buildSourceText(['One sentence.', 'Two sentence.']);
    assert.equal(text, 'One sentence. Two sentence.');
});

test('buildSourceText truncates on whole sentences and reports what it kept', () => {
    const evidence = ['aaaa', 'bbbb', 'cccc'];
    const { text, keptCount, truncated } = buildSourceText(evidence, { maxChars: 9 });
    // 'aaaa' (4) + ' bbbb' (5) = 9; adding 'cccc' would exceed the cap.
    assert.equal(text, 'aaaa bbbb');
    assert.equal(keptCount, 2);
    assert.equal(truncated, true);
});

test('buildSourceText reports no truncation when everything fits', () => {
    const { keptCount, truncated } = buildSourceText(['a', 'b'], { maxChars: 1000 });
    assert.equal(keptCount, 2);
    assert.equal(truncated, false);
});

test('extractSourceMeta pulls title and publisher, ignoring other meta fields', () => {
    assert.deepEqual(extractSourceMeta(WICE_ROW.evidence), {
        title: 'Morrison Bridge - City Tribune',
        publisher: 'City Tribune',
    });
    assert.deepEqual(extractSourceMeta(['no metadata here']), { title: null, publisher: null });
});

// --- supporting sentences ---

test('flattenSupportingSentences unions the per-annotator index sets', () => {
    assert.deepEqual(flattenSupportingSentences([[1, 3], [3, 4]]), [1, 3, 4]);
    assert.deepEqual(flattenSupportingSentences([]), []);
    assert.deepEqual(flattenSupportingSentences(undefined), []);
});

// --- subclaim join and label projection ---

test('indexSubclaims groups subclaims under their parent claim id', () => {
    const index = indexSubclaims(SUBCLAIM_ROWS);
    assert.deepEqual([...index.keys()].sort(), ['dev01234', 'dev09999']);
    assert.equal(index.get('dev01234').length, 2);
});

test('projectionFor distinguishes a real label from a projection artifact', () => {
    assert.equal(projectionFor(['supported', 'supported']), 'unanimous');
    assert.equal(projectionFor(['not_supported', 'not_supported']), 'unanimous');
    assert.equal(projectionFor(['supported', 'not_supported']), 'mixed');
    assert.equal(projectionFor([]), 'unknown');
    assert.equal(projectionFor(undefined), 'unknown');
});

// --- full row conversion ---

test('convertWiceRow produces a row the benchmark runner can consume', () => {
    const row = convertWiceRow(WICE_ROW, {
        split: 'dev',
        subclaimIndex: indexSubclaims(SUBCLAIM_ROWS),
    });

    // The fields run_benchmark.js actually reads.
    assert.equal(row.id, 'wice_dev01234');
    assert.equal(row.claim_text, WICE_ROW.claim);
    assert.equal(row.ground_truth, 'Partially supported');
    assert.equal(row.extraction_status, 'complete');
    assert.equal(row.needs_manual_review, false);
    assert.equal(row.dataset_version, 'wice');
    assert.ok(row.source_text.length > 0);
});

test('convertWiceRow reconstructs the claim container by appending the claim to its context', () => {
    // WiCE's claim_context is the text preceding the claim and never contains
    // it, so the container has to be rebuilt rather than used as-is.
    const row = convertWiceRow(WICE_ROW, { split: 'dev' });
    assert.ok(!WICE_ROW.meta.claim_context.includes(WICE_ROW.claim));
    assert.equal(row.claim_container, `${WICE_ROW.meta.claim_context} ${WICE_ROW.claim}`);
    assert.ok(row.claim_container.endsWith(WICE_ROW.claim));
});

test('convertWiceRow records the annotated subclaim labels behind a projected label', () => {
    const row = convertWiceRow(WICE_ROW, {
        split: 'dev',
        subclaimIndex: indexSubclaims(SUBCLAIM_ROWS),
    });
    assert.equal(row.wice_subclaim_count, 2);
    assert.deepEqual(row.wice_subclaim_labels, ['supported', 'not_supported']);
    // Mixed subclaims => the 'Partially supported' label is WiCE's projection
    // rule talking, not a direct human judgement.
    assert.equal(row.wice_label_projection, 'mixed');
});

test('convertWiceRow leaves fields WiCE has no equivalent for null rather than inventing them', () => {
    const row = convertWiceRow(WICE_ROW, { split: 'dev' });
    assert.equal(row.source_url, null, 'WiCE ships no source URL');
    assert.equal(row.citation_number, null);
    assert.equal(row.occurrence, null);
    assert.equal(row.total_occurrences, null);
});

test('convertWiceRow reconstructs an (unpinned) article URL from the page title', () => {
    const row = convertWiceRow(WICE_ROW, { split: 'dev' });
    assert.equal(row.article_url, 'https://en.wikipedia.org/wiki/Morrison_Bridge');
});

test('convertWiceRow flags a row only when truncation dropped a supporting sentence', () => {
    // Cap keeps 2 of 5 sentences; supporting indices 1,3,4 -> 3 and 4 are lost.
    const lossy = convertWiceRow(WICE_ROW, { split: 'dev', maxSourceChars: 60 });
    assert.equal(lossy.wice_source_truncated, true);
    assert.equal(lossy.wice_truncated_supporting, true);
    assert.equal(lossy.needs_manual_review, true, 'label is no longer checkable against the text');

    // Truncation that spares every supporting sentence is harmless.
    const safe = convertWiceRow(
        { ...WICE_ROW, supporting_sentences: [[0]] },
        { split: 'dev', maxSourceChars: 60 }
    );
    assert.equal(safe.wice_source_truncated, true);
    assert.equal(safe.wice_truncated_supporting, false);
    assert.equal(safe.needs_manual_review, false);
});

test('convertWiceRow throws when the row has no id to key on', () => {
    assert.throws(() => convertWiceRow({ ...WICE_ROW, meta: {} }, { split: 'dev' }), /missing meta\.id/);
});

test('DEFAULT_MAX_SOURCE_CHARS matches the extractor cap so sizes stay comparable', () => {
    assert.equal(DEFAULT_MAX_SOURCE_CHARS, 50000);
});

// --- split conversion and summary ---

test('convertWiceSplit and summarizeConverted report the corpus composition', () => {
    const rows = convertWiceSplit(
        [WICE_ROW, { ...WICE_ROW, label: 'supported', meta: { ...WICE_ROW.meta, id: 'dev05555' } }],
        { split: 'dev', subclaimIndex: indexSubclaims(SUBCLAIM_ROWS) }
    );
    const summary = summarizeConverted(rows);
    assert.equal(summary.total, 2);
    assert.deepEqual(summary.by_split, { dev: 2 });
    assert.deepEqual(summary.by_ground_truth, { 'Partially supported': 1, Supported: 1 });
    assert.equal(summary.flagged_for_review, 0);
});

test('converted ids are content-independent and immune to CSV reordering', () => {
    // Our own row ids are derived from a CSV line number, which makes them
    // shift under any reorder (see CLAUDE.md). WiCE ids are upstream-assigned,
    // so a re-convert is stable by construction.
    const a = convertWiceRow(WICE_ROW, { split: 'dev' });
    const b = convertWiceRow(WICE_ROW, { split: 'dev' });
    assert.equal(a.id, b.id);
    assert.equal(a.id, 'wice_dev01234');
});
