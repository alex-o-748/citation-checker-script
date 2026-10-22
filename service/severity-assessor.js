// The severity pass, as a batch-pipeline stage between verify
// (service/verifier.js) and assembly (service/finding-builder.js): for a
// finding the verifier flagged, one extra model call that labels the claim's
// subclaims, and core/severity.js's tierFor() on the result.
//
// Same error contract as verifyCitation(): an auth/billing error throws
// ProviderAuthError so the runner halts; anything specific to this one
// finding (a source too large, an unparseable answer) comes back as
// { tier: null, error } and the finding is still recorded, untiered.

import { runSeverityPass, SEVERITY_VERDICTS, needsSeverity } from '../core/severity.js';
import { isSourceTooLargeError } from '../core/retry.js';
import { ProviderAuthError, isAuthOrBillingError, assembleGroupText } from './verifier.js';

// Moved to core/severity.js so the userscript ranks the same verdicts; kept
// exported here for the runner and its tests.
export { SEVERITY_VERDICTS, needsSeverity };

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
 * Returns core/severity.js's runSeverityPass() shape:
 * { tier, subclaims, error, usage, promptVersion }.
 */
export async function assessSeverity({
    claimText, sourceInfo, sourceTruncated = false, verification,
    articleTitle, sectionTitle, paragraphText,
}, { callModel, retry = {}, signal } = {}) {
    if (typeof callModel !== 'function') {
        throw new TypeError('assessSeverity requires a callModel(systemPrompt, userContent) function');
    }

    const retryOptions = { ...retry };
    if (signal && !retryOptions.shouldAbort) {
        retryOptions.shouldAbort = () => Boolean(signal.aborted);
    }

    try {
        return await runSeverityPass({
            claimText, sourceInfo, sourceTruncated,
            verdict: verification?.verdict, reasonType: verification?.reasonType,
            articleTitle, sectionTitle, paragraphText,
        }, { callModel, retry: retryOptions });
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
}

// The source text a group's severity pass reads: the same assembled text
// verifyGroup() judged, so the two passes see identical evidence.
export { assembleGroupText };
