// WiCE -> benchmark dataset conversion (pure transform; no file IO).
//
// WiCE (Kamoi et al., "WiCE: Real-World Entailment for Claims in Wikipedia",
// EMNLP 2023 — https://github.com/ryokamoi/wice) is a human-annotated
// entailment dataset built from real Wikipedia sentences and the web pages they
// cite. Its three labels map onto three of our four verdicts, which makes it a
// ready-made *external* check on the verifier — one nobody on this project
// labeled, against claims nobody here chose.
//
// `convert_wice.js` is the file-IO layer around this module.
//
// WiCE's task is close to ours but NOT identical, and the differences are all
// concentrated in this file. Each one is called out below and recorded on the
// converted row so it can be sliced at analysis time rather than discovered as
// a mystery accuracy gap. Long form: docs/wice-benchmark.md.
//
// 1. CLAIM LEVEL, NEVER SUBCLAIM LEVEL.
//    WiCE ships two parallel corpora: `entailment_retrieval/claim/` (one row
//    per Wikipedia sentence) and `entailment_retrieval/subclaim/` (one row per
//    GPT-3.5-decomposed atomic fact). Our verifier never decomposes a claim —
//    it judges the text between adjacent citation markers as a unit — so
//    scoring it on subclaims would measure a task the tool does not perform.
//    We convert the claim-level corpus only.
//
// 2. CLAIM-LEVEL LABELS ARE DERIVED, NOT ANNOTATED.
//    This is the subtle one. WiCE's annotators only ever labeled *subclaims*.
//    Claim-level labels are projected from them by a rule (paper S2.4):
//        all subclaims SUPPORTED      -> SUPPORTED
//        all subclaims NOT_SUPPORTED  -> NOT_SUPPORTED
//        anything mixed               -> PARTIALLY_SUPPORTED
//    That rule is not our rubric. A claim whose every substantive part is
//    unsupported, but which carries one incidentally-true subclaim, lands in
//    PARTIALLY-SUPPORTED under the projection where our rubric (and a human
//    editor) would likely say Not supported. It is also why PARTIALLY-SUPPORTED
//    is ~55% of WiCE claims versus a far smaller share of our own dataset.
//    So we join the subclaim corpus back in and record, per row, the labels the
//    annotators actually assigned plus whether the projection was
//    `unanimous` (subclaims agreed; the claim label means what ours means) or
//    `mixed` (the label is an artifact of the projection rule). The unanimous
//    subset is the apples-to-apples comparison; the mixed subset is the stress
//    test where disagreement may be rubric divergence rather than model error.
//
// 3. CLAIM GRANULARITY DIFFERS AND CANNOT BE FIXED.
//    A WiCE claim is a whole Wikipedia sentence. Ours is the span between
//    adjacent citations, which equals a full sentence only when the citation is
//    sentence-final and nothing cites mid-sentence. WiCE claims therefore skew
//    longer and denser than our median row. There is no transform that undoes
//    this, so we record `wice_subclaim_count` as a claim-complexity proxy to
//    slice on instead.
//
// 4. FROZEN EVIDENCE, NOT A LIVE FETCH.
//    WiCE's `evidence` is the cited page as sentences, captured from Common
//    Crawl in 2023. We join it into one `source_text` rather than re-fetching
//    the URL live: the annotators labeled against *this* text, so re-fetching
//    would silently invalidate the ground truth (and collect years of link
//    rot). The tradeoff is that a WiCE run exercises the prompt and the model
//    but not the CORS-proxy fetch path.

import { canonicalizeVerdict, toTitleCase } from '../core/verdicts.js';

// The three label strings WiCE uses. Anything else is a corpus we don't
// recognize and would rather fail loudly on than silently mislabel.
export const WICE_LABELS = Object.freeze(['supported', 'partially_supported', 'not_supported']);

// Matches extract_dataset.js's own cap, so a WiCE row's source text sits in the
// same size regime the model sees in a production run.
export const DEFAULT_MAX_SOURCE_CHARS = 50000;

// WiCE prefixes a handful of pseudo-sentences onto each evidence list carrying
// page metadata: "(meta data) TITLE: ...", PUBLISHER, AUTHOR, PUBLISHED
// DATETIME, COPYRIGHT. They were shown to the annotators, so they stay in the
// source text — but the "(meta data) " marker itself is a WiCE artifact that no
// real page extraction contains, so it comes off. What's left ("TITLE: Foo")
// reads like the head of a scraped page, which is what our proxy produces.
const META_MARKER = /^\(meta data\)\s*/;
const META_FIELD = /^\(meta data\)\s*([A-Z][A-Z ]*):\s*(.*)$/;

