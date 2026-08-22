// Maps one service/pipeline.js article result into the finding row(s) it
// implies, ready for service/findings.js's buildUpsertQuery(). Pure — no I/O,
// no database — except for the injected verification seams, which are the
// only thing this module doesn't own. See
// docs/design-plans/2026-08-21-findings-write-path-wiring.md for the design.
//
// Two things this module refuses to do, on purpose (§2d of that doc):
//
//   - Store a finding for a source we were REFUSED (HTTP 403/429). A refusal
//     is not the same fact as "the source is gone" and storing it as
//     SOURCE UNAVAILABLE would silently corrupt the corpus the moment a
//     publisher block lifts — the exact hazard the parent design doc's §5
//     names explicitly.
//   - Store a finding when source fetching was never attempted at all (the
//     stage-3 stub in service/extract-articles.js, or any caller running
//     with `sourceFetchEnabled: false`). Its placeholder error string is not
//     a verification outcome.
//
// Both cases come back in `skipped[]` with a reason code instead of a row, so
// a caller can report what was skipped and why.

import { groupSourceUrlHash } from '../core/anchor.js';
import { PROMPT_VERSION } from '../core/prompts.js';

export const SKIP_REASONS = Object.freeze({
    BLOCKED_FETCH: 'blocked_fetch',
    STUB_SOURCE_FETCH: 'stub_source_fetch',
});

// `provider` is part of citation_findings' unique key
// (wiki, page_id, claim_hash, source_url_hash, provider, prompt_version).
// MariaDB's unique index treats NULL as never equal to NULL — including to
// itself — so a NULL in ANY unique-key column silently defeats
// ON DUPLICATE KEY UPDATE: two rows identical in every other respect both
// insert instead of the second updating the first. Confirmed the hard way
// against real ToolsDB on 2026-08-22: every SOURCE UNAVAILABLE finding
// (provider left null, since no LLM was called) duplicated on every re-run.
// core/anchor.js's sourceUrlHash(null) already avoids this exact trap for
// source_url_hash; this sentinel gives provider the same guarantee. Never
// write `null` into finding.provider — use this instead.
export const NO_PROVIDER = 'none';

// How long a stored finding stays valid before a re-crawl should supersede
// it — see §2e. Exported so a caller adjusting the policy doesn't have to
// find a number buried in a template string.
export const TTL_MS = Object.freeze({
    FETCHED: 30 * 24 * 60 * 60 * 1000,      // verdict computed from a live fetch: the source could change under us
    UNAVAILABLE: 3 * 24 * 60 * 60 * 1000,   // a transient fetch failure should be retried soon
    // No-URL findings get expiresAt: null — see expiresAtFor().
});

// citation_number is INT in the schema ("display only; NOT an identifier"),
// but core/citations.js's collectCitations() produces a string
// (refElement.textContent, minus brackets) — '1', or '1, 2' for a named ref
// cited from two places. Anything that isn't a bare leading integer becomes
// null rather than corrupting/truncating into the column.
export function toCitationNumber(raw) {
    if (raw == null) return null;
    const match = String(raw).match(/^\s*(\d+)\s*$/);
    return match ? Number(match[1]) : null;
}

// The collective row's display number: the lowest member number, but only
// when every member actually parses as one — a partial answer (e.g. "at
// least [3]" when [4] is a roman numeral) would misrepresent the group as
// smaller than it is.
function groupCitationNumber(members) {
    const numbers = members.map(m => toCitationNumber(m.citationNumber));
    if (numbers.some(n => n === null)) return null;
    return Math.min(...numbers);
}

const SOURCE_CLASS = Object.freeze({
    NO_URL: 'no_url',           // never fetched — no citation URL exists
    STUB: 'stub',                // never attempted — sourceFetchEnabled is false
    AVAILABLE: 'available',     // fetched, has content — feed to the verifier
    BLOCKED: 'blocked',          // fetched, refused (403/429) — skip, don't store
    UNAVAILABLE: 'unavailable', // fetched, failed for another reason — real SOURCE UNAVAILABLE
});

function classify(citation, { sourceFetchEnabled }) {
    if (!citation.url) return SOURCE_CLASS.NO_URL;
    if (!sourceFetchEnabled) return SOURCE_CLASS.STUB;
    const source = citation.source || {};
    if (source.content) return SOURCE_CLASS.AVAILABLE;
    if (source.status === 403 || source.status === 429) return SOURCE_CLASS.BLOCKED;
    return SOURCE_CLASS.UNAVAILABLE;
}

function unavailableRationale(citation) {
    const source = citation.source || {};
    if (!citation.url) return 'No URL found in reference';
    const statusPart = source.status != null ? `HTTP ${source.status}` : null;
    const reasonPart = source.error || 'Could not fetch source content';
    return statusPart ? `${statusPart}: ${reasonPart}` : reasonPart;
}

