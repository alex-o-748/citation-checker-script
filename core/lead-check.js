// The lead check: every lead sentence against the article body.
//
// A lead summarizes the body, so per WP:LEADCITE a lead statement needs no
// citation of its own as long as the body covers it. This check asks exactly
// that, for every lead sentence, whether or not it carries a citation and
// whatever the claim scope. It is independent of the citation checks: a
// sentence that fails both is reported by both, because the two fixes differ
// (a better source; content added to the body). Design:
// docs/design-plans/2026-10-22-lead-checks.md.
//
// Its own prompt with its own hash-pinned version, like the severity pass:
// the verdict prompt in core/prompts.js is tuned against the benchmark and
// stays untouched. Same verdict vocabulary, so every consumer reads the
// result the way it reads a citation verdict; only the meaning of "omission"
// shifts, to "not covered in the body".
//
// Shared by the batch pipeline (service/verifier.js's verifyLead()) and the
// userscript (inlined into main.js). runLeadCheck() is the one sequence both
// run; each front end only decides what a thrown error means for it.

import { withRetry, isSourceTooLargeError, isOutputBudgetError } from './retry.js';
import { verifyQuote } from './quote.js';
import { VERDICTS, canonicalizeVerdict } from './verdicts.js';
import { fitBody } from './lead.js';

// Bump whenever the prompt text changes, same contract as PROMPT_VERSION:
// tests/lead-check.test.js pins a hash of the prompt against it.
export const LEAD_PROMPT_VERSION = 'l1';

// What a lead sentence's verdict means for the editor.
export const LEAD_OUTCOMES = Object.freeze({
    // SUPPORTED: the body covers it. Nothing to report.
    COVERED: 'covered',
    // PARTIALLY SUPPORTED, or NOT SUPPORTED as an omission: add it to the body.
    NOT_COVERED: 'not_covered',
    // NOT SUPPORTED as a contradiction: the lead and the body disagree.
    CONTRADICTED: 'contradicted',
});

export function leadOutcomeFor(verdict, reasonType) {
    const v = canonicalizeVerdict(verdict);
    if (v === VERDICTS.SUPPORTED) return LEAD_OUTCOMES.COVERED;
    if (v === VERDICTS.NOT_SUPPORTED && String(reasonType || '').toLowerCase() === 'contradiction') {
        return LEAD_OUTCOMES.CONTRADICTED;
    }
    if (v === VERDICTS.NOT_SUPPORTED || v === VERDICTS.PARTIALLY_SUPPORTED) return LEAD_OUTCOMES.NOT_COVERED;
    return null;
}

// Sentences per model call. The body is sent with every call, so fewer calls
// are cheaper — but the answer is one JSON item per sentence, and a model
// that reasons before answering spends its output budget on each of them: in
// the 2026-10-22 prototype, 8 sentences in one call to the default provider
// used 15.8k of its 16,384 output tokens. Lift Wing's router clamps output to
// 4,096. First guesses, per provider; LEAD_CHUNK_SIZE_DEFAULT for the rest.
export const LEAD_CHUNK_SIZES = Object.freeze({
    liftwing: 3,
    'liftwing-safeguard': 3,
    huggingface: 4,
    publicai: 4,
    claude: 8,
    gemini: 6,
    openai: 8,
});
export const LEAD_CHUNK_SIZE_DEFAULT = 4;

export function leadChunkSize(provider) {
    return LEAD_CHUNK_SIZES[provider] ?? LEAD_CHUNK_SIZE_DEFAULT;
}

// A body a model rejects as too long is halved and retried, down to this.
// Below it, the remaining sentences are recorded as unchecked rather than
// judged against a body too small to mean anything.
export const LEAD_BODY_MIN_CHARS = 10000;

