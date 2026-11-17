import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    autoAcceptState,
    selectSpotChecks,
    disputedRows,
    parseCommands,
    applyCommands,
    renderCommandReply,
    buildDigest,
    renderDigest,
    isoWeek,
    DROPPED_REASON,
    SPOT_CHECK_SIZE,
} from '../feedback-loop/digest.js';
import { selectForTriage, normalizeCase } from '../feedback-loop/cases.js';

// A field-set row as triage writes it, reduced to what the digest reads.
function fieldRow(checkId, { status = 'agreed', held = false, groundTruth = 'Supported', audit, feedbackAt = '2026-11-01T00:00:00Z', triagedAt = '2026-11-10T00:00:00Z', suggestedBy = 'editor' } = {}) {
    return {
        id: `field_${checkId}`,
        article_url: `https://en.wikipedia.org/w/index.php?title=A&oldid=1`,
        article_title: 'Article',
        citation_number: '3',
        claim_text: 'The bridge opened in 2002.',
        source_url: 'https://example.org/bridge',
        ground_truth: groundTruth,
        needs_manual_review: status !== 'agreed' || held,
        excluded_reason: null,
        field: {
            check_id: checkId,
            tool: { model: 'llm-qwen38-27b', verdict: 'NOT SUPPORTED', comments: 'The source does not mention it.' },
            feedback: { rating: -1, corrected_verdict: 'SUPPORTED', feedback_at: feedbackAt },
            adjudication: { blind: { verdict: 'SUPPORTED', explanation: 'Stated.', verifiedQuote: 'The bridge opened to traffic in 2002' } },
            label: { status, proposed_ground_truth: groundTruth, suggested_by: suggestedBy, reasons: status === 'agreed' ? [] : ['the independent reading says NOT SUPPORTED, the editor SUPPORTED'], held },
            ...(audit ? { audit } : {}),
            triaged_at: triagedAt,
        },
    };
}

const accepted = (n, prefix = 'acc') => Array.from({ length: n }, (_, i) => fieldRow(`${prefix}${String(i).padStart(5, '0')}`));

test('auto-accept pauses only when more than one of the last ten spot-checks failed', () => {
    const audit = (result, day) => ({ result, at: `2026-11-${String(day).padStart(2, '0')}T00:00:00Z` });
    const rows = r => r.map(([result, day], i) => fieldRow(`aud${String(i).padStart(5, '0')}`, { status: 'owner', audit: audit(result, day) }));
    assert.equal(autoAcceptState([]).paused, false, 'no audits, no pause');
    assert.equal(autoAcceptState(rows([['wrong', 1]])).paused, false, 'one wrong label is noise');
    const twoWrong = autoAcceptState(rows([['wrong', 1], ['wrong', 2], ['ok', 3]]));
    assert.deepEqual(twoWrong, { paused: true, wrong: 2, checked: 3, window: 10 });
    // Old failures age out of the window as newer spot-checks pass.
    const recovered = rows([['wrong', 1], ['wrong', 2], ...Array.from({ length: 10 }, (_, i) => ['ok', 10 + i])]);
    assert.equal(autoAcceptState(recovered).paused, false);
});

test('spot-checks sample only unaudited auto-accepted rows, the same way all week', () => {
    const rows = [
        ...accepted(12),
        fieldRow('held0001', { held: true }),
        fieldRow('disp0001', { status: 'needs_owner' }),
        fieldRow('done0001', { status: 'owner', audit: { result: 'ok', at: '2026-11-01T00:00:00Z' } }),
    ];
    const a = selectSpotChecks(rows, { seed: '2026-W47' });
    assert.equal(a.length, SPOT_CHECK_SIZE);
    assert.ok(a.every(r => r.field.check_id.startsWith('acc')));
    assert.deepEqual(selectSpotChecks(rows, { seed: '2026-W47' }).map(r => r.id), a.map(r => r.id), 'deterministic per week');
    const other = selectSpotChecks(rows, { seed: '2026-W48' }).map(r => r.id);
    assert.notDeepEqual(other, a.map(r => r.id), 'a different week draws differently');
    assert.equal(selectSpotChecks(accepted(2)).length, 2, 'fewer candidates than the sample size');
});

