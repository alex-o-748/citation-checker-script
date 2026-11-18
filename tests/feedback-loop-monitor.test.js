import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    buildMonitorSql,
    evaluateAlerts,
    indexSnapshot,
    renderMonitorReport,
    alertFingerprint,
    shouldComment,
    DEFAULT_THRESHOLDS,
} from '../feedback-loop/monitor.js';
import { CAUSE_RULES, causeRule, causeSql } from '../feedback-loop/causes.js';

// One row of the snapshot's `models` array, as the generated SQL returns it.
function modelRow(win, model, checks, shares = {}, patterns = {}) {
    const n = share => Math.round(checks * share);
    const row = {
        win, model, checks,
        supported: n(shares.supported ?? 0.45),
        partially: n(shares.partially ?? 0.10),
        not_supported: n(shares.not_supported ?? 0.25),
        unavailable: n(shares.unavailable ?? 0.20),
        fetch_failed: n(shares.fetch_failed ?? 0.12),
    };
    for (const rule of CAUSE_RULES) if (rule.id !== 'fetch_failed') row[rule.id] = n(patterns[rule.id] ?? 0.02);
    return row;
}

function snapshot(models, feedback = []) {
    return { generated_at: '2026-11-15T06:43:00Z', window_days: 7, baseline_days: 28, models, failing_hosts: [], feedback };
}

const keys = alerts => alerts.map(a => a.key).sort();

test('a steady week raises nothing', () => {
    const snap = snapshot([modelRow('baseline', 'llm-qwen38-27b', 8000), modelRow('current', 'llm-qwen38-27b', 2000)]);
    assert.deepEqual(evaluateAlerts(snap), []);
});

test('the October default switch: a new model carrying the traffic', () => {
    // gpt-oss-20b was the default; Qwen3.8 took over within a week.
    const snap = snapshot([
        modelRow('baseline', 'openai/gpt-oss-20b', 12000),
        modelRow('current', 'openai/gpt-oss-20b', 150),
        modelRow('current', 'llm-qwen38-27b', 2500),
    ]);
    assert.deepEqual(keys(evaluateAlerts(snap)), ['gone-model:openai/gpt-oss-20b', 'new-model:llm-qwen38-27b']);
});

test('one person\'s own key starting or stopping is not an alert', () => {
    const snap = snapshot([
        modelRow('baseline', 'llm-qwen38-27b', 9000), modelRow('baseline', 'claude-sonnet-4-6', 535),
        modelRow('current', 'llm-qwen38-27b', 3500),
    ]);
    assert.deepEqual(evaluateAlerts(snap), []);
});

test('the late-October jump in SOURCE UNAVAILABLE, said by the model', () => {
    const snap = snapshot([
        modelRow('baseline', 'llm-qwen38-27b', 8000, { unavailable: 0.20, fetch_failed: 0.13, supported: 0.50 }),
        modelRow('current', 'llm-qwen38-27b', 2000, { unavailable: 0.39, fetch_failed: 0.13, supported: 0.31 }),
    ]);
    const k = keys(evaluateAlerts(snap));
    assert.ok(k.includes('share:llm-qwen38-27b:unavailable:up'));
    assert.ok(k.includes('share:llm-qwen38-27b:model_unavailable:up'), 'the model, not the fetcher');
    assert.ok(!k.includes('share:llm-qwen38-27b:fetch_failed:up'));
    assert.ok(k.includes('share:all models:unavailable:up'), 'and visible across all models');
});

test('the September Wayback throttling: fetch failures, not the model', () => {
    const snap = snapshot([
        modelRow('baseline', 'openai/gpt-oss-20b', 8000, { unavailable: 0.18, fetch_failed: 0.10 }),
        modelRow('current', 'openai/gpt-oss-20b', 2000, { unavailable: 0.30, fetch_failed: 0.22 }),
    ]);
    const k = keys(evaluateAlerts(snap));
    assert.ok(k.includes('share:openai/gpt-oss-20b:fetch_failed:up'));
    assert.ok(!k.includes('share:openai/gpt-oss-20b:model_unavailable:up'));
});

