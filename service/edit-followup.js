// Did a check lead to an edit? Measured from the article history, not from
// edit summaries.
//
// Editors almost never keep the prefilled "checked with Source Verifier"
// summary — of 222 enwiki article edits that carried it by 2026-11, 202 were
// the maintainer's own — so counting summaries measures nothing. This instead
// takes each check logged to Neon (`verification_logs`: article, revision_id,
// timestamp, citation, source URL, verdict), reads the article's revisions in
// the hours after it, and asks of every checked citation whether a human
// edit changed it.
//
// The comparison that makes the number mean something is WITHIN A RUN: the
// flagged citations and the Supported ones of the same check, on the same
// article, over the same edits. An article that is busy anyway raises both
// rates; only the tool's verdict separates them. The gap is the estimate.
//
// What counts as "changed", per citation, against the checked revision:
//
//   removed  the source URL occurs fewer times (dropped or replaced)
//   tagged   a maintenance tag ({{failed verification}}, {{better source
//            needed}}, …) appeared right after a ref holding it
//   claim    the URL is still there, but the wikitext just before its ref
//            changed — a reworded claim. Reported separately: it is the
//            weakest signal, since an edit to a neighbouring citation in the
//            same sentence trips it too.
//
// Matching is on the source URL, never the citation number (which shifts as
// refs are added above) and never Neon's claim_text (taken from the rendered
// page, so it does not occur in wikitext). A citation whose URL cannot be
// found in the checked revision is counted as unmatched and left out of every
// rate, rather than guessed at.
//
// Bot edits are not counted (InternetArchiveBot repairs dead links whatever
// any tool said), and an edit made before the run's first check cannot have
// been caused by it. Who RAN a check is unknown — Neon stores no user — so a
// run is attributed to nobody; `excludedEditors` drops whole runs in which a
// named editor edited, which is how the maintainer's own use is taken out.
//
// Pure: no I/O. service/run-edit-followup.js does the fetching.

export const DEFAULT_WINDOWS_HOURS = Object.freeze([1, 6, 24, 48]);

const HOUR_MS = 60 * 60 * 1000;

// The export run-edit-followup.js reads. One row per logged check; group
// checks are skipped (they carry no source_url), but are cheap to keep in
// the export so the skipped count is visible.
export const EXPORT_SQL = `SELECT to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ts,
       article_url, article_title, revision_id, kind,
       citation_number, source_url, verdict
FROM verification_logs
WHERE revision_id IS NOT NULL
  AND ts >= now() - interval '60 days'
ORDER BY ts`;

export const VERDICT_CLASSES = Object.freeze({
    FLAGGED: 'flagged',          // NOT SUPPORTED, PARTIALLY SUPPORTED
    SUPPORTED: 'supported',      // the within-run baseline
    UNAVAILABLE: 'unavailable',  // SOURCE UNAVAILABLE: dead links get fixed for other reasons
});
export const CLASS_ORDER = Object.freeze([
    VERDICT_CLASSES.FLAGGED, VERDICT_CLASSES.SUPPORTED, VERDICT_CLASSES.UNAVAILABLE,
]);

export function verdictClass(verdict) {
    switch (String(verdict || '').trim().toUpperCase()) {
        case 'NOT SUPPORTED':
        case 'PARTIALLY SUPPORTED':
            return VERDICT_CLASSES.FLAGGED;
        case 'SUPPORTED':
            return VERDICT_CLASSES.SUPPORTED;
        case 'SOURCE UNAVAILABLE':
            return VERDICT_CLASSES.UNAVAILABLE;
        default:
            return null; // ERROR, PARSE_ERROR, SKIPPED: nothing to measure
    }
}

/**
 * Milliseconds since the epoch, or null. Takes ISO 8601 (the export's
 * to_char form, and the MediaWiki API's) and Postgres's default text form
 * ("2026-10-01 12:34:56.789+00"), which a plain `\copy` without to_char
 * produces.
 */
export function parseTimestamp(value) {
    if (value === null || value === undefined || value === '') return null;
    let s = String(value).trim();
    const pg = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)([+-]\d{2})(?::?(\d{2}))?$/.exec(s);
    if (pg) s = `${pg[1]}T${pg[2]}${pg[3]}:${pg[4] ?? '00'}`;
    const ms = Date.parse(s);
    return Number.isFinite(ms) ? ms : null;
}

