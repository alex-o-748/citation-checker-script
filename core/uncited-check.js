// The uncited-text check: uncited body sentences against the model's own
// knowledge.
//
// The other two checks are grounded: a citation is read against its source,
// a lead sentence against the body. An uncited sentence has nothing to be
// read against, so this one asks the model what it knows. That is the weaker
// kind of evidence, and the check is shaped around it:
//
// - It reports exceptions, not verdicts. The model is asked which statements
//   it has a specific reason to think are wrong, and "none" is the expected
//   answer. A statement it doesn't report has no verdict at all: "not
//   reported" is not "checked and fine".
// - It reports few. At most UNCITED_PER_CALL_MAX per call and
//   UNCITED_MAX_FINDINGS per article, ranked by the model's confidence.
// - The action is always the same, and cheap when the model is wrong: find a
//   source for the sentence. Per WP:V that is a fair request for any uncited
//   statement, true or not, so a false alarm costs a citation search, not a
//   correct sentence. The model's idea of the right value is in its comment,
//   never offered as an edit.
//
// Its own prompt with its own hash-pinned version, like the lead and severity
// passes. Shared by the batch (service/verifier.js's verifyUncited()) and
// the userscript (inlined into main.js, so top-level names carry an UNCITED_
// / uncited prefix); runUncitedCheck() is the one sequence.
// Design: docs/design-plans/2026-10-23-uncited-text-check.md.

import { withRetry, isSourceTooLargeError, isOutputBudgetError } from './retry.js';
import { normalizeForMatch, QUOTE_STATUSES } from './quote.js';
import { COMMENT_LANGUAGE_NAMES } from './prompts.js';

// Bump whenever the prompt text changes, same contract as PROMPT_VERSION:
// tests/uncited-check.test.js pins a hash of the prompt against it.
export const UNCITED_PROMPT_VERSION = 'u1';

export const UNCITED_CONFIDENCE = Object.freeze({ HIGH: 'high', MEDIUM: 'medium' });
const UNCITED_CONFIDENCE_ORDER = [UNCITED_CONFIDENCE.HIGH, UNCITED_CONFIDENCE.MEDIUM];

// What a finding is recorded as. Same verdict vocabulary as every other
// check, so a consumer reads it the way it reads a citation verdict: no
// citation supports the sentence, and the model doubts it.
export const UNCITED_VERDICT = 'NOT SUPPORTED';
export const UNCITED_REASON_TYPE = 'doubtful';

// Statements the model may report per call. Said in the prompt, and enforced
// on the answer: a model that reports everything is not ranking.
export const UNCITED_PER_CALL_MAX = 3;
// Findings kept per article, best first. "Top one or top three things": the
// check is a short list for an editor, not an audit.
export const UNCITED_MAX_FINDINGS = 3;

// Statements per call. The answer is short (a few issues at most), but a
// model that reasons first thinks about each statement before answering, and
// Lift Wing's router clamps output to 4,096 tokens. First guesses, per
// provider; an answer that runs out of budget is retried in halves anyway.
export const UNCITED_CHUNK_SIZES = Object.freeze({
    liftwing: 8,
    'liftwing-safeguard': 8,
    huggingface: 15,
    publicai: 12,
    claude: 30,
    gemini: 25,
    openai: 30,
});
export const UNCITED_CHUNK_SIZE_DEFAULT = 12;

export function uncitedChunkSize(provider) {
    return UNCITED_CHUNK_SIZES[provider] ?? UNCITED_CHUNK_SIZE_DEFAULT;
}

// The provider a front end runs this check on unless the editor picks the
// one their citation checks use. Not the keyless default provider
// (core/models.js's DEFAULT_PROVIDER, gpt-oss-20b): on the 2026-10-23 smoke
// test it flagged 14 of 98 correct sentences against Lift Wing Qwen's 5, and
// confidently denied true facts. Keyless too, so nothing is lost by it.
// docs/design-plans/2026-10-23-uncited-text-check.md.
export const UNCITED_DEFAULT_PROVIDER = 'liftwing';