/**
 * Map a WiCE label to our title-case ground-truth vocabulary.
 * Routed through core/verdicts.js so the two stay in sync by construction.
 * @param {string} label - WiCE label ('supported' | 'partially_supported' | 'not_supported')
 * @returns {string} Title-case verdict ('Supported' | 'Partially supported' | 'Not supported')
 */
export function mapWiceLabel(label) {
    const canonical = canonicalizeVerdict(label);
    if (!canonical) throw new Error(`Unrecognized WiCE label: ${JSON.stringify(label)}`);
    return toTitleCase(canonical);
}

/**
 * Pull page metadata out of the leading "(meta data) KEY: value" pseudo-sentences.
 * @param {string[]} evidence - WiCE evidence sentences
 * @returns {{title: string|null, publisher: string|null}}
 */
export function extractSourceMeta(evidence) {
    const meta = { title: null, publisher: null };
    for (const sentence of evidence) {
        const match = META_FIELD.exec(sentence);
        if (!match) continue;
        const [, key, value] = match;
        if (key === 'TITLE' && !meta.title) meta.title = value.trim() || null;
        if (key === 'PUBLISHER' && !meta.publisher) meta.publisher = value.trim() || null;
    }
    return meta;
}

/**
 * Join WiCE's sentence list into one source-text blob, capped at `maxChars`.
 *
 * Sentences are joined with single spaces because that is what our CORS proxy's
 * extractText() emits — one flowing blob of page text — and keeping the model's
 * input distributionally similar to production is the point of the exercise.
 *
 * Truncation is by whole sentence so that evidence indices stay meaningful, and
 * the set of indices that survived is returned. A caller can then check whether
 * truncation dropped a sentence the annotators relied on, which would invalidate
 * the row's label.
 *
 * @param {string[]} evidence - WiCE evidence sentences
 * @param {{maxChars?: number}} [options]
 * @returns {{text: string, keptCount: number, truncated: boolean}}
 */
export function buildSourceText(evidence, { maxChars = DEFAULT_MAX_SOURCE_CHARS } = {}) {
    const cleaned = evidence.map(s => s.replace(META_MARKER, ''));
    const kept = [];
    let length = 0;
    for (const sentence of cleaned) {
        const added = kept.length === 0 ? sentence.length : sentence.length + 1;
        if (length + added > maxChars) break;
        kept.push(sentence);
        length += added;
    }
    return {
        text: kept.join(' '),
        keptCount: kept.length,
        truncated: kept.length < cleaned.length,
    };
}

/**
 * Flatten WiCE's per-annotator supporting-sentence index sets into one set.
 * `supporting_sentences` is a list of lists: each inner list is one annotator's
 * minimal sufficient evidence set, and they legitimately differ.
 * @param {number[][]} supportingSentences
 * @returns {number[]} Sorted unique indices
 */
export function flattenSupportingSentences(supportingSentences) {
    const flat = new Set();
    for (const set of supportingSentences || []) {
        for (const index of set) flat.add(index);
    }
    return [...flat].sort((a, b) => a - b);
}

/**
 * Index the subclaim corpus by its parent claim id.
 * Subclaim ids are the claim id plus a positional suffix: `dev02986-0`.
 * @param {Array<object>} subclaimRows - Parsed rows from the subclaim JSONL
 * @returns {Map<string, Array<object>>} claim id -> subclaim rows, in file order
 */
export function indexSubclaims(subclaimRows) {
    const index = new Map();
    for (const row of subclaimRows) {
        const id = row?.meta?.id;
        if (typeof id !== 'string') continue;
        const claimId = id.replace(/-\d+$/, '');
        if (!index.has(claimId)) index.set(claimId, []);
        index.get(claimId).push(row);
    }
    return index;
}

/**
 * Classify how a claim-level label relates to the subclaim labels it was
 * projected from. See note 2 at the top of this file.
 * @param {string[]} subclaimLabels - Raw WiCE subclaim labels
 * @returns {'unanimous'|'mixed'|'unknown'}
 */
export function projectionFor(subclaimLabels) {
    if (!subclaimLabels || subclaimLabels.length === 0) return 'unknown';
    return new Set(subclaimLabels).size === 1 ? 'unanimous' : 'mixed';
}