export function wikiHostOf(articleUrl) {
    try {
        return new URL(articleUrl).host;
    } catch {
        return null;
    }
}

/**
 * Groups exported check rows into runs: one per (article, checked revision).
 * Within a run a citation checked more than once keeps its latest check.
 *
 * Returns `{ runs, skipped }`; `skipped` counts rows left out, by reason.
 */
export function groupRuns(rows, { wiki = 'en.wikipedia.org', sinceMs = null, untilMs = null } = {}) {
    const skipped = { other_wiki: 0, group: 0, no_source_url: 0, unscored_verdict: 0, bad_row: 0, out_of_range: 0 };
    const runs = new Map();

    for (const row of rows) {
        const host = wikiHostOf(row.article_url);
        if (wiki && host !== wiki) { skipped.other_wiki++; continue; }
        const checkMs = parseTimestamp(row.ts);
        const revisionId = Number(row.revision_id);
        const title = String(row.article_title || '').trim();
        if (checkMs === null || !Number.isInteger(revisionId) || revisionId <= 0 || !title) {
            skipped.bad_row++;
            continue;
        }
        if ((sinceMs !== null && checkMs < sinceMs) || (untilMs !== null && checkMs >= untilMs)) {
            skipped.out_of_range++;
            continue;
        }
        if (String(row.kind || 'source') === 'group') { skipped.group++; continue; }
        const sourceUrl = String(row.source_url || '').trim();
        if (!sourceUrl) { skipped.no_source_url++; continue; }
        const cls = verdictClass(row.verdict);
        if (!cls) { skipped.unscored_verdict++; continue; }

        const key = `${title}\u0000${revisionId}`;
        let run = runs.get(key);
        if (!run) {
            run = { title, revisionId, wiki: host, firstCheckMs: checkMs, lastCheckMs: checkMs, citations: new Map() };
            runs.set(key, run);
        }
        run.firstCheckMs = Math.min(run.firstCheckMs, checkMs);
        run.lastCheckMs = Math.max(run.lastCheckMs, checkMs);

        const citationKey = `${row.citation_number ?? ''}\u0000${sourceUrl}`;
        const existing = run.citations.get(citationKey);
        if (!existing || checkMs >= existing.checkMs) {
            run.citations.set(citationKey, {
                citationNumber: String(row.citation_number ?? ''),
                sourceUrl,
                verdict: String(row.verdict).trim().toUpperCase(),
                verdictClass: cls,
                checkMs,
            });
        }
    }

    const list = [...runs.values()].map(run => ({ ...run, citations: [...run.citations.values()] }));
    list.sort((a, b) => a.firstCheckMs - b.firstCheckMs);
    return { runs: list, skipped };
}

// --- Finding a citation in wikitext -----------------------------------------

function safeDecode(url) {
    try {
        return decodeURI(url);
    } catch {
        return url;
    }
}

/**
 * The spellings of a source URL worth looking for in wikitext. The scheme is
 * dropped (an http/https mismatch between the rendered href and the wikitext
 * is common), a trailing slash is made optional by findUrlOccurrences(), and
 * the href's percent-encoding is undone since wikitext usually holds the raw
 * characters.
 */
export function urlForms(url) {
    const strip = u => u.replace(/^[a-z][a-z0-9+.-]*:(?=\/\/)/i, '').replace(/\/+$/, '');
    const forms = new Set();
    for (const u of [url, safeDecode(url)]) {
        const s = strip(String(u).trim());
        if (s.length < 8) continue; // "//a.b" would match half the page
        forms.add(s);
        if (s.includes('&')) forms.add(s.replace(/&/g, '&amp;'));
    }
    return [...forms];
}

// A URL in wikitext ends at whitespace, a pipe, a bracket, a brace, a quote
// or a tag — not at "/" or "?", so that "//example.com/a" doesn't match
// inside "//example.com/a/b" or "//example.com/a?page=2".
const URL_TERMINATOR = /[\s|\]}<>"'{]/;

/** Start offsets of every occurrence of `url` in `text`, de-duplicated across spellings. */
export function findUrlOccurrences(text, url) {
    const positions = new Set();
    for (const form of urlForms(url)) {
        let from = 0;
        for (;;) {
            const at = text.indexOf(form, from);
            if (at === -1) break;
            from = at + 1;
            let end = at + form.length;
            if (text[end] === '/') end++;
            if (end < text.length && !URL_TERMINATOR.test(text[end])) continue;
            positions.add(at);
        }
    }
    return [...positions].sort((a, b) => a - b);
}

