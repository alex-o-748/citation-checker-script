import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { rowSupportScore } from '../benchmark/io.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('rowSupportScore reads either spelling of the model-reported score', () => {
    assert.equal(rowSupportScore({ support_score: 75 }), 75);
    assert.equal(rowSupportScore({ confidence: 75 }), 75);
    assert.equal(rowSupportScore({ support_score: 0 }), 0);
    assert.equal(rowSupportScore({}), 0);
    assert.equal(rowSupportScore(null), 0);
});

// Structural guard, same shape as models.test.js's "no model id as a literal
// in main.js" check.
//
// Commit e0706fb renamed `confidence` to `support_score` across the LLM
// contract but missed benchmark/roc.js, which kept reading `r.confidence`.
// Nothing failed: roc.js silently read 0 for every current-schema row,
// collapsing the ROC curve to a single threshold and AUC 0.500, while
// analyze_results.js — reading only the *new* name — silently reported an
// average support score of 0 for every pre-rename row. Two metrics, broken in
// opposite directions, against the same results.json, for months.
//
// Reading the field through io.js's rowSupportScore is what makes both
// spellings work, so a module that reaches for either name directly is the
// bug re-appearing. Presentation-only reads (inspect_results.js prints the
// raw value with its own fallback) and the metrics object built by
// analyze_results.js (`m.support_score.avg`) are not row reads and are
// allowed.
test('no benchmark module reads a result row\'s score field directly', () => {
    const dir = path.join(ROOT, 'benchmark');
    const offenders = [];
    for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.js')) continue;
        if (name === 'io.js') continue;            // defines the accessor
        if (name === 'inspect_results.js') continue; // prints the raw value
        const src = fs.readFileSync(path.join(dir, name), 'utf8');
        src.split('\n').forEach((line, i) => {
            // Strip line comments, and skip block-comment bodies outright —
            // the explanations of this very bug name both fields in prose.
            if (/^\s*\*/.test(line)) return;
            const code = line.replace(/\/\/.*$/, '');
            if (/\br\.(support_score|confidence)\b/.test(code)) {
                offenders.push(`${name}:${i + 1}: ${line.trim()}`);
            }
        });
    }
    assert.deepEqual(
        offenders,
        [],
        `read the score via rowSupportScore() from io.js instead:\n${offenders.join('\n')}`,
    );
});

// results.json is the file the restore in 4567db2 left on the pre-rename
// schema while liftwing rows arrived on the current one, so the same artifact
// carried both spellings and each metric silently dropped half of it.
test('committed results.json rows all use the current support_score spelling', () => {
    const file = path.join(ROOT, 'benchmark', 'results.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rows = Array.isArray(parsed) ? parsed : parsed.rows;
    const stale = rows.filter(r => r.confidence !== undefined);
    assert.equal(stale.length, 0, `${stale.length} row(s) still spell the score "confidence"`);
    const missing = rows.filter(r => r.support_score === undefined && !r.error);
    assert.equal(missing.length, 0, `${missing.length} non-error row(s) carry no support_score`);
});
