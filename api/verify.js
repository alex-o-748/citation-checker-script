// Public, per-citation HTTP surface over the existing verification pipeline.
//
// This module deliberately owns only HTTP concerns. In particular, it does
// not contain a prompt, model response parser, verdict list, source fetcher or
// provider implementation: changing any of those here would create a second
// verification behaviour beside core/pipeline.js.

import { verifyCitation, VERIFY_STAGES } from '../core/pipeline.js';
import { DEFAULT_PROVIDER, modelFor } from '../core/models.js';

export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_CLAIM_CHARS = 10_000;
export const MAX_SOURCE_CONTENT_CHARS = 50_000;

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
 * request parameter: the public service operator chooses one deployment-wide.
 */
export async function verifyRequest(body, {
    provider = DEFAULT_PROVIDER,
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
        sourceContent: body.source_content?.trim() || null,
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