// The paragraph text shown before a chunk's first statement, at most.
export const UNCITED_CONTEXT_MAX_CHARS = 1500;

export function generateUncitedSystemPrompt() {
    return `You help Wikipedia volunteers find statements that may be factually wrong. You are given numbered STATEMENTS from a Wikipedia article. None of them has a citation, so nothing in the article backs them up. Judge them using your own knowledge.

Report a statement only when you have a specific reason to believe it is wrong:
- a wrong date, number, name, place, title or ranking;
- events in the wrong order, or attributed to the wrong person, group or work;
- something impossible or implausible on its face, such as an age that does not add up.

Only judge well-established facts: the kind any good reference work on the subject states. Leave obscure details alone (a minor date, a small number, a fact about one building, event or episode that few sources cover). Your memory of those is not reliable enough to correct an encyclopedia.

Rules:
- Report at most ${UNCITED_PER_CALL_MAX} statements. Reporting none is a normal answer: most statements in most articles are correct.
- Never report a statement only because you do not know about it, cannot confirm it, or it may describe events after your knowledge ends. Not knowing something is not a reason to doubt it.
- Never report a statement because it has no citation. None of them has one.
- Do not report opinions, wording, tone, neutrality, or missing detail.
- The article context and the earlier text of each paragraph are there so you know what a statement refers to ("She later moved to Paris"). Report only the numbered statements.
- Names from languages using non-Latin scripts may have several valid romanizations. Do not treat transliteration differences as errors.

For each statement you report:
- "id": its number.
- "excerpt": the words in the statement that are wrong, copied exactly from it. Keep it short.
- "comments": what is wrong and what you believe is correct, in one or two sentences. Decide before you write: never report a statement and then conclude in "comments" that it is correct.
- "confidence": "high" if you are sure it is wrong, "medium" if it is probably wrong. Do not report a statement you are less sure about than that.

Respond with JSON only:
{"issues": [{"id": <statement number>, "excerpt": "<words from the statement>", "comments": "<explanation>", "confidence": "high|medium"}]}
When nothing is wrong, respond with {"issues": []}.

<example>
Article: Eiffel Tower

Opening paragraph, for context:
The Eiffel Tower is a wrought-iron lattice tower on the Champ de Mars in Paris, France.

Section: History
Statements to check:
1. "The tower was completed in 1899 as the entrance arch to the World's Fair."
2. "Its design is credited to Maurice Koechlin and Émile Nouguier, two engineers working for Gustave Eiffel's company."
3. "A small plaque near the north pillar lists the workers who maintained the elevators in the 1950s."

{"issues": [{"id": 1, "excerpt": "completed in 1899", "comments": "The tower was completed in 1889, as the entrance arch to the 1889 Exposition Universelle, not in 1899.", "confidence": "high"}]}
</example>`;
}

/**
 * The comment-language directive, for a non-English wiki. Not
 * core/prompts.js's withCommentLanguage(): that one names the verdict
 * prompt's fields (source_quote, verdict, reason_type), which this prompt
 * doesn't have. Same rule otherwise: the explanation in the article's
 * language, the copied text never translated.
 */
export function withUncitedCommentLanguage(prompt, { lang, articleLangCode } = {}) {
    const language = COMMENT_LANGUAGE_NAMES[lang];
    if (!language && (!articleLangCode || articleLangCode === 'en')) return prompt;
    const instruction = language
        ? `Write the "comments" field in ${language}.`
        : 'Write the "comments" field in the same language as the statements, not in English.';
    return `${prompt}\n\nLANGUAGE: ${instruction} The "excerpt" field is an exception: copy it from the statement exactly, never translated. Keep the "confidence" values in English (high, medium).`;
}

function uncitedContextBefore(paragraph, start) {
    const text = paragraph.text.slice(0, start).trim();
    if (text.length <= UNCITED_CONTEXT_MAX_CHARS) return text;
    return `…${text.slice(text.length - UNCITED_CONTEXT_MAX_CHARS).trimStart()}`;
}