export function generateLeadSystemPrompt() {
    return `You are a fact-checking assistant for Wikipedia. The lead section of a Wikipedia article summarizes the rest of the article, its body. You are given the BODY of an article, under its section headings, and numbered STATEMENTS from the same article's lead. For each statement, decide whether the body supports it.

Rules:
- ONLY use the body text provided. Never use outside knowledge. Do not judge whether a statement is true, only whether the body says it.
- A lead summarizes at a higher level of generality than the body. A statement is supported when it is a fair summary of what the body states: a paraphrase, a generalization that follows directly from the body, or facts gathered from several sections together.
- Specific details must actually appear in the body: numbers, dates, names, places, rankings and superlatives ("the first", "the largest"), direct quotations, and evaluations attributed to others ("widely regarded as", "critics praised").
- Search the whole body before deciding the body does not cover a statement: the passage that supports it can sit in any section, including one mainly about something else.
- The lead is given for context only, so you know who or what a statement refers to ("She later moved to Paris"). It is never evidence.
- Names from languages using non-Latin scripts may have several valid romanizations. Do not treat transliteration differences as errors.

Verdicts:
- SUPPORTED: the body states it, or it fairly summarizes what the body states.
- PARTIALLY SUPPORTED: the body supports part of the statement, but a specific detail is missing from the body.
- NOT SUPPORTED: the body does not cover the statement, or contradicts it. Add "reason_type": "contradiction" when the body states something incompatible with the statement (a different date, number, name or outcome), or "omission" when the body does not address it. If both apply, use "contradiction". Do not include reason_type for other verdicts.

The "source_quote" field: copy EXACTLY, character for character, the passage of the body that decides the verdict: the one that supports the statement, or the one that contradicts it. Keep it short, normally one sentence. Never quote a section heading, the lead, or the statement itself. Use "" for omission. It is checked automatically against the body, and a quote that does not appear there verbatim is discarded.

The "section" field: the heading of the section the quote comes from, as written in the body without the = signs, or "" when there is no quote.

Support score guide:
- 80-100: SUPPORTED
- 50-79: PARTIALLY SUPPORTED
- 0-49: NOT SUPPORTED

Respond with a JSON array only, one object per statement, in the order given:
[{"id": <statement number>, "verdict": "<verdict>", "support_score": <number>, "reason_type": "<only for NOT SUPPORTED>", "source_quote": "<passage>", "section": "<heading>", "comments": "<brief explanation, without repeating the quote>"}]

<example>
Article: Morrison Bridge

Article body:
== History ==
The Morrison Bridge project broke ground in 1994. The bridge was opened to traffic in August 2002, four years behind schedule.

== Design ==
It is a cable-stayed bridge with a main span of 300 metres, designed by engineer Anna Holt.

The lead, for context only (it is never evidence):
The Morrison Bridge is a cable-stayed bridge that opened in 2002. It was designed by Anna Holt and cost $200 million. Construction began in 1998. It is the longest bridge in the state.

Statements from the lead to check:
1. "The Morrison Bridge is a cable-stayed bridge that opened in 2002."
2. "It was designed by Anna Holt and cost $200 million."
3. "Construction began in 1998."
4. "It is the longest bridge in the state."

[{"id": 1, "verdict": "SUPPORTED", "support_score": 95, "source_quote": "The bridge was opened to traffic in August 2002, four years behind schedule.", "section": "History", "comments": "History gives the 2002 opening, and Design says it is cable-stayed."},
{"id": 2, "verdict": "PARTIALLY SUPPORTED", "support_score": 60, "source_quote": "It is a cable-stayed bridge with a main span of 300 metres, designed by engineer Anna Holt.", "section": "Design", "comments": "The body names Anna Holt as the designer but gives no cost."},
{"id": 3, "verdict": "NOT SUPPORTED", "reason_type": "contradiction", "support_score": 10, "source_quote": "The Morrison Bridge project broke ground in 1994.", "section": "History", "comments": "The body says construction began in 1994, not 1998."},
{"id": 4, "verdict": "NOT SUPPORTED", "reason_type": "omission", "support_score": 5, "source_quote": "", "section": "", "comments": "The body does not compare it with other bridges in the state."}]
</example>`;
}

/**
 * @param {object} args
 * @param {string} [args.articleTitle]
 * @param {string} args.bodyText - articleBody()'s `text`.
 * @param {Array<{index: number, paragraphIndex: number, text: string}>} args.leadSentences - Every lead sentence, for context.
 * @param {Array<{index: number, text: string}>} args.statements - The ones to check; numbered index + 1.
 */
export function generateLeadUserPrompt({ articleTitle, bodyText, leadSentences, statements }) {
    const paragraphs = [];
    for (const s of leadSentences) {
        (paragraphs[s.paragraphIndex ?? 0] ??= []).push(s.text);
    }
    const lead = paragraphs.filter(Boolean).map(p => p.join(' ')).join('\n\n');
    const lines = [];
    if (articleTitle) lines.push(`Article: ${articleTitle}`, '');
    lines.push('Article body:', bodyText, '');
    lines.push('The lead, for context only (it is never evidence):', lead, '');
    lines.push('Statements from the lead to check:');
    for (const s of statements) lines.push(`${s.index + 1}. "${s.text}"`);
    return lines.join('\n');
}

function extractJsonArray(text) {
    const trimmed = (text || '').trim();
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    const body = fenced ? fenced[1].trim() : trimmed;
    const start = body.indexOf('[');
    const end = body.lastIndexOf(']');
    if (start !== -1 && end > start) return body.slice(start, end + 1);
    return body;
}

