import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    escapeHtml,
    deltaColor,
    directionColor,
} from '../benchmark/render_compare.js';

test('escapeHtml escapes the five HTML-significant characters', () => {
    assert.equal(escapeHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#x27;&lt;/a&gt;');
    assert.equal(escapeHtml(''), '');
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
    assert.equal(escapeHtml(42), '42');
});

test('deltaColor returns green/red/grey based on noise floor', () => {
    assert.equal(deltaColor(10, 5), '#e6ffe6'); // above floor → green
    assert.equal(deltaColor(-10, 5), '#ffe6e6'); // below -floor → red
    assert.equal(deltaColor(2, 5), '#f0f0f0'); // within ±floor → grey
    assert.equal(deltaColor(-3, 5), '#f0f0f0');
    assert.equal(deltaColor(0, 5), '#f0f0f0');
});

test('directionColor maps each direction to a distinct shade', () => {
    assert.equal(directionColor('improvement'), '#e6ffe6');
    assert.equal(directionColor('regression'), '#ffe6e6');
    assert.equal(directionColor('lateral'), '#fff5cc');
    assert.equal(directionColor('unchanged-correct'), '#ffffff');
    assert.equal(directionColor('unchanged-wrong-same'), '#ffffff');
});

import { renderJson } from '../benchmark/render_compare.js';
import { compareResults } from '../benchmark/compare_results.js';

const TINY_DATASET = [
    { id: 'r1', ground_truth: 'Supported', claim_text: 'c1', source_url: 'http://x/1', extraction_status: 'complete', needs_manual_review: false },
];
const TINY_CONTROL = { rows: [{ entry_id: 'r1', provider: 'p', predicted_verdict: 'Not supported', error: null }] };
const TINY_TREATMENT = { rows: [{ entry_id: 'r1', provider: 'p', predicted_verdict: 'Supported', error: null }] };

test('renderJson serializes a ComparisonResult round-trippable through JSON.parse', () => {
    const result = compareResults({ control: TINY_CONTROL, treatment: TINY_TREATMENT, dataset: TINY_DATASET });
    const json = renderJson(result);
    const parsed = JSON.parse(json);
    assert.equal(parsed.coverage.comparedCells, 1);
    assert.equal(parsed.cells[0].direction, 'improvement');
    // perProvider was a Map; should serialize to a plain object.
    assert.equal(typeof parsed.perProvider, 'object');
    assert.equal(parsed.perProvider.p.n, 1);
});

import { renderMarkdown } from '../benchmark/render_compare.js';

test('renderMarkdown emits a headline accuracy table (exact + lenient + binary) and a flip table', () => {
    const result = compareResults({ control: TINY_CONTROL, treatment: TINY_TREATMENT, dataset: TINY_DATASET });
    const md = renderMarkdown(result);
    // Headline section — header row carries all three metric pairs in order: exact, lenient, binary.
    assert.match(md, /## Headline accuracy/);
    assert.match(md, /\| Provider \| n \| Control exact \| Treatment exact \| Δ exact \| Control lenient \| Treatment lenient \| Δ lenient \| Control binary \| Treatment binary \| Δ binary \|/);
    assert.match(md, /\| p \| 1 \|/);
    // Flip section
    assert.match(md, /## Flips/);
    assert.match(md, /improvement/);
    // Coverage / metadata block
    assert.match(md, /Compared cells: \*\*1\*\*/);
});

test('renderMarkdown notes when changeAxes are provided', () => {
    const result = compareResults({
        control: TINY_CONTROL, treatment: TINY_TREATMENT, dataset: TINY_DATASET,
        options: { changeAxes: ['prompt', 'source_text'], groundTruthVersion: 'post-audit-2026-04-30' },
    });
    const md = renderMarkdown(result);
    assert.match(md, /Change axes: `prompt`, `source_text`/);
    assert.match(md, /Ground truth version: `post-audit-2026-04-30`/);
});

import { renderHtml } from '../benchmark/render_compare.js';

test('renderHtml emits a self-contained HTML document with headline and flip tables', () => {
    const result = compareResults({ control: TINY_CONTROL, treatment: TINY_TREATMENT, dataset: TINY_DATASET });
    const html = renderHtml(result);
    assert.match(html, /<!DOCTYPE html>/);
    assert.match(html, /<style>/); // inline CSS
    assert.match(html, /Headline accuracy/);
    assert.match(html, /Flips/);
    assert.match(html, /<td[^>]*>p<\/td>/); // provider name in a row
    assert.match(html, /improvement/);
    // Color-coded direction cell present
    assert.match(html, /background-color:\s*#e6ffe6/);
});

test('renderHtml escapes claim text and source URLs', () => {
    const datasetWithDangerousChars = [{
        id: 'r1', ground_truth: 'Supported',
        claim_text: '<script>alert("x")</script>',
        source_url: 'http://x/?a=b&c=d',
        extraction_status: 'complete', needs_manual_review: false,
    }];
    const control = { rows: [{ entry_id: 'r1', provider: 'p', predicted_verdict: 'Not supported', error: null }] };
    const treatment = { rows: [{ entry_id: 'r1', provider: 'p', predicted_verdict: 'Supported', error: null }] };
    const result = compareResults({ control, treatment, dataset: datasetWithDangerousChars });
    const html = renderHtml(result);
    assert.equal(html.includes('<script>alert'), false);
    assert.match(html, /&lt;script&gt;alert/);
    assert.match(html, /a=b&amp;c=d/);
});
