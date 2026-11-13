// Turns tracked suggestions and revision metadata into the outputs:
// per-suggestion CSV, per-revision CSV, a per-wiki summary (Markdown + JSON),
// and a seeded random sample of changed flagged claims for a person to judge.
//
// The summary reports rates and their uncertainty. It makes no claim that a
// suggestion caused an edit, on purpose: the control group exists to show
// how much change ordinary editing produces, and even a gap between the groups
// has other explanations (flagged claims are more often list items, newer
// text, contested statements …). Whether a change addressed the flag is for
// the reviewed sample to say, not for this code.

import { hostForWiki } from './mwapi.js';

export const SEEN_TAG = 'editsuggestion-seen';
export const USED_TAG = 'editsuggestion-used';
export const REVERTED_TAG = 'mw-reverted';
export const REVERT_TAGS = ['mw-undo', 'mw-rollback', 'mw-manual-revert'];

export function editorType(meta) {
    if (meta.anon) return 'ip';
    if (meta.temp) return 'temp';
    return 'registered';
}

export function revisionFlags(meta) {
    const tags = new Set(meta.tags);
    return {
        seen: tags.has(SEEN_TAG),
        used: tags.has(USED_TAG),
        reverted: tags.has(REVERTED_TAG),
        visualeditor: [...tags].some(t => t === 'visualeditor' || t.startsWith('visualeditor-')),
        is_revert: REVERT_TAGS.some(t => tags.has(t)),
    };
}

export function diffUrl(wiki, meta) {
    const host = hostForWiki(wiki);
    return meta.parent_id
        ? `https://${host}/w/index.php?diff=${meta.rev_id}&oldid=${meta.parent_id}`
        : `https://${host}/w/index.php?oldid=${meta.rev_id}`;
}

function cell(value) {
    if (value === null || value === undefined) return '';
    const s = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns, rows) {
    const lines = [columns.map(cell).join(',')];
    for (const row of rows) lines.push(columns.map(c => cell(row[c])).join(','));
    return `${lines.join('\n')}\n`;
}

export const SUGGESTION_COLUMNS = [
    'wiki', 'batch_id', 'check_id', 'group', 'verdict', 'reason_type', 'page_id', 'page_title',
    'checked_revision_id', 'baseline_revision_id', 'citation_number', 'ref_name', 'is_collective',
    'source_url', 'claim_text', 'located', 'locate_method', 'locate_score', 'flags_at_baseline',
    'revisions_after', 'seen_revisions_after', 'text_unavailable_revisions',
    'changed', 'first_change_rev_id', 'first_change_timestamp', 'first_change_kinds', 'first_change_detail',
    'first_change_user', 'first_change_editor_type', 'first_change_is_bot', 'first_change_seen',
    'first_change_used', 'first_change_visualeditor', 'first_change_reverted', 'first_change_tags',
    'first_change_diff', 'changed_at_end', 'end_kinds', 'before_prose', 'after_prose',
    'before_footnote', 'after_footnote', 'rationale',
];

export const REVISION_COLUMNS = [
    'wiki', 'page_id', 'page_title', 'rev_id', 'parent_id', 'timestamp', 'user', 'editor_type', 'is_bot',
    'seen', 'used', 'mw_reverted', 'visualeditor', 'is_revert', 'minor', 'size', 'tags', 'comment', 'diff',
    'first_changes_flagged', 'first_changes_supported',
];

/** One output row for a tracked suggestion. */
export function suggestionRecord(s, result, { baselineRevId, revisions, wiki }) {
    const first = result.first;
    const meta = first?.meta;
    const flags = meta ? revisionFlags(meta) : null;
    return {
        wiki,
        batch_id: s.batch_id,
        check_id: s.check_id,
        group: s.group,
        verdict: s.verdict,
        reason_type: s.reason_type,
        page_id: s.page_id,
        page_title: s.page_title,
        checked_revision_id: s.checked_revision_id,
        baseline_revision_id: baselineRevId,
        citation_number: s.citation_number,
        ref_name: s.ref_name,
        is_collective: s.is_collective ? 1 : 0,
        source_url: s.source_url,
        claim_text: s.claim_text,
        located: result.located ? 1 : 0,
        locate_method: result.located?.method ?? '',
        locate_score: result.located?.score !== undefined ? round(result.located.score)
            : (result.located?.pageScore !== undefined ? round(result.located.pageScore) : ''),
        flags_at_baseline: result.located?.flags?.join('|') ?? '',
        revisions_after: revisions.length,
        seen_revisions_after: revisions.filter(r => revisionFlags(r).seen).length,
        text_unavailable_revisions: result.skipped,
        changed: first ? 1 : 0,
        first_change_rev_id: meta?.rev_id ?? '',
        first_change_timestamp: meta?.timestamp ?? '',
        first_change_kinds: first ? first.kinds.join('|') : '',
        first_change_detail: first && Object.keys(first.detail).length ? first.detail : '',
        first_change_user: meta?.user ?? '',
        first_change_editor_type: meta ? editorType(meta) : '',
        first_change_is_bot: meta ? (meta.is_bot ? 1 : 0) : '',
        first_change_seen: flags ? (flags.seen ? 1 : 0) : '',
        first_change_used: flags ? (flags.used ? 1 : 0) : '',
        first_change_visualeditor: flags ? (flags.visualeditor ? 1 : 0) : '',
        first_change_reverted: flags ? (flags.reverted ? 1 : 0) : '',
        first_change_tags: meta ? meta.tags.join('|') : '',
        first_change_diff: meta ? diffUrl(wiki, meta) : '',
        changed_at_end: result.end ? (result.end.kinds.length ? 1 : 0) : (result.located ? 0 : ''),
        end_kinds: result.end?.kinds.join('|') ?? '',
        before_prose: first?.before?.prose ?? '',
        after_prose: first?.after?.prose ?? '',
        before_footnote: first?.before?.footnote ?? '',
        after_footnote: first?.after?.footnote ?? '',
        rationale: s.rationale,
    };
}

