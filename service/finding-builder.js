// Stage between verify (service/verifier.js) and store (service/findings-store.js):
// turns one verifyCitation() result, plus the citation and candidate metadata
// it came from, into the finding object buildUpsertQuery() expects. Named
// "assembly" to match the pipeline diagram in docs/design-plans/
// 2026-08-22-batch-verification-and-persistence.md.
//
// Pure and synchronous — no I/O, no clock reads beyond an injectable `now`.

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
    const modelRan = Boolean(verification.usage);

    return {
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
        verdict: verification.verdict,
        confidence: verification.confidence,
        reasonType: verification.reasonType,
        rationale: verification.rationale,
        sourceQuote: verification.sourceQuote,
        quoteStatus: verification.quoteStatus,
        provider: modelRan ? provider : null,
        model: modelRan ? model : null,
        promptVersion,
        fetchStatus: verification.fetchStatus,
        sourceTruncated: Boolean(citation.source?.content?.includes('\nTruncated: true')),
        tokensIn: verification.usage?.input ?? null,
        tokensOut: verification.usage?.output ?? null,
        expiresAt: computeExpiresAt(hasContent, fetchedAt, ttlDays),
        published: false,
    };
}
