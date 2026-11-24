// Deterministic cause tags: the rationale patterns from
// docs/design-plans/2026-11-08-fixable-causes-of-disputed-verdicts.md, as code.
//
// They read only what the tool logged — verdict, reason type, quote, claim and
// the model's own explanation — so they cost nothing and run on every row.
// They are HINTS, not labels: their precision has not been measured, which is
// why triage shows them beside the adjudicator's independent judgement rather
// than instead of it.
//
// One definition, two compilers. tagCauses() evaluates a rule in JS (triage,
// over exported cases); causeSql() turns the same rule into a SQL condition
// over verification_logs (the monitor, over every logged check). The patterns
// are written in the subset of regex syntax JS and Postgres ARE share — no \b,
// no lookbehind — so one string serves both, and changing a pattern changes
// what both of them count.

export const FLAG_VERDICTS = Object.freeze(['NOT SUPPORTED', 'PARTIALLY SUPPORTED']);

// Case-insensitive in both engines (JS `i` flag, Postgres `~*`).
export const PATTERNS = Object.freeze({
    // How the userscript words a fetch that failed before any model call.
    fetchFailure: '^(HTTP [0-9]|Source returned|Failed to fetch|fetch|timeout|timed out|Could not|Proxy|Network|Error|Google Books|No Wayback|Source text could not)',
    // The rationale itself says the page is not the source.
    unusablePage: '(log ?in|sign ?in|paywall|subscri|captcha|security check|verify you are|javascript|cookie|access denied|bibliograph|metadata|catalog(ue)? (record|page|entry)|landing page|only (a |the )?(abstract|links?|navigation|menu|table of contents|title|headline)|not included in the provided|no (article|substantive|actual|readable) (content|text))',
    // The rationale describes a readable document...
    readablePage: '(article|report|review|interview|story|press release|blog post|obituary|profile|biography|discusses|is about)',
    // ...and says the claim is absent from it.
    saysAbsent: "(does not|doesn['’]t|no) (contain|mention|include|provide|state|specify|support|information)",
    fragment: 'fragment',
    // "The source confirms X, but ..." — partial support, by the prompt's own example.
    admitsPartial: '(confirms|supports|mentions|states|notes|reports|describes|lists|shows)[^.]{0,160}(but|however|although|yet)',
    demandsWording: '(exact (phrase|wording)|specific (phrase|wording)|the phrase|verbatim|that (specific )?wording)',
    // A date the model could have read off the source's dateline.
    missingDate: "(does not|doesn['’]t|no|without|not)[^.]{0,25}(specify|specifying|mention|mentioning|provide|providing|give|giving|state|stating|include|including|indicate|indicating)[^.]{0,30}(date|year|month)",
    weekday: '(^|[^a-z])(monday|tuesday|wednesday|thursday|friday|saturday|sunday)([^a-z]|$)',
});

const PATTERN_RE = Object.freeze(Object.fromEntries(
    Object.entries(PATTERNS).map(([id, source]) => [id, new RegExp(source, 'i')]),
));

// Claims longer than this span several sentences in practice; rated NOT
// SUPPORTED verdicts on them were thumbs-down 15 times out of 16.
export const LONG_CLAIM_CHARS = 400;
// Shorter than this, a claim is usually a table cell, list item or infobox
// value that reached the model without its row or label.
export const FRAGMENT_CLAIM_CHARS = 25;

// Hosts carry the publisher's name often enough ("handelszeitung.ch") to test
// whether a claim names its own source. Labels that are not names are skipped.
const NOT_A_PUBLISHER = new Set([
    'www', 'web', 'archive', 'doi', 'html', 'news', 'edition', 'online', 'media',
    'press', 'books', 'scholar', 'journals', 'academic', 'research', 'about',
    'store', 'info', 'blog', 'blogs', 'files', 'assets', 'static', 'experts',
]);