export function revisionRecord(meta, { wiki, pageTitle, firstChanges }) {
    const flags = revisionFlags(meta);
    return {
        wiki,
        page_id: meta.page_id,
        page_title: pageTitle,
        rev_id: meta.rev_id,
        parent_id: meta.parent_id,
        timestamp: meta.timestamp,
        user: meta.user,
        editor_type: editorType(meta),
        is_bot: meta.is_bot ? 1 : 0,
        seen: flags.seen ? 1 : 0,
        used: flags.used ? 1 : 0,
        mw_reverted: flags.reverted ? 1 : 0,
        visualeditor: flags.visualeditor ? 1 : 0,
        is_revert: flags.is_revert ? 1 : 0,
        minor: meta.minor ? 1 : 0,
        size: meta.size,
        tags: meta.tags.join('|'),
        comment: meta.comment,
        diff: diffUrl(wiki, meta),
        first_changes_flagged: firstChanges?.flagged ?? 0,
        first_changes_supported: firstChanges?.supported ?? 0,
    };
}

function round(x, digits = 3) {
    const f = 10 ** digits;
    return Math.round(x * f) / f;
}

/** 95% Wilson score interval for k successes in n trials. */
export function wilson(k, n, z = 1.96) {
    if (!n) return [null, null];
    const p = k / n;
    const d = 1 + (z * z) / n;
    const centre = (p + (z * z) / (2 * n)) / d;
    const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
    return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

function rate(k, n) {
    const [lo, hi] = wilson(k, n);
    return { k, n, rate: n ? k / n : null, ci95: [lo, hi] };
}

const yes = v => v === 1 || v === '1';

/** Numbers for one wiki. Pure: takes the output rows. */
export function summarize({ wiki, suggestions, revisions, window, pagesWithSuggestions }) {
    const byGroup = {};
    for (const group of ['flagged', 'supported']) {
        const rows = suggestions.filter(r => r.group === group);
        const located = rows.filter(r => yes(r.located));
        const changed = located.filter(r => yes(r.changed));
        const human = changed.filter(r => !yes(r.first_change_is_bot) && !yes(r.first_change_reverted));
        const viaSeen = changed.filter(r => yes(r.first_change_seen));
        const viaUsed = changed.filter(r => yes(r.first_change_used));
        const onEditedPages = located.filter(r => Number(r.revisions_after) > 0);
        const kinds = {};
        for (const r of changed) for (const k of String(r.first_change_kinds).split('|')) kinds[k] = (kinds[k] ?? 0) + 1;
        byGroup[group] = {
            rows: rows.length,
            located: located.length,
            not_located: rows.length - located.length,
            on_pages_edited_after_live: onEditedPages.length,
            changed: rate(changed.length, located.length),
            changed_by_human_unreverted_edit: rate(human.length, located.length),
            changed_by_seen_tagged_edit: rate(viaSeen.length, located.length),
            changed_by_other_edit: rate(changed.length - viaSeen.length, located.length),
            changed_by_used_tagged_edit: rate(viaUsed.length, located.length),
            still_changed_at_end: changed.filter(r => yes(r.changed_at_end)).length,
            change_kinds: kinds,
        };
    }
    const revs = revisions;
    const pagesEdited = new Set(revs.map(r => r.page_id));
    return {
        wiki,
        window,
        pages_with_suggestions: pagesWithSuggestions,
        pages_edited_after_live: pagesEdited.size,
        revisions_after_live: revs.length,
        revisions_by_bots: revs.filter(r => yes(r.is_bot)).length,
        revisions_tagged_seen: revs.filter(r => yes(r.seen)).length,
        revisions_tagged_used: revs.filter(r => yes(r.used)).length,
        revisions_later_reverted: revs.filter(r => yes(r.mw_reverted)).length,
        revisions_visualeditor: revs.filter(r => yes(r.visualeditor)).length,
        pages_with_used_tag: [...new Set(revs.filter(r => yes(r.used)).map(r => r.page_title))].sort(),
        groups: byGroup,
    };
}

const pct = x => (x === null || x === undefined ? '–' : `${(100 * x).toFixed(1)}%`);
const ci = r => (r.n ? `${pct(r.rate)} (${r.k}/${r.n}; 95% CI ${pct(r.ci95[0])}–${pct(r.ci95[1])})` : '–');

export function summaryMarkdown(s) {
    const f = s.groups.flagged;
    const c = s.groups.supported;
    const lines = [
        `# Edits after Source Verification suggestions — ${s.wiki}`,
        '',
        `Window: ${s.window.from} → ${s.window.until} (baseline: last revision before ${s.window.from}).`,
        '',
        'Descriptive only. A change after a suggestion went live is not evidence the suggestion caused it: the',
        'supported claims on the same pages show how much ordinary editing changes claims anyway, and whether a',
        'change addressed the flag is judged by a person in the review sample, not here. See analysis/README.md.',
        '',
        '## Pages and revisions',
        '',
        `| | |`,
        `|---|---|`,
        `| Pages with a suggestion | ${s.pages_with_suggestions} |`,
        `| …edited after go-live | ${s.pages_edited_after_live} |`,
        `| Revisions after go-live | ${s.revisions_after_live} |`,
        `| …by bots | ${s.revisions_by_bots} |`,
        `| …tagged \`${SEEN_TAG}\` (any suggestion type) | ${s.revisions_tagged_seen} |`,
        `| …tagged \`${USED_TAG}\` (any suggestion type) | ${s.revisions_tagged_used} |`,
        `| …later reverted (\`${REVERTED_TAG}\`) | ${s.revisions_later_reverted} |`,
        `| …made in VisualEditor | ${s.revisions_visualeditor} |`,
        '',
        `Pages with a \`${USED_TAG}\` revision: ${s.pages_with_used_tag.length ? s.pages_with_used_tag.join('; ') : 'none'}.`,
        '',
        '## Claims',
        '',
        '| | Flagged (shown) | Supported (control) |',
        '|---|---|---|',
        `| Rows | ${f.rows} | ${c.rows} |`,
        `| Located in the baseline revision | ${f.located} | ${c.located} |`,
        `| …on a page edited after go-live | ${f.on_pages_edited_after_live} | ${c.on_pages_edited_after_live} |`,
        `| **Changed** (sentence or footnote, any edit) | ${ci(f.changed)} | ${ci(c.changed)} |`,
        `| …first changed by a non-bot edit that wasn't reverted | ${ci(f.changed_by_human_unreverted_edit)} | ${ci(c.changed_by_human_unreverted_edit)} |`,
        `| …first changed by an edit tagged \`${SEEN_TAG}\` | ${ci(f.changed_by_seen_tagged_edit)} | ${ci(c.changed_by_seen_tagged_edit)} |`,
        `| …first changed by any other edit | ${ci(f.changed_by_other_edit)} | ${ci(c.changed_by_other_edit)} |`,
        `| …first changed by an edit tagged \`${USED_TAG}\` | ${ci(f.changed_by_used_tagged_edit)} | ${ci(c.changed_by_used_tagged_edit)} |`,
        `| Still different from baseline at window end | ${f.still_changed_at_end} | ${c.still_changed_at_end} |`,
        '',
        'Rates are over claims located in the baseline. Claims not located (text changed between the batch check',
        'and go-live, or generated by a template) are excluded from both groups alike.',
        '',
        '## How claims changed (first change)',
        '',
        '| Kind | Flagged | Supported |',
        '|---|---|---|',
    ];
    const kinds = [...new Set([...Object.keys(f.change_kinds), ...Object.keys(c.change_kinds)])].sort();
    for (const k of kinds) lines.push(`| ${k} | ${f.change_kinds[k] ?? 0} | ${c.change_kinds[k] ?? 0} |`);
    if (!kinds.length) lines.push('| (none) | 0 | 0 |');
    lines.push('');
    return lines.join('\n');
}

// mulberry32: small, seedable, good enough to make the sample reproducible.
export function seededRandom(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function sampleChanged(suggestions, { size = 30, seed = 1 } = {}) {
    const pool = suggestions
        .filter(r => r.group === 'flagged' && yes(r.changed))
        .sort((a, b) => String(a.check_id).localeCompare(String(b.check_id)));
    const rnd = seededRandom(seed);
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, size);
}

export const SAMPLE_COLUMNS = [
    'check_id', 'page_title', 'verdict', 'reason_type', 'claim_text', 'rationale', 'first_change_kinds',
    'first_change_user', 'first_change_is_bot', 'first_change_seen', 'first_change_used', 'first_change_reverted',
    'first_change_diff', 'addressed_flag', 'reviewer_notes',
];

export function sampleMarkdown(wiki, sample, { seed, poolSize }) {
    const lines = [
        `# Review sample — ${wiki}`,
        '',
        `${sample.length} of ${poolSize} flagged claims that changed after go-live, drawn at random (seed ${seed}).`,
        'For each: did the change address what the flag said was wrong? Record the answer in the',
        '`addressed_flag` column of the matching CSV (yes / partly / no / unclear).',
        '',
    ];
    sample.forEach((r, i) => {
        lines.push(
            `## ${i + 1}. ${r.page_title} — ${r.verdict}${r.reason_type ? ` (${r.reason_type})` : ''}`,
            '',
            `- check_id \`${r.check_id}\` · change: **${r.first_change_kinds}** · by ${r.first_change_user || '(hidden)'}`
            + `${yes(r.first_change_is_bot) ? ' (bot)' : ''} · seen ${yes(r.first_change_seen) ? 'yes' : 'no'}`
            + ` · used ${yes(r.first_change_used) ? 'yes' : 'no'}${yes(r.first_change_reverted) ? ' · **later reverted**' : ''}`,
            `- Diff: ${r.first_change_diff}`,
            `- Claim: ${r.claim_text}`,
            `- Why it was flagged: ${r.rationale}`,
            '',
            '**Before**',
            '',
            '```',
            `${r.before_prose}`,
            `${r.before_footnote}`,
            '```',
            '',
            '**After**',
            '',
            '```',
            `${r.after_prose}`,
            `${r.after_footnote}`,
            '```',
            '',
        );
    });
    return lines.join('\n');
}

/**
 * Per-page detail for a validation run (--titles): every revision after
 * go-live with its tags, and every claim that changed. Small enough to read,
 * or paste, in full.
 */
export function pagesMarkdown(wiki, results) {
    const lines = [`# Per-page detail — ${wiki}`, ''];
    for (const page of results) {
        const flagged = page.suggestions.filter(s => s.group === 'flagged');
        const supported = page.suggestions.filter(s => s.group === 'supported');
        lines.push(`## ${page.page_title}`, '');
        if (!page.suggestions.length) lines.push('No Source Verification suggestion on this page (not in any batch).', '');
        else {
            const located = rows => rows.filter(s => yes(s.located)).length;
            lines.push(`Baseline r${page.baseline_revision_id ?? '?'}. Flagged: ${flagged.length} (${located(flagged)} located).`
                + ` Supported: ${supported.length} (${located(supported)} located).${page.error ? ` **${page.error}**` : ''}`, '');
        }
        lines.push('| Revision | Time | Editor | Bot | seen | used | VE | reverted | First changes (flagged/supported) |', '|---|---|---|---|---|---|---|---|---|');
        for (const r of page.revisions) {
            lines.push(`| [${r.rev_id}](${r.diff}) | ${r.timestamp} | ${r.user ?? '(hidden)'} (${r.editor_type}) | ${yes(r.is_bot) ? 'yes' : ''}`
                + ` | ${yes(r.seen) ? 'yes' : ''} | ${yes(r.used) ? 'yes' : ''} | ${yes(r.visualeditor) ? 'yes' : ''} | ${yes(r.mw_reverted) ? 'yes' : ''}`
                + ` | ${r.first_changes_flagged ?? 0}/${r.first_changes_supported ?? 0} |`);
        }
        if (!page.revisions.length) lines.push('| (no revisions after go-live) | | | | | | | | |');
        lines.push('');
        const changed = page.suggestions.filter(s => yes(s.changed));
        if (changed.length) {
            lines.push('Changed claims:', '');
            for (const s of changed) {
                lines.push(`- **${s.group}** ${s.verdict} [${s.citation_number}] “${String(s.claim_text).slice(0, 140)}” — ${s.first_change_kinds}`
                    + ` in r${s.first_change_rev_id} by ${s.first_change_user || '(hidden)'}${yes(s.first_change_seen) ? ' (seen)' : ''}${yes(s.first_change_used) ? ' (used)' : ''}`);
            }
            lines.push('');
        }
        const notLocated = page.suggestions.filter(s => s.group === 'flagged' && !yes(s.located));
        if (notLocated.length) {
            lines.push('Flagged claims not located in the baseline:', '');
            for (const s of notLocated) lines.push(`- [${s.citation_number}] “${String(s.claim_text).slice(0, 140)}”`);
            lines.push('');
        }
    }
    return lines.join('\n');
}
