import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_LOGGED_TEXT,
  truncateForLog,
  newCheckId,
  buildLogPayload,
} from '../core/feedback.js';

test('newCheckId returns 8 lowercase hex characters', () => {
  for (let i = 0; i < 50; i++) {
    assert.match(newCheckId(), /^[0-9a-f]{8}$/);
  }
});

test('newCheckId does not obviously collide across a batch', () => {
  const ids = new Set(Array.from({ length: 500 }, () => newCheckId()));
  assert.equal(ids.size, 500);
});

test('newCheckId falls back to getRandomValues when randomUUID is absent', () => {
  const id = newCheckId({
    getRandomValues: buf => {
      buf.set([0x0a, 0xbc, 0x00, 0xff]);
      return buf;
    },
  });
  assert.equal(id, '0abc00ff');
});

test('newCheckId still produces an id with no crypto at all', () => {
  assert.match(newCheckId({}), /^[0-9a-f]{8}$/);
});

test('truncateForLog passes short text through, trimmed', () => {
  assert.equal(truncateForLog('  a claim  '), 'a claim');
});

test('truncateForLog returns null for empty/absent values', () => {
  assert.equal(truncateForLog(null), null);
  assert.equal(truncateForLog(undefined), null);
  assert.equal(truncateForLog(''), null);
  assert.equal(truncateForLog('   '), null);
});

test('truncateForLog caps long text at the limit, ellipsis included', () => {
  const out = truncateForLog('x'.repeat(MAX_LOGGED_TEXT + 500));
  assert.equal(out.length, MAX_LOGGED_TEXT);
  assert.ok(out.endsWith('…'));
});

test('truncateForLog leaves text exactly at the limit untouched', () => {
  const exact = 'x'.repeat(MAX_LOGGED_TEXT);
  assert.equal(truncateForLog(exact), exact);
});

test('buildLogPayload maps camelCase fields onto the snake_case columns', () => {
  const payload = buildLogPayload({
    checkId: 'a7f3k2q9',
    articleUrl: 'https://en.wikipedia.org/wiki/Test',
    articleTitle: 'Test',
    citationNumber: '12',
    sourceUrl: 'https://example.com/s',
    provider: 'claude',
    model: 'claude-sonnet-4-6',
    verdict: 'NOT SUPPORTED',
    confidence: 80,
    reasonType: 'omission',
    claimText: 'The sky is blue.',
    comments: 'Source never mentions the sky.',
  });
  assert.deepEqual(payload, {
    check_id: 'a7f3k2q9',
    kind: 'source',
    article_url: 'https://en.wikipedia.org/wiki/Test',
    article_title: 'Test',
    citation_number: '12',
    source_url: 'https://example.com/s',
    provider: 'claude',
    model: 'claude-sonnet-4-6',
    verdict: 'NOT SUPPORTED',
    confidence: 80,
    reason_type: 'omission',
    claim_text: 'The sky is blue.',
    llm_comments: 'Source never mentions the sky.',
  });
});

test('buildLogPayload carries claim text and rationale — the fields that make a rating interpretable', () => {
  const payload = buildLogPayload({ claimText: 'A claim.', comments: 'Because.' });
  assert.equal(payload.claim_text, 'A claim.');
  assert.equal(payload.llm_comments, 'Because.');
});

test('buildLogPayload truncates oversized claim text and rationale', () => {
  const payload = buildLogPayload({
    claimText: 'c'.repeat(MAX_LOGGED_TEXT + 1),
    comments: 'r'.repeat(MAX_LOGGED_TEXT + 1),
  });
  assert.equal(payload.claim_text.length, MAX_LOGGED_TEXT);
  assert.equal(payload.llm_comments.length, MAX_LOGGED_TEXT);
});

test('buildLogPayload defaults kind to source and honours an explicit group', () => {
  assert.equal(buildLogPayload({}).kind, 'source');
  assert.equal(buildLogPayload({ kind: 'group' }).kind, 'group');
});

test('buildLogPayload nulls absent fields rather than dropping the keys', () => {
  const payload = buildLogPayload();
  for (const key of ['check_id', 'article_url', 'source_url', 'model', 'verdict', 'claim_text']) {
    assert.equal(payload[key], null, `${key} should be null`);
  }
});

test('buildLogPayload preserves a confidence of 0 instead of nulling it', () => {
  // SOURCE UNAVAILABLE rows log confidence: 0 — a ?? chain that treated 0 as
  // absent would silently drop it.
  assert.equal(buildLogPayload({ confidence: 0 }).confidence, 0);
});
