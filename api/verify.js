// Public, per-citation HTTP surface over the existing verification pipeline.
//
// This module deliberately owns only HTTP concerns. In particular, it does
// not contain a prompt, model response parser, verdict list, source fetcher or
// provider implementation: changing any of those here would create a second
// verification behaviour beside core/pipeline.js.

import { verifyCitation, VERIFY_STAGES } from '../core/pipeline.js';
import { modelFor } from '../core/models.js';

// Every request goes to Lift Wing, which core/providers.js reaches through the
// tf-llm-router Toolforge tool unless a workerBase overrides it. That keeps
// the public API's inference inside Wikimedia infrastructure and off the
// personal Cloudflare worker, whose shared path 429'd after two back-to-back
// calls where the router took a hundred without error
// (docs/design-plans/2026-08-25-verify-concurrency-and-the-fetch-question.md).
const API_PROVIDER = 'liftwing';

export const MAX_CLAIM_CHARS = 10_000;
export const MAX_SOURCE_CONTENT_CHARS = 50_000;
// The character limits above are the contract; the byte cap only has to stop
// abuse without undercutting them. JSON can spend six bytes on one UTF-16 unit
// (a \uXXXX escape, which Python's json.dumps emits for every non-ASCII
// character by default), so size for that worst case, plus headroom for field
// names, page and a source_url.
export const MAX_BODY_BYTES = (MAX_CLAIM_CHARS + MAX_SOURCE_CONTENT_CHARS) * 6 + 8 * 1024;

export function validateVerifyRequest(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return 'Request body must be a JSON object';
    }
    if (typeof body.claim !== 'string' || !body.claim.trim()) {
        return 'claim must be a non-empty string';
    }
    if (body.claim.length > MAX_CLAIM_CHARS) {
        return `claim must not exceed ${MAX_CLAIM_CHARS} characters`;
    }

    const hasUrl = typeof body.source_url === 'string' && body.source_url.trim();
    const hasContent = typeof body.source_content === 'string' && body.source_content.trim();
    if (!hasUrl && !hasContent) {
        return 'Provide source_url or source_content';
    }
    if (body.source_url != null && typeof body.source_url !== 'string') {
        return 'source_url must be a string';
    }
    if (hasUrl) {
        try {
            const url = new URL(body.source_url);
            if (!['http:', 'https:'].includes(url.protocol)) {
                return 'source_url must use http or https';
            }
        } catch {
            return 'source_url must be an absolute URL';
        }
    }
    if (body.source_content != null && typeof body.source_content !== 'string') {
        return 'source_content must be a string';
    }
    if (body.source_content?.length > MAX_SOURCE_CONTENT_CHARS) {
        return `source_content must not exceed ${MAX_SOURCE_CONTENT_CHARS} characters`;
    }
    if (body.page != null && (!Number.isInteger(body.page) || body.page < 1)) {
        return 'page must be a positive integer';
    }
    const knownFields = new Set(['claim', 'source_url', 'source_content', 'page']);
    const unknown = Object.keys(body).find(field => !knownFields.has(field));
    if (unknown) return `Unknown field: ${unknown}`;
    return null;
}

// Preserve the model's established response field names. Quote verification
// is additive metadata; verified_text is the only quote text a consumer can
// safely display as evidence.
export function publicResult(result) {
    return {
        verdict: result.verdict,
        support_score: result.supportScore,
        comments: result.comments,
        reason_type: result.reasonType,
        source_quote: result.sourceQuote,
        quote_status: result.quote.status,
        verified_text: result.quote.verifiedText,
    };
}

function failureStatus(stage) {
    if (stage === VERIFY_STAGES.SOURCE) return 422;
    if (stage === VERIFY_STAGES.PROVIDER) return 502;
    return 502;
}

/**
 * Verify a validated public request with the same five-step function used by
 * the CLI and other core consumers. The provider is intentionally not a
 * request parameter: every request uses API_PROVIDER.
 */
export async function verifyRequest(body, {
    provider = API_PROVIDER,
    model = modelFor(provider),
    workerBase,
    fetchSource,
    callProvider,
} = {}) {
    const validationError = validateVerifyRequest(body);
    if (validationError) {
        return { status: 400, body: { error: validationError } };
    }

    const options = {
        claimText: body.claim.trim(),
        sourceUrl: body.source_url?.trim() || null,
        pageNum: body.page ?? null,
        // Preserve supplied source bytes. Trimming here would make the API a
        // subtly different input path from other verifyCitation() callers.
        // Whitespace-only text is still absent, as validation already treats
        // it: passing it on would skip the source_url fetch and have the model
        // judge the claim against nothing.
        sourceContent: body.source_content?.trim() ? body.source_content : null,
        provider,
        model,
    };
    if (workerBase) options.workerBase = workerBase;
    if (fetchSource) options.fetchSource = fetchSource;
    if (callProvider) options.callProvider = callProvider;

    const result = await verifyCitation(options);
    if (!result.ok) {
        return {
            status: failureStatus(result.stage),
            body: {
                error: result.error,
                stage: result.stage,
                ...(result.status != null ? { source_status: result.status } : {}),
            },
        };
    }
    return { status: 200, body: publicResult(result) };
}
