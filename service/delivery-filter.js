// Which flagged findings are delivered as suggestions, on top of the clean
// CSV's rules (service/csv-report.js's createCleanRules()).
//
// The clean CSV drops findings the pipeline can't stand behind (truncated
// sources, group members superseded by a collective verdict, groups with an
// unread source). This decides how much of what remains goes to editors, as
// a named tier, because how much to show is a choice rather than a
// correctness rule: on the November 2026 ruwiki rerun the clean CSV still
// held 22,495 flags, ~13 per article, and the omission class in particular
// is where the model is pedantic ("Pakistan, not Islamabad").
//
// scripts/review-sweep.js reports the count every tier leaves, using these
// same predicates, so the numbers a delivery decision is made on are the
// numbers the delivery file then contains.

import { isTableLikeClaim, THRESHOLDS } from './sweep-checks.js';
import { hostOf } from './host-pool.js';

const FLAGGED = new Set(['NOT SUPPORTED', 'PARTIALLY SUPPORTED']);
const VERIFIED_QUOTE = new Set(['exact', 'normalized', 'partial']);

// Hosts whose pages reach the model as a JavaScript shell, viewer, login or
// cookie wall, so "not mentioned" there means "not fetched". From the
// November 2026 ruwiki rerun, where each was flagged on 80-100% of judged
// citations. Matched as a suffix, so youtube.com covers www.youtube.com.
export const DEFAULT_EXCLUDED_HOSTS = Object.freeze([
    'atpworldtour.com', 'elib.biblioatom.ru', 'cia.gov', 'publication.pravo.gov.ru', 'inside.fifa.com',
    'rutube.ru', 'youtube.com', 'youtu.be', 'yandex.ru', 'tvguide.com', 'vk.com', 'google.com', 'imdb.com',
    'uefa.com', 'sportsecyclopedia.com', 'bloomberg.com', 'worldcat.org', 't.me', 'irbis-nbuv.gov.ua',
]);

export function hostExcluded(host, excluded = DEFAULT_EXCLUDED_HOSTS) {
    const h = (host ?? '').toLowerCase();
    return excluded.some(e => h === e || h.endsWith(`.${e}`));
}

/**
 * Why a row is not a deliverable flag at all, or null if it is one:
 * 'not-flagged', 'problem-host' or 'table-cell'. Judged per row: excluding
 * whole "table-like" articles dropped prose articles (Якутия, Владимир)
 * whose clean rows happened to be mostly figures.
 */
export function exclusionReason(row, { excludedHosts = DEFAULT_EXCLUDED_HOSTS } = {}) {
    if (!FLAGGED.has(row.verdict)) return 'not-flagged';
    if (row.source_url && hostExcluded(hostOf(row.source_url), excludedHosts)) return 'problem-host';
    if (isTableLikeClaim(row.claim_text, THRESHOLDS.tableLikeLetterShare)) return 'table-cell';
    return null;
}

// Cumulative: each tier keeps a subset of the one before. Index 0 is every
// flagged row, before the host and table-cell exclusions.
export const DELIVERY_TIERS = Object.freeze([
    { name: 'all-flagged', label: 'Every NOT / PARTIALLY SUPPORTED row', keep: () => true },
    { name: 'flagged', label: 'minus problem hosts and table-cell claims', keep: () => true },
    { name: 'not-supported', label: '…NOT SUPPORTED only', keep: r => r.verdict === 'NOT SUPPORTED' },
    { name: 'contradiction', label: '…contradiction only (the source says something else)', keep: r => r.reason_type === 'contradiction' },
    { name: 'verified-contradiction', label: '…with the contradicting passage verified in the source', keep: r => VERIFIED_QUOTE.has(r.quote_status) },
]);

export const DELIVERY_TIER_NAMES = DELIVERY_TIERS.slice(1).map(t => t.name);

/**
 * The deepest tier index a row reaches: -1 when it is not flagged at all,
 * 0 when flagged but excluded (problem host / table cell), and so on.
 */
export function tierReached(row, options) {
    if (!FLAGGED.has(row.verdict)) return -1;
    if (exclusionReason(row, options)) return 0;
    let reached = 1;
    for (let i = 2; i < DELIVERY_TIERS.length; i++) {
        if (!DELIVERY_TIERS[i].keep(row)) break;
        reached = i;
    }
    return reached;
}

/** A predicate keeping rows that reach the named tier. Throws on an unknown name. */
export function deliveryPredicate(tierName, options) {
    const index = DELIVERY_TIERS.findIndex(t => t.name === tierName);
    if (index < 1) throw new Error(`unknown delivery tier "${tierName}"; one of: ${DELIVERY_TIER_NAMES.join(', ')}`);
    return row => tierReached(row, options) >= index;
}
