// Turns the rows feedback-loop/sql/cases.sql exports into cases, and decides
// which of them the nightly triage still has to look at.
//
// A case is one rated check: what the tool said (the verification log row),
// what the editor said back (the collapsed feedback rows), and enough about
// the rater to weigh the rating — without ever carrying who the rater was
// (see the header of cases.sql for why client_id never leaves the query).

import { canonicalizeVerdict } from '../core/verdicts.js';

// A rating given this soon after the same browser's previous one is usually a
// sweep through a Verify All report rather than a reading of the source. Such
// ratings are kept, but marked, so a reviewer can weigh them.
export const QUICK_RATING_SECONDS = 5;

// One browser rating this many checks on a single article is a review
// session. Nothing wrong with that, but its ratings are not independent of
// each other, and one session should not be able to dominate a cause cluster.
export const HEAVY_SESSION_CHECKS = 10;

export function wikiHost(articleUrl) {
    try {
        return new URL(articleUrl).host || null;
    } catch {
        return null;
    }
}

// The logged article_url is whatever was in the address bar — a /wiki/ link,
// or an index.php URL with action=edit — and article_title is the display
// title, which drops the namespace ("Coliemore Harbour" for
// Draft:Coliemore_Harbour). So the page title has to come from the URL.
export function pageTitleFromUrl(articleUrl) {
    let url;
    try {
        url = new URL(articleUrl);
    } catch {
        return null;
    }
    if (url.pathname.startsWith('/wiki/')) {
        try {
            return decodeURIComponent(url.pathname.slice('/wiki/'.length)) || null;
        } catch {
            return null;
        }
    }
    return url.searchParams.get('title') || null;
}

// A permalink to the revision the check read, in dataset.json's shape
// (index.php?title=…&oldid=…). Without a revision id (rows logged before
// revision_id existed) the logged URL is the best there is.
export function pinnedArticleUrl(articleUrl, revisionId) {
    const host = wikiHost(articleUrl);
    const rev = Number(revisionId);
    if (!host || !Number.isSafeInteger(rev) || rev <= 0) return articleUrl ?? null;
    const title = pageTitleFromUrl(articleUrl);
    const titleParam = title ? `title=${encodeURIComponent(title.replace(/ /g, '_'))}&` : '';
    return `https://${host}/w/index.php?${titleParam}oldid=${rev}`;
}

/**
 * What the editor's feedback says the verdict should have been.
 *
 *   - A corrected verdict is the editor's own answer.
 *   - A thumbs-up with no correction endorses the tool's verdict.
 *   - A thumbs-down with no correction says only "not that": verdict is null.
 *
 * `inconsistent` marks feedback that contradicts itself — a thumbs-down whose
 * correction is the verdict the tool already gave, or a thumbs-up followed by
 * a different verdict. Those go to the owner rather than into a label.
 */
export function editorVerdict({ rating, correctedVerdict, toolVerdict }) {
    const corrected = canonicalizeVerdict(correctedVerdict);
    const tool = canonicalizeVerdict(toolVerdict);
    if (corrected) {
        const inconsistent = (rating === -1 && corrected === tool) || (rating === 1 && corrected !== tool);
        return { verdict: corrected, disagrees: corrected !== tool, inconsistent };
    }
    if (rating === 1) return { verdict: tool, disagrees: false, inconsistent: false };
    if (rating === -1) return { verdict: null, disagrees: true, inconsistent: false };
    return { verdict: null, disagrees: false, inconsistent: false };
}