/**
 * Parses a lead-check response: `{ ok: true, items: Map<id, item> }` or
 * `{ ok: false, error }`. Each item is
 * `{ verdict, reasonType, supportScore, sourceQuote, section, comments }`.
 *
 * Lenient about shape (a bare array, or an object holding one; string ids)
 * and strict about the verdict: only the three a body can give count, and
 * an item with any other is left out, so its sentence is recorded as
 * unchecked rather than guessed.
 */
export function parseLeadCheckResult(text) {
    let parsed;
    try {
        parsed = JSON.parse(extractJsonArray(text));
    } catch {
        return { ok: false, error: 'parse_error' };
    }
    const raw = Array.isArray(parsed)
        ? parsed
        : (parsed && typeof parsed === 'object' ? Object.values(parsed).find(Array.isArray) : null);
    if (!Array.isArray(raw)) return { ok: false, error: 'parse_error' };

    const items = new Map();
    for (const item of raw) {
        const id = Number(item?.id);
        const verdict = canonicalizeVerdict(item?.verdict);
        if (!Number.isInteger(id) || ![VERDICTS.SUPPORTED, VERDICTS.PARTIALLY_SUPPORTED, VERDICTS.NOT_SUPPORTED].includes(verdict)) {
            continue;
        }
        const quote = item.source_quote ?? item.sourceQuote ?? item.quote;
        const reasonType = verdict === VERDICTS.NOT_SUPPORTED && item.reason_type
            ? String(item.reason_type).trim().toLowerCase()
            : null;
        items.set(id, {
            verdict,
            reasonType,
            supportScore: Number.isFinite(Number(item.support_score)) ? Number(item.support_score) : null,
            sourceQuote: typeof quote === 'string' ? quote.trim() : '',
            section: typeof item.section === 'string' ? item.section.trim() : '',
            comments: typeof item.comments === 'string' ? item.comments.trim() : '',
        });
    }
    if (items.size === 0) return { ok: false, error: 'no_items' };
    return { ok: true, items };
}

// The section a verified quote is actually in, which beats the model's own
// "section" when they disagree. Falls back to the model's when it names a
// real heading, else null.
function sectionFor(sections, quote, claimed) {
    if (quote) {
        for (const s of sections) {
            if (verifyQuote(s.text, quote).verified) return s.heading;
        }
    }
    const named = sections.find(s => s.heading.toLowerCase() === String(claimed || '').toLowerCase());
    return named ? named.heading : null;
}

function uncheckedResult(sentence, error, bodyTruncated) {
    return {
        index: sentence.index,
        text: sentence.text,
        verdict: null,
        reasonType: null,
        supportScore: null,
        sourceQuote: null,
        quoteStatus: null,
        quoteText: null,
        section: null,
        comments: null,
        outcome: null,
        bodyTruncated,
        usage: null,
        error,
    };
}

/**
 * Checks lead sentences against the body.
 *
 * @param {object} input
 * @param {Array<{index, paragraphIndex, text}>} input.sentences - core/lead.js's leadSentences().
 * @param {object} input.body - core/lead.js's articleBody().
 * @param {string} [input.articleTitle]
 * @param {Array<number>} [input.only] - Sentence indexes to check (default: all).
 *   The rest are still sent as context.
 * @param {object} deps
 * @param {Function} deps.callModel - (systemPrompt, userContent, { kind: 'lead' }) => { text, usage }.
 * @param {string} [deps.systemPrompt] - A localized generateLeadSystemPrompt().
 * @param {number} [deps.chunkSize]
 * @param {object} [deps.retry] - core/retry.js options.
 * @param {Function} [deps.onChunk] - (results so far, sentences total), after each call.
 * @param {Function} [deps.onChunkError] - (error) => an error code to record
 *   that chunk's sentences under, then carry on; or nothing, to throw. It may
 *   throw itself (an auth error that must halt a run). Without it, every
 *   failure but a too-long prompt is thrown, losing the chunks before it.
 *
 * Returns `{ results, bodyChars, bodyTruncated, usage, calls, promptVersion }`,
 * one result per checked sentence, in order:
 * `{ index, text, verdict, reasonType, supportScore, sourceQuote, quoteStatus,
 *    quoteText, section, comments, outcome, bodyTruncated, usage, error }`,
 * `usage` being the sentence's share of its call's tokens.
 * `quoteText` is core/quote.js's verifiedText: the only part a renderer may
 * show. A sentence the model left out, or answered unreadably, has `error`
 * set and no verdict.
 *
 * Two failures are handled here, because both depend on how much is asked
 * at once. A prompt too long for the model is retried with the body halved
 * (down to LEAD_BODY_MIN_CHARS), and later calls keep the smaller body. An
 * answer that ran out of output budget — a reasoning model thinking about
 * every sentence before answering — is retried as two calls of half the
 * sentences each, down to one. Every other failure (an exhausted retry, an
 * auth error, a budget run out on a single sentence) goes to onChunkError,
 * the caller's own policy.
 */