function expiresAtFor(kind, now) {
    if (kind === 'no_url') return null;
    const ttl = kind === 'fetched' ? TTL_MS.FETCHED : TTL_MS.UNAVAILABLE;
    return new Date(now.getTime() + ttl);
}

const baseRecord = (article, { wiki, now }) => ({
    wiki,
    pageId: article.pageId,
    pageTitle: article.title,
    revisionId: article.revisionId,
    provider: NO_PROVIDER,
    model: null,
    promptVersion: PROMPT_VERSION,
    fetchStatus: null,
    sourceTruncated: false,
    tokensIn: null,
    tokensOut: null,
    published: false,
    // ref_name would be <ref name="..."> when present — nothing in core/
    // extracts it today (collectCitations() surfaces the cite_note fragment
    // id, not the ref name attribute), so this is an honest null, not a
    // fabricated value, until that extraction exists.
    refName: null,
    fetchedAt: null,
    groupId: null,
    isCollective: false,
    citationNumber: null,
    sourceUrl: null,
});

async function perSourceRecord(citation, article, ctx, groupIdHex) {
    const { wiki, now, verifyCitation, sourceFetchEnabled } = ctx;
    const record = {
        ...baseRecord(article, { wiki, now }),
        claimText: citation.claimText,
        citationNumber: toCitationNumber(citation.citationNumber),
        sourceUrl: citation.url,
        groupId: groupIdHex,
    };

    const cls = classify(citation, { sourceFetchEnabled });

    if (cls === SOURCE_CLASS.BLOCKED) {
        return { skip: { citationNumber: citation.citationNumber, url: citation.url, groupId: groupIdHex, isCollective: false, reason: SKIP_REASONS.BLOCKED_FETCH } };
    }
    if (cls === SOURCE_CLASS.STUB) {
        return { skip: { citationNumber: citation.citationNumber, url: citation.url, groupId: groupIdHex, isCollective: false, reason: SKIP_REASONS.STUB_SOURCE_FETCH } };
    }

    if (cls === SOURCE_CLASS.NO_URL || cls === SOURCE_CLASS.UNAVAILABLE) {
        return {
            record: {
                ...record,
                verdict: 'SOURCE UNAVAILABLE',
                confidence: null,
                reasonType: null,
                rationale: unavailableRationale(citation),
                fetchStatus: citation.source?.status ?? null,
                expiresAt: expiresAtFor(cls === SOURCE_CLASS.NO_URL ? 'no_url' : 'unavailable', now),
            },
        };
    }

    // AVAILABLE: the only class that calls the injected verifier.
    const verdict = await verifyCitation(citation.claimText, citation.source, {
        pageId: article.pageId,
        title: article.title,
        revisionId: article.revisionId,
        citationNumber: citation.citationNumber,
    });

    return {
        record: {
            ...record,
            verdict: verdict.verdict,
            confidence: verdict.confidence ?? null,
            reasonType: verdict.reasonType ?? null,
            rationale: verdict.rationale ?? null,
            provider: verdict.provider ?? NO_PROVIDER,
            model: verdict.model ?? null,
            tokensIn: verdict.tokensIn ?? null,
            tokensOut: verdict.tokensOut ?? null,
            sourceTruncated: verdict.sourceTruncated ?? false,
            fetchStatus: citation.source?.status ?? null,
            fetchedAt: now,
            expiresAt: expiresAtFor('fetched', now),
        },
    };
}

