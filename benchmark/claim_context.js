// Builds the article context for a benchmark row, for the claim-context
// experiment (docs/design-plans/2026-10-12-claim-context.md).
//
// Production will build context from the article DOM, where the claim's
// position is known exactly. A dataset row only has strings: `claim_text`, the
// `claim_container` it was extracted from, the article title, and (on WiCE)
// the section and the fetched page's title. So this recovers "the text before
// the claim" by finding the claim inside its container, and gives up rather
// than guesses when it can't.

// What a context can carry, in the order the runner reports them. Matches the
// fields formatClaimContext() in core/prompts.js renders.
export const CONTEXT_FIELDS = ['title', 'section', 'preceding', 'citation'];

// Enough for two or three sentences: what pronoun and "that evening"
// resolution needs. More starts to read as a second claim to verify.
export const MAX_PRECEDING_CHARS = 1200;

// Footnote markers and inline maintenance tags in the stored container text
// ("[4]", "[a]", "[note 2]", "[citation needed]"). They carry no meaning for
// the model and break the substring match against claim_text.
const BRACKET_TAG = /\[(?:\d+|[a-z]|note \d+|citation needed|clarification needed|when\?|who\?|according to whom\?|failed verification|dubious[^\]]*|better source needed)\]/gi;

function clean(text) {
    return String(text || '').replace(BRACKET_TAG, '').replace(/\s+/g, ' ').trim();
}

/**
 * Parses `--context` into a list of fields. `none` (or nothing) is [].
 * Throws on an unknown field rather than silently running without it.
 */
export function parseContextFields(arg) {
    if (!arg || arg === 'none') return [];
    const fields = arg.split(',').map(s => s.trim()).filter(Boolean);
    for (const f of fields) {
        if (!CONTEXT_FIELDS.includes(f)) {
            throw new Error(`Unknown --context field "${f}": expected none or a comma-separated subset of ${CONTEXT_FIELDS.join(',')}`);
        }
    }
    return CONTEXT_FIELDS.filter(f => fields.includes(f));
}

/**
 * The container text before the claim, trimmed to the last `maxChars`
 * characters (cut at a sentence start where possible, else a word), or null
 * when the claim can't be found in the container.
 *
 * Null rather than a fallback: a context that doesn't actually precede the
 * claim is worse than none, since it can hand the model a wrong referent.
 */
export function precedingTextFromContainer(claim, container, { maxChars = MAX_PRECEDING_CHARS } = {}) {
    const c = clean(container);
    const k = clean(claim);
    if (!c || !k) return null;

    let idx = c.indexOf(k);
    if (idx === -1) {
        // The stored claim can differ from the container at its far end
        // (a trailing quote mark, a stripped template). Its first 40 chars
        // are still a reliable anchor; anything shorter matches by accident.
        const head = k.slice(0, 40);
        if (head.length < 40) return null;
        idx = c.indexOf(head);
        if (idx === -1 || c.indexOf(head, idx + 1) !== -1) return null;
    }

    let before = c.slice(0, idx).trim();
    if (!before) return null;
    if (before.length > maxChars) {
        const tail = before.slice(before.length - maxChars);
        const sentence = tail.search(/[.!?…]["'”’)]?\s+\S/);
        const word = tail.indexOf(' ');
        const cut = sentence !== -1 ? tail.indexOf(' ', sentence) + 1 : word + 1;
        before = `…${tail.slice(cut).trim()}`;
    }
    return before;
}

/**
 * WiCE stores the section path as "Career.:Solo album and reunions
 * (2009–present)." — levels joined by ".:" with a trailing period. Returns
 * the house style the production builder uses ("Career > Solo album …").
 */
export function sectionPathFromWice(section) {
    if (!section) return null;
    const parts = String(section).split('.:').map(p => p.replace(/\.$/, '').trim()).filter(Boolean);
    return parts.length ? parts.join(' > ') : null;
}

/**
 * The context object for a row, restricted to `fields`, or null when none of
 * the requested fields is available for it.
 *
 * A row may carry an explicit `claim_context` object (the probe set does, see
 * context_probes.js); it replaces the derived one field by field.
 */
export function contextForEntry(entry, fields) {
    if (!fields || fields.length === 0) return null;
    const explicit = entry.claim_context || {};
    const pick = (name, derive) => (name in explicit ? explicit[name] : derive());

    const context = {};
    if (fields.includes('title')) {
        context.articleTitle = pick('articleTitle', () => entry.article_title || null);
    }
    if (fields.includes('section')) {
        context.sectionTitle = pick('sectionTitle', () => entry.section_title || sectionPathFromWice(entry.wice_section));
    }
    if (fields.includes('preceding')) {
        context.precedingText = pick('precedingText', () => precedingTextFromContainer(entry.claim_text, entry.claim_container));
    }
    if (fields.includes('citation')) {
        context.citationTitle = pick('citationTitle', () => entry.source_title || null);
    }
    return Object.values(context).some(v => typeof v === 'string' && v.trim()) ? context : null;
}

/**
 * Which context fields a built context actually carries — what a result row
 * records, so an analysis can split "asked for preceding text" from "got it".
 */
export function presentContextFields(context) {
    if (!context) return [];
    const map = { title: 'articleTitle', section: 'sectionTitle', preceding: 'precedingText', citation: 'citationTitle' };
    return CONTEXT_FIELDS.filter(f => typeof context[map[f]] === 'string' && context[map[f]].trim());
}
