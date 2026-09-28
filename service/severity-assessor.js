// The severity pass, as a batch-pipeline stage between verify
// (service/verifier.js) and assembly (service/finding-builder.js): for a
// finding the verifier flagged, one extra model call that labels the claim's
// subclaims, and core/severity.js's tierFor() on the result.
//
// Same error contract as verifyCitation(): an auth/billing error throws
// ProviderAuthError so the runner halts; anything specific to this one
// finding (a source too large, an unparseable answer) comes back as
// { tier: null, error } and the finding is still recorded, untiered.

import {
    generateSeveritySystemPrompt, generateSeverityUserPrompt,
    parseSeverityResult, tierFor, SEVERITY_TIERS, SEVERITY_PROMPT_VERSION,
} from '../core/severity.js';
import { withRetry, isSourceTooLargeError } from '../core/retry.js';
import { ProviderAuthError, isAuthOrBillingError, assembleGroupText } from './verifier.js';

export const SEVERITY_VERDICTS = new Set(['NOT SUPPORTED', 'PARTIALLY SUPPORTED']);

// Whether a verified finding gets a severity pass at all. Only flags are
// ranked; a SUPPORTED or SOURCE UNAVAILABLE row has nothing to rank.
export function needsSeverity(verification) {
    return Boolean(verification) && SEVERITY_VERDICTS.has(verification.verdict);
}

/**
 * @param {object} args
 * @param {string} args.claimText
 * @param {string} args.sourceInfo - The exact source text the verdict was
 *   reached on: a solo citation's `source.content`, or a group's
 *   assembleGroupText().
 * @param {boolean} args.sourceTruncated
 * @param {object} args.verification - The verdict being ranked.
 * @param {string} [args.articleTitle]
 * @param {string|null} [args.sectionTitle]
 * @param {string|null} [args.paragraphText]
 * @param {object} deps
 * @param {Function} deps.callModel - makeModelCaller()'s return value.
 *
 * Returns { tier, subclaims, error, usage, promptVersion }. promptVersion is
 * set only when the model was actually asked, so a finding records which
 * prompt produced its labels and not a version for a call that never ran.
 */
export async function assessSeverity({
    claimText, sourceInfo, sourceTruncated = false, verification,
    articleTitle, sectionTitle, paragraphText,
}, { callModel, retry = {}, signal } = {}) {
    if (typeof callModel !== 'function') {
        throw new TypeError('assessSeverity requires a callModel(systemPrompt, userContent) function');
    }

    // No model call for a pure omission on a truncated source: every subclaim
    // the first pass could not find would be "absent", and tierFor()
    // discounts absence on a truncated source whatever the labels say. The
    // second pass could in principle turn up a contradiction the first missed,
    // but paying a call per truncated omission for that is poor value.
    if (sourceTruncated && verification?.verdict === 'NOT SUPPORTED' && verification?.reasonType === 'omission') {
        return { tier: SEVERITY_TIERS.DISCOUNTED, subclaims: null, error: null, usage: null };
    }
    if (!sourceInfo) {
        return { tier: null, subclaims: null, error: 'no_source', usage: null };
    }

    const systemPrompt = generateSeveritySystemPrompt();
    const userContent = generateSeverityUserPrompt({ claimText, sourceInfo, articleTitle, sectionTitle, paragraphText });

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
        if (isSourceTooLargeError(error)) {
            return { tier: null, subclaims: null, error: 'source_too_large', usage: null };
        }
        throw error;
    }

    const parsed = parseSeverityResult(response.text);
    const asked = { usage: response.usage ?? null, promptVersion: SEVERITY_PROMPT_VERSION };
    if (!parsed.ok) {
        return { tier: null, subclaims: null, error: parsed.error, ...asked };
    }
    return {
        tier: tierFor({ subclaims: parsed.subclaims, sourceTruncated }),
        subclaims: parsed.subclaims,
        error: null,
        ...asked,
    };
}

// The source text a group's severity pass reads: the same assembled text
// verifyGroup() judged, so the two passes see identical evidence.
export { assembleGroupText };