/**
 * @param {object} args
 * @param {string} [args.articleTitle]
 * @param {string} [args.opening] - core/uncited.js's `opening`.
 * @param {Array} args.paragraphs - core/uncited.js's `paragraphs` (text, sectionTitle).
 * @param {Array<{index, paragraphIndex, text, start}>} args.statements - Numbered index + 1.
 */
export function generateUncitedUserPrompt({ articleTitle, opening, paragraphs, statements }) {
    const lines = [];
    if (articleTitle) lines.push(`Article: ${articleTitle}`, '');
    if (opening) lines.push('Opening paragraph, for context:', opening, '');
    let section;
    let paragraphIndex = null;
    for (const s of statements) {
        if (s.paragraphIndex !== paragraphIndex) {
            if (paragraphIndex !== null) lines.push('');
            paragraphIndex = s.paragraphIndex;
            const paragraph = paragraphs[paragraphIndex];
            const title = paragraph?.sectionTitle || null;
            if (title !== section) {
                section = title;
                if (title) lines.push(`Section: ${title}`);
            }
            const context = paragraph ? uncitedContextBefore(paragraph, s.start ?? 0) : '';
            if (context) lines.push('Earlier in the paragraph, for context:', context);
            lines.push('Statements to check:');
        }
        lines.push(`${s.index + 1}. "${s.text}"`);
    }
    return lines.join('\n');
}

function uncitedExtractJson(text) {
    const trimmed = (text || '').trim();
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    const body = fenced ? fenced[1].trim() : trimmed;
    const object = body.indexOf('{');
    const array = body.indexOf('[');
    // A bare array is accepted too: some models drop the wrapper.
    if (array !== -1 && (object === -1 || array < object)) {
        const end = body.lastIndexOf(']');
        if (end > array) return body.slice(array, end + 1);
    }
    const end = body.lastIndexOf('}');
    if (object !== -1 && end > object) return body.slice(object, end + 1);
    return body;
}

/**
 * Parses an uncited-check answer: `{ ok: true, issues }` or
 * `{ ok: false, error: 'parse_error' }`. Each issue is
 * `{ id, excerpt, comments, confidence }`. An empty list is a valid answer.
 *
 * Lenient about shape (`{"issues": [...]}`, a bare array, string ids) and
 * strict about content: an issue without a usable id, or with a confidence
 * other than high or medium, is left out. A model that reports a statement
 * as "low" confidence was told not to report it at all.
 */
export function parseUncitedCheckResult(text) {
    let parsed;
    try {
        parsed = JSON.parse(uncitedExtractJson(text));
    } catch {
        return { ok: false, error: 'parse_error' };
    }
    const raw = Array.isArray(parsed)
        ? parsed
        : (parsed && typeof parsed === 'object'
            ? (Array.isArray(parsed.issues) ? parsed.issues : Object.values(parsed).find(Array.isArray))
            : null);
    if (!Array.isArray(raw)) return { ok: false, error: 'parse_error' };

    const issues = [];
    for (const item of raw) {
        const id = Number(item?.id);
        const confidence = String(item?.confidence ?? '').trim().toLowerCase();
        if (!Number.isInteger(id) || !UNCITED_CONFIDENCE_ORDER.includes(confidence)) continue;
        const excerpt = item.excerpt ?? item.quote;
        const comments = item.comments ?? item.problem ?? item.reason;
        issues.push({
            id,
            excerpt: typeof excerpt === 'string' ? excerpt.trim() : '',
            comments: typeof comments === 'string' ? comments.trim() : '',
            confidence,
        });
    }
    return { ok: true, issues };
}

/**
 * Where the model's excerpt is in a statement, as a core/quote.js status:
 * `exact`, `normalized` (after folding case, quote style, dashes and
 * whitespace), `not-found`, or `empty`. No minimum length, unlike a source
 * quote: an excerpt is matched inside one sentence, not a whole source, so
 * "1899" found there means something.
 */