/**
 * Convert one WiCE claim-level row into a `dataset.json`-shaped row.
 *
 * @param {object} row - Parsed WiCE claim-level JSONL row
 * @param {object} options
 * @param {string} options.split - 'dev' | 'test' | 'train', recorded for provenance
 * @param {Map<string, Array<object>>} [options.subclaimIndex] - From indexSubclaims()
 * @param {number} [options.maxSourceChars]
 * @returns {object} A row the benchmark runner can consume
 */
export function convertWiceRow(row, { split, subclaimIndex, maxSourceChars = DEFAULT_MAX_SOURCE_CHARS } = {}) {
    const wiceId = row?.meta?.id;
    if (!wiceId) throw new Error('WiCE row is missing meta.id');

    const evidence = row.evidence || [];
    const { text, keptCount, truncated } = buildSourceText(evidence, { maxChars: maxSourceChars });
    const supporting = flattenSupportingSentences(row.supporting_sentences);
    const sourceMeta = extractSourceMeta(evidence);

    const subclaims = subclaimIndex?.get(wiceId) || [];
    const subclaimLabels = subclaims.map(s => s.label);

    // Truncation is only harmful if it dropped a sentence an annotator cited as
    // evidence — that would leave the row labeled against text the model can no
    // longer see. Those rows get flagged, and the runner's
    // `!needs_manual_review` filter keeps them out of a default run.
    const lostSupporting = supporting.filter(i => i >= keptCount);

    const context = row.meta.claim_context || '';
    const title = row.meta.claim_title || '';

    return {
        id: `wice_${wiceId}`,
        // Reconstructed from the page title: WiCE records no revision id, so
        // unlike our own rows this URL is NOT pinned to the revision the claim
        // was taken from. It is a pointer for a human, not a reproduction key.
        article_url: title
            ? `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`
            : null,
        article_title: title || null,
        // WiCE keeps no citation ordinal — the claim is tied to its cited
        // article directly, not to a numbered marker in the article.
        citation_number: null,
        occurrence: null,
        total_occurrences: null,
        claim_text: row.claim,
        // WiCE's claim_context is the text *preceding* the claim (verified: the
        // claim sentence never appears inside it), so the container is the
        // context with the claim appended back on.
        claim_container: context ? `${context} ${row.claim}` : row.claim,
        // No URL survives in the WiCE release; only the page's own metadata does.
        source_url: null,
        source_text: text,
        ground_truth: mapWiceLabel(row.label),
        dataset_version: 'wice',
        extraction_status: 'complete',
        needs_manual_review: lostSupporting.length > 0,

        // --- WiCE provenance, for slicing at analysis time ---
        wice_id: wiceId,
        wice_split: split,
        wice_section: row.meta.claim_section || null,
        wice_label: row.label,
        wice_subclaim_count: subclaims.length,
        wice_subclaim_labels: subclaimLabels,
        wice_label_projection: projectionFor(subclaimLabels),
        wice_supporting_sentences: supporting,
        wice_evidence_sentence_count: evidence.length,
        wice_source_truncated: truncated,
        wice_truncated_supporting: lostSupporting.length > 0,
        source_title: sourceMeta.title,
        source_publisher: sourceMeta.publisher,
    };
}

/**
 * Convert a whole split.
 * @param {Array<object>} claimRows - Parsed claim-level JSONL rows
 * @param {object} options - As convertWiceRow, minus the per-row fields
 * @returns {Array<object>}
 */
export function convertWiceSplit(claimRows, options) {
    return claimRows.map(row => convertWiceRow(row, options));
}

/**
 * Summarize a converted set — label mix, projection mix, flagged rows.
 * Used by the CLI to print a conversion report.
 * @param {Array<object>} rows - Converted rows
 * @returns {object}
 */
export function summarizeConverted(rows) {
    const tally = (key) => rows.reduce((acc, r) => {
        const k = r[key];
        acc[k] = (acc[k] || 0) + 1;
        return acc;
    }, {});
    return {
        total: rows.length,
        by_split: tally('wice_split'),
        by_ground_truth: tally('ground_truth'),
        by_projection: tally('wice_label_projection'),
        truncated: rows.filter(r => r.wice_source_truncated).length,
        flagged_for_review: rows.filter(r => r.needs_manual_review).length,
    };
}