async function collectiveRecord(members, article, ctx) {
    const { wiki, now, verifyGroup, sourceFetchEnabled } = ctx;
    const classified = members.map(m => ({ citation: m, cls: classify(m, { sourceFetchEnabled }) }));

    const urls = members.map(m => m.url).filter(Boolean);
    const groupHash = groupSourceUrlHash(urls);
    const groupIdHex = groupHash.toString('hex');

    const record = {
        ...baseRecord(article, { wiki, now }),
        claimText: members[0].claimText,
        citationNumber: groupCitationNumber(members),
        // sourceUrl is a denormalized, human-readable join for display only
        // (matches page_title's own "denormalized for display" comment).
        // sourceUrls (the raw list) is what buildUpsertQuery() actually
        // hashes for source_url_hash — see its comment. Both are derived
        // from the same `urls` array as groupId (below), so the three stay
        // consistent by construction rather than by convention.
        sourceUrl: urls.length ? urls.join('; ') : null,
        sourceUrls: urls,
        groupId: groupIdHex,
        isCollective: true,
    };

    const available = classified.filter(c => c.cls === SOURCE_CLASS.AVAILABLE);
    const genuine = classified.filter(c => c.cls === SOURCE_CLASS.NO_URL || c.cls === SOURCE_CLASS.UNAVAILABLE);
    const allNoUrl = classified.every(c => c.cls === SOURCE_CLASS.NO_URL);

    if (available.length === 0 && genuine.length === 0) {
        // Every member was refused or never attempted — same reasoning as
        // the per-source BLOCKED/STUB skip: we have no honest signal to
        // store, only "we couldn't or didn't check."
        const reason = classified.some(c => c.cls === SOURCE_CLASS.STUB)
            ? SKIP_REASONS.STUB_SOURCE_FETCH
            : SKIP_REASONS.BLOCKED_FETCH;
        return { groupIdHex, skip: { citationNumber: null, url: record.sourceUrl, groupId: groupIdHex, isCollective: true, reason } };
    }

    if (available.length === 0) {
        // At least one member is genuinely unavailable (not just refused) —
        // a real, storable "we checked and couldn't get anything" result.
        return {
            groupIdHex,
            record: {
                ...record,
                verdict: 'SOURCE UNAVAILABLE',
                confidence: null,
                reasonType: null,
                rationale: 'None of the grouped sources could be retrieved.',
                expiresAt: expiresAtFor(allNoUrl ? 'no_url' : 'unavailable', now),
            },
        };
    }

    const entries = members.map(m => ({
        citationNumbers: [m.citationNumber],
        url: m.url,
        content: m.source?.content ?? null,
        status: m.source?.status ?? null,
        error: m.source?.error ?? null,
    }));

    const verdict = await verifyGroup(members[0].claimText, entries, {
        pageId: article.pageId,
        title: article.title,
        revisionId: article.revisionId,
        groupCitationNumbers: members.map(m => m.citationNumber),
    });

    return {
        groupIdHex,
        record: {
            ...record,
            verdict: verdict.verdict,
            confidence: verdict.confidence ?? null,
            reasonType: verdict.reasonType ?? null,
            rationale: verdict.rationale ?? null,
            provider: verdict.provider ?? NO_PROVIDER,
            model: verdict.model ?? null,
            tokensIn: verdict.tokensIn ?? null,
            tokensOut: verdict.tokensOut ?? null,
            sourceTruncated: verdict.sourceTruncated ?? false,
            fetchedAt: now,
            expiresAt: expiresAtFor('fetched', now),
        },
    };
}

/**
 * Maps one processArticle() result (service/pipeline.js) to the finding
 * row(s) it implies.
 *
 * `context`:
 *   - wiki (required) — e.g. 'enwiki'.
 *   - now — Date, injectable for tests. Defaults to `new Date()`.
 *   - verifyCitation(claimText, source, ctx) — async, required whenever any
 *     citation actually has fetched content. Returns
 *     { verdict, confidence, reasonType, rationale, provider, model,
 *       tokensIn, tokensOut, sourceTruncated? }.
 *   - verifyGroup(claimText, entries, ctx) — same return shape, for a
 *     collective (adjacent-group) verdict. `entries` matches
 *     core/prompts.js's assembleGroupSources() input shape.
 *   - sourceFetchEnabled — default true. Set false when the caller used a
 *     stub fetcher (no real attempt was made) for the whole run — every
 *     URL-bearing citation is then skipped as SKIP_REASONS.STUB_SOURCE_FETCH
 *     rather than misreported as SOURCE UNAVAILABLE.
 *
 * Returns { records, skipped }. `records` are ready for
 * service/findings.js's buildUpsertQuery(); `skipped` entries carry a reason
 * code so a caller can report what was intentionally not stored and why.
 */
export async function toFindingRecords(article, context) {
    const { wiki } = context;
    if (!wiki) throw new TypeError('toFindingRecords requires context.wiki');
    const ctx = { now: new Date(), sourceFetchEnabled: true, ...context };

    const records = [];
    const skipped = [];

    if (article.outcome !== 'ok' || !article.citations?.length) {
        return { records, skipped };
    }

    const groups = new Map();
    const solo = [];
    for (const citation of article.citations) {
        if (citation.groupSize && citation.groupSize > 1) {
            if (!groups.has(citation.groupId)) groups.set(citation.groupId, []);
            groups.get(citation.groupId).push(citation);
        } else {
            solo.push(citation);
        }
    }

    for (const citation of solo) {
        const { record, skip } = await perSourceRecord(citation, article, ctx, null);
        if (record) records.push(record);
        if (skip) skipped.push(skip);
    }

    for (const members of groups.values()) {
        const collective = await collectiveRecord(members, article, ctx);
        const groupIdHex = collective.groupIdHex ?? groupSourceUrlHash(members.map(m => m.url).filter(Boolean)).toString('hex');

        for (const member of members) {
            const { record, skip } = await perSourceRecord(member, article, ctx, groupIdHex);
            if (record) records.push(record);
            if (skip) skipped.push(skip);
        }

        if (collective.record) records.push(collective.record);
        if (collective.skip) skipped.push(collective.skip);
    }

    return { records, skipped };
}
