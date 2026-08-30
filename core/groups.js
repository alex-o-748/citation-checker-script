// Adjacent-citation group semantics: when the collective (multi-source)
// verification for a group should fire, how a group's members collapse to
// one entry per distinct source, whether the collective verdict is worth
// running at all, and how a collective verdict merges with per-source
// results into one unit per claim.
//
// Extracted verbatim from main.js's verifyGroupCollective() and
// getReportUnits() so the userscript and the Toolforge batch pipeline
// (service/verifier.js) compute identical group units instead of maintaining
// two implementations that can silently drift — see docs/design-plans/
// 2026-08-22-batch-verification-and-persistence.md §2 and docs/design-plans/
// 2026-08-24-csv-deliverable-and-component-names.md (G4). Pure logic only:
// no DOM, no fetch, no provider call — callers own all of that.

import { extractSourceText } from './prompts.js';

/**
 * True when `citation` is the last member of its adjacent-citation group —
 * the point at which the group's collective verification should fire, once
 * per group rather than once per member. A solo citation (no group, or a
 * group of one) is never "close".
 */
export function isGroupClose(citation) {
    return Boolean(citation && citation.groupSize > 1 && citation.groupIndex === citation.groupSize - 1);
}

/**
 * Dedupes an adjacent-citation group's members down to one entry per
 * distinct source. Two citations backed by the same named `<ref>` (or the
 * same URL at the same page number) collapse into a single entry carrying
 * both citation numbers, so the group prompt (assembleGroupSources()) isn't
 * asked to show the model the same source text twice.
 *
 * `sourceFor(member)` resolves one member to its source; callers own *how*,
 * because that differs by caller: the userscript looks a member up in its
 * `url|page=N`-keyed sourceCache, while the batch pipeline already carries
 * each citation's resolved `source` object directly
 * (service/claim-extractor.js's processArticle output). It must return
 * `{ key, url, content, error, status }` — `key` is the dedup key; the rest
 * become the entry's fields the first time that key is seen.
 *
 * @param {Array<object>} members - Group members, sharing one groupId.
 * @param {(member: object) => {key: string, url?: string|null, content?: string|null, error?: string|null, status?: number|null}} sourceFor
 * @returns {Array<{citationNumbers: (string|number)[], url: string|null, content: string|null, error: string|null, status: number|null}>}
 */
export function groupSourceEntries(members, sourceFor) {
    const byKey = new Map();
    for (const member of members) {
        const { key, url, content, error, status } = sourceFor(member);
        let entry = byKey.get(key);
        if (!entry) {
            entry = {
                citationNumbers: [],
                url: url || null,
                content: content ?? null,
                error: error ?? null,
                status: status ?? null,
            };
            byKey.set(key, entry);
        }
        entry.citationNumbers.push(member.citationNumber);
    }
    return Array.from(byKey.values());
}

/**
 * Whether the collective (multi-source) verdict should be skipped in favor
 * of the group's existing per-source results. True when at most one member
 * source has usable text — with ≤1 available source, a collective verdict
 * would just restate the solo one, so running it would burn a model call to
 * say nothing new.
 *
 * @param {ReturnType<typeof groupSourceEntries>} entries
 */
export function shouldSkipCollective(entries) {
    const availableCount = entries.filter(e => e.content && extractSourceText(e.content).trim()).length;
    return availableCount <= 1;
}

/**
 * Merges per-source results and collective group verdicts into one entry per
 * claim, in the order `results` presents them: a solo citation passes
 * through unchanged; an adjacent group collapses to its collective verdict.
 * A group whose collective check was skipped (§ shouldSkipCollective) falls
 * back to its per-source member results instead. A group whose collective
 * check hasn't completed yet (`groupResults` has no entry for it) is omitted
 * entirely — a result page that hasn't finished a group shouldn't report a
 * partial or wrong verdict for it.
 *
 * Drives the summary counts and the wikitext/plaintext exporters — this is
 * the merge that decides which row means "for a group, the collective
 * verdict is the one to publish" (docs/design-plans/
 * 2026-08-07-batch-source-checks-for-edit-suggestions.md §6).
 *
 * @param {Array<object>} results - Per-source results, one per citation.
 * @param {Map<string, object>} groupResults - Collective verdicts (or
 *   `{ skipped: true, groupId }` placeholders), keyed by groupId.
 */
export function mergeReportUnits(results, groupResults) {
    const units = [];
    const seenGroups = new Set();
    for (const r of results) {
        if (r.groupSize && r.groupSize > 1) {
            if (seenGroups.has(r.groupId)) continue;
            seenGroups.add(r.groupId);
            const collective = groupResults.get(r.groupId);
            if (collective && !collective.skipped) {
                units.push(collective);
            } else if (collective && collective.skipped) {
                for (const x of results) {
                    if (x.groupId === r.groupId) units.push(x);
                }
            }
        } else {
            units.push(r);
        }
    }
    return units;
}