test('disputed rows come oldest first, with a total beyond the limit', () => {
    const rows = [
        fieldRow('new00001', { status: 'needs_owner', feedbackAt: '2026-11-09T00:00:00Z' }),
        fieldRow('old00001', { status: 'needs_owner', feedbackAt: '2026-10-01T00:00:00Z' }),
        fieldRow('held0001', { held: true, feedbackAt: '2026-10-15T00:00:00Z' }),
        ...accepted(3),
    ];
    const { shown, total } = disputedRows(rows, { limit: 2 });
    assert.equal(total, 3);
    assert.deepEqual(shown.map(r => r.field.check_id), ['old00001', 'held0001']);
});

test('parseCommands reads one command per id-led line and ignores prose', () => {
    const commands = parseCommands([
        'Thanks, looked at these:',
        '`a1b2c3d4` ok',
        '- B2C3D4E5: not supported',
        '/c3d4e5f6 → partially.',
        'd4e5f6a7 drop',
        'e5f6a7b8 Source unavailable',
        'f6a7b8c9 maybe?',
        'a1b2c3d4e5 ok',
        'the check 12345678 was fine',
    ].join('\n'));
    assert.deepEqual(commands, [
        { checkId: 'a1b2c3d4', action: 'ok' },
        { checkId: 'b2c3d4e5', action: 'label', verdict: 'NOT SUPPORTED' },
        { checkId: 'c3d4e5f6', action: 'label', verdict: 'PARTIALLY SUPPORTED' },
        { checkId: 'd4e5f6a7', action: 'drop' },
        { checkId: 'e5f6a7b8', action: 'label', verdict: 'SOURCE UNAVAILABLE' },
        { checkId: 'f6a7b8c9', action: 'unknown', text: 'maybe?' },
    ]);
});

test('ok on an auto-accepted row is a passed spot-check, and the row becomes the owner\'s', () => {
    const { rows, applied, changed } = applyCommands([fieldRow('a1b2c3d4')], [{ checkId: 'a1b2c3d4', action: 'ok' }], { at: '2026-11-20T00:00:00Z', by: 'alex' });
    assert.equal(changed, true);
    const r = rows[0];
    assert.deepEqual(r.field.audit, { result: 'ok', at: '2026-11-20T00:00:00Z', previous: 'Supported', was_held: false });
    assert.equal(r.field.label.status, 'owner');
    assert.equal(r.field.label.decided_by, 'alex');
    assert.equal(r.ground_truth, 'Supported');
    assert.match(applied[0].note, /spot-check passed/);
});

test('relabelling an auto-accepted row counts against auto-accepting', () => {
    const { rows, applied } = applyCommands([fieldRow('a1b2c3d4')], [{ checkId: 'a1b2c3d4', action: 'label', verdict: 'NOT SUPPORTED' }]);
    assert.equal(rows[0].ground_truth, 'Not supported');
    assert.equal(rows[0].field.audit.result, 'wrong');
    assert.equal(rows[0].needs_manual_review, false);
    assert.match(applied[0].note, /relabelled \*\*Not supported\*\* \(was Supported\)/);
});

test('ok on a disputed row accepts the suggestion without counting as a spot-check', () => {
    const { rows } = applyCommands([fieldRow('d1d2d3d4', { status: 'needs_owner' })], [{ checkId: 'd1d2d3d4', action: 'ok' }]);
    assert.equal(rows[0].needs_manual_review, false);
    assert.equal(rows[0].field.label.status, 'owner');
    assert.equal(rows[0].field.audit, undefined, 'the rule did not decide this row, so it is not an audit of the rule');
});

test('a decision on a row held during a pause is a spot-check of the rule', () => {
    const { rows } = applyCommands([fieldRow('a1a2a3a4', { held: true })], [{ checkId: 'a1a2a3a4', action: 'ok' }]);
    assert.equal(rows[0].field.audit.result, 'ok');
    assert.equal(rows[0].field.audit.was_held, true);
    assert.equal(rows[0].needs_manual_review, false);
});

