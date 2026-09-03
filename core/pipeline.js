// One citation in, one verdict out.
//
// Every front end that verifies a citation runs the same five steps in the
// same order: fetch the source, build the prompts, call the model, parse the
// verdict, check the quote against the source. cli/verify.js spelled that out
// inline, main.js spells it out again across verifyClaim() and its helpers,
// and the standalone web tool (alex-o-748/citation-checker) used to spell out
// a *different* version with its own prompt and its own JSON shape. This
// module is that sequence, once, so a front end is left owning only its own
// I/O and presentation.
//
// Deliberately not in scripts/sync-main.js's CORE_ORDER: main.js's flow is
// interleaved with sidebar state (cancellation ids, per-source caching,
// manual-paste override) and does not decompose into a single call yet.
//
// No I/O of its own — every network call is made by the core module that
// owns it, and both are injectable so callers can test without a network.

import { fetchSourceContent } from './worker.js';
import { generateSystemPrompt, generateUserPrompt, extractSourceText } from './prompts.js';
import { callProviderAPI } from './providers.js';
import { parseVerificationResult } from './parsing.js';
import { verifyQuote } from './quote.js';

// Which step failed, on a `{ ok: false }` result. Callers map these onto their
// own error surface — the CLI onto exit codes, a UI onto a message.
export const VERIFY_STAGES = Object.freeze({
    SOURCE:   'source',   // no usable source text to judge against
    PROVIDER: 'provider', // the model call itself failed (HTTP, network)
    PARSE:    'parse',    // the model answered, but not in a readable shape
});

/**
 * Verifies one claim against one source.
 *
 * Supply either `sourceUrl` (fetched through the worker proxy) or
 * `sourceContent` (already-fetched or hand-pasted text, in the framed shape
 * fetchSourceContent returns — plain text works too, extractSourceText passes
 * it through unchanged). `sourceContent` wins if both are given, which is the
 * manual-paste override every front end offers.
 *
 * Never throws for an expected failure: a dead source, a 429, or unparseable
 * model output all come back as `{ ok: false, stage, error }`. It only throws
 * on programmer error (a missing claim or provider).
 *
 * @returns {Promise<
 *   { ok: true, claimText, provider, model, verdict, supportScore, comments,
 *     reasonType, sourceQuote, quote, sourceUrl, sourceContent, sourceText,
 *     sourceStatus, usage, raw }
 *   | { ok: false, stage, error, status?, cause?, raw?, sourceUrl,
 *       sourceContent?, usage? }>}
 */
export async function verifyCitation({
    claimText,
    sourceUrl = null,
    pageNum = null,
    sourceContent = null,
    provider,
    model = null,
    apiKey = undefined,
    workerBase,
    systemPrompt,
    fetchSource = fetchSourceContent,
    callProvider = callProviderAPI,
} = {}) {
    if (!claimText) throw new TypeError('verifyCitation requires claimText');
    if (!provider) throw new TypeError('verifyCitation requires provider');

    // workerBase is threaded through only when the caller overrode it, so the
    // defaults baked into core/worker.js and core/providers.js still apply.
    const workerOpts = workerBase ? { workerBase } : {};

    // 1. Source text.
    let content = sourceContent;
    let sourceStatus = null;
    if (!content) {
        if (!sourceUrl) {
            return {
                ok: false,
                stage: VERIFY_STAGES.SOURCE,
                error: 'This citation has no fetchable URL, and no source text was supplied',
                status: null,
                sourceUrl: null,
            };
        }
        const fetched = await fetchSource(sourceUrl, pageNum, workerOpts);
        if (!fetched.content) {
            return {
                ok: false,
                stage: VERIFY_STAGES.SOURCE,
                error: fetched.error || 'Source content was empty or could not be retrieved',
                status: fetched.status ?? null,
                sourceUrl,
            };
        }
        content = fetched.content;
        sourceStatus = fetched.status ?? null;
    }

    // 2. Prompts and the model call. A caller that localizes the system prompt
    //    (main.js's localizeSystemPrompt) passes the localized text in.
    const system = systemPrompt ?? generateSystemPrompt();
    const userContent = generateUserPrompt(claimText, content);

    let response;
    try {
        response = await callProvider(provider, {
            apiKey,
            model,
            systemPrompt: system,
            userContent,
            ...workerOpts,
        });
    } catch (error) {
        return {
            ok: false,
            stage: VERIFY_STAGES.PROVIDER,
            error: error?.message || String(error),
            // The original error, so a caller that classifies on the message
            // shape (cli/verify.js's classifyProviderError) keeps working.
            cause: error,
            sourceUrl,
            sourceContent: content,
        };
    }

    // 3. Verdict.
    const parsed = parseVerificationResult(response.text);
    if (parsed.verdict === 'PARSE_ERROR') {
        return {
            ok: false,
            stage: VERIFY_STAGES.PARSE,
            error: parsed.comments,
            raw: response.text,
            sourceUrl,
            sourceContent: content,
            usage: response.usage ?? null,
        };
    }

    // 4. Quote check. The model's source_quote is looked up in the exact text
    //    the model was shown; renderers display quote.verifiedText, never the
    //    raw quote (see core/quote.js).
    const sourceText = extractSourceText(content);
    const quote = verifyQuote(sourceText, parsed.source_quote);

    return {
        ok: true,
        // Echoed back so the result is self-describing: the verification log
        // stores the claim that was judged, and a caller that fanned out over
        // many citations would otherwise have to correlate it back by hand.
        claimText,
        provider,
        model,
        verdict: parsed.verdict,
        supportScore: parsed.support_score,
        comments: parsed.comments,
        reasonType: parsed.reason_type ?? null,
        sourceQuote: parsed.source_quote,
        quote,
        sourceUrl,
        sourceContent: content,
        sourceText,
        sourceStatus,
        usage: response.usage ?? null,
        raw: response.text,
    };
}
