#!/usr/bin/env node
// The owner's side of the loop: a weekly digest issue, and the one-line
// replies that answer it.
//
// Agreed labels land in the field set without anyone approving them (see
// run-triage.js). Oversight is by audit instead: every week the digest shows
// a few randomly chosen auto-accepted rows to spot-check, plus the rows the
// rule could not decide. The owner answers in a comment, one line per check:
//
//   a1b2c3d4 ok              the label shown is right (or: accept the suggestion)
//   a1b2c3d4 not supported   the right label is this one
//   a1b2c3d4 drop            leave this check out of the field set for good
//
// .github/workflows/feedback-commands.yml applies the owner's replies and
// confirms them. If the spot-checks keep finding wrong labels, auto-accepting
// pauses by itself (autoAcceptState), and agreed rows wait for the owner like
// every other row until audits recover.
//
//   node feedback-loop/digest.js render --field FILE [--week 2026-W47] [--out FILE]
//   node feedback-loop/digest.js apply --field FILE [--by LOGIN] [--comment-file FILE] [--reply-out FILE]
//
// `apply` reads the comment from --comment-file, or the COMMENT_BODY
// environment variable (never interpolated into a shell: it is untrusted).

import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { toTitleCase } from '../core/verdicts.js';
import { LABEL_STATUSES } from './adjudicate.js';
import { loadFieldSet, writeFieldSet, summarizeFieldRows } from './field-set.js';
import { md, safeUrl } from './report.js';

export const SPOT_CHECK_SIZE = 5;
export const DIGEST_DISPUTED_LIMIT = 20;
// Auto-accepting pauses when more than this many of the last AUDIT_WINDOW
// spot-checks found a wrong label: 2 in 10.
export const AUDIT_WINDOW = 10;
export const AUDIT_MAX_WRONG = 1;
export const DROPPED_REASON = 'dropped by the owner';

/**
 * Whether agreed labels may still be accepted without review, from the
 * owner's most recent spot-checks.
 */
export function autoAcceptState(rows, { window = AUDIT_WINDOW, maxWrong = AUDIT_MAX_WRONG } = {}) {
    const audits = rows.map(r => r.field?.audit).filter(Boolean)
        .sort((a, b) => String(b.at).localeCompare(String(a.at)))
        .slice(0, window);
    const wrong = audits.filter(a => a.result === 'wrong').length;
    return { paused: wrong > maxWrong, wrong, checked: audits.length, window };
}

// mulberry32, seeded from a string: the same week always draws the same rows.
function seededRandom(seed) {
    let h = 1779033703 ^ String(seed).length;
    for (const ch of String(seed)) {
        h = Math.imul(h ^ ch.codePointAt(0), 3432918353);
        h = (h << 13) | (h >>> 19);
    }
    let a = h >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const feedbackAt = r => String(r.field?.feedback?.feedback_at ?? '');

/** A random sample of auto-accepted rows nobody has audited yet. */
export function selectSpotChecks(rows, { size = SPOT_CHECK_SIZE, seed = 'seed' } = {}) {
    const pool = rows.filter(r => r.field?.label?.status === LABEL_STATUSES.AGREED
        && !r.needs_manual_review && !r.field.audit && !r.excluded_reason)
        .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const random = seededRandom(seed);
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, size).sort((a, b) => feedbackAt(a).localeCompare(feedbackAt(b)));
}

/** Rows waiting for a decision, oldest first. */
export function disputedRows(rows, { limit = DIGEST_DISPUTED_LIMIT } = {}) {
    const all = rows.filter(r => r.needs_manual_review).sort((a, b) => feedbackAt(a).localeCompare(feedbackAt(b)));
    return { shown: all.slice(0, limit), total: all.length };
}

// ---- Replies ----

const OK_WORDS = new Set(['ok', 'okay', 'accept', 'right', 'correct', 'yes']);
const DROP_WORDS = new Set(['drop', 'exclude', 'remove']);
const VERDICT_WORDS = new Map([
    ['supported', 'SUPPORTED'],
    ['partially', 'PARTIALLY SUPPORTED'], ['partial', 'PARTIALLY SUPPORTED'], ['partially supported', 'PARTIALLY SUPPORTED'],
    ['not supported', 'NOT SUPPORTED'], ['unsupported', 'NOT SUPPORTED'], ['not', 'NOT SUPPORTED'],
    ['unavailable', 'SOURCE UNAVAILABLE'], ['source unavailable', 'SOURCE UNAVAILABLE'],
]);