function numberOrNull(value) {
    if (value == null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

/** One exported row (cases.sql's column names) -> a case. */
export function normalizeCase(row) {
    const rating = numberOrNull(row.rating);
    const toolVerdict = canonicalizeVerdict(row.verdict);
    const gapSeconds = numberOrNull(row.rating_gap_s);
    const checksOnArticle = numberOrNull(row.rater_checks_on_article);

    return {
        checkId: row.check_id,
        rating,
        correctedVerdict: canonicalizeVerdict(row.corrected_verdict),
        editor: editorVerdict({ rating, correctedVerdict: row.corrected_verdict, toolVerdict: row.verdict }),
        wikiSection: row.wiki_section ?? null,
        firstFeedbackAt: row.first_feedback_at ?? null,
        feedbackAt: row.last_feedback_at ?? null,
        feedbackRows: numberOrNull(row.feedback_rows),
        raters: numberOrNull(row.raters),
        rater: {
            gapSeconds,
            checksOnArticle,
            checksTotal: numberOrNull(row.rater_checks_total),
            quick: gapSeconds != null && gapSeconds < QUICK_RATING_SECONDS,
            heavySession: checksOnArticle != null && checksOnArticle >= HEAVY_SESSION_CHECKS,
        },
        check: {
            checkedAt: row.checked_at ?? null,
            kind: row.kind || 'source',
            wiki: wikiHost(row.article_url),
            articleUrl: pinnedArticleUrl(row.article_url, row.revision_id),
            articleTitle: row.article_title ?? null,
            revisionId: numberOrNull(row.revision_id),
            citationNumber: row.citation_number == null ? null : String(row.citation_number),
            sourceUrl: row.source_url || null,
            provider: row.provider ?? null,
            model: row.model ?? null,
            // Canonical, or null for PARSE_ERROR and other non-verdicts.
            verdict: toolVerdict,
            rawVerdict: row.verdict ?? null,
            supportScore: numberOrNull(row.confidence),
            reasonType: row.reason_type || null,
            claimText: row.claim_text || '',
            comments: row.llm_comments || '',
            sourceQuote: row.source_quote || '',
            quoteStatus: row.quote_status || null,
        },
    };
}

// Why a case is not sent to the adjudicator. Every skipped case is still
// listed in the triage report, so nothing disappears silently.
export const SKIP_REASONS = Object.freeze({
    ALREADY_TRIAGED: 'already_triaged',
    GROUP: 'group',           // collective verdict over several sources; not yet supported
    NO_SOURCE_URL: 'no_source_url',
    NO_VERDICT: 'no_verdict', // PARSE_ERROR and the like: nothing to agree or disagree with
    NO_CLAIM: 'no_claim',
    NO_FEEDBACK: 'no_feedback',
});

function skipReason(c, existing) {
    if (existing.has(c.checkId)) return SKIP_REASONS.ALREADY_TRIAGED;
    if (c.rating == null && !c.correctedVerdict) return SKIP_REASONS.NO_FEEDBACK;
    if (c.check.kind === 'group') return SKIP_REASONS.GROUP;
    if (!c.check.verdict) return SKIP_REASONS.NO_VERDICT;
    if (!c.check.claimText.trim()) return SKIP_REASONS.NO_CLAIM;
    if (!c.check.sourceUrl) return SKIP_REASONS.NO_SOURCE_URL;
    return null;
}

/**
 * Splits cases into those to triage now and those skipped, with a reason.
 *
 * Disputed cases (a thumbs-down or a correction) come first, then endorsed
 * ones, newest feedback first within each — so a --limit spends the budget on
 * the cases most likely to reveal a failure. Endorsed cases are triaged too:
 * the field set needs verdicts the tool got right, or a fix for false alarms
 * could pass it by approving everything.
 *
 * @param {object[]} cases - normalizeCase() output
 * @param {Iterable<string>} triagedCheckIds - check ids already in the field set
 */
export function selectForTriage(cases, triagedCheckIds = [], { limit = Infinity, retriage = false } = {}) {
    const existing = new Set(retriage ? [] : triagedCheckIds);
    const toTriage = [];
    const skipped = [];
    for (const c of cases) {
        const reason = skipReason(c, existing);
        if (reason) skipped.push({ case: c, reason });
        else toTriage.push(c);
    }
    const disputed = c => (c.rating === -1 || c.editor.disagrees ? 0 : 1);
    toTriage.sort((a, b) => disputed(a) - disputed(b)
        || String(b.feedbackAt).localeCompare(String(a.feedbackAt))
        || String(a.checkId).localeCompare(String(b.checkId)));
    return { toTriage: toTriage.slice(0, limit), deferred: toTriage.slice(limit), skipped };
}
