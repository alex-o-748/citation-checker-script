// The knowledge check: flagged cited claims against the model's own knowledge.
//
// Every other check on a cited claim asks whether its source supports it. This
// one asks a second question: does the model, from what it knows, have a
// specific reason to believe the claim is wrong? A claim can fail its source
// and still be true (the source just doesn't say it), and for an editor that
// is a different job: find a better source, not fix the text.
//
// It is the uncited-text check (core/uncited-check.js), applied to flagged
// cited claims: the same prompt (UNCITED_PROMPT_VERSION u2 is worded to be
// true of cited and uncited statements alike), the same parser, chunking and
// excerpt location, run through runUncitedCheck(). Not a second prompt.
//
// Three rules, from docs/design-plans/2026-11-27-knowledge-check-for-flagged-claims.md:
//
// - It reports doubts, not truths. The outcome is DOUBTED or NOT_DOUBTED, and
//   NOT_DOUBTED covers "probably true" and "no idea" together. A doubted
//   claim is promoted; a not-doubted one is left as it is, never labelled
//   "probably true".
// - It is independent. The model sees the claim, the article's title and
//   opening, and the paragraph text before the claim. Never the source, the
//   first verdict or its rationale.
// - The model's knowledge only routes a finding. Its idea of the right value
//   stays in its comment and is never offered as an edit.
//
// Flagged claims go in calls of their own, not mixed with an article's
// uncited sentences: the prompt's limit of UNCITED_PER_CALL_MAX reports per
// call would otherwise be shared between the two, and an uncited sentence
// could crowd out a flagged claim.
//
// Inlined into main.js (scripts/sync-main.js), so top-level names carry a
// KNOWLEDGE_ / knowledge prefix.

import { runUncitedCheck, UNCITED_PROMPT_VERSION } from './uncited-check.js';

export const KNOWLEDGE_OUTCOMES = Object.freeze({
    DOUBTED: 'doubted',
    NOT_DOUBTED: 'not_doubted',
    ERROR: 'error',
});
export const KNOWLEDGE_OUTCOME_LIST = Object.freeze(Object.values(KNOWLEDGE_OUTCOMES));

// The prompt version a knowledge-check result was made under: the uncited
// check's, since it is the same prompt.
export const KNOWLEDGE_PROMPT_VERSION = UNCITED_PROMPT_VERSION;

// Where a claim starts in its paragraph text, so the text before it can go
// with the claim as context. -1 when it can't be found (the paragraph text was
// cut to its maximum length, or extraction differs), in which case no
// paragraph context is sent rather than the wrong one.
function knowledgeClaimStart(paragraphText, claimText) {
    if (!paragraphText || !claimText) return -1;
    return paragraphText.indexOf(claimText);
}

/**
 * Turns flagged claims into runUncitedCheck()'s input.
 *
 * @param {Array<{key, claimText, sectionTitle?, paragraphText?}>} claims - In
 *   article order. `key` is the caller's handle for a claim; two claims with
 *   the same text (a group's members share one claim) become one statement,
 *   and the result is reported under every key.
 * @param {object} [opts]
 * @param {string} [opts.opening] - The article's opening paragraph.
 * @returns {{ uncited: {sentences, paragraphs, opening}, keysByIndex: Array<Array> }}
 */