/**
 * One command per line that starts with a check id; every other line is
 * ignored, so a reply can carry prose. Backticks, list markers and a
 * leading slash are tolerated, as are separators like ":" or "→".
 */
export function parseCommands(text) {
    const commands = [];
    for (const raw of String(text ?? '').split(/\r?\n/)) {
        const line = raw.replace(/[`*]/g, '').trim().replace(/^(?:[-•>/]\s*)+/, '');
        const match = line.match(/^([0-9a-f]{8})(?![0-9a-z])[\s:=,→\-]*(.*)$/i);
        if (!match) continue;
        const checkId = match[1].toLowerCase();
        const word = match[2].trim().toLowerCase().replace(/[.!]+$/, '').replace(/\s+/g, ' ');
        if (OK_WORDS.has(word)) commands.push({ checkId, action: 'ok' });
        else if (DROP_WORDS.has(word)) commands.push({ checkId, action: 'drop' });
        else if (VERDICT_WORDS.has(word)) commands.push({ checkId, action: 'label', verdict: VERDICT_WORDS.get(word) });
        else commands.push({ checkId, action: 'unknown', text: match[2].trim() });
    }
    return commands;
}

function decide(row, cmd, { at, by }) {
    const label = row.field?.label ?? {};
    // Agreed by the rule, whether accepted or held while auto-accept was
    // paused: a decision on such a row is a spot-check of the rule.
    const agreedByRule = label.status === LABEL_STATUSES.AGREED && !row.field.audit;
    const next = structuredClone(row);
    let audit = null;
    let note;
    if (cmd.action === 'ok') {
        if (!next.ground_truth) return { error: 'has no suggested label: reply with a verdict instead' };
        if (label.status === LABEL_STATUSES.OWNER) return { error: 'was already decided' };
        if (agreedByRule) audit = 'ok';
        next.needs_manual_review = false;
        note = `confirmed **${next.ground_truth}**`;
    } else if (cmd.action === 'label') {
        const title = toTitleCase(cmd.verdict);
        if (agreedByRule) audit = title === row.ground_truth ? 'ok' : 'wrong';
        next.ground_truth = title;
        next.needs_manual_review = false;
        note = row.ground_truth && row.ground_truth !== title ? `relabelled **${title}** (was ${row.ground_truth})` : `labelled **${title}**`;
    } else if (cmd.action === 'drop') {
        if (agreedByRule) audit = 'wrong';
        // Kept as a marker rather than deleted: a deleted row's check id
        // would look untriaged, and the next run would read it again.
        next.excluded_reason = DROPPED_REASON;
        next.needs_manual_review = false;
        note = 'dropped from the field set';
    } else {
        return { error: `"${cmd.text}" is not a command (ok, drop, supported, partially, not supported, unavailable)` };
    }
    next.field.label = { ...label, status: LABEL_STATUSES.OWNER, decided_at: at, decided_by: by };
    if (audit) {
        next.field.audit = { result: audit, at, previous: row.ground_truth, was_held: Boolean(row.needs_manual_review) };
        note += audit === 'wrong' ? ' — counted as a wrong auto-accepted label' : ' — spot-check passed';
    }
    return { row: next, note };
}

/**
 * Applies parsed commands to the field set. Rows are never deleted.
 * @returns {{rows: object[], applied: {checkId, note}[], errors: {checkId, error}[], changed: boolean}}
 */
export function applyCommands(rows, commands, { at = new Date().toISOString(), by = null } = {}) {
    const updated = new Map();
    const byId = new Map(rows.map(r => [r.field?.check_id, r]));
    const applied = [];
    const errors = [];
    for (const cmd of commands) {
        const current = updated.get(cmd.checkId) ?? byId.get(cmd.checkId);
        if (!current) {
            errors.push({ checkId: cmd.checkId, error: 'is not in the field set' });
            continue;
        }
        const result = decide(current, cmd, { at, by });
        if (result.error) {
            errors.push({ checkId: cmd.checkId, error: result.error });
            continue;
        }
        updated.set(cmd.checkId, result.row);
        applied.push({ checkId: cmd.checkId, note: result.note });
    }
    return {
        rows: rows.map(r => updated.get(r.field?.check_id) ?? r),
        applied, errors,
        changed: updated.size > 0,
    };
}

export function renderCommandReply({ applied, errors }, { state } = {}) {
    const lines = [];
    if (applied.length) {
        lines.push('Applied to `benchmark/dataset_field.json`:', '');
        for (const a of applied) lines.push(`- \`${a.checkId}\` ${a.note}`);
    }
    if (errors.length) {
        if (lines.length) lines.push('');
        lines.push('Not applied:', '');
        for (const e of errors) lines.push(`- \`${e.checkId}\` ${md(e.error)}`);
    }
    if (state?.paused) lines.push('', `Auto-accept is **paused**: ${state.wrong} of the last ${state.checked} spot-checks were wrong. Agreed labels now wait for a decision.`);
    return `${lines.join('\n')}\n`;
}

// ---- The digest ----

function link(label, url) {
    const target = safeUrl(url);
    return target ? `[${label}](${target})` : label;
}

function rowHeading(r) {
    const cite = r.citation_number ? ` [${md(r.citation_number)}]` : '';
    return `### \`${r.field.check_id}\` — ${link(md(r.article_title || 'unknown article'), r.article_url)}${cite}`;
}

function rowFacts(r) {
    const f = r.field;
    const editor = f.feedback?.corrected_verdict
        ? `${f.feedback.rating === -1 ? '👎' : '👍'} → ${f.feedback.corrected_verdict}`
        : (f.feedback?.rating === 1 ? '👍' : '👎 (no verdict given)');
    const lines = [
        `- **Tool** (${md(f.tool?.model ?? 'unknown model')}): ${f.tool?.verdict ?? '?'} — ${md(f.tool?.comments, 250)}`,
        `- **Editor:** ${editor}`,
    ];
    const blind = f.adjudication?.blind;
    if (blind) {
        lines.push(`- **Independent reading:** ${blind.verdict} — ${md(blind.explanation, 250)}`);
        if (blind.verifiedQuote) lines.push(`  > ${md(blind.verifiedQuote, 400)}`);
    }
    lines.push(`- **Claim:** ${md(r.claim_text, 350)} · ${link('source', r.source_url)}`);
    return lines;
}

const VERDICT_HINT = '`supported`, `partially`, `not supported` or `unavailable`';

function spotCheckBlock(r) {
    const id = r.field.check_id;
    return [
        rowHeading(r),
        `- **Accepted label: ${md(r.ground_truth)}**`,
        ...rowFacts(r),
        '',
        `Reply \`${id} ok\` if that is right; otherwise \`${id}\` and the right label (${VERDICT_HINT}).`,
    ].join('\n');
}

function disputedBlock(r) {
    const id = r.field.check_id;
    const reasons = r.field.label?.reasons ?? [];
    const suggestion = r.ground_truth
        ? `**${md(r.ground_truth)}** (from the ${r.field.label?.suggested_by === 'adjudicator' ? 'independent reading' : 'editor'})`
        : 'none';
    return [
        rowHeading(r),
        `- **Suggested label:** ${suggestion}`,
        reasons.length ? `- **Why it needs you:** ${reasons.map(x => md(x)).join('; ')}` : null,
        r.excluded_reason ? `- **Out of scoring:** ${md(r.excluded_reason)}` : null,
        ...rowFacts(r),
        '',
        r.ground_truth
            ? `Reply \`${id} ok\` to accept ${md(r.ground_truth)}, \`${id}\` and another label (${VERDICT_HINT}), or \`${id} drop\`.`
            : `Reply \`${id}\` and the right label (${VERDICT_HINT}), or \`${id} drop\`.`,
    ].filter(line => line !== null).join('\n');
}

/** ISO 8601 week, e.g. "2026-W47". */
export function isoWeek(date = new Date()) {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function buildDigest(rows, { week = isoWeek(), now = new Date() } = {}) {
    const spotChecks = selectSpotChecks(rows, { seed: week });
    const disputed = disputedRows(rows);
    const state = autoAcceptState(rows);
    const since = new Date(now.getTime() - 7 * 86400000).toISOString();
    const recent = rows.filter(r => String(r.field?.triaged_at ?? '') >= since);
    return {
        week, spotChecks, disputed, state,
        summary: summarizeFieldRows(rows),
        thisWeek: {
            added: recent.length,
            autoAccepted: recent.filter(r => r.field?.label?.status === LABEL_STATUSES.AGREED && !r.needs_manual_review).length,
        },
        items: spotChecks.length + disputed.total,
    };
}

export function renderDigest(digest) {
    const { week, spotChecks, disputed, state, summary, thisWeek } = digest;
    const out = [
        `# Feedback digest — ${week}`, '',
        `Field set: ${summary.rows} rows, ${summary.scoreable} scoreable, ${summary.needs_owner} waiting for a decision. Added in the last 7 days: ${thisWeek.added} (${thisWeek.autoAccepted} accepted automatically).`, '',
        state.paused
            ? `**Auto-accept is paused:** ${state.wrong} of the last ${state.checked} spot-checks found a wrong label, so agreed labels now wait below with the rest. It resumes once recent spot-checks pass.`
            : `Auto-accept is on (${state.wrong} wrong in the last ${state.checked} spot-checks).`,
        '',
        '## How to answer',
        '',
        'Reply to this issue with one line per check, starting with its id. Other lines are ignored, so you can write notes too.',
        '',
        '- `a1b2c3d4 ok` — the label shown is right (for a disputed row: accept the suggestion)',
        `- \`a1b2c3d4 not supported\` — the right label is this one (${VERDICT_HINT})`,
        '- `a1b2c3d4 drop` — leave this check out of the field set for good',
        '',
        'Replies are applied to `benchmark/dataset_field.json` within a few minutes and confirmed in a reply. Nothing has to be answered: an unanswered spot-check stays accepted, and an unanswered dispute stays out of scoring.',
        '',
        `## Spot-check (${spotChecks.length})`,
        '',
        'Labels accepted automatically, chosen at random. These are the oversight: wrong ones here pause auto-accepting.',
        '',
        spotChecks.length ? spotChecks.map(spotCheckBlock).join('\n\n') : '_No unaudited auto-accepted rows._',
        '',
        `## Needs a decision (${disputed.total}${disputed.total > disputed.shown.length ? `, oldest ${disputed.shown.length} shown` : ''})`,
        '',
        disputed.shown.length ? disputed.shown.map(disputedBlock).join('\n\n') : '_Nothing waiting._',
    ];
    return `${out.join('\n')}\n`;
}

function setGithubOutputs(values) {
    if (!process.env.GITHUB_OUTPUT) return;
    fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(values).map(([k, v]) => `${k}=${v}\n`).join(''));
}

function main() {
    const [command, ...rest] = process.argv.slice(2);
    const { values } = parseArgs({
        args: rest,
        options: {
            field: { type: 'string', default: 'benchmark/dataset_field.json' },
            week: { type: 'string', default: isoWeek() },
            out: { type: 'string' },
            by: { type: 'string' },
            'comment-file': { type: 'string' },
            'reply-out': { type: 'string' },
        },
    });
    const { rows, metadata } = loadFieldSet(values.field);

    if (command === 'render') {
        const digest = buildDigest(rows, { week: values.week });
        const body = renderDigest(digest);
        if (values.out) fs.writeFileSync(values.out, body);
        else process.stdout.write(body);
        setGithubOutputs({ items: digest.items });
        console.error(`${digest.spotChecks.length} spot-check(s), ${digest.disputed.total} waiting`);
        return;
    }
    if (command === 'apply') {
        const text = values['comment-file'] ? fs.readFileSync(values['comment-file'], 'utf8') : (process.env.COMMENT_BODY ?? '');
        const commands = parseCommands(text);
        if (!commands.length) {
            setGithubOutputs({ changed: false, replied: false });
            console.error('No commands in the comment.');
            return;
        }
        const result = applyCommands(rows, commands, { by: values.by ?? null });
        if (result.changed) writeFieldSet(values.field, result.rows, metadata);
        if (values['reply-out']) fs.writeFileSync(values['reply-out'], renderCommandReply(result, { state: autoAcceptState(result.rows) }));
        setGithubOutputs({ changed: result.changed, replied: Boolean(values['reply-out']) });
        console.error(`${result.applied.length} applied, ${result.errors.length} not applied`);
        return;
    }
    console.error('Usage: digest.js render [--field FILE --week W --out FILE] | digest.js apply [--field FILE --by LOGIN --comment-file FILE --reply-out FILE]');
    process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
