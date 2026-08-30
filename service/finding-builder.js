// Stage between verify (service/verifier.js) and store (service/findings-store.js):
// turns one verifyCitation() result, plus the citation and candidate metadata
// it came from, into the finding object buildUpsertQuery() expects. Named
// "assembly" to match the pipeline diagram in docs/design-plans/
// 2026-08-22-batch-verification-and-persistence.md.
//
// assembleGroupFinding() does the same for a group's collective (multi-source)
// verdict from service/verifier.js's verifyGroup(). It's a separate function
// rather than a branch of assembleFinding() because the two draw from
// genuinely different shapes — one citation with one source vs. several
// citations with several sources — and the only thing they share is the
// trailing "which columns get what" logic, factored into finishFinding()
// below.
//
// Pure and synchronous — no I/O, no clock reads beyond an injectable `now`.

import { groupSourceUrl } from '../core/anchor.js';

// §4 of the design doc: nothing computed by this phase has been through the
// §1 publication filter (that threshold doesn't exist yet — Track B), so
// every finding this module assembles is published:false. The column exists
// so that decision can be made later without re-running any inference; this
// module isn't the place that decision gets made.
export const FINDING_TTL_DAYS = 30;

// Only set on rows that actually have something to go stale — a fetched
// source. A no-URL / fetch-failed row has no live source to expire against,
// and is already published:false for an unrelated reason, so an expiry here
// would communicate nothing and cost a redundant idx_expiry scan candidate.
function computeExpiresAt(hasContent, fetchedAt, ttlDays) {
    if (!hasContent) return null;
    return new Date(fetchedAt.getTime() + ttlDays * 24 * 60 * 60 * 1000);
}

// Columns both assembleFinding() and assembleGroupFinding() fill the same
// way once they've each worked out the shape-specific fields above them
// (citationNumber, sourceUrl, groupId, isCollective, sourceTruncated,
// fetchStatus). `verification` is either verifyCitation()'s or
// verifyGroup()'s return value — both carry verdict/supportScore/reasonType/
// rationale/sourceQuote/quoteStatus/usage under the same names.
function finishFinding(base, { verification, provider, model, promptVersion, hasContent, fetchedAt, ttlDays }) {
    const modelRan = Boolean(verification.usage);
    return {
        ...base,
        verdict: verification.verdict,
        supportScore: verification.supportScore,
        reasonType: verification.reasonType,
        rationale: verification.rationale,
        sourceQuote: verification.sourceQuote,
        quoteStatus: verification.quoteStatus,
        provider: modelRan ? provider : null,
        model: modelRan ? model : null,
        promptVersion,
        tokensIn: verification.usage?.input ?? null,
        tokensOut: verification.usage?.output ?? null,
        expiresAt: computeExpiresAt(hasContent, fetchedAt, ttlDays),
        published: false,
    };
}

/**
 * @param {object} args
 * @param {{wiki: string, pageId: number, title: string, revisionId: number}} args.candidate
 *   The selected-article row (service/article-picker.js's normalizeRow shape:
 *   pageId, title, revisionId), plus `wiki` — selectCandidates() doesn't
 *   return that field itself, so the caller attaches it from whichever wiki
 *   database it queried (e.g. the runner's --wiki argument).
 * @param {object} args.citation - One entry from processArticle()'s
 *   `citations` array (service/claim-extractor.js): claimText, url, citationNumber,
 *   groupId, source: {content, status, error, unavailableReason}.
 * @param {object} args.verification - verifyCitation()'s return value.
 * @param {string} args.provider - Provider name, for display. Only recorded
 *   when the model actually ran (verification.usage is set) — a no-URL row
 *   never called a provider and shouldn't claim one.
 * @param {string} args.model - Model id, same gating as provider.
 * @param {string} args.promptVersion - core/prompts.js's PROMPT_VERSION at
 *   write time. Passed in rather than imported directly so a caller
 *   replaying under a pinned historical version can override it.
 * @param {Date} [args.fetchedAt] - When the source was retrieved. Defaults
 *   to now; a replay runner reusing benchmark/dataset.json's stored
 *   source_text should still pass the real fetch time if known, since it
 *   predates this run.
 * @param {number} [args.ttlDays] - Overrides FINDING_TTL_DAYS.
 */
export function assembleFinding({
    candidate,
    citation,
    verification,
    provider,
    model,
    promptVersion,
    fetchedAt = new Date(),
    ttlDays = FINDING_TTL_DAYS,
}) {
    const hasContent = Boolean(citation.source?.content);

    return finishFinding(
        {
            wiki: candidate.wiki,
            pageId: candidate.pageId,
            pageTitle: candidate.title,
            revisionId: candidate.revisionId,
            claimText: citation.claimText,
            citationNumber: citation.citationNumber ?? null,
            refName: citation.refName ?? null,
            sourceUrl: citation.url ?? null,
            fetchedAt: hasContent ? fetchedAt : null,
            groupId: citation.groupId ?? null,
            isCollective: false,
            fetchStatus: verification.fetchStatus,
            sourceTruncated: Boolean(citation.source?.content?.includes('\nTruncated: true')),
        },
        { verification, provider, model, promptVersion, hasContent, fetchedAt, ttlDays }
    );
}

/**
 * Same as assembleFinding(), for a group's collective (multi-source) verdict.
 *
 * @param {object} args
 * @param {{wiki: string, pageId: number, title: string, revisionId: number}} args.candidate
 *   Same shape as assembleFinding()'s.
 * @param {Array<object>} args.members - The group's citations (processArticle()
 *   shape), pre-filtered to one groupId — the same array passed to
 *   verifyGroup().
 * @param {object} args.verification - verifyGroup()'s return value. Must have
 *   `skipped: false` — a skipped group has no collective verdict to store;
 *   callers should not call this for one (its per-source member findings,
 *   from assembleFinding(), already cover it — see core/groups.js's header).
 * @param {string} args.provider - Same gating as assembleFinding()'s.
 * @param {string} args.model
 * @param {string} args.promptVersion
 * @param {Date} [args.fetchedAt]
 * @param {number} [args.ttlDays]
 */
export function assembleGroupFinding({
    candidate,
    members,
    verification,
    provider,
    model,
    promptVersion,
    fetchedAt = new Date(),
    ttlDays = FINDING_TTL_DAYS,
}) {
    if (verification.skipped) {
        throw new TypeError('assembleGroupFinding requires a completed (non-skipped) verifyGroup() result');
    }

    const hasContent = members.some(m => Boolean(m.source?.content));
    const citationNumbers = verification.memberCitationNumbers ?? members.map(m => m.citationNumber);

    return finishFinding(
        {
            wiki: candidate.wiki,
            pageId: candidate.pageId,
            pageTitle: candidate.title,
            revisionId: candidate.revisionId,
            claimText: members[0]?.claimText ?? null,
            // Display only, per 001's schema comment — not an identifier.
            // "5, 6" rather than a single number: service/migrations/
            // 003-widen-citation-number.sql must be applied before this can
            // be written to the real table (citation_number was INT).
            citationNumber: citationNumbers.join(', '),
            refName: null,
            sourceUrl: groupSourceUrl(members.map(m => m.url)),
            fetchedAt: hasContent ? fetchedAt : null,
            groupId: verification.groupId ?? members[0]?.groupId ?? null,
            isCollective: true,
            fetchStatus: null,
            sourceTruncated: members.some(m => m.source?.content?.includes('\nTruncated: true')),
        },
        { verification, provider, model, promptVersion, hasContent, fetchedAt, ttlDays }
    );
}