// The maintenance tags an editor puts after a ref they think fails. Names
// and their common redirects on enwiki; matched case-insensitively.
export const MAINTENANCE_TAG_NAMES = Object.freeze([
    'failed verification', 'fv', 'failed', 'verification failed', 'not in citation given',
    'not in source', 'not in ref', 'nic', 'better source needed', 'better source', 'bsn',
    'verify source', 'verification needed', 'vn', 'dubious', 'disputed inline',
    'unreliable source?', 'unreliable source', 'unreliable inline', 'self-published inline',
    'text-source inline', 'specify', 'page needed', 'citation needed', 'cn', 'fact',
    'dead link', 'request quotation', 'rq',
]);

const TAG_NAMES_ALTERNATION = MAINTENANCE_TAG_NAMES
    .map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '[ _]'))
    .join('|');
const TAG_PATTERN = new RegExp(`\\{\\{\\s*(?:${TAG_NAMES_ALTERNATION})\\s*(?:\\||\\}\\})`, 'i');
// The whole tag, for removing it from claim context.
const TAG_TEMPLATE = new RegExp(`\\{\\{\\s*(?:${TAG_NAMES_ALTERNATION})\\s*(?:\\|[^{}]*)?\\}\\}`, 'gi');

// Refs, ref reuses and inline templates directly after a ref: the span a tag
// for that ref sits in. "[1][2]{{fv}}" tags the last ref, but the tag still
// belongs to the cluster.
const TRAILING_CLUSTER = /^(?:\s*(?:<ref\b[^>]*\/>|<ref\b[^>]*>[\s\S]*?<\/ref\s*>|\{\{(?:[^{}]|\{\{[^{}]*\}\})*\}\}))*/i;

// '<ref' followed by whitespace, '>' or '/' — not '<references'.
const isRefOpen = (text, at) => /[\s>/]/.test(text[at + 4] ?? '');

function lastRefOpen(text, before) {
    let at = text.lastIndexOf('<ref', before);
    while (at !== -1 && !isRefOpen(text, at)) at = at === 0 ? -1 : text.lastIndexOf('<ref', at - 1);
    return at;
}

function nextRefOpen(text, from) {
    let at = text.indexOf('<ref', from);
    while (at !== -1 && !isRefOpen(text, at)) at = text.indexOf('<ref', at + 1);
    return at;
}

function refAround(text, position) {
    const open = lastRefOpen(text, position);
    if (open === -1) return null;
    const openEnd = text.indexOf('>', open);
    if (openEnd === -1 || openEnd > position || text[openEnd - 1] === '/') return null;
    const close = text.indexOf('</ref', position);
    if (close === -1) return null;
    // A '<ref' between the URL and the close means the URL was outside any ref.
    const nextOpen = nextRefOpen(text, position);
    if (nextOpen !== -1 && nextOpen < close) return null;
    const closeEnd = text.indexOf('>', close);
    if (closeEnd === -1) return null;
    return { start: open, end: closeEnd + 1 };
}

const CLAIM_CONTEXT_CHARS = 200;