export function knowledgeStatements(claims, { opening = '' } = {}) {
    const sentences = [];
    const paragraphs = [];
    const keysByIndex = [];
    const byText = new Map();
    const paragraphIndexOf = new Map();
    for (const claim of claims || []) {
        const text = String(claim?.claimText ?? '').trim();
        if (!text) continue;
        if (byText.has(text)) {
            keysByIndex[byText.get(text)].push(claim.key);
            continue;
        }
        const sectionTitle = claim.sectionTitle ?? null;
        const paragraphText = claim.paragraphText || '';
        const start = knowledgeClaimStart(paragraphText, text);
        // A claim whose paragraph can't be placed gets a paragraph of its
        // own, holding just the claim: no context, and no context borrowed
        // from a neighbour.
        const paragraphKey = start >= 0 ? `${sectionTitle}\u0000${paragraphText}` : `\u0001${sentences.length}`;
        if (!paragraphIndexOf.has(paragraphKey)) {
            paragraphIndexOf.set(paragraphKey, paragraphs.length);
            paragraphs.push({ index: paragraphs.length, sectionTitle, text: start >= 0 ? paragraphText : text });
        }
        const index = sentences.length;
        byText.set(text, index);
        keysByIndex.push([claim.key]);
        sentences.push({
            index,
            paragraphIndex: paragraphIndexOf.get(paragraphKey),
            sectionTitle,
            text,
            start: start >= 0 ? start : 0,
        });
    }
    return { uncited: { sentences, paragraphs, opening: opening || '' }, keysByIndex };
}

/**
 * Runs the knowledge check on an article's flagged claims.
 *
 * @param {object} input
 * @param {Array} input.claims - See knowledgeStatements().
 * @param {string} [input.articleTitle]
 * @param {string} [input.opening]
 * @param {object} deps - runUncitedCheck()'s deps (callModel, systemPrompt,
 *   chunkSize, retry, pause, shouldAbort, onChunk, onChunkError). maxFindings
 *   is not taken: every doubted claim is kept, since each one is a finding
 *   promoted, not an extra row.
 *
 * Returns `{ results, calls, usage, promptVersion }`. `results` is a Map from
 * each claim's key to
 * `{ outcome, confidence, comment, excerpt, excerptStatus, error }`:
 * DOUBTED with the model's confidence, comment and excerpt; NOT_DOUBTED; or
 * ERROR with the error code of the call that left it unchecked. A claim the
 * run never reached (stopped early) has no entry.
 */
export async function runKnowledgeCheck({ claims, articleTitle, opening } = {}, deps = {}) {
    const { uncited, keysByIndex } = knowledgeStatements(claims, { opening });
    const run = await runUncitedCheck({ uncited, articleTitle }, { ...deps, maxFindings: Infinity });

    const byIndex = new Map();
    for (const s of uncited.sentences) byIndex.set(s.index, null);
    const answered = new Set();
    for (const f of run.findings) {
        answered.add(f.index);
        byIndex.set(f.index, {
            outcome: KNOWLEDGE_OUTCOMES.DOUBTED,
            confidence: f.confidence,
            comment: f.comments || null,
            excerpt: f.excerpt || null,
            excerptStatus: f.excerptStatus ?? null,
            error: null,
        });
    }
    const failed = new Map(run.unchecked.map(u => [u.index, u.error]));
    for (const [index, error] of failed) {
        byIndex.set(index, {
            outcome: KNOWLEDGE_OUTCOMES.ERROR, confidence: null, comment: null, excerpt: null, excerptStatus: null, error,
        });
    }
    // Every sentence of a call that answered and didn't report it. A run cut
    // short leaves the rest unreached: neither answered nor failed. runUncitedCheck()
    // checks in order, so the first `checked + unchecked` sentences were reached.
    const reached = run.checked + run.unchecked.length;
    uncited.sentences.slice(0, reached).forEach(s => {
        if (!byIndex.get(s.index)) {
            byIndex.set(s.index, {
                outcome: KNOWLEDGE_OUTCOMES.NOT_DOUBTED, confidence: null, comment: null, excerpt: null, excerptStatus: null, error: null,
            });
        }
    });

    const results = new Map();
    for (const [index, result] of byIndex) {
        if (!result) continue;
        for (const key of keysByIndex[index]) results.set(key, result);
    }
    return { results, calls: run.calls, usage: run.usage, promptVersion: run.promptVersion };
}

// Whether a knowledge-check result promotes its finding.
export function isKnowledgeDoubted(result) {
    return result?.outcome === KNOWLEDGE_OUTCOMES.DOUBTED;
}