export function locateExcerpt(sentence, excerpt) {
    const raw = String(excerpt ?? '').trim();
    if (!raw) return QUOTE_STATUSES.EMPTY;
    const text = String(sentence ?? '');
    if (text.includes(raw)) return QUOTE_STATUSES.EXACT;
    const needle = normalizeForMatch(raw);
    if (needle && normalizeForMatch(text).includes(needle)) return QUOTE_STATUSES.NORMALIZED;
    return QUOTE_STATUSES.NOT_FOUND;
}

function uncitedExcerptFound(status) {
    return status === QUOTE_STATUSES.EXACT || status === QUOTE_STATUSES.NORMALIZED;
}

// The statement an issue is about. Its id, unless the excerpt is not in that
// statement and is in exactly one other statement of the call: a model that
// numbered off by one still names the words. An issue whose id is not in the
// call at all, and whose excerpt doesn't settle it, is dropped (null).
function uncitedResolveIssue(issue, statements) {
    const byId = statements.find(s => s.index + 1 === issue.id) ?? null;
    const status = byId ? locateExcerpt(byId.text, issue.excerpt) : QUOTE_STATUSES.NOT_FOUND;
    if (byId && (uncitedExcerptFound(status) || status === QUOTE_STATUSES.EMPTY)) {
        return { statement: byId, excerptStatus: status };
    }
    if (issue.excerpt) {
        const matches = statements
            .map(s => ({ s, status: locateExcerpt(s.text, issue.excerpt) }))
            .filter(m => uncitedExcerptFound(m.status));
        if (matches.length === 1) return { statement: matches[0].s, excerptStatus: matches[0].status };
    }
    return byId ? { statement: byId, excerptStatus: status } : null;
}

/**
 * Orders findings best first: high confidence before medium, then article
 * order. Stable, pure; exported for the tests and for any front end that
 * merges findings itself.
 */
export function rankUncitedFindings(findings) {
    return [...findings].sort((a, b) =>
        (UNCITED_CONFIDENCE_ORDER.indexOf(a.confidence) - UNCITED_CONFIDENCE_ORDER.indexOf(b.confidence))
        || (a.index - b.index));
}

/**
 * Checks uncited sentences against the model's knowledge.
 *
 * @param {object} input
 * @param {object} input.uncited - core/uncited.js's uncitedSentences() (or
 *   its plain-data copy): `{ sentences, paragraphs, opening }`.
 * @param {string} [input.articleTitle]
 * @param {object} deps
 * @param {Function} deps.callModel - (systemPrompt, userContent, { kind: 'uncited' }) => { text, usage }.
 * @param {string} [deps.systemPrompt] - A localized generateUncitedSystemPrompt().
 * @param {number} [deps.chunkSize]
 * @param {number} [deps.maxFindings] - Findings kept, best first.
 * @param {object} [deps.retry] - core/retry.js options.
 * @param {Function} [deps.onChunk] - (sentences done so far, answered or not;
 *   sentences total), after each call.
 * @param {Function} [deps.pause] - Awaited between two calls (a rate-limit delay).
 * @param {Function} [deps.shouldAbort] - Checked before each call; true stops
 *   the check, returning what was found so far.
 * @param {Function} [deps.onChunkError] - (error) => an error code to record
 *   that call's sentences under, then carry on; or nothing, to throw. It may
 *   throw itself (an auth error that must halt a run).
 *
 * Returns `{ findings, dropped, unchecked, checked, usage, calls, promptVersion }`:
 * - `findings`: at most `maxFindings`, best first —
 *   `{ index, text, sectionTitle, excerpt, excerptStatus, comments, confidence, usage }`,
 *   `usage` being the finding's share of its call's tokens;
 * - `dropped`: findings past `maxFindings`;
 * - `unchecked`: `{ index, text, sectionTitle, error }` for each sentence of
 *   a call that failed or answered unreadably;
 * - `checked`: sentences whose call answered.
 *
 * As in the lead check, two failures depend on how much is asked at once and
 * are handled here: an answer that ran out of output budget, or a prompt too
 * long for the model, is retried as two calls of half the sentences each,
 * down to one. Every other failure goes to onChunkError.
 */
