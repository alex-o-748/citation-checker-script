// Severity pass: for a claim the verifier already flagged, how much does the
// failure matter?
//
// A second, separate model call — the verdict prompt in core/prompts.js is
// tuned against the benchmark and stays untouched. The model splits the claim
// into subclaims and labels each one: what the source does with it
// (supported / absent / contradicted), and whether it is central to the
// sentence. tierFor() turns that, plus whether the source was truncated, into
// a tier. The model is never asked for a number or for a severity directly:
// categories calibrate far better than scores, and a tier computed from
// observable labels can be explained to a volunteer ("a central fact is
// contradicted") where a model's 0.73 cannot.
//
// Rationale and the alternatives rejected:
// docs/design-plans/2026-09-24-severity-ranking-for-flagged-claims.md.
//
// Not in scripts/sync-main.js's CORE_ORDER: batch pipeline only, for now.

import { extractSourceText } from './prompts.js';

// Bump whenever the prompt text changes, same contract as PROMPT_VERSION:
// tests/severity.test.js pins a hash of the prompt against it.
export const SEVERITY_PROMPT_VERSION = 's1';

export const SUBCLAIM_STATUSES = Object.freeze({
    SUPPORTED: 'supported',
    ABSENT: 'absent',
    CONTRADICTED: 'contradicted',
});
const STATUS_VALUES = new Set(Object.values(SUBCLAIM_STATUSES));

// Most urgent first. Strings rather than 1/2/3 so a CSV cell reads on its own.
export const SEVERITY_TIERS = Object.freeze({
    // A central subclaim is contradicted by the source.
    CENTRAL_CONTRADICTED: 'T1',
    // A central subclaim is absent from a source read in full, or a
    // peripheral one is contradicted.
    CENTRAL_ABSENT: 'T2',
    // Only peripheral subclaims are absent — the "minor detail" case.
    PERIPHERAL_ABSENT: 'T3',
    // Only absences, and the source was cut off at a fetch cap: the missing
    // text may simply be past the cutoff.
    DISCOUNTED: 'discounted',
    // The second pass found every subclaim supported, contradicting the
    // first pass's flag. The likeliest false positives.
    DISAGREEMENT: 'disagreement',
});
export const SEVERITY_TIER_ORDER = Object.freeze([
    SEVERITY_TIERS.CENTRAL_CONTRADICTED,
    SEVERITY_TIERS.CENTRAL_ABSENT,
    SEVERITY_TIERS.PERIPHERAL_ABSENT,
    SEVERITY_TIERS.DISCOUNTED,
    SEVERITY_TIERS.DISAGREEMENT,
]);

export function generateSeveritySystemPrompt() {
    return `You help Wikipedia volunteers decide which citation problems to fix first. You are given a claim from a Wikipedia article, the text of the source cited for it, and where the claim sits in the article.

Split the claim into subclaims, then label each one.

Subclaims:
- A subclaim is one separate factual assertion: who, what, when, where, how many, what kind. Most claims have one to four.
- Use the claim's own wording, in the claim's language. Do not add anything the claim does not say.
- Do not split off words that assert nothing checkable.

For each subclaim, "status":
- "supported": the source states it, or it follows directly from what the source states.
- "absent": the source does not address it.
- "contradicted": the source states something incompatible with it.
Decide status ONLY from the source text. Never use outside knowledge. Never use the article context as evidence: other sentences in the paragraph have their own citations.

For each subclaim, "central":
- true if it is the point of the sentence: changing or removing it would change what the sentence tells the reader.
- false if it is a peripheral detail: a qualifier, a secondary date, an incidental descriptor, a middle name.
- Use the article title, section and paragraph to judge this. Every claim has at least one central subclaim.

Respond with JSON only:
{"subclaims": [{"text": "<subclaim>", "status": "supported|absent|contradicted", "central": true|false}]}

Example:
Article: Riverside Bridge
Section: History
Claim: "The bridge, designed by engineer Anna Holt, opened in 1998."
Source says it opened in August 2002 and names Holt as its designer, with no mention of her profession.
{"subclaims": [{"text": "The bridge opened in 1998", "status": "contradicted", "central": true}, {"text": "The bridge was designed by Anna Holt", "status": "supported", "central": true}, {"text": "Anna Holt is an engineer", "status": "absent", "central": false}]}`;
}