test('drop keeps the row as a marker, so triage does not read the check again', () => {
    const { rows } = applyCommands([fieldRow('d1d2d3d4', { status: 'needs_owner' })], [{ checkId: 'd1d2d3d4', action: 'drop' }]);
    assert.equal(rows.length, 1, 'never deleted');
    assert.equal(rows[0].excluded_reason, DROPPED_REASON);
    assert.equal(rows[0].needs_manual_review, false);
    const theCase = normalizeCase({ check_id: 'd1d2d3d4', rating: -1, corrected_verdict: 'SUPPORTED', verdict: 'NOT SUPPORTED', claim_text: 'c', source_url: 'https://x.org' });
    const { toTriage, skipped } = selectForTriage([theCase], rows.map(r => r.field.check_id));
    assert.equal(toTriage.length, 0);
    assert.equal(skipped[0].reason, 'already_triaged');
});

test('commands that cannot apply are reported, and change nothing', () => {
    const before = [fieldRow('a1b2c3d4', { status: 'needs_owner', groundTruth: null })];
    const { rows, errors, changed } = applyCommands(before, [
        { checkId: 'ffffffff', action: 'ok' },
        { checkId: 'a1b2c3d4', action: 'ok' },
        { checkId: 'a1b2c3d4', action: 'unknown', text: 'maybe?' },
    ]);
    assert.equal(changed, false);
    assert.deepEqual(rows, before);
    assert.deepEqual(errors.map(e => e.checkId), ['ffffffff', 'a1b2c3d4', 'a1b2c3d4']);
    assert.match(errors[1].error, /no suggested label/);
    assert.match(errors[2].error, /not a command/);
});

test('a second decision on the same row in one comment builds on the first', () => {
    const { rows, errors } = applyCommands([fieldRow('a1b2c3d4')], [
        { checkId: 'a1b2c3d4', action: 'label', verdict: 'NOT SUPPORTED' },
        { checkId: 'a1b2c3d4', action: 'ok' },
    ]);
    assert.equal(rows[0].ground_truth, 'Not supported');
    assert.match(errors[0].error, /already decided/);
});

test('the reply lists what was applied and what was not', () => {
    const reply = renderCommandReply({
        applied: [{ checkId: 'a1b2c3d4', note: 'confirmed **Supported** — spot-check passed' }],
        errors: [{ checkId: 'ffffffff', error: 'is not in the field set' }],
    }, { state: { paused: true, wrong: 2, checked: 4 } });
    assert.match(reply, /- `a1b2c3d4` confirmed \*\*Supported\*\*/);
    assert.match(reply, /Not applied:\n\n- `ffffffff` is not in the field set/);
    assert.match(reply, /Auto-accept is \*\*paused\*\*: 2 of the last 4/);
});

test('the digest explains how to answer and gives each row its own command line', () => {
    const rows = [...accepted(3), fieldRow('d1d2d3d4', { status: 'needs_owner', suggestedBy: 'adjudicator' })];
    rows[0].claim_text = 'Ask @someone about #398 | here';
    const digest = buildDigest(rows, { week: '2026-W47', now: new Date('2026-11-16T00:00:00Z') });
    assert.equal(digest.items, 4);
    const body = renderDigest(digest);
    assert.match(body, /^# Feedback digest — 2026-W47/);
    assert.match(body, /Auto-accept is on/);
    assert.match(body, /## Spot-check \(3\)/);
    assert.match(body, /Reply `acc00000 ok` if that is right/);
    assert.match(body, /## Needs a decision \(1\)/);
    assert.match(body, /Suggested label:\*\* \*\*Supported\*\* \(from the independent reading\)/);
    assert.match(body, /Reply `d1d2d3d4 ok` to accept Supported/);
    assert.match(body, /> The bridge opened to traffic in 2002/);
    assert.ok(body.includes('@​someone') && body.includes('#​398') && body.includes('\\|'), 'claim text is neutralized');
});

test('an empty field set makes an empty digest', () => {
    const digest = buildDigest([], { week: '2026-W47' });
    assert.equal(digest.items, 0);
    assert.match(renderDigest(digest), /_Nothing waiting._/);
});

test('isoWeek follows ISO 8601, including the year boundary', () => {
    assert.equal(isoWeek(new Date('2026-11-17T12:00:00Z')), '2026-W47');
    assert.equal(isoWeek(new Date('2027-01-01T00:00:00Z')), '2026-W53');
    assert.equal(isoWeek(new Date('2026-12-28T00:00:00Z')), '2026-W53');
});