export async function runLeadCheck({ sentences, body, articleTitle, only } = {}, {
    callModel, systemPrompt = generateLeadSystemPrompt(), chunkSize = LEAD_CHUNK_SIZE_DEFAULT,
    retry = {}, onChunk, onChunkError,
} = {}) {
    if (typeof callModel !== 'function') {
        throw new TypeError('runLeadCheck requires a callModel(systemPrompt, userContent) function');
    }
    const usage = { input: 0, output: 0 };
    const empty = { results: [], bodyChars: body?.chars ?? 0, bodyTruncated: Boolean(body?.truncated), usage, calls: 0, promptVersion: LEAD_PROMPT_VERSION };
    if (!body?.text || !Array.isArray(sentences) || sentences.length === 0) return empty;

    const wanted = only ? new Set(only) : null;
    const toCheck = sentences.filter(s => !wanted || wanted.has(s.index));
    const leadText = sentences.map(s => s.text).join(' ');
    const size = Math.max(1, chunkSize);
    let current = body;
    let calls = 0;
    const results = [];

    // A queue rather than a fixed loop: a chunk whose answer ran out of
    // output budget goes back on the front as two halves.
    const queue = [];
    for (let i = 0; i < toCheck.length; i += size) queue.push(toCheck.slice(i, i + size));

    while (queue.length) {
        const chunk = queue.shift();
        let response = null;
        let failure = null;
        let split = false;
        for (;;) {
            const userContent = generateLeadUserPrompt({ articleTitle, bodyText: current.text, leadSentences: sentences, statements: chunk });
            try {
                calls++;
                response = await withRetry(() => callModel(systemPrompt, userContent, { kind: 'lead' }), retry);
                break;
            } catch (error) {
                if (isOutputBudgetError(error) && chunk.length > 1) {
                    const half = Math.ceil(chunk.length / 2);
                    queue.unshift(chunk.slice(0, half), chunk.slice(half));
                    split = true;
                    break;
                }
                if (!isSourceTooLargeError(error)) {
                    const code = typeof onChunkError === 'function' ? onChunkError(error) : null;
                    if (!code) throw error;
                    failure = code;
                    break;
                }
                const smaller = Math.floor(current.chars / 2);
                if (smaller < LEAD_BODY_MIN_CHARS) {
                    failure = 'body_too_large';
                    break;
                }
                current = { ...fitBody(current.sections, { maxChars: smaller, leadText }), totalChars: body.totalChars };
            }
        }
        if (split) continue;

        const truncated = Boolean(current.truncated);
        if (response) {
            usage.input += response.usage?.input || 0;
            usage.output += response.usage?.output || 0;
        }
        const parsed = response ? parseLeadCheckResult(response.text) : null;
        // Each answered sentence carries its share of the call's tokens, the
        // remainder on the first, so per-row token columns still sum to what
        // the calls cost.
        const shareOf = (total, i) => Math.floor(total / chunk.length) + (i === 0 ? total % chunk.length : 0);
        chunk.forEach((sentence, i) => {
            const error = failure || (parsed.ok ? null : parsed.error);
            const item = error ? null : parsed.items.get(sentence.index + 1);
            if (!item) {
                results.push(uncheckedResult(sentence, error || 'missing_from_response', truncated));
                return;
            }
            const quote = verifyQuote(current.text, item.sourceQuote);
            results.push({
                index: sentence.index,
                text: sentence.text,
                verdict: item.verdict,
                reasonType: item.reasonType,
                supportScore: item.supportScore,
                sourceQuote: item.sourceQuote,
                quoteStatus: quote.status,
                quoteText: quote.verifiedText || null,
                section: sectionFor(current.sections, quote.verified ? item.sourceQuote : '', item.section),
                comments: item.comments,
                outcome: leadOutcomeFor(item.verdict, item.reasonType),
                bodyTruncated: truncated,
                usage: {
                    input: shareOf(response.usage?.input || 0, i),
                    output: shareOf(response.usage?.output || 0, i),
                },
                error: null,
            });
        });
        if (typeof onChunk === 'function') onChunk(results, toCheck.length);
    }

    return {
        results,
        bodyChars: current.chars,
        bodyTruncated: Boolean(current.truncated),
        usage,
        calls,
        promptVersion: LEAD_PROMPT_VERSION,
    };
}
