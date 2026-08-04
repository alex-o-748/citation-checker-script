// Feedback helpers: the check identifier and the verification-log payload.
//
// Every verification mints a short `check_id` client-side, at the moment the
// verdict is parsed. Client-side rather than server-assigned so that logging
// stays fire-and-forget — nothing has to await a round trip before the
// feedback controls attached to a result become usable, and the id still
// exists if the log write failed outright.
//
// The id is what lets a later rating or talk-page comment point back at the
// exact check it is about. Collision risk is 32 bits against a low-volume,
// human-paced event stream; a duplicate would mean one rating attaches to the
// wrong row, which is not worth a longer id in the UI or the section heading.
//
// Inlined into main.js between <core-injected> markers, and importable from
// tests.

// Claim text and LLM rationale are unbounded in principle — a pathological
// source or a runaway model response shouldn't push a multi-megabyte row into
// the log table. Both are stored for interpretation, not verbatim archival.
export const MAX_LOGGED_TEXT = 2000;

export function truncateForLog(value, max = MAX_LOGGED_TEXT) {
    if (value == null) return null;
    const s = String(value).trim();
    if (!s) return null;
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// 8 hex characters. `source` is injectable so tests can pin the output;
// production passes nothing and picks up the ambient Web Crypto.
export function newCheckId(source) {
    const c = source ?? (typeof crypto !== 'undefined' ? crypto : null);
    if (c && typeof c.randomUUID === 'function') {
        return c.randomUUID().replace(/-/g, '').slice(0, 8);
    }
    if (c && typeof c.getRandomValues === 'function') {
        const buf = c.getRandomValues(new Uint8Array(4));
        return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
    }
    // Neither API available (very old browser, exotic sandbox). Ratings and
    // comments still work; ids are merely less uniformly distributed.
    return Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0');
}

// Shapes the POST /log body. Field names are snake_case to match the Neon
// columns directly, so the worker can insert without a translation layer.
export function buildLogPayload(fields = {}) {
    return {
        check_id:        fields.checkId ?? null,
        // 'source' for a single citation, 'group' for the collective verdict
        // over an adjacent-citation group. Without it a group row is
        // indistinguishable from a solo row whose source couldn't be fetched:
        // both carry a null source_url.
        kind:            fields.kind ?? 'source',
        article_url:     fields.articleUrl ?? null,
        article_title:   fields.articleTitle ?? null,
        citation_number: fields.citationNumber ?? null,
        source_url:      fields.sourceUrl ?? null,
        provider:        fields.provider ?? null,
        model:           fields.model ?? null,
        verdict:         fields.verdict ?? null,
        confidence:      fields.confidence ?? null,
        reason_type:     fields.reasonType ?? null,
        // Without these two a thumbs-down is uninterpretable: you know the
        // check was wrong but not what it claimed or why it decided that.
        claim_text:      truncateForLog(fields.claimText),
        llm_comments:    truncateForLog(fields.comments),
    };
}
