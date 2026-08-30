// Stage 4 of the batch pipeline: turns a claim + already-fetched source (what
// service/claim-extractor.js produces) into a verdict. Deliberately thin — every
// piece of actual logic already exists in core/ and is shared with the
// userscript and CLI; this module is the retry wiring, the halt rule, and
// the mapping into a plain result object.
//
// verifyCitation() is the solo (one-source-per-claim) path. verifyGroup() is
// the adjacent-group collective path, added once core/groups.js existed to
// share the dedup/skip/merge rules with the userscript — see that module's
// header, and docs/design-plans/2026-08-22-batch-verification-and-persistence.md
// §2 for why the two were built in that order. Nothing in this repo calls
// verifyGroup() yet: no runner joins the full six-stage pipeline
// (docs/design-plans/2026-08-24-csv-deliverable-and-component-names.md, G1),
// and benchmark/dataset.json, the replay corpus service/run-replay.js drives,
// has no grouped citations to exercise it against. It is tested in isolation
// so the sweep runner has correct logic to call once it exists.

import {
    generateSystemPrompt, generateUserPrompt, extractSourceText,
    generateGroupSystemPrompt, generateGroupUserPrompt, assembleGroupSources,
} from '../core/prompts.js';
import { callProviderAPI } from '../core/providers.js';
import { parseVerificationResult } from '../core/parsing.js';
import { canonicalizeVerdict } from '../core/verdicts.js';
import { verifyQuote } from '../core/quote.js';
import { withRetry, isContextLengthError } from '../core/retry.js';
import { groupSourceEntries, shouldSkipCollective } from '../core/groups.js';
import { sourceCacheKey } from './claim-extractor.js';

// Thrown when the model call fails with 401/402/403. Distinct from a
// context-length failure (below), which is data-dependent — specific to
// this one citation's source, not evidence every future call is doomed —
// and from every other failure, which halts the whole batch: a runner must
// halt on THIS one rather than record it as a per-citation failure — see
// isAuthOrBillingError's doc comment for why.
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
 * `source` is the shape service/claim-extractor.js's resolveSource() returns:
 * { content, status, error, unavailableReason }. A missing `content` (no
 * URL, or the fetch failed) short-circuits to SOURCE UNAVAILABLE without
 * calling the model — matching main.js's and service/claim-extractor.js's existing
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
 *
 * A prompt that exceeds the model's context window (vLLM/Lift Wing's
 * "maximum context length" validation error) does NOT throw — it's
 * data-dependent and permanent for this one citation's source, unrelated to
 * whether any other citation will succeed, so it's returned as a normal
 * `verdict: 'ERROR'` result instead, same as the no-content short-circuit
 * above. core/retry.js declines to retry it for the same reason (the same
 * oversized prompt fails identically every time).
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
            supportScore: null,
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
        // Data-dependent, per-citation, and permanent for this exact source
        // — retrying (core/retry.js already declined to) or halting the
        // whole batch over it would both be wrong; recorded as a normal
        // (non-throwing) result instead, same as the no-content
        // short-circuit above, so a runner just moves on to the next task.
        if (isContextLengthError(error)) {
            return {
                verdict: 'ERROR',
                supportScore: null,
                reasonType: 'context_length',
                rationale: `Source too large for the model's context window: ${error.message}`,
                sourceQuote: null,
                quoteStatus: null,
                usage: null,
                fetchStatus: source.status ?? null,
            };
        }
        throw error;
    }

    const parsed = parseVerificationResult(response.text);
    const verdict = canonicalizeVerdict(parsed.verdict) || parsed.verdict;
    const quote = verifyQuote(extractSourceText(source.content), parsed.source_quote);

    return {
        verdict,
        supportScore: parsed.support_score ?? null,
        reasonType: parsed.reason_type || null,
        rationale: parsed.comments || null,
        sourceQuote: parsed.source_quote || null,
        quoteStatus: quote.status,
        usage: response.usage ?? null,
        fetchStatus: source.status ?? null,
    };
}