/**
 * @param {object} args
 * @param {string} args.claimText
 * @param {string} args.sourceInfo - Source content as fetched (the same string
 *   the verdict call was given); extractSourceText() strips the fetch header.
 * @param {string} [args.articleTitle]
 * @param {string|null} [args.sectionTitle] - null means the lead.
 * @param {string|null} [args.paragraphText]
 *
 * The first-pass verdict is deliberately NOT passed. Shown a flag, the model
 * tends to find a failure to agree with it, and then the "disagreement" tier
 * — the second pass finding nothing wrong — stops meaning anything.
 */
export function generateSeverityUserPrompt({ claimText, sourceInfo, articleTitle, sectionTitle, paragraphText }) {
    const lines = [];
    if (articleTitle) lines.push(`Article: ${articleTitle}`);
    lines.push(`Section: ${sectionTitle || '(lead section)'}`);
    if (paragraphText) lines.push(`Paragraph (context only, not evidence): ${paragraphText}`);
    lines.push('', `Claim: "${claimText}"`, '', 'Source text:', extractSourceText(sourceInfo || ''));
    return lines.join('\n');
}

function extractJson(text) {
    const trimmed = (text || '').trim();
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (fenced) return fenced[1].trim();
    // Some models answer with the bare subclaim array. Checked before the
    // brace match, which would otherwise grab just the first element.
    if (trimmed.startsWith('[')) return trimmed;
    const braces = trimmed.match(/\{[\s\S]*\}/);
    return braces ? braces[0] : trimmed;
}

/**
 * Parses the severity response. Returns { ok: true, subclaims } or
 * { ok: false, error }.
 *
 * Strict about status (an unknown status can't be tiered, and guessing one
 * would silently move a finding between tiers) and lenient about the rest:
 * a subclaim with no usable `central` is treated as central, which can only
 * rank a finding higher, never bury it.
 */
export function parseSeverityResult(text) {
    let parsed;
    try {
        parsed = JSON.parse(extractJson(text));
    } catch {
        return { ok: false, error: 'parse_error' };
    }
    const raw = Array.isArray(parsed) ? parsed : parsed?.subclaims;
    if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: 'no_subclaims' };

    const subclaims = [];
    for (const item of raw) {
        const status = String(item?.status ?? '').trim().toLowerCase();
        if (!STATUS_VALUES.has(status)) return { ok: false, error: 'bad_status' };
        subclaims.push({
            text: String(item?.text ?? '').trim(),
            status,
            central: item?.central === false || item?.central === 'false' ? false : true,
        });
    }
    return { ok: true, subclaims };
}

/**
 * The tier for a flagged finding.
 *
 * Truncation discounts absence only. A contradiction survives it — the
 * conflicting passage is in the part that was read — but "the source doesn't
 * mention it" means nothing when most of the source was never seen: truncated
 * rows falsely report failure on 18.4% of benchmark calls
 * (docs/benchmark-ground-truth-audit-2026-09-06.md).
 *
 * BLP is not a tier input; it orders findings within a tier (compareSeverity).
 */
export function tierFor({ subclaims, sourceTruncated = false }) {
    const failing = subclaims.filter(s => s.status !== SUBCLAIM_STATUSES.SUPPORTED);
    if (failing.length === 0) return SEVERITY_TIERS.DISAGREEMENT;

    const has = (status, central) => failing.some(s => s.status === status && s.central === central);
    const { CONTRADICTED, ABSENT } = SUBCLAIM_STATUSES;

    if (has(CONTRADICTED, true)) return SEVERITY_TIERS.CENTRAL_CONTRADICTED;
    if (has(CONTRADICTED, false)) return SEVERITY_TIERS.CENTRAL_ABSENT;
    if (sourceTruncated) return SEVERITY_TIERS.DISCOUNTED;
    if (has(ABSENT, true)) return SEVERITY_TIERS.CENTRAL_ABSENT;
    return SEVERITY_TIERS.PERIPHERAL_ABSENT;
}

/**
 * Sort comparator over findings: tier, then BLP first, then lower first-pass
 * support score first. Findings with no tier (not flagged, or the pass
 * failed) sort last.
 */
export function compareSeverity(a, b) {
    const rank = f => {
        const i = SEVERITY_TIER_ORDER.indexOf(f.severityTier);
        return i === -1 ? SEVERITY_TIER_ORDER.length : i;
    };
    return (rank(a) - rank(b))
        || ((b.isBlp === true) - (a.isBlp === true))
        || ((a.supportScore ?? 101) - (b.supportScore ?? 101));
}