/** The host a source really lives on, looking through a Wayback URL. */
export function sourceHost(sourceUrl) {
    if (!sourceUrl) return null;
    const wayback = String(sourceUrl).match(/web\.archive\.org\/web\/[^/]+\/(?:https?:\/\/)?([^/?#:]+)/i);
    if (wayback) return wayback[1].toLowerCase().replace(/^www\./, '');
    try {
        return new URL(sourceUrl).host.toLowerCase().replace(/^www\./, '') || null;
    } catch {
        return null;
    }
}

/** The longest host label that could be a publisher's name, or null. */
export function publisherToken(sourceUrl) {
    const host = sourceHost(sourceUrl);
    if (!host) return null;
    const labels = host.split('.').slice(0, -1) // drop the TLD
        .filter(label => label.length >= 4 && !NOT_A_PUBLISHER.has(label));
    return labels.sort((a, b) => b.length - a.length)[0] ?? null;
}

const squash = s => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const SAYS_NOT_NAMED = /(not|no|never|without) (mention|name|attribut|identif|state|refer|cite|indicate)/i;

// "In 2021 Protekta was named market leader in the Handelszeitung", checked
// against handelszeitung.ch and judged unsupported because the text never
// names the Handelszeitung. JS only: it needs URL parsing the SQL side lacks.
export function namesOwnSource(check) {
    const token = publisherToken(check.sourceUrl);
    if (!token || !squash(check.claimText).includes(token)) return false;
    return SAYS_NOT_NAMED.test(check.comments ?? '');
}

/**
 * Each rule: which verdicts it applies to, and conditions on the logged
 * fields. `all` / `any` / `none` name PATTERNS tested against the model's
 * explanation. `anyShortClaim` and `jsAny` join `any` as alternatives.
 * `brief` is the cause's section in the 2026-11-08 design plan (null: not a
 * model failure at all).
 */
export const CAUSE_RULES = Object.freeze([
    {
        id: 'fetch_failed', brief: null,
        label: 'Fetch failed before any model call',
        verdicts: ['SOURCE UNAVAILABLE'], all: ['fetchFailure'],
    },
    {
        id: 'citation_metadata', brief: 1,
        label: 'Model not told what the source is (date, publisher)',
        verdicts: FLAG_VERDICTS, any: ['missingDate', 'weekday'], jsAny: namesOwnSource,
    },
    {
        id: 'unusable_page', brief: 2,
        label: 'Unusable page judged as if it were the source',
        verdicts: FLAG_VERDICTS, all: ['unusablePage'],
    },
    {
        id: 'readable_called_unavailable', brief: 2,
        label: 'Readable page called unavailable',
        verdicts: ['SOURCE UNAVAILABLE'], all: ['readablePage', 'saysAbsent'],
        none: ['fetchFailure', 'unusablePage', 'fragment'],
    },
    {
        id: 'rationale_contradicts_verdict', brief: 3,
        label: 'Explanation describes partial support, verdict says none',
        verdicts: ['NOT SUPPORTED'], all: ['admitsPartial'],
    },
    {
        id: 'demands_wording', brief: 3,
        label: "Rejects a paraphrase for not using the claim's wording",
        verdicts: FLAG_VERDICTS, all: ['demandsWording'],
    },
    {
        id: 'uncheckable_omission', brief: 4,
        label: 'Omission with nothing for the editor to check',
        verdicts: ['NOT SUPPORTED'], reasonType: 'omission', emptyQuote: true,
    },
    {
        id: 'claim_too_long', brief: 5,
        label: 'Claim spans several sentences',
        verdicts: FLAG_VERDICTS, minClaimChars: LONG_CLAIM_CHARS,
    },
    {
        id: 'claim_fragment', brief: 5,
        label: 'Claim is a fragment (table cell, list item, infobox)',
        // Any verdict a model actually made: a fetch failure never showed
        // the claim to anyone, so its length says nothing.
        none: ['fetchFailure'], any: ['fragment'], anyShortClaim: FRAGMENT_CLAIM_CHARS,
    },
]);

export const CAUSE_IDS = Object.freeze(CAUSE_RULES.map(r => r.id));
const RULES_BY_ID = new Map(CAUSE_RULES.map(r => [r.id, r]));

export function causeRule(id) {
    return RULES_BY_ID.get(id) ?? null;
}

const charLength = s => [...String(s ?? '')].length;

/**
 * Whether one rule fires on one logged check.
 * @param {object} rule - an entry of CAUSE_RULES
 * @param {{verdict, reasonType, sourceQuote, claimText, comments, sourceUrl}} check
 *   - normalizeCase()'s `check` (canonical UPPERCASE verdict)
 */
export function ruleMatches(rule, check) {
    const comments = check.comments ?? '';
    const claimLength = charLength(check.claimText);
    if (rule.verdicts && !rule.verdicts.includes(check.verdict)) return false;
    if (rule.reasonType && check.reasonType !== rule.reasonType) return false;
    if (rule.emptyQuote && String(check.sourceQuote ?? '').trim()) return false;
    if (rule.minClaimChars && claimLength < rule.minClaimChars) return false;
    const has = id => PATTERN_RE[id].test(comments);
    if (rule.all && !rule.all.every(has)) return false;
    if (rule.none && rule.none.some(has)) return false;
    if (rule.any || rule.anyShortClaim || rule.jsAny) {
        const anyHit = (rule.any ?? []).some(has)
            || (rule.anyShortClaim != null && claimLength > 0 && claimLength < rule.anyShortClaim)
            || (rule.jsAny ? rule.jsAny(check) : false);
        if (!anyHit) return false;
    }
    return true;
}

/** Ids of every rule that fires on a check, in CAUSE_RULES order. */
export function tagCauses(check) {
    return CAUSE_RULES.filter(rule => ruleMatches(rule, check)).map(rule => rule.id);
}

const sqlString = s => `'${String(s).replace(/'/g, "''")}'`;
const commentsMatch = id => `coalesce(llm_comments, '') ~* ${sqlString(PATTERNS[id])}`;

/**
 * The same rule as a SQL boolean over verification_logs' columns. A rule's
 * `jsAny` alternative has no SQL form, so the SQL count for such a rule is a
 * lower bound; `sqlIsExact(rule)` says which.
 */
export function causeSql(rule) {
    const conditions = [];
    if (rule.verdicts) conditions.push(`verdict IN (${rule.verdicts.map(sqlString).join(', ')})`);
    if (rule.reasonType) conditions.push(`reason_type = ${sqlString(rule.reasonType)}`);
    if (rule.emptyQuote) conditions.push("btrim(coalesce(source_quote, '')) = ''");
    if (rule.minClaimChars) conditions.push(`char_length(coalesce(claim_text, '')) >= ${Number(rule.minClaimChars)}`);
    for (const id of rule.all ?? []) conditions.push(commentsMatch(id));
    for (const id of rule.none ?? []) conditions.push(`NOT (${commentsMatch(id)})`);
    const alternatives = (rule.any ?? []).map(commentsMatch);
    if (rule.anyShortClaim != null) {
        alternatives.push(`char_length(coalesce(claim_text, '')) BETWEEN 1 AND ${Number(rule.anyShortClaim) - 1}`);
    }
    if (alternatives.length) conditions.push(`(${alternatives.join(' OR ')})`);
    return conditions.length ? conditions.join(' AND ') : 'TRUE';
}

export function sqlIsExact(rule) {
    return !rule.jsAny;
}
