import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseCompareArgs, COMPARE_HELP_TEXT, runCompare } from '../cli/compare.js';
import { UsageError } from '../cli/verify.js';

test('parseCompareArgs: --help short-circuits with scope=compare', () => {
    const opts = parseCompareArgs(['--help']);
    assert.equal(opts.help, true);
    assert.equal(opts.scope, 'compare');
});

test('parseCompareArgs: requires control + treatment positionals and --dataset', () => {
    assert.throws(() => parseCompareArgs([]), UsageError);
    assert.throws(() => parseCompareArgs(['c.json']), UsageError);
    assert.throws(() => parseCompareArgs(['c.json', 't.json']), UsageError); // missing --dataset
});

test('parseCompareArgs: returns full opts on a complete invocation', () => {
    const opts = parseCompareArgs([
        'control.json',
        'treatment.json',
        '--dataset', 'dataset.json',
        '--report', 'report.html',
        '--filter', 'version=v2',
        '--noise-floor', '7',
        '--change-axis', 'prompt',
        '--change-axis', 'source_text',
        '--gt-version', 'post-audit-2026-04-30',
    ]);
    assert.equal(opts.help, false);
    assert.equal(opts.controlPath, 'control.json');
    assert.equal(opts.treatmentPath, 'treatment.json');
    assert.equal(opts.datasetPath, 'dataset.json');
    assert.equal(opts.reportPath, 'report.html');
    assert.equal(opts.filter, 'version=v2');
    assert.equal(opts.noiseFloor, 7);
    assert.deepEqual(opts.changeAxes, ['prompt', 'source_text']);
    assert.equal(opts.groundTruthVersion, 'post-audit-2026-04-30');
});

test('parseCompareArgs: defaults reportPath to null and noiseFloor to 5', () => {
    const opts = parseCompareArgs(['c.json', 't.json', '--dataset', 'd.json']);
    assert.equal(opts.reportPath, null);
    assert.equal(opts.noiseFloor, 5);
    assert.deepEqual(opts.changeAxes, []);
});

test('COMPARE_HELP_TEXT mentions key flags', () => {
    assert.match(COMPARE_HELP_TEXT, /--dataset/);
    assert.match(COMPARE_HELP_TEXT, /--report/);
    assert.match(COMPARE_HELP_TEXT, /--filter/);
});

function tmp(suffix = '.json') {
    return path.join(os.tmpdir(), `ccs-compare-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`);
}

const FIX_DATASET = [
    { id: 'r1', ground_truth: 'Supported', claim_text: 'c1', source_url: 'http://x/1', extraction_status: 'complete', needs_manual_review: false, dataset_version: 'v1' },
    { id: 'r2', ground_truth: 'Not supported', claim_text: 'c2', source_url: 'http://x/2', extraction_status: 'complete', needs_manual_review: false, dataset_version: 'v2' },
];
const FIX_CONTROL = { rows: [
    { entry_id: 'r1', provider: 'mistral', predicted_verdict: 'Not supported', error: null },
    { entry_id: 'r2', provider: 'mistral', predicted_verdict: 'Supported', error: null },
] };
const FIX_TREATMENT = { rows: [
    { entry_id: 'r1', provider: 'mistral', predicted_verdict: 'Supported', error: null },
    { entry_id: 'r2', provider: 'mistral', predicted_verdict: 'Not supported', error: null },
] };

function setup() {
    const c = tmp(), t = tmp(), d = tmp();
    fs.writeFileSync(c, JSON.stringify(FIX_CONTROL));
    fs.writeFileSync(t, JSON.stringify(FIX_TREATMENT));
    fs.writeFileSync(d, JSON.stringify(FIX_DATASET));
    return { c, t, d };
}

test('runCompare writes JSON to stdout when no --report given', async () => {
    const { c, t, d } = setup();
    const out = [];
    const stdout = { write: (s) => out.push(s) };
    const stderr = { write: () => {} };
    try {
        const code = await runCompare(
            { controlPath: c, treatmentPath: t, datasetPath: d, reportPath: null, filter: null, noiseFloor: 5, changeAxes: [], groundTruthVersion: null },
            { stdout, stderr },
        );
        assert.equal(code, 0);
        const json = JSON.parse(out.join(''));
        assert.equal(json.coverage.comparedCells, 2);
    } finally {
        for (const f of [c, t, d]) fs.unlinkSync(f);
    }
});

