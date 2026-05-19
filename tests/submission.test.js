import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DATASET_SUBMISSION_FORM_URL,
  DATASET_SUBMISSION_ENTRY_IDS,
  isDatasetSubmissionConfigured,
  buildDatasetSubmissionUrl,
} from '../core/submission.js';

const REAL_FORM_URL = 'https://docs.google.com/forms/d/e/1AAA/viewform';
const REAL_ENTRY_IDS = {
  articleUrl:     'entry.111',
  citationNumber: 'entry.222',
  claimText:      'entry.333',
  sourceUrl:      'entry.444',
  llmVerdict:     'entry.555',
  llmRationale:   'entry.666',
  llmProvider:    'entry.777',
  llmModel:       'entry.888',
  fetchStatus:    'entry.1111',
  editorHandle:   'entry.999',
  notes:          'entry.1010',
};

test('isDatasetSubmissionConfigured accepts the shipped form URL + entry IDs', () => {
  // The module ships pre-wired to the production form. If this fails, either
  // someone reset the constants back to PLACEHOLDER_* values without updating
  // the test, or a real entry ID accidentally contains the sentinel substring.
  assert.equal(isDatasetSubmissionConfigured(), true);
  assert.equal(
    isDatasetSubmissionConfigured(DATASET_SUBMISSION_FORM_URL, DATASET_SUBMISSION_ENTRY_IDS),
    true,
  );
});

test('isDatasetSubmissionConfigured rejects when the URL is real but entry IDs are placeholder', () => {
  const placeholderIds = Object.fromEntries(
    Object.keys(DATASET_SUBMISSION_ENTRY_IDS).map((k, i) => [k, `entry.PLACEHOLDER_${i}`]),
  );
  assert.equal(isDatasetSubmissionConfigured(REAL_FORM_URL, placeholderIds), false);
});

test('isDatasetSubmissionConfigured rejects when any single entry ID is still a placeholder', () => {
  const partial = { ...REAL_ENTRY_IDS, notes: 'entry.PLACEHOLDER_10' };
  assert.equal(isDatasetSubmissionConfigured(REAL_FORM_URL, partial), false);
});

test('isDatasetSubmissionConfigured accepts a fully-configured form', () => {
  assert.equal(isDatasetSubmissionConfigured(REAL_FORM_URL, REAL_ENTRY_IDS), true);
});

test('buildDatasetSubmissionUrl prefixes the form URL and sets usp=pp_url', () => {
  const url = buildDatasetSubmissionUrl({}, REAL_FORM_URL, REAL_ENTRY_IDS);
  assert.ok(url.startsWith(`${REAL_FORM_URL}?`));
  const params = new URL(url).searchParams;
  assert.equal(params.get('usp'), 'pp_url');
});

test('buildDatasetSubmissionUrl maps every supplied field to its entry ID', () => {
  const url = buildDatasetSubmissionUrl({
    articleUrl: 'https://en.wikipedia.org/wiki/Test',
    citationNumber: '7',
    claimText: 'The sky is blue.',
    sourceUrl: 'https://example.com/source',
    llmVerdict: 'SUPPORTED',
    llmRationale: 'Source states sky is blue.',
    llmProvider: 'Claude',
    llmModel: 'claude-sonnet-4-6',
    fetchStatus: 503,
    editorHandle: 'Alice',
    notes: 'Cross-checked manually',
  }, REAL_FORM_URL, REAL_ENTRY_IDS);
  const params = new URL(url).searchParams;
  assert.equal(params.get('entry.111'), 'https://en.wikipedia.org/wiki/Test');
  assert.equal(params.get('entry.222'), '7');
  assert.equal(params.get('entry.333'), 'The sky is blue.');
  assert.equal(params.get('entry.444'), 'https://example.com/source');
  assert.equal(params.get('entry.555'), 'SUPPORTED');
  assert.equal(params.get('entry.666'), 'Source states sky is blue.');
  assert.equal(params.get('entry.777'), 'Claude');
  assert.equal(params.get('entry.888'), 'claude-sonnet-4-6');
  assert.equal(params.get('entry.1111'), '503');
  assert.equal(params.get('entry.999'), 'Alice');
  assert.equal(params.get('entry.1010'), 'Cross-checked manually');
});

test('buildDatasetSubmissionUrl skips missing/empty fields rather than appending blanks', () => {
  const url = buildDatasetSubmissionUrl({
    articleUrl: 'https://en.wikipedia.org/wiki/Test',
    claimText: 'A claim.',
    // sourceUrl omitted
    llmVerdict: '',          // empty -> skipped
    llmRationale: null,      // null -> skipped
    llmProvider: undefined,  // undefined -> skipped
  }, REAL_FORM_URL, REAL_ENTRY_IDS);
  const params = new URL(url).searchParams;
  assert.equal(params.has('entry.111'), true);
  assert.equal(params.has('entry.333'), true);
  assert.equal(params.has('entry.444'), false);
  assert.equal(params.has('entry.555'), false);
  assert.equal(params.has('entry.666'), false);
  assert.equal(params.has('entry.777'), false);
});

test('buildDatasetSubmissionUrl URL-encodes special characters and unicode', () => {
  const url = buildDatasetSubmissionUrl({
    claimText: 'Tübingen & Zürich — "facts"',
    notes: 'a=b&c=d',
  }, REAL_FORM_URL, REAL_ENTRY_IDS);
  const params = new URL(url).searchParams;
  assert.equal(params.get('entry.333'), 'Tübingen & Zürich — "facts"');
  assert.equal(params.get('entry.1010'), 'a=b&c=d');
});

test('buildDatasetSubmissionUrl tolerates null/undefined fields argument', () => {
  const urlFromNull = buildDatasetSubmissionUrl(null, REAL_FORM_URL, REAL_ENTRY_IDS);
  const urlFromUndef = buildDatasetSubmissionUrl(undefined, REAL_FORM_URL, REAL_ENTRY_IDS);
  for (const url of [urlFromNull, urlFromUndef]) {
    const params = new URL(url).searchParams;
    assert.equal(params.get('usp'), 'pp_url');
    // No entry.* params should be set.
    for (const id of Object.values(REAL_ENTRY_IDS)) {
      assert.equal(params.has(id), false);
    }
  }
});

test('buildDatasetSubmissionUrl coerces non-string field values to strings', () => {
  const url = buildDatasetSubmissionUrl({
    citationNumber: 42,
  }, REAL_FORM_URL, REAL_ENTRY_IDS);
  const params = new URL(url).searchParams;
  assert.equal(params.get('entry.222'), '42');
});