/**
 * Verifies one adjacent-citation group's collective (multi-source) claim.
 *
 * `members` are one group's citations, in the shape
 * service/claim-extractor.js's processArticle() produces (each carrying a
 * resolved `source`), pre-filtered to a single `groupId` and sorted by
 * `groupIndex` — the caller's job, since a runner iterating a flat citations
 * array already knows how to group them (`citations.filter(c => c.groupId
 * === id)`).
 *
 * Uses core/groups.js for the dedup and skip rules, so this computes the
 * same group unit the userscript's verifyGroupCollective() does. Returns
 * `{ skipped: true, groupId }` when at most one member source has usable
 * text — the same placeholder shape main.js's reportGroupResults holds for a
 * skipped group, and what core/groups.js's mergeReportUnits() expects to
 * find there. Otherwise returns the same shape verifyCitation() does, plus
 * `groupId` and `memberCitationNumbers`.
 *
 * Throws ProviderAuthError on a 401/402/403, same as verifyCitation() —
 * callers must halt the whole batch on this rather than record it as a
 * per-group failure. A context-length failure, same as verifyCitation(),
 * does not throw — returned as `{ skipped: false, verdict: 'ERROR', ... }`.
 */
export async function verifyGroup(members, {
    callModel,
    signal,
    retry = {},
} = {}) {
    if (typeof callModel !== 'function') {
        throw new TypeError('verifyGroup requires a callModel(systemPrompt, userContent) function');
    }
    if (!Array.isArray(members) || members.length === 0) {
        throw new TypeError('verifyGroup requires a non-empty array of group members');
    }

    const groupId = members[0].groupId;
    const claimText = members[0].claimText;
    const memberCitationNumbers = members.map(m => m.citationNumber);

    // Dedupe by cache key so a source cited twice in the group (named refs)
    // is sent once, with both citation numbers on its label. Each member
    // already carries its own resolved `source` (processArticle() resolved
    // it per-citation against a shared cache), so — unlike the userscript,
    // which looks members up in a live sourceCache — this reads straight off
    // the member.
    const entries = groupSourceEntries(members, m => ({
        key: m.url ? sourceCacheKey(m.url, m.pageNum) : `__nourl_${m.citationNumber}`,
        url: m.url || null,
        content: m.source?.content ?? null,
        error: m.source?.error ?? null,
        status: m.source?.status ?? null,
    }));

    // With at most one usable source the collective verdict would just
    // restate the solo one, so skip the model call entirely.
    if (shouldSkipCollective(entries)) {
        return { skipped: true, groupId };
    }

    const { text: assembledText } = assembleGroupSources(entries);
    const systemPrompt = generateGroupSystemPrompt();
    const userContent = generateGroupUserPrompt(claimText, assembledText);

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
        // See verifyCitation()'s matching branch: data-dependent and
        // permanent for this exact group's assembled sources, not evidence
        // the batch itself is broken.
        if (isContextLengthError(error)) {
            return {
                skipped: false,
                groupId,
                memberCitationNumbers,
                verdict: 'ERROR',
                supportScore: null,
                reasonType: 'context_length',
                rationale: `Source too large for the model's context window: ${error.message}`,
                sourceQuote: null,
                quoteStatus: null,
                usage: null,
            };
        }
        throw error;
    }

    const parsed = parseVerificationResult(response.text);
    const verdict = canonicalizeVerdict(parsed.verdict) || parsed.verdict;
    // The group quote is checked against the assembled text of every source
    // in the group, so a verbatim quote from any one of them verifies —
    // matching main.js's buildQuoteView(parsed, assembledText).
    const quote = verifyQuote(extractSourceText(assembledText), parsed.source_quote);

    return {
        skipped: false,
        groupId,
        memberCitationNumbers,
        verdict,
        supportScore: parsed.support_score ?? null,
        reasonType: parsed.reason_type || null,
        rationale: parsed.comments || null,
        sourceQuote: parsed.source_quote || null,
        quoteStatus: quote.status,
        usage: response.usage ?? null,
    };
}
