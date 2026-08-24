// Stage 4 of the batch pipeline: turns a claim + already-fetched source (what
// service/pipeline.js produces) into a verdict. Deliberately thin — every
// piece of actual logic already exists in core/ and is shared with the
// userscript and CLI; this module is the retry wiring, the halt rule, and
// the mapping into a plain result object.
//
// Scope note: only the solo (one-source-per-claim) path is implemented.
// Adjacent-group collective verification (core/groups.js, not yet built) is
// deliberately out of scope here — see docs/design-plans/
// 2026-08-22-batch-verification-and-persistence.md §2 — and
// benchmark/dataset.json, the replay corpus this module exists to run
// against first, has no grouped citations to exercise it against anyway.

import { generateSystemPrompt, generateUserPrompt, extractSourceText } from '../core/prompts.js';
import { callProviderAPI } from '../core/providers.js';
import { parseVerificationResult } from '../core/parsing.js';
import { canonicalizeVerdict } from '../core/verdicts.js';
import { verifyQuote } from '../core/quote.js';
import { withRetry } from '../core/retry.js';

// Thrown when the model call fails with 401/402/403. Distinct from every
// other failure this module can raise: a runner must halt the whole batch on
// this, not record it as a per-citation failure — see isAuthOrBillingError's
// doc comment for why.
export class ProviderAuthError extends Error {
    constructor(message, { status, cause } = {}) {
        super(message);
        this.name = 'ProviderAuthError';
        this.status = status;
        if (cause) this.cause = cause;
    }
}

const AUTH_BILLING_STATUSES = new Set([401, 402, 403]);

// Matches the status code core/providers.js embeds in its thrown message
// (e.g. "PublicAI API request failed (402): ...", or Claude's bare
// "API request failed (401): ..."). Narrower than cli/verify.js's
// classifyProviderError, which buckets every 4xx together for an exit code —
// this only flags the three statuses that mean "stop the whole run", per the
// real incident docs/design-plans/2026-08-07-batch-source-checks-for-edit-suggestions.md
// §5 describes: a spent PublicAI wallet balance produced 31 silently-wrong
// SOURCE UNAVAILABLE rows in one benchmark run because nothing halted the loop.
export function isAuthOrBillingError(error) {
    const match = (error?.message || '').match(/\((\d{3})\)/);
    return match ? AUTH_BILLING_STATUSES.has(Number(match[1])) : false;
}

// Binds a provider config into a (systemPrompt, userContent) => {text, usage}
// function, so verifyCitation() itself never sees provider names, API keys,
// or worker bases — the same seam the planned core/verify-run.js orchestrator
// (docs/design-plans/2026-08-10-track-c-orchestration-extraction.md) would
// use for makeVerifiers(). Runners construct one of these per provider and
// pass it in.
export function makeModelCaller({ provider, apiKey, model, workerBase }) {
    if (!provider) throw new TypeError('makeModelCaller requires a provider name');
    return (systemPrompt, userContent) => callProviderAPI(provider, {
        apiKey,
        model,
        systemPrompt,
        userContent,
        ...(workerBase ? { workerBase } : {}),
    });
}

/**
 * Verifies one claim against one already-fetched source.
 *
 * `source` is the shape service/pipeline.js's resolveSource() returns:
 * { content, status, error, unavailableReason }. A missing `content` (no
 * URL, or the fetch failed) short-circuits to SOURCE UNAVAILABLE without
 * calling the model — matching main.js's and service/pipeline.js's existing
 * "nothing to verify" handling, and the maintainer's 2026-08-20 decision
 * that these rows are still worth storing (docs/design-plans/
 * 2026-08-17-toolsdb-findings-store.md, "Design question, resolved").
 *
 * `source_quote` / `quote_status` are computed and returned on every row
 * regardless of verdict — mirroring core/worker.js's logVerification(), not
 * the UI's display-time filtering, per CLAUDE.md's "Source quotes are
 * verified before they are shown": the log/store layer keeps what the UI
 * hides, because a not-found quote is exactly the row worth inspecting later.
 *
 * Throws ProviderAuthError on a 401/402/403 from the model call. Callers
 * (runners) must halt the whole batch on this rather than record it as a
 * per-citation failure.
 */
export async function verifyCitation(claimText, source, {
    callModel,
    signal,
    retry = {},
} = {}) {
    if (typeof callModel !== 'function') {
        throw new TypeError('verifyCitation requires a callModel(systemPrompt, userContent) function');
    }

    if (!source?.content) {
        return {
            verdict: 'SOURCE UNAVAILABLE',
            confidence: null,
            reasonType: null,
            rationale: null,
            sourceQuote: null,
            quoteStatus: null,
            usage: null,
            fetchStatus: source?.status ?? null,
        };
    }

    const systemPrompt = generateSystemPrompt();
    const userContent = generateUserPrompt(claimText, source.content);

    const retryOptions = { ...retry };
    if (signal && !retryOptions.shouldAbort) {
        retryOptions.shouldAbort = () => Boolean(signal.aborted);
    }

    let response;
    try {
        response = await withRetry(() => callModel(systemPrompt, userContent), retryOptions);
    } catch (error) {
        if (isAuthOrBillingError(error)) {
            const status = Number((error.message || '').match(/\((\d{3})\)/)?.[1]) || null;
            throw new ProviderAuthError(error.message, { status, cause: error });
        }
        throw error;
    }

    const parsed = parseVerificationResult(response.text);
    const verdict = canonicalizeVerdict(parsed.verdict) || parsed.verdict;
    const quote = verifyQuote(extractSourceText(source.content), parsed.source_quote);

    return {
        verdict,
        confidence: parsed.confidence ?? null,
        reasonType: parsed.reason_type || null,
        rationale: parsed.comments || null,
        sourceQuote: parsed.source_quote || null,
        quoteStatus: quote.status,
        usage: response.usage ?? null,
        fetchStatus: source.status ?? null,
    };
}