export async function runUncitedCheck({ uncited, articleTitle } = {}, {
    callModel, systemPrompt = generateUncitedSystemPrompt(), chunkSize = UNCITED_CHUNK_SIZE_DEFAULT,
    maxFindings = UNCITED_MAX_FINDINGS, retry = {}, onChunk, onChunkError, pause, shouldAbort,
} = {}) {
    if (typeof callModel !== 'function') {
        throw new TypeError('runUncitedCheck requires a callModel(systemPrompt, userContent) function');
    }
    const usage = { input: 0, output: 0 };
    const sentences = Array.isArray(uncited?.sentences) ? uncited.sentences : [];
    const paragraphs = uncited?.paragraphs ?? [];
    const result = { findings: [], dropped: 0, unchecked: [], checked: 0, usage, calls: 0, promptVersion: UNCITED_PROMPT_VERSION };
    if (sentences.length === 0) return result;

    const size = Math.max(1, chunkSize);
    const queue = [];
    for (let i = 0; i < sentences.length; i += size) queue.push(sentences.slice(i, i + size));
    const found = [];

    while (queue.length) {
        if (typeof shouldAbort === 'function' && shouldAbort()) break;
        if (result.calls > 0 && typeof pause === 'function') await pause();
        const chunk = queue.shift();
        const userContent = generateUncitedUserPrompt({ articleTitle, opening: uncited.opening, paragraphs, statements: chunk });
        let response = null;
        let failure = null;
        try {
            result.calls++;
            response = await withRetry(() => callModel(systemPrompt, userContent, { kind: 'uncited' }), retry);
        } catch (error) {
            if ((isOutputBudgetError(error) || isSourceTooLargeError(error)) && chunk.length > 1) {
                const half = Math.ceil(chunk.length / 2);
                queue.unshift(chunk.slice(0, half), chunk.slice(half));
                continue;
            }
            if (isSourceTooLargeError(error)) {
                failure = 'source_too_large';
            } else {
                failure = typeof onChunkError === 'function' ? onChunkError(error) : null;
                if (!failure) throw error;
            }
        }

        if (response) {
            usage.input += response.usage?.input || 0;
            usage.output += response.usage?.output || 0;
        }
        const parsed = response ? parseUncitedCheckResult(response.text) : null;
        const error = failure || (parsed.ok ? null : parsed.error);
        if (error) {
            for (const s of chunk) {
                result.unchecked.push({ index: s.index, text: s.text, sectionTitle: s.sectionTitle ?? null, error });
            }
        } else {
            result.checked += chunk.length;
            const seen = new Set();
            const issues = [];
            for (const issue of parsed.issues) {
                const resolved = uncitedResolveIssue(issue, chunk);
                if (!resolved || seen.has(resolved.statement.index)) continue;
                seen.add(resolved.statement.index);
                issues.push({ issue, ...resolved });
                if (issues.length === UNCITED_PER_CALL_MAX) break;
            }
            // Each finding carries its share of the call's tokens, the
            // remainder on the first, so per-row token columns still sum to
            // what the calls that found something cost.
            const shareOf = (total, i) => Math.floor(total / issues.length) + (i === 0 ? total % issues.length : 0);
            issues.forEach(({ issue, statement, excerptStatus }, i) => {
                found.push({
                    index: statement.index,
                    text: statement.text,
                    sectionTitle: statement.sectionTitle ?? null,
                    excerpt: issue.excerpt,
                    excerptStatus,
                    comments: issue.comments,
                    confidence: issue.confidence,
                    usage: {
                        input: shareOf(response.usage?.input || 0, i),
                        output: shareOf(response.usage?.output || 0, i),
                    },
                });
            });
        }
        if (typeof onChunk === 'function') onChunk(result.checked + result.unchecked.length, sentences.length);
    }

    const ranked = rankUncitedFindings(found);
    result.findings = ranked.slice(0, Math.max(0, maxFindings));
    result.dropped = ranked.length - result.findings.length;
    return result;
}
