import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { leadDatasetEntry, carryOverLabels, scoreLeadRun, leadArticleId, LEAD_LABELS } from '../benchmark/lead_dataset.js';
import { parsoidRevision } from '../benchmark/extract_lead_dataset.js';
import { leadCaller, resultRow } from '../benchmark/run_lead_benchmark.js';
import { analyzeLead } from '../benchmark/analyze_lead.js';
import { LEAD_PROMPT_VERSION } from '../core/lead-check.js';

const html = '<!DOCTYPE html><html about="https://en.wikipedia.org/wiki/Special:Redirect/revision/123"><head><title>Bridge</title></head><body>'
    + '<section data-mw-section-id="0"><p>The bridge opened in 1998. It cost a fortune.</p></section>'
    + '<section data-mw-section-id="1"><h2>History</h2><p>The bridge opened to traffic in 1998.</p></section></body></html>';

test('a dataset entry stores the body and unlabeled lead sentences, keyed by wiki, title and revision', () => {
    assert.equal(parsoidRevision(html), 123);
    const entry = leadDatasetEntry({ wiki: 'enwiki', title: 'Bridge', revisionId: 123, root: JSDOM.fragment(html) });
    assert.equal(entry.id, 'enwiki:Bridge@123');
    assert.equal(entry.id, leadArticleId('enwiki', 'Bridge', 123));
    assert.equal(entry.body.text, '== History ==\nThe bridge opened to traffic in 1998.');
    assert.deepEqual(entry.sentences, [
        { index: 0, paragraphIndex: 0, text: 'The bridge opened in 1998.', label: null, notes: '' },
        { index: 1, paragraphIndex: 0, text: 'It cost a fortune.', label: null, notes: '' },
    ]);
    assert.ok(!('block' in entry.sentences[0]), 'plain data: no DOM elements in the dataset');
});

test('re-extracting keeps every label whose article and sentence text are unchanged', () => {
    const fresh = () => leadDatasetEntry({ wiki: 'enwiki', title: 'Bridge', revisionId: 123, root: JSDOM.fragment(html) });
    const old = fresh();
    old.sentences[0].label = 'covered';
    old.sentences[0].notes = 'History, first line';
    old.sentences[1].label = 'not_covered';
    old.sentences[1].text = 'It cost a great deal.'; // the sentence has since changed
    const entries = [fresh()];
    assert.equal(carryOverLabels(entries, [old]), 1);
    assert.deepEqual(entries[0].sentences.map(s => [s.label, s.notes]), [['covered', 'History, first line'], [null, '']]);
});

test('scoring: only labeled sentences count, the positive class is "not covered", unchecked is reported', () => {
    const dataset = [{
        id: 'a', sentences: [
            { index: 0, label: 'covered' },
            { index: 1, label: 'not_covered' },
            { index: 2, label: 'contradicted' },
            { index: 3, label: 'partly_covered' },
            { index: 4, label: 'covered' },
            { index: 5, label: null },
            { index: 6, label: 'not_covered' },
        ],
    }];
    const r = (i, verdict, outcome, extra = {}) => ({ article_id: 'a', sentence_index: i, verdict, outcome, ...extra });
    const results = [
        r(0, 'SUPPORTED', 'covered'),
        r(1, 'NOT SUPPORTED', 'not_covered'),
        r(2, 'NOT SUPPORTED', 'not_covered'),
        r(3, 'PARTIALLY SUPPORTED', 'not_covered'),
        r(4, 'PARTIALLY SUPPORTED', 'not_covered'),
        r(5, 'SUPPORTED', 'covered'),
        r(6, null, null, { error: 'error' }),
    ];
    const a = scoreLeadRun(dataset, results);
    assert.equal(a.labeled, 6);
    assert.equal(a.scored, 5);
    assert.equal(a.unchecked, 1);
    assert.deepEqual(a.counts, { tp: 3, fp: 1, fn: 0, tn: 1 });
    assert.equal(a.exact_accuracy, 3 / 5, 'contradicted read as not covered is a miss on the exact label');
    assert.equal(a.binary_accuracy, 4 / 5);
    assert.equal(a.tpr, 1);
    assert.equal(a.fpr, 0.5);
    assert.equal(a.confusion.not_covered.unchecked, 1);
    assert.equal(a.confusion.covered.partly_covered, 1);
    assert.deepEqual(LEAD_LABELS, ['covered', 'partly_covered', 'not_covered', 'contradicted']);
    assert.deepEqual(Object.keys(analyzeLead(dataset, results.map(x => ({ ...x, provider: 'p' })))), ['p']);
});

test('the benchmark caller hands the lead check raw text and rethrows a failed call', async () => {
    const ok = leadCaller('p', async () => ({ raw_response: '[]', usage: { input: 1, output: 2 }, error: null }));
    assert.deepEqual(await ok('s', 'u'), { text: '[]', usage: { input: 1, output: 2 } });
    const failing = leadCaller('p', async () => ({ verdict: 'ERROR', error: 'HF: the model ran out of output budget (16384 tokens)' }));
    await assert.rejects(failing('s', 'u'), /ran out of output budget/, 'so the lead check can split the chunk');
});

test('a result row carries the provider, the sentence and the prompt version', () => {
    const row = resultRow({
        provider: 'p', model: 'm', articleId: 'a', bodyTruncated: false,
        result: { index: 2, verdict: 'SUPPORTED', reasonType: null, outcome: 'covered', supportScore: 90, quoteStatus: 'exact', section: 'History', comments: 'ok', error: null },
    });
    assert.deepEqual(row, {
        provider: 'p', model: 'm', article_id: 'a', sentence_index: 2, verdict: 'SUPPORTED', reason_type: null,
        outcome: 'covered', support_score: 90, quote_status: 'exact', section: 'History', comments: 'ok', error: null,
        body_truncated: false, prompt_version: LEAD_PROMPT_VERSION,
    });
});