test('runCompare writes HTML to disk when --report ends in .html', async () => {
    const { c, t, d } = setup();
    const reportPath = tmp('.html');
    const stdout = { write: () => {} };
    const stderr = { write: () => {} };
    try {
        const code = await runCompare(
            { controlPath: c, treatmentPath: t, datasetPath: d, reportPath, filter: null, noiseFloor: 5, changeAxes: [], groundTruthVersion: null },
            { stdout, stderr },
        );
        assert.equal(code, 0);
        const contents = fs.readFileSync(reportPath, 'utf8');
        assert.match(contents, /<!DOCTYPE html>/);
        assert.match(contents, /Headline accuracy/);
    } finally {
        for (const f of [c, t, d, reportPath]) try { fs.unlinkSync(f); } catch {}
    }
});

test('runCompare returns 2 when control file is missing', async () => {
    const { t, d } = setup();
    const stderr = [];
    const code = await runCompare(
        { controlPath: '/nonexistent.json', treatmentPath: t, datasetPath: d, reportPath: null, filter: null, noiseFloor: 5, changeAxes: [], groundTruthVersion: null },
        { stdout: { write: () => {} }, stderr: { write: (s) => stderr.push(s) } },
    );
    assert.equal(code, 2);
    assert.match(stderr.join(''), /ccs compare: /);
    for (const f of [t, d]) fs.unlinkSync(f);
});

test('runCompare returns 2 on no-overlap intersection', async () => {
    const c = tmp(), t = tmp(), d = tmp();
    fs.writeFileSync(c, JSON.stringify({ rows: [{ entry_id: 'r1', provider: 'mistral', predicted_verdict: 'Supported', error: null }] }));
    fs.writeFileSync(t, JSON.stringify({ rows: [{ entry_id: 'r2', provider: 'granite', predicted_verdict: 'Supported', error: null }] }));
    fs.writeFileSync(d, JSON.stringify(FIX_DATASET));
    const stderr = [];
    try {
        const code = await runCompare(
            { controlPath: c, treatmentPath: t, datasetPath: d, reportPath: null, filter: null, noiseFloor: 5, changeAxes: [], groundTruthVersion: null },
            { stdout: { write: () => {} }, stderr: { write: (s) => stderr.push(s) } },
        );
        assert.equal(code, 2);
        assert.match(stderr.join(''), /no cells in intersection/);
    } finally {
        for (const f of [c, t, d]) fs.unlinkSync(f);
    }
});

test('runCompare with --filter version=v2 narrows to v2 rows', async () => {
    const { c, t, d } = setup();
    const reportPath = tmp('.json');
    const stdout = { write: () => {} };
    const stderr = { write: () => {} };
    try {
        const code = await runCompare(
            { controlPath: c, treatmentPath: t, datasetPath: d, reportPath, filter: 'version=v2', noiseFloor: 5, changeAxes: [], groundTruthVersion: null },
            { stdout, stderr },
        );
        assert.equal(code, 0);
        const json = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
        // FIX_DATASET has one v2 row → filter to 1 cell.
        assert.equal(json.coverage.comparedCells, 1);
        assert.equal(json.metadata.filtered, true);
    } finally {
        for (const f of [c, t, d, reportPath]) try { fs.unlinkSync(f); } catch {}
    }
});

test('runCompare returns 2 on unknown --filter direction', async () => {
    const { c, t, d } = setup();
    const stderr = [];
    try {
        const code = await runCompare(
            { controlPath: c, treatmentPath: t, datasetPath: d, reportPath: null, filter: 'direction=reg', noiseFloor: 5, changeAxes: [], groundTruthVersion: null },
            { stdout: { write: () => {} }, stderr: { write: (s) => stderr.push(s) } },
        );
        assert.equal(code, 2);
        assert.match(stderr.join(''), /unknown direction: reg/);
    } finally {
        for (const f of [c, t, d]) fs.unlinkSync(f);
    }
});
