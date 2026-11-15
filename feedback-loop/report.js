// Markdown for a triage run: the full report committed alongside the field
// set, and a short PR body pointing at it.
//
// Everything quoted here is arbitrary text — article prose, model output,
// source passages — headed for GitHub, which renders Markdown and turns
// "@name" into a notification and "#123" into a link. md() neutralizes all of
// it. And as everywhere in this repo (CLAUDE.md, "Source quotes are verified
// before they are shown"), a source passage is shown only as the verified
// text core/quote.js located, never as the quote a model returned.

import { CAUSE_BRIEF_SECTION } from './adjudicate.js';
import { causeRule } from './causes.js';

const ZWSP = '​';

/** Inline-safe Markdown: one line, specials escaped, no mentions or autolinks. */
export function md(text, max = 0) {
    let s = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (max && s.length > max) s = `${s.slice(0, max - 1)}…`;
    return s
        .replace(/[\\`*_[\]<>|~]/g, ch => `\\${ch}`)
        .replace(/@/g, `@${ZWSP}`)
        .replace(/#(?=\d)/g, `#${ZWSP}`);
}

// encodeURIComponent leaves ( and ) alone, and a ")" is exactly what ends a
// Markdown link early, so the characters are mapped by hand.
const URL_ESCAPES = Object.freeze({ '(': '%28', ')': '%29', '<': '%3C', '>': '%3E', ' ': '%20', '\n': '%0A' });

/** A link target, or null: http(s) only, with Markdown-breaking characters encoded. */
export function safeUrl(url) {
    if (!/^https?:\/\//i.test(String(url ?? ''))) return null;
    return String(url).replace(/[()<> \n]/g, ch => URL_ESCAPES[ch]);
}

function link(label, url) {
    const target = safeUrl(url);
    return target ? `[${label}](${target})` : label;
}

const RATING = { 1: '👍', '-1': '👎' };

function editorLine(c) {
    const thumb = RATING[c.rating] ?? '—';
    if (c.correctedVerdict) return `${thumb} → ${c.correctedVerdict}${c.editor.inconsistent ? ' (same as the tool: contradicts the 👎)' : ''}`;
    return c.rating === -1 ? `${thumb} (no verdict given)` : thumb;
}

function evidence(adjudication) {
    const v = adjudication?.blind?.verifiedQuote;
    return v ? `\n  > ${md(v, 500)}` : '';
}

function causeOf(result) {
    return result.adjudication?.attribution?.cause ?? null;
}

function causeLabel(id) {
    return id ? `\`${id}\`` : '—';
}

function caseHeading(c) {
    const cite = c.check.citationNumber ? ` [${md(c.check.citationNumber)}]` : '';
    return `\`${c.checkId}\` — ${link(md(c.check.articleTitle || 'unknown article'), c.check.articleUrl)}${cite}`;
}

function caseBlock(result) {
    const { case: c, adjudication, label } = result;
    const lines = [`### ${caseHeading(c)}`];
    lines.push(`- **Tool** (${md(c.check.model ?? 'unknown model')}): **${c.check.verdict}**${c.check.reasonType ? ` (${c.check.reasonType})` : ''} — ${md(c.check.comments, 300)}`);
    lines.push(`- **Editor:** ${editorLine(c)}`);
    if (adjudication) {
        const b = adjudication.blind;
        lines.push(`- **Independent reading:** **${b.verdict}** — ${md(b.explanation, 300)}${evidence(adjudication)}`);
        const a = adjudication.attribution;
        lines.push(`- **Cause:** ${causeLabel(a.cause)} — ${md(a.explanation, 300)}`);
    }
    if (label?.reasons?.length) lines.push(`- **Why it needs you:** ${label.reasons.map(r => md(r)).join('; ')}`);
    if (label?.excludedReason) lines.push(`- **Excluded from scoring:** ${md(label.excludedReason)}`);
    if (result.hints?.length) lines.push(`- **Pattern hints:** ${result.hints.map(h => `\`${h}\``).join(', ')}`);
    lines.push(`- **Claim:** ${md(c.check.claimText, 400)} · ${link('source', c.check.sourceUrl)}`);
    return lines.join('\n');
}

function causeTable(results) {
    const groups = new Map();
    for (const r of results) {
        const key = causeOf(r) ?? '(not adjudicated)';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r.case.checkId);
    }
    if (!groups.size) return '_No cases._';
    const rows = [...groups.entries()].sort((a, b) => b[1].length - a[1].length).map(([cause, ids]) => {
        const section = CAUSE_BRIEF_SECTION[cause];
        return `| ${causeLabel(cause === '(not adjudicated)' ? null : cause)} | ${section ? `cause ${section}` : '—'} | ${ids.length} | ${ids.map(id => `\`${id}\``).join(' ')} |`;
    });
    return ['| Cause | Brief | Cases | Check ids |', '|---|---|---|---|', ...rows].join('\n');
}

function hintTable(results) {
    const counts = new Map();
    for (const r of results) for (const h of r.hints ?? []) counts.set(h, (counts.get(h) ?? 0) + 1);
    if (!counts.size) return '_No pattern hints fired._';
    const rows = [...counts.entries()].sort((a, b) => b[1] - a[1])
        .map(([id, n]) => `| \`${id}\` | ${md(causeRule(id)?.label ?? '')} | ${n} |`);
    return ['| Hint | Pattern | Cases |', '|---|---|---|', ...rows].join('\n');
}

function summaryLine({ results, failures, skipped, deferred, dryRun }) {
    const agreed = results.filter(r => r.label?.labelStatus === 'agreed').length;
    const parts = [dryRun
        ? `**${results.length}** cases fetched and tagged; a dry run proposes no labels.`
        : `**${results.length}** cases triaged: **${agreed}** agreed, **${results.length - agreed}** need your decision.`];
    if (failures.length) parts.push(`${failures.length} could not be triaged (retried next run).`);
    if (skipped.length) parts.push(`${skipped.length} skipped.`);
    if (deferred.length) parts.push(`${deferred.length} deferred to the next run.`);
    return parts.join(' ');
}

const HOW_TO_REVIEW = `## How to review

- **Merging accepts the agreed rows.** An editor and an independent reading (which saw only the claim and the source) reached the same verdict, and the passage it relies on was found in the source.
- **Rows that need your decision** are in \`benchmark/dataset_field.json\` with \`"needs_manual_review": true\` and a suggested \`ground_truth\`. To accept one, set \`"needs_manual_review": false\`; to relabel it, change \`ground_truth\` too; to drop it, delete the row. Later runs never overwrite a row you edited.
- Nothing here changes the tool. Fixes come as separate PRs, tested against this set.`;

/**
 * @param {object} run
 * @param {string} run.date - YYYY-MM-DD
 * @param {object[]} run.results - { case, adjudication, label, hints } per triaged case
 * @param {object[]} run.failures - { case, stage, error }
 * @param {object[]} run.skipped - { case, reason } from selectForTriage
 * @param {object[]} run.deferred - cases over the run's limit
 * @param {object} [run.fieldSummary] - summarizeFieldRows() of the merged set
 * @param {string|null} [run.model]
 * @param {{input:number, output:number, calls:number}} [run.usage]
 * @param {boolean} [run.dryRun]
 */
export function renderTriageReport(run) {
    const { date, results = [], failures = [], skipped = [], deferred = [], fieldSummary, model, usage, dryRun } = run;
    const needsOwner = results.filter(r => r.label?.labelStatus !== 'agreed');
    const agreed = results.filter(r => r.label?.labelStatus === 'agreed');
    const out = [`# Feedback triage — ${date}${dryRun ? ' (dry run: no model calls)' : ''}`, ''];
    out.push(summaryLine({ results, failures, skipped, deferred, dryRun }));
    if (fieldSummary) {
        out.push('', `Field set after this run: ${fieldSummary.rows} rows, ${fieldSummary.scoreable} scoreable, ${fieldSummary.needs_owner} awaiting a decision, ${fieldSummary.excluded} excluded.`);
    }
    out.push('', HOW_TO_REVIEW, '', '## By cause', '', dryRun ? hintTable(results) : causeTable(results));

    if (!dryRun) out.push('', '### Pattern hints', '', hintTable(results));

    out.push('', dryRun ? `## Cases (${needsOwner.length})` : `## Needs your decision (${needsOwner.length})`, '');
    out.push(needsOwner.length ? needsOwner.map(caseBlock).join('\n\n') : '_None._');

    out.push('', `## Agreed (${agreed.length})`, '');
    if (agreed.length) {
        out.push('| Check | Article | Tool → label | Cause |', '|---|---|---|---|');
        for (const r of agreed) {
            out.push(`| \`${r.case.checkId}\` | ${link(md(r.case.check.articleTitle || '?', 60), r.case.check.articleUrl)} | ${r.case.check.verdict} → ${md(r.label.groundTruth)} | ${causeLabel(causeOf(r))} |`);
        }
    } else {
        out.push('_None._');
    }

    if (failures.length || skipped.length || deferred.length) {
        out.push('', '## Not triaged', '');
        for (const f of failures) out.push(`- \`${f.case.checkId}\` — ${f.stage} failed: ${md(f.error, 200)}`);
        const byReason = new Map();
        for (const s of skipped) {
            if (!byReason.has(s.reason)) byReason.set(s.reason, []);
            byReason.get(s.reason).push(s.case.checkId);
        }
        for (const [reason, ids] of byReason) {
            const shown = ids.slice(0, 40).map(id => `\`${id}\``).join(' ');
            out.push(`- Skipped, \`${reason}\` (${ids.length}): ${shown}${ids.length > 40 ? ' …' : ''}`);
        }
        if (deferred.length) out.push(`- Deferred to the next run (over the limit): ${deferred.length}`);
    }

    if (usage?.calls) {
        out.push('', '## Model use', '', `${md(model ?? 'unknown model')}: ${usage.calls} calls, ${usage.input} input and ${usage.output} output tokens.`);
    }
    return `${out.join('\n')}\n`;
}

/** A short PR body: the summary, the review instructions, and where the rest is. */
export function renderPrBody({ date, reportPath, results = [], failures = [], skipped = [], deferred = [], fieldSummary }) {
    const lines = [
        `Nightly triage of editor feedback, ${date}.`, '',
        summaryLine({ results, failures, skipped, deferred }),
    ];
    if (fieldSummary) lines.push('', `Field set after this run: ${fieldSummary.rows} rows, ${fieldSummary.scoreable} scoreable.`);
    lines.push('', `The full report, with every case, is \`${reportPath}\` in this PR.`, '', HOW_TO_REVIEW, '', '## By cause', '', causeTable(results));
    return `${lines.join('\n')}\n`;
}
