// Stable identity for stored findings, per
// docs/design-plans/2026-08-07-batch-source-checks-for-edit-suggestions.md §2.
//
// Node-only, and deliberately NOT listed in scripts/sync-main.js's
// CORE_ORDER: this uses node:crypto, which has no browser equivalent, and the
// live userscript never persists a finding across page loads the way the
// batch runner does — it has no use for a stable hash in the first place.
//
// A citation number is a rendering artifact of one revision — insert a
// reference above it and every number below shifts. A finding written today
// and read next week needs an anchor that survives renumbering, section
// moves, and re-fetching the same source two different ways (a live URL vs.
// its Wayback fallback), while still going stale the moment the claim itself
// is edited, which is the correct behavior.
//
// Both halves of that anchor are hashes of *what was cited*, never of
// fetched content: content varies fetch to fetch (dynamic page elements,
// extraction-library drift, truncation) in ways that would make a
// content-based identity produce spurious duplicates or spurious mismatches.
// See the design doc's §6 note on why source_url_hash replaced an earlier,
// rejected content_hash design.
//
// This module is the single place both the write path (this session) and the
// future read-time resolution path (§2's "locate the claim in the current
// article, or drop the finding") must agree on — so nothing here should be
// duplicated rather than imported.

import { createHash } from 'node:crypto';

// Normalizes claim text before hashing. extractClaimText() (core/claim.js)
// already collapses whitespace and strips maintenance markers, so this is a
// safety net for callers that didn't go through that path, plus Unicode
// normalization: two extractions of the same prose can carry different
// combining-character sequences for the same visible text (e.g. across
// different HTML sources for the same claim), which would otherwise hash to
// different values for text a reader can't tell apart.
export function normalizeClaim(text) {
    if (!text) return '';
    return text.normalize('NFC').replace(/\s+/g, ' ').trim();
}

// Normalizes a cited URL before hashing. Deliberately minimal — no scheme
// unification, no trailing-slash stripping, no query-param reordering. Claim
// normalization can safely collapse whitespace because prose whitespace
// carries no meaning; a URL's exact bytes can (a trailing slash or a query
// param may point at a genuinely different resource), so "aggressive
// normalization" here trades a real risk of silently merging two different
// sources for a marginal dedup gain. See the same content_hash-brittleness
// lesson this module's header describes, applied conservatively rather than
// re-triggered on URLs.
export function normalizeSourceUrl(url) {
    if (!url) return '';
    return url.trim();
}

function sha256(text) {
    return createHash('sha256').update(text, 'utf8').digest();
}

// Returns a 32-byte Buffer, matching the schema's BINARY(32) claim_hash /
// source_url_hash columns directly — no hex round-trip.
export function claimHash(claimText) {
    return sha256(normalizeClaim(claimText));
}

// The identity a live fetch and its Wayback fallback share: core/worker.js's
// fetchSourceContent() resolves the Wayback substitution internally, so every
// caller-visible citation.url is always the originally cited URL, never a
// Wayback raw-endpoint URL — this hash needs no special-casing for that case,
// it falls out of which URL reaches this function.
export function sourceUrlHash(url) {
    return sha256(normalizeSourceUrl(url));
}