test('a pattern rate must rise both relatively and absolutely', () => {
    const rising = snapshot([
        modelRow('baseline', 'm', 5000, {}, { unusable_page: 0.01 }),
        modelRow('current', 'm', 1000, {}, { unusable_page: 0.04 }),
    ]);
    assert.ok(keys(evaluateAlerts(rising)).includes('pattern:m:unusable_page'));
    const tiny = snapshot([
        modelRow('baseline', 'm', 5000, {}, { unusable_page: 0.002 }),
        modelRow('current', 'm', 1000, {}, { unusable_page: 0.006 }),
    ]);
    assert.ok(!keys(evaluateAlerts(tiny)).includes('pattern:m:unusable_page'), 'tripled, but by under 2 points');
});

test('small models are not compared on shares', () => {
    const snap = snapshot([
        modelRow('baseline', 'gemini-flash-latest', 26, { unavailable: 1.0 }),
        modelRow('current', 'gemini-flash-latest', 18, { unavailable: 0.55 }),
        modelRow('baseline', 'llm-qwen38-27b', 9000), modelRow('current', 'llm-qwen38-27b', 3000),
    ]);
    assert.ok(!keys(evaluateAlerts(snap)).some(k => k.includes('gemini')));
    assert.ok(DEFAULT_THRESHOLDS.minChecks > 26);
});

test('thumbs-down on flags needs enough ratings on both sides', () => {
    const models = [modelRow('baseline', 'm', 5000), modelRow('current', 'm', 1000)];
    const moved = snapshot(models, [
        { win: 'baseline', rated_flags: 60, down_on_flags: 30 },
        { win: 'current', rated_flags: 25, down_on_flags: 20 },
    ]);
    assert.ok(keys(evaluateAlerts(moved)).includes('feedback:down-on-flags:up'));
    const thin = snapshot(models, [
        { win: 'baseline', rated_flags: 60, down_on_flags: 30 },
        { win: 'current', rated_flags: 5, down_on_flags: 5 },
    ]);
    assert.ok(!keys(evaluateAlerts(thin)).includes('feedback:down-on-flags:up'));
});

test('indexSnapshot derives model-made unavailability and an all-models row', () => {
    const idx = indexSnapshot(snapshot([modelRow('current', 'a', 100), modelRow('current', 'b', 300)]));
    assert.equal(idx.current.get('a').model_unavailable, 20 - 12);
    assert.equal(idx.current.get('all models').checks, 400);
});

test('a standing alert comments once, not every day', () => {
    const alerts = [{ key: 'share:m:unavailable:up', text: 'x' }];
    const body = renderMonitorReport(snapshot([modelRow('current', 'm', 300)]), alerts);
    assert.match(body, new RegExp(`<!-- monitor-alerts: ${alertFingerprint(alerts)} -->`));
    assert.equal(shouldComment(alerts, ''), true, 'first sighting');
    assert.equal(shouldComment(alerts, body), false, 'unchanged since yesterday');
    assert.equal(shouldComment([...alerts, { key: 'pattern:m:unusable_page', text: 'y' }], body), true, 'a new alert joined');
    assert.equal(shouldComment([], body), false, 'nothing to say');
    assert.equal(alertFingerprint([{ key: 'b' }, { key: 'a' }]), alertFingerprint([{ key: 'a' }, { key: 'b' }]), 'order does not matter');
});

test('the report escapes model names and lists hosts', () => {
    const snap = snapshot([modelRow('current', 'evil|model @someone', 300)]);
    snap.failing_hosts = [{ host: 'doi.org', checks: 157, fetch_failed: 85 }];
    const body = renderMonitorReport(snap, []);
    assert.ok(body.includes('evil\\|model @​someone'));
    assert.match(body, /\| doi\.org \| 85 \| 157 \| 54\.1% \|/);
    assert.match(body, /## Alerts \(0\)\n\n_None\._/);
});

test('the generated SQL counts exactly what the cause rules define', () => {
    const sql = buildMonitorSql({ days: 3, baselineDays: 14 });
    assert.match(sql, /interval '3 days'/);
    assert.match(sql, /interval '17 days'/);
    for (const rule of CAUSE_RULES) {
        if (rule.id === 'fetch_failed') continue;
        assert.ok(sql.includes(`count(*) FILTER (WHERE ${causeSql(rule)}) AS ${rule.id}`), `${rule.id} not counted as defined`);
    }
    assert.ok(sql.includes(`count(*) FILTER (WHERE ${causeSql(causeRule('fetch_failed'))}) AS fetch_failed`));
    assert.ok(!/client_id/.test(sql), 'the monitor never reads rater identity');
});