function claimBefore(text, refStart) {
    let from = Math.max(0, refStart - CLAIM_CONTEXT_CHARS);
    // Stop at the previous ref or paragraph break: text before those is
    // another citation's claim.
    for (const marker of ['</ref>', '/>', '\n']) {
        const at = text.lastIndexOf(marker, refStart - 1);
        if (at !== -1 && at + marker.length > from && at + marker.length <= refStart) from = at + marker.length;
    }
    // Refs and maintenance tags aren't claim text: a {{fv}} put after the
    // previous citation's ref must not read as this claim being reworded.
    return text.slice(from, refStart)
        .replace(/<ref\b[^>]*\/>/gi, '')
        .replace(/<ref\b[^>]*>[\s\S]*?<\/ref\s*>/gi, '')
        .replace(TAG_TEMPLATE, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Where a citation stands in one revision's wikitext: how often its URL
 * occurs, how many of those refs carry a maintenance tag, and the claim text
 * before each ref.
 */
export function citationState(text, url) {
    const occurrences = findUrlOccurrences(text || '', url);
    let tagged = 0;
    const claims = [];
    for (const position of occurrences) {
        const ref = refAround(text, position);
        if (!ref) { claims.push(null); continue; }
        const cluster = TRAILING_CLUSTER.exec(text.slice(ref.end, ref.end + 2000))?.[0] ?? '';
        if (TAG_PATTERN.test(cluster)) tagged++;
        // An empty claim (a ref at the start of a line, in an infobox) has
        // nothing to compare: text appearing there later is the article
        // growing, not the claim being reworded.
        claims.push(claimBefore(text, ref.start) || null);
    }
    return { count: occurrences.length, tagged, claims };
}

/** What changed between the checked revision's state and a later one. */
export function compareStates(base, next) {
    const removed = next.count < base.count;
    const tagged = next.tagged > base.tagged;
    let claim = false;
    if (!removed && next.count === base.count) {
        claim = base.claims.some((c, i) => c !== null && next.claims[i] !== null && c !== next.claims[i]);
    }
    return { removed, tagged, claim, strong: removed || tagged, any: removed || tagged || claim };
}

// --- One run ------------------------------------------------------------------

/**
 * Analyzes one run against its article's revisions.
 *
 * `revisions` is ascending by time and starts with the checked revision:
 * `[{ revid, timestampMs, user, text }]`. `isBot(user)` says whether an edit
 * is a bot's. Returns `{ status, citations, editsByWindow }`, where each
 * citation carries the first human edit that changed it (strong signal, and
 * any signal), in minutes after its own check.
 */
export function analyzeRun(run, revisions, {
    windowsHours = DEFAULT_WINDOWS_HOURS,
    isBot = () => false,
    excludedEditors = [],
} = {}) {
    if (!revisions?.length) return { status: 'no_revisions', citations: [], editsByWindow: {} };
    if (revisions[0].revid !== run.revisionId) return { status: 'base_mismatch', citations: [], editsByWindow: {} };
    if (revisions[0].text === null || revisions[0].text === undefined) {
        return { status: 'base_hidden', citations: [], editsByWindow: {} };
    }

    const maxWindowMs = Math.max(...windowsHours) * HOUR_MS;
    const horizonMs = run.lastCheckMs + maxWindowMs;
    const later = revisions.slice(1).filter(r => r.timestampMs <= horizonMs);

    const excluded = new Set(excludedEditors.map(e => e.toLowerCase()));
    if (later.some(r => r.timestampMs >= run.firstCheckMs && excluded.has(String(r.user || '').toLowerCase()))) {
        return { status: 'excluded_editor', citations: [], editsByWindow: {} };
    }

    // Run level: was there any human edit at all after the checks began?
    const humanAfter = later.filter(r => r.timestampMs >= run.firstCheckMs && !isBot(r.user));
    const editsByWindow = {};
    for (const h of windowsHours) {
        editsByWindow[h] = humanAfter.some(r => r.timestampMs <= run.lastCheckMs + h * HOUR_MS);
    }

    const citations = run.citations.map(citation => {
        const base = citationState(revisions[0].text, citation.sourceUrl);
        const result = {
            ...citation,
            matched: base.count > 0,
            strong: null,
            any: null,
        };
        if (!result.matched) return result;

        for (const revision of later) {
            if (revision.text === null || revision.text === undefined) continue; // revdeleted
            const change = compareStates(base, citationState(revision.text, citation.sourceUrl));
            if (!change.any) continue;
            const event = {
                revid: revision.revid,
                user: revision.user ?? null,
                byBot: Boolean(isBot(revision.user)),
                beforeCheck: revision.timestampMs < run.firstCheckMs,
                minutes: Math.max(0, (revision.timestampMs - citation.checkMs) / 60000),
                kind: change.removed ? 'removed' : change.tagged ? 'tagged' : 'claim',
            };
            if (!result.any) result.any = event;
            if (change.strong && !result.strong) result.strong = event;
            if (result.strong) break;
        }
        return result;
    });

    return { status: 'ok', citations, editsByWindow };
}

// A change counts in a window only if a human made it, after the run began.
function countsWithin(event, hours) {
    return Boolean(event) && !event.byBot && !event.beforeCheck && event.minutes <= hours * 60;
}

// --- Summary --------------------------------------------------------------------

function rate(numerator, denominator) {
    return denominator ? numerator / denominator : null;
}

/**
 * Aggregates analyzed runs into rates per verdict class and window, and the
 * flagged-minus-supported gap.
 */
export function summarize(analyzed, { windowsHours = DEFAULT_WINDOWS_HOURS, topEditors = 10 } = {}) {
    const statuses = {};
    const classes = {};
    for (const cls of CLASS_ORDER) {
        classes[cls] = { citations: 0, unmatched: 0, byBot: 0, beforeCheck: 0, windows: {} };
        for (const h of windowsHours) classes[cls].windows[h] = { strong: 0, any: 0, removed: 0, tagged: 0, claim: 0 };
    }
    const runsWithEdit = Object.fromEntries(windowsHours.map(h => [h, 0]));
    const editorCounts = new Map();
    let okRuns = 0;
    const maxHours = Math.max(...windowsHours);

    for (const { status, citations, editsByWindow } of analyzed) {
        statuses[status] = (statuses[status] ?? 0) + 1;
        if (status !== 'ok') continue;
        okRuns++;
        for (const h of windowsHours) if (editsByWindow[h]) runsWithEdit[h]++;

        for (const c of citations) {
            const bucket = classes[c.verdictClass];
            if (!c.matched) { bucket.unmatched++; continue; }
            bucket.citations++;
            if (c.strong?.byBot) bucket.byBot++;
            if (c.any?.beforeCheck) bucket.beforeCheck++;
            for (const h of windowsHours) {
                const w = bucket.windows[h];
                if (countsWithin(c.strong, h)) {
                    w.strong++;
                    w[c.strong.kind]++;
                }
                if (countsWithin(c.any, h)) {
                    w.any++;
                    if (!countsWithin(c.strong, h) && c.any.kind === 'claim') w.claim++;
                }
            }
            if (c.verdictClass === VERDICT_CLASSES.FLAGGED && countsWithin(c.any, maxHours) && c.any.user) {
                editorCounts.set(c.any.user, (editorCounts.get(c.any.user) ?? 0) + 1);
            }
        }
    }

    for (const cls of CLASS_ORDER) {
        const bucket = classes[cls];
        for (const h of windowsHours) {
            const w = bucket.windows[h];
            w.strongRate = rate(w.strong, bucket.citations);
            w.anyRate = rate(w.any, bucket.citations);
        }
    }

    const gap = {};
    for (const h of windowsHours) {
        const f = classes.flagged.windows[h];
        const s = classes.supported.windows[h];
        gap[h] = {
            strong: f.strongRate !== null && s.strongRate !== null ? f.strongRate - s.strongRate : null,
            any: f.anyRate !== null && s.anyRate !== null ? f.anyRate - s.anyRate : null,
        };
    }

    const editors = [...editorCounts].sort((a, b) => b[1] - a[1]).slice(0, topEditors)
        .map(([user, flaggedCitationsChanged]) => ({ user, flaggedCitationsChanged }));

    return {
        windowsHours: [...windowsHours],
        runs: { total: analyzed.length, analyzed: okRuns, byStatus: statuses, withHumanEdit: runsWithEdit },
        classes,
        gap,
        editors,
    };
}

// --- Rendering --------------------------------------------------------------------

const pct = value => (value === null || value === undefined ? '—' : `${(value * 100).toFixed(1)}%`);
const pts = value => (value === null || value === undefined ? '—' : `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)} pts`);

export function renderMarkdown(summary, { skipped = {}, notes = [] } = {}) {
    const { windowsHours, runs, classes, gap, editors } = summary;
    const lines = [];
    lines.push('# Edits after checks', '');
    lines.push(
        'A citation counts as **changed** when a human edit after the check removed or replaced its source URL, '
        + 'or put a maintenance tag after its ref. **+ claim** also counts edits to the text just before the ref. '
        + 'Supported citations from the same runs are the baseline; the gap is the estimate of the tool\'s effect.',
        '',
    );

    lines.push('## Flagged vs Supported citations', '');
    lines.push('| Window | Flagged changed | Supported changed | Gap | Flagged + claim | Supported + claim | Gap + claim |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const h of windowsHours) {
        const f = classes.flagged.windows[h];
        const s = classes.supported.windows[h];
        lines.push(`| ${h} h | ${pct(f.strongRate)} (${f.strong}) | ${pct(s.strongRate)} (${s.strong}) | ${pts(gap[h].strong)} `
            + `| ${pct(f.anyRate)} (${f.any}) | ${pct(s.anyRate)} (${s.any}) | ${pts(gap[h].any)} |`);
    }
    lines.push('');
    lines.push(`Matched citations: ${classes.flagged.citations} flagged, ${classes.supported.citations} supported.`, '');

    lines.push('## Source Unavailable (reported apart: dead links get fixed for other reasons)', '');
    lines.push('| Window | Changed | + claim |', '|---|---|---|');
    for (const h of windowsHours) {
        const u = classes.unavailable.windows[h];
        lines.push(`| ${h} h | ${pct(u.strongRate)} (${u.strong}) | ${pct(u.anyRate)} (${u.any}) |`);
    }
    lines.push('', `Matched citations: ${classes.unavailable.citations}.`, '');

    lines.push('## What the flagged changes were', '');
    lines.push('| Window | Source removed or replaced | Tag added | Claim edited only |', '|---|---|---|---|');
    for (const h of windowsHours) {
        const f = classes.flagged.windows[h];
        lines.push(`| ${h} h | ${f.removed} | ${f.tagged} | ${f.claim} |`);
    }
    lines.push('');

    lines.push('## Runs', '');
    lines.push(`${runs.total} runs (article + checked revision); ${runs.analyzed} analyzed.`, '');
    lines.push('| Window | Runs followed by any human edit |', '|---|---|');
    for (const h of windowsHours) {
        lines.push(`| ${h} h | ${pct(rate(runs.withHumanEdit[h], runs.analyzed))} (${runs.withHumanEdit[h]}) |`);
    }
    lines.push('');
    const statusLines = Object.entries(runs.byStatus).filter(([s]) => s !== 'ok');
    if (statusLines.length) {
        lines.push('Runs not analyzed:', '');
        for (const [status, n] of statusLines) lines.push(`- ${status}: ${n}`);
        lines.push('');
    }

    lines.push('## Coverage', '');
    for (const cls of CLASS_ORDER) {
        const b = classes[cls];
        lines.push(`- ${cls}: ${b.citations} matched, ${b.unmatched} URL not found in the checked revision, `
            + `${b.byBot} first changed by a bot, ${b.beforeCheck} changed before the check`);
    }
    const skippedLines = Object.entries(skipped).filter(([, n]) => n);
    if (skippedLines.length) {
        lines.push('', 'Export rows skipped:', '');
        for (const [reason, n] of skippedLines) lines.push(`- ${reason}: ${n}`);
    }
    lines.push('');

    if (editors.length) {
        lines.push(`## Who changed flagged citations (within ${Math.max(...windowsHours)} h)`, '');
        lines.push('| Editor | Flagged citations changed |', '|---|---|');
        for (const e of editors) lines.push(`| ${e.user} | ${e.flaggedCitationsChanged} |`);
        lines.push('');
    }

    if (notes.length) {
        lines.push('## Notes', '');
        for (const note of notes) lines.push(`- ${note}`);
        lines.push('');
    }
    return lines.join('\n');
}

export const CITATION_CSV_HEADER = Object.freeze([
    'title', 'revision_id', 'citation_number', 'verdict', 'verdict_class', 'source_url', 'matched',
    'change_kind', 'change_minutes', 'change_revid', 'change_by_bot',
    'claim_edit_minutes', 'claim_edit_revid',
]);

function csvCell(value) {
    if (value === null || value === undefined) return '';
    const s = String(value);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One row per checked citation, for auditing individual cases. No usernames. */
export function citationsToCsv(runsWithResults) {
    const lines = [CITATION_CSV_HEADER.join(',')];
    for (const { run, result } of runsWithResults) {
        if (result.status !== 'ok') continue;
        for (const c of result.citations) {
            const claimOnly = c.any && c.any.kind === 'claim' ? c.any : null;
            lines.push([
                run.title, run.revisionId, c.citationNumber, c.verdict, c.verdictClass, c.sourceUrl, c.matched,
                c.strong?.kind ?? '', c.strong ? c.strong.minutes.toFixed(1) : '', c.strong?.revid ?? '',
                c.strong ? c.strong.byBot : '',
                claimOnly ? claimOnly.minutes.toFixed(1) : '', claimOnly?.revid ?? '',
            ].map(csvCell).join(','));
        }
    }
    return `${lines.join('\n')}\n`;
}
